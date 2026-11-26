package netplay

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"net/netip"
	"runtime"
	"strings"
	"testing"
	"time"
)

// A message longer than its cap is refused on its header, before its body is read or a buffer
// made for it.
func TestReadMsgMaxRefusesOnTheHeader(t *testing.T) {
	hdr := binary.AppendUvarint([]byte{MsgHello}, maxMessage)
	br := bufio.NewReaderSize(bytes.NewReader(hdr), 16)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	if _, _, err := readMsgMax(br, func(byte) uint64 { return maxHello }); err == nil {
		t.Fatal("an 8 MB hello was read")
	}
	runtime.ReadMemStats(&after)
	if d := after.TotalAlloc - before.TotalAlloc; d > 64<<10 {
		t.Errorf("%d bytes allocated refusing a header", d)
	}
	ok := binary.AppendUvarint([]byte{MsgHello}, 3)
	if typ, p, err := readMsgMax(bufio.NewReader(bytes.NewReader(append(ok, "abc"...))), func(byte) uint64 { return 3 }); err != nil || typ != MsgHello || string(p) != "abc" {
		t.Fatalf("a message at its cap: %d %q %v", typ, p, err)
	}
}

// What an honest client sends fits its cap with room to spare: a hello with a long name, the
// largest command and the page's echo.
func TestHonestMessagesFitTheirCaps(t *testing.T) {
	h, _ := json.Marshal(Hello{Proto: Proto, Version: "v1.2.3-45-gabcdef1-dirty", Name: strings.Repeat("ü", 64), UDP: true})
	if len(h) > maxHello/4 {
		t.Errorf("a hello is %d bytes, the cap %d", len(h), maxHello)
	}
	c := Cmd{Op: OpChat, A: 255, B: 255, X: 9999, Y: 9999, T: 65535, Text: strings.Repeat("x", 1000), Seq: 65535}
	if n := len(c.encode()); n > maxCmdMsg*2/3 {
		t.Errorf("the largest command is %d bytes, the cap %d", n, maxCmdMsg)
	}
	// web.Session's echo is a u64 time and a u32 count.
	if echo := len(binary.LittleEndian.AppendUint32(binary.LittleEndian.AppendUint64(nil, 1), 1)); echo > maxSmallMsg/4 {
		t.Errorf("an echo is %d bytes, the cap %d", echo, maxSmallMsg)
	}
}

// A hello claiming megabytes gets the connection closed at once, and the host goes on letting
// players in.
func TestAHugeHelloIsRefused(t *testing.T) {
	t.Parallel()
	s, err := Listen(ServerConfig{Addrs: []string{"127.0.0.1:0"}, Seed: 3, Version: "test", Host: "box"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, err := net.Dial("tcp", s.Addrs()[0])
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write(binary.AppendUvarint([]byte{MsgHello}, 1<<20)); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if n, err := c.Read(make([]byte, 64)); n != 0 || err == nil || isTimeout(err) {
		t.Fatalf("read %d, %v: want the connection closed", n, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cl, _, err := Dial(ctx, s.Addrs()[0], Hello{Name: "tester", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	cl.Close()
}

func isTimeout(err error) bool {
	ne, ok := err.(net.Error)
	return ok && ne.Timeout()
}

func TestHandshakeAdmission(t *testing.T) {
	var h handshakes
	a, b := netip.MustParseAddr("100.64.0.1"), netip.MustParseAddr("100.64.0.2")
	for i := range maxHandshakesPerIP {
		if !h.admit(a) {
			t.Fatalf("handshake %d from one address refused", i+1)
		}
	}
	if h.admit(a) {
		t.Fatal("one handshake too many from one address let in")
	}
	if !h.admit(b) {
		t.Fatal("another address refused")
	}
	h.done(a)
	if !h.admit(a) {
		t.Fatal("a handshake that ended still counted")
	}
	// Loopback is held to the total only.
	lo := netip.MustParseAddr("127.0.0.1")
	n := 0
	for h.admit(lo) {
		n++
	}
	if want := maxHandshakes - maxHandshakesPerIP - 1; n != want {
		t.Fatalf("%d loopback handshakes let in, want %d", n, want)
	}
	h.done(lo)
	if h.admit(b) != true {
		t.Fatal("the total did not free up")
	}
}

// Past the cap of connections that never say hello, the next is closed at once; once they go,
// players get in again.
func TestIdleHandshakesAreCapped(t *testing.T) {
	t.Parallel()
	s, err := Listen(ServerConfig{Addrs: []string{"127.0.0.1:0"}, Seed: 3, Version: "test", Host: "box"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var idle []net.Conn
	defer func() {
		for _, c := range idle {
			c.Close()
		}
	}()
	for range maxHandshakes {
		c, err := net.Dial("tcp", s.Addrs()[0])
		if err != nil {
			t.Fatal(err)
		}
		idle = append(idle, c)
	}
	// The accept loop counts them in as it takes them.
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.hs.mu.Lock()
		n := s.hs.all
		s.hs.mu.Unlock()
		if n == maxHandshakes {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d handshakes counted", n)
		}
		time.Sleep(10 * time.Millisecond)
	}
	c, err := net.Dial("tcp", s.Addrs()[0])
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := c.Read(make([]byte, 1)); err == nil || isTimeout(err) {
		t.Fatalf("one over the cap: %v, want it closed", err)
	}
	c.Close()
	for _, c := range idle {
		c.Close()
	}
	idle = nil
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		cl, _, err := Dial(ctx, s.Addrs()[0], Hello{Name: "tester", Version: "test"})
		if err == nil {
			cl.Close()
			return
		}
		if ctx.Err() != nil {
			t.Fatalf("no join once the idle connections went: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A message larger than any a client sends ends its connection.
func TestAnOversizedCommandEndsTheConnection(t *testing.T) {
	t.Parallel()
	s, err := Listen(ServerConfig{Addrs: []string{"127.0.0.1:0"}, Seed: 3, Version: "test", Host: "box"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := Dial(ctx, s.Addrs()[0], Hello{Name: "tester", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.writeTCP(MsgEcho, make([]byte, maxSmallMsg+1)); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(3 * time.Second)
	for {
		select {
		case m, ok := <-c.Msgs():
			if !ok || m.Err != nil {
				return
			}
		case <-deadline:
			t.Fatal("the connection outlived an oversized echo")
		}
	}
}

// The buckets never hold up what an honest player sends: a steer every frame at 360 Hz with
// clicks at 15 a second, then all of a 3 s stall's backlog at once; then the same at 240 Hz
// after a 5 s stall.
func TestTheBucketsPassHonestPlay(t *testing.T) {
	msgs := bucket{rate: msgRate, burst: msgBurst}
	paths := bucket{rate: pathRate, burst: pathBurst}
	now := time.Unix(1000, 0)
	send := func(n int, every time.Duration, click int) {
		for i := range n {
			if w := msgs.take(now); w > 0 {
				t.Fatalf("message %d held up %v", i, w)
			}
			if click > 0 && i%click == 0 {
				if w := paths.take(now); w > 0 {
					t.Fatalf("click %d held up %v", i, w)
				}
			}
			now = now.Add(every)
		}
	}
	send(360*30, time.Second/360, 24)
	send(3*360, 0, 24) // the stall's backlog, arriving together
	send(360*30, time.Second/360, 24)
	send(5*240, 0, 16) // 5 s of a 240 Hz screen's
	send(240*30, time.Second/240, 16)
}

// A flood waits: past the burst, at the bucket's rate.
func TestTheBucketsSlowAFlood(t *testing.T) {
	b := bucket{rate: pathRate, burst: pathBurst}
	now := time.Unix(1000, 0)
	for i := range pathBurst {
		if w := b.take(now); w > 0 {
			t.Fatalf("take %d of the burst waited %v", i, w)
		}
	}
	// Each further one waits its turn, the reader sleeping as it would.
	start := now
	for range 3 * pathRate {
		now = now.Add(b.take(now))
	}
	if got := now.Sub(start); got < 2900*time.Millisecond || got > 3100*time.Millisecond {
		t.Fatalf("%d more took %v, want 3 s", 3*pathRate, got)
	}
}

// Over a real connection: a flood of moves is acked at the path rate past its burst, and a
// burst of steers as a stalled link delivers them is acked within a few ticks.
func TestAFloodOfMovesIsSlowed(t *testing.T) {
	t.Parallel()
	s, err := Listen(ServerConfig{Addrs: []string{"127.0.0.1:0"}, Seed: 3, Version: "test", Host: "box"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, wel, err := Dial(ctx, s.Addrs()[0], Hello{Name: "tester", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	r := NewReplica(wel.W, wel.H, wel.Terrain, wel.You, wel.Seed)
	var acked uint16
	// await reads until seq is acked or d is up, and says how long it took.
	await := func(seq uint16, d time.Duration) time.Duration {
		start := time.Now()
		deadline := time.After(d)
		for acked != seq {
			select {
			case m := <-c.Msgs():
				if m.Err != nil {
					t.Fatal(m.Err)
				}
				switch m.Type {
				case MsgFrame:
					_ = r.Apply(m.Payload)
				case MsgAck:
					a, err := DecodeAck(m.Payload)
					if err != nil {
						t.Fatal(err)
					}
					acked = a.Seq
				}
			case <-deadline:
				return d
			}
		}
		return time.Since(start)
	}
	for !r.Synced {
		await(0xffff, 100*time.Millisecond)
	}
	me := r.Me()
	seq := uint16(0)
	for range 500 {
		seq++
		if err := c.Send(Cmd{Op: OpSteer, A: uint8(seq), B: 1, Seq: seq}); err != nil {
			t.Fatal(err)
		}
	}
	if d := await(seq, 2*time.Second); d > 300*time.Millisecond {
		t.Fatalf("500 steers at once acked after %v", d)
	}
	// Moves to where the survivor stands, so the paths cost nothing and only the bucket counts.
	const moves = pathBurst + 2*pathRate
	start := time.Now()
	for range moves {
		seq++
		if err := c.Send(Cmd{Op: OpMove, X: me.X, Y: me.Y, Seq: seq}); err != nil {
			t.Fatal(err)
		}
	}
	await(seq, 4*time.Second)
	if d := time.Since(start); d < 1800*time.Millisecond {
		t.Fatalf("%d moves acked within %v, want about 2 s", moves, d)
	}
	if acked != seq {
		t.Fatalf("acked %d of %d", acked, seq)
	}
}

// Chat lines come chatBurst at once, then one a chatEvery; one past that is not sent, and the
// sender is told.
func TestChatIsMetered(t *testing.T) {
	t.Parallel()
	l := &hostLog{}
	s, err := Listen(ServerConfig{Addrs: []string{"127.0.0.1:0"}, Seed: 3, Version: "test", Host: "box", Log: l.log})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := Dial(ctx, s.Addrs()[0], Hello{Name: "tester", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	const lines = chatBurst + 3
	for i := range lines {
		if err := c.Send(Cmd{Op: OpChat, Text: "hello " + string(rune('a'+i)), Seq: uint16(i + 1)}); err != nil {
			t.Fatal(err)
		}
	}
	refused := 0
	deadline := time.After(2 * time.Second)
	for refused < lines-chatBurst {
		select {
		case m := <-c.Msgs():
			if m.Err != nil {
				t.Fatal(m.Err)
			}
			if m.Type == MsgToast {
				if _, text := DecodeToast(m.Payload); strings.Contains(text, "too fast") {
					refused++
				}
			}
		case <-deadline:
			t.Fatalf("%d lines refused, want %d", refused, lines-chatBurst)
		}
	}
	time.Sleep(200 * time.Millisecond)
	if n := l.count("tester: hello"); n != chatBurst {
		t.Fatalf("%d lines said, want %d", n, chatBurst)
	}
}

func TestHelloGate(t *testing.T) {
	g := helloGate{}
	now := time.Unix(1000, 0)
	if !g.allow(1, now) || !g.allow(2, now) {
		t.Fatal("a first hello dropped")
	}
	if g.allow(1, now.Add(helloGap/2)) {
		t.Fatal("a hello bunched up with the last let through")
	}
	// The client's pace, five a second, and its least gap, half its interval.
	for i := 1; i <= 50; i++ {
		if !g.allow(2, now.Add(time.Duration(i)*200*time.Millisecond)) {
			t.Fatalf("hello %d at five a second dropped", i)
		}
	}
	if !g.allow(1, now.Add(helloGap)) {
		t.Fatal("a hello helloGap after the last dropped")
	}
	g.forget(func(tok uint64) bool { return tok == 2 })
	if _, ok := g[1]; ok || len(g) != 1 {
		t.Fatalf("forget kept %v", g)
	}
}
