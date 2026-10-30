package netplay

import (
	"bytes"
	"context"
	"fmt"
	"math/rand/v2"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"taildefense/internal/game"
)

// A unit cut into fragments comes back whole from them in any order, duplicates and all, and
// no fragment is larger than the tailnet's MTU allows.
func TestFragmentsReassemble(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	var pk unitPacker
	for _, size := range []int{1, 300, fragData, 5000, 40000} {
		frames := []seqFrame{{7, make([]byte, size)}, {8, make([]byte, size/2+1)}}
		for _, f := range frames {
			for i := range f.p {
				f.p[i] = byte(rng.IntN(256)) // incompressible, the worst case
			}
		}
		dgs := fragment(3, 8, pk.pack(frames))
		for _, dg := range dgs {
			if len(dg) > udpMax {
				t.Fatalf("a datagram of %d bytes", len(dg))
			}
		}
		dgs = append(dgs, dgs[0])
		rng.Shuffle(len(dgs), func(i, j int) { dgs[i], dgs[j] = dgs[j], dgs[i] })
		var r reassembler
		var unit []byte
		for _, dg := range dgs {
			m, ok := parseDatagram(dg)
			if !ok {
				t.Fatalf("own fragment refused")
			}
			// A duplicate after the unit is whole may start it again; the client drops
			// fragments of what it has applied before they get here.
			if u := r.add(m); u != nil && unit == nil {
				unit = u
			}
		}
		got, err := unpack(unit)
		if err != nil || len(got) != 2 || got[0].seq != 7 || got[1].seq != 8 ||
			!bytes.Equal(got[0].p, frames[0].p) || !bytes.Equal(got[1].p, frames[1].p) {
			t.Fatalf("%d bytes: unit came back as %d frames, %v", size, len(got), err)
		}
	}
}

// A unit missing a fragment is given up once enough newer ones have started.
func TestALostFragmentIsForgotten(t *testing.T) {
	var pk unitPacker
	var r reassembler
	big := make([]byte, 3*fragData)
	for i := range big {
		big[i] = byte(i * 7919 >> 3)
	}
	for seq := uint32(1); seq <= maxPartial+3; seq++ {
		dgs := fragment(0, seq, pk.pack([]seqFrame{{seq, big}}))
		for _, dg := range dgs[1:] { // the first is always lost
			m, _ := parseDatagram(dg)
			if r.add(m) != nil {
				t.Fatal("a unit without its first fragment completed")
			}
		}
	}
	if len(r.parts) > maxPartial {
		t.Fatalf("%d partial units kept", len(r.parts))
	}
}

// frameFlow hands on frames in order, each delta on the one before, whatever order and
// however often they come; a hole makes it want a keyframe, and an ack waits for its frame.
func TestFrameFlowOrders(t *testing.T) {
	frame := func(key bool, tick uint32) []byte {
		var b enc
		if key {
			b.u8(frameKey)
		} else {
			b.u8(0)
		}
		b.u32(tick)
		return b.b
	}
	var f frameFlow
	ticks := func() []uint32 {
		var out []uint32
		for _, m := range f.out {
			if m.Type == MsgFrame {
				tk, _ := frameTick(m.Payload)
				out = append(out, tk)
			} else {
				a, _ := DecodeAck(m.Payload)
				out = append(out, 1000+a.Tick)
			}
		}
		f.out = f.out[:0]
		return out
	}
	expect := func(what string, want ...uint32) {
		t.Helper()
		if got := ticks(); !equal(got, want) {
			t.Fatalf("%s: handed on %v, want %v", what, got, want)
		}
	}
	f.frame(2, frame(false, 2), true)
	f.ack(Msg{Type: MsgAck, Payload: Ack{Seq: 1, Tick: 1}.encode()})
	expect("a delta before any keyframe, and an ack")
	f.frame(1, frame(true, 1), false)
	expect("the keyframe", 1, 1001, 2)
	f.frame(4, frame(false, 4), true)
	f.frame(2, frame(false, 2), true)
	f.ack(Msg{Type: MsgAck, Payload: Ack{Seq: 2, Tick: 4}.encode()})
	expect("a delta past a hole, a duplicate and an early ack")
	if f.wantKey {
		t.Fatal("wants a keyframe for a hole that may yet fill")
	}
	f.frame(3, frame(false, 3), true)
	expect("the hole filled", 3, 4, 1004)
	f.frame(6, frame(false, 6), true)
	f.frame(7, frame(false, 7), true)
	expect("past a hole")
	if !f.wantKey {
		t.Fatal("no keyframe wanted for a hole the slack is past")
	}
	f.frame(6, frame(true, 6), false)
	expect("a keyframe", 6, 7)
	if f.wantKey || f.applied() != 7 {
		t.Fatalf("after the keyframe: want %v, applied %d", f.wantKey, f.applied())
	}
	// A restart: frames of the old epoch are not applied, acks of the old game go first.
	f.ack(Msg{Type: MsgAck, Payload: Ack{Seq: 3, Tick: 9}.encode()})
	f.welcome(Msg{Type: MsgWelcome})
	if got := ticks(); len(got) != 2 || got[0] != 1009 {
		t.Fatalf("restart handed on %v", got)
	}
	f.frame(9, frame(false, 1), true)
	expect("a delta after the welcome")
	f.frame(8, frame(true, 0), true)
	expect("the new map's keyframe", 0, 1)
}

func equal(a, b []uint32) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Through datagrams that are lost, duplicated and reordered, a replica fed by frameFlow,
// asking for keyframes as a client does, ends up where the world is.
func TestLossyUnitsTrackTheWorld(t *testing.T) {
	w := newWorldWithCreeps(400)
	s := &Server{world: w}
	rng := rand.New(rand.NewPCG(5, 6))
	r := NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
	var f frameFlow
	var parts reassembler
	type inflight struct {
		at int
		dg []byte
	}
	var air []inflight
	needKey, keys := true, 0
	apply := func() {
		for _, m := range f.out {
			if err := r.Apply(m.Payload); err != nil {
				t.Fatal(err)
			}
		}
		f.out = f.out[:0]
	}
	lastKey := -10
	deliver := func(a inflight) {
		m, ok := parseDatagram(a.dg)
		if !ok {
			t.Fatal("own datagram refused")
		}
		if unit := parts.add(m); unit != nil {
			frames, err := unpack(unit)
			if err != nil {
				t.Fatal(err)
			}
			for _, fr := range frames {
				f.frame(fr.seq, fr.p, true)
			}
		}
	}
	for tick := 1; tick <= 600; tick++ {
		w.Step()
		if tick%60 == 0 {
			for range 20 {
				w.SpawnCreep(game.CSwarmer, w.SpawnPts[0][0], w.SpawnPts[0][1])
			}
		}
		s.seq++
		delta := s.enc.Delta(w, nil)
		uf := udpFrames{s: s, seq: s.seq, delta: func() []byte { return delta }, key: func() []byte { return s.enc.Key(w, nil) }}
		dgs := uf.deltaDgs()
		if needKey && tick-lastKey > 3 {
			dgs, needKey, lastKey = uf.keyDgs(), false, tick
			keys++
		}
		s.remember(s.seq, delta)
		// The last ticks go through clean, to settle.
		for _, dg := range dgs {
			if tick <= 560 && rng.Float64() < 0.08 {
				continue
			}
			air = append(air, inflight{tick + rng.IntN(3), dg})
			if rng.Float64() < 0.02 {
				air = append(air, inflight{tick + 2, dg})
			}
		}
		keep := air[:0]
		rng.Shuffle(len(air), func(i, j int) { air[i], air[j] = air[j], air[i] })
		for _, a := range air {
			if a.at > tick {
				keep = append(keep, a)
				continue
			}
			deliver(a)
		}
		air = keep
		apply()
		if f.wantKey {
			needKey = true
		}
	}
	for _, a := range air {
		deliver(a)
	}
	apply()
	if !r.Synced || f.applied() != s.seq {
		t.Fatalf("applied %d of %d", f.applied(), s.seq)
	}
	checkReplica(t, w, r)
	t.Logf("%d keyframes for 600 ticks at 8%% loss", keys)
}

// relay forwards datagrams between a client and a host's UDP port, unless told to drop them.
type relay struct {
	pc      *net.UDPConn
	block   atomic.Bool
	client  atomic.Pointer[netip.AddrPort]
	host    netip.AddrPort
	forward atomic.Int64
}

func newRelay(t *testing.T, host string) *relay {
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	r := &relay{pc: pc, host: netip.MustParseAddrPort(host)}
	t.Cleanup(func() { pc.Close() })
	go func() {
		buf := make([]byte, 2048)
		for {
			n, from, err := pc.ReadFromUDPAddrPort(buf)
			if err != nil {
				return
			}
			if r.block.Load() {
				continue
			}
			r.forward.Add(1)
			if from == r.host {
				if c := r.client.Load(); c != nil {
					_, _ = pc.WriteToUDPAddrPort(buf[:n], *c)
				}
			} else {
				r.client.Store(&from)
				_, _ = pc.WriteToUDPAddrPort(buf[:n], r.host)
			}
		}
	}()
	return r
}

func (r *relay) addr() string { return r.pc.LocalAddr().String() }

// play reads a client's messages for d, applying frames, and says how many it applied.
func play(t *testing.T, c *Client, r *Replica, d time.Duration, until func() bool) int {
	t.Helper()
	n := 0
	end := time.After(d)
	for {
		select {
		case m, ok := <-c.Msgs():
			if !ok || m.Err != nil {
				t.Fatalf("the host went away: %v", m.Err)
			}
			if m.Type == MsgFrame {
				was := r.Tick
				if err := r.Apply(m.Payload); err != nil {
					t.Fatal(err)
				}
				if r.Synced && r.Tick < was {
					t.Fatalf("tick %d after %d", r.Tick, was)
				}
				n++
				if until != nil && until() {
					return n
				}
			}
		case <-end:
			return n
		}
	}
}

func udpHost(t *testing.T) *Server {
	t.Helper()
	s, err := Listen(ServerConfig{Addrs: []string{"127.0.0.1:0"}, Seed: 3, Version: "test", Host: "box", LocalLogin: "me", LocalName: "me"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if s.udps[0] == nil {
		t.Skip("no UDP on the TCP port")
	}
	return s
}

// A player that asks for UDP gets its frames that way, and its commands are still acked.
func TestFramesOverUDP(t *testing.T) {
	s := udpHost(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, wel, err := Dial(ctx, s.Addrs()[0], Hello{Name: "tester", Version: "test", UDP: true})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	r := NewReplica(wel.W, wel.H, wel.Terrain, wel.You, wel.Seed)
	play(t, c, r, 3*time.Second, func() bool { return c.Transport() == "udp" && r.Synced })
	if c.Transport() != "udp" {
		t.Fatal("frames never came over UDP")
	}
	if err := c.Send(Cmd{Op: OpStop, Seq: 9}); err != nil {
		t.Fatal(err)
	}
	end := time.After(3 * time.Second)
	for {
		select {
		case m := <-c.Msgs():
			if m.Err != nil {
				t.Fatal(m.Err)
			}
			switch m.Type {
			case MsgFrame:
				if err := r.Apply(m.Payload); err != nil {
					t.Fatal(err)
				}
			case MsgAck:
				a, _ := DecodeAck(m.Payload)
				if a.Seq != 9 {
					continue
				}
				// The ack never overtakes its frame.
				if r.Tick < a.Tick {
					t.Fatalf("ack of tick %d with the replica at %d", a.Tick, r.Tick)
				}
				return
			}
		case <-end:
			t.Fatal("no ack")
		}
	}
}

// With UDP blocked from the start a player plays over TCP; when it is blocked later, the
// host notices and the frames come over TCP again.
func TestUDPFallsBackToTCP(t *testing.T) {
	for _, later := range []bool{false, true} {
		s := udpHost(t)
		rl := newRelay(t, s.udps[0].LocalAddr().String())
		rl.block.Store(!later)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		c, wel, err := Dial(ctx, s.Addrs()[0], Hello{Name: "tester", Version: "test", UDP: true, UDPVia: rl.addr()})
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		r := NewReplica(wel.W, wel.H, wel.Terrain, wel.You, wel.Seed)
		if later {
			play(t, c, r, 3*time.Second, func() bool { return c.Transport() == "udp" && r.Synced })
			if c.Transport() != "udp" {
				t.Fatal("frames never came over UDP")
			}
			rl.block.Store(true)
		}
		var lastFrame time.Time
		var worst time.Duration
		start := time.Now()
		n := 0
		play(t, c, r, 6*time.Second, func() bool {
			now := time.Now()
			if !lastFrame.IsZero() {
				worst = max(worst, now.Sub(lastFrame))
			}
			lastFrame = now
			n++
			return strings.HasPrefix(c.Transport(), "tcp") && r.Synced && n > 2*game.TickRate
		})
		if !strings.HasPrefix(c.Transport(), "tcp") || !r.Synced || n <= 2*game.TickRate {
			t.Fatalf("blocked later %v: %d frames in %v over %s", later, n, time.Since(start), c.Transport())
		}
		// Why it is on TCP: never answered, or answered once and lost since.
		if want := map[bool]string{false: "tcp (udp: trying)", true: "tcp (udp: lost, retrying)"}[later]; c.Transport() != want {
			t.Fatalf("blocked later %v: transport %q, want %q", later, c.Transport(), want)
		}
		if later && worst > udpTimeoutMin+time.Second {
			t.Fatalf("frames stopped for %v", worst)
		}
		c.Close()
	}
}

// hostLog is a host's log lines, for a test to read while the host runs.
type hostLog struct {
	mu    sync.Mutex
	lines []string
}

func (l *hostLog) log(format string, a ...any) {
	l.mu.Lock()
	l.lines = append(l.lines, fmt.Sprintf(format, a...))
	l.mu.Unlock()
}

func (l *hostLog) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.lines...)
}

// count is how many lines so far hold s.
func (l *hostLog) count(s string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, ln := range l.lines {
		if strings.Contains(ln, s) {
			n++
		}
	}
	return n
}

func udpHostLog(t *testing.T) (*Server, *hostLog) {
	t.Helper()
	l := &hostLog{}
	s, err := Listen(ServerConfig{Addrs: []string{"127.0.0.1:0"}, Seed: 3, Version: "test", Host: "box", LocalLogin: "me", LocalName: "me", Log: l.log})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if s.udps[0] == nil {
		t.Skip("no UDP on the TCP port")
	}
	return s, l
}

// fakeConn stands in for a player's TCP connection where only its far end is asked.
type fakeConn struct {
	net.Conn
	remote net.Addr
}

func (c fakeConn) RemoteAddr() net.Addr { return c.remote }

// The host's UDP bookkeeping, datagram by datagram: a hello moves the binding to another port
// of the player's IP even while frames go over UDP, never to another IP or from another
// listener; the fallback waits for a few round trips; after it, once the answer to a hello since then is confirmed, by MsgUDPOK or an ack, they come back
// with a keyframe, and from the second fallback in a row the hellos go unanswered for a hold
// that grows with each.
func TestUDPBookkeeping(t *testing.T) {
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	var lines []string
	s := &Server{cfg: ServerConfig{Log: func(f string, a ...any) { lines = append(lines, fmt.Sprintf(f, a...)) }},
		udps: []*net.UDPConn{pc, pc}, byTok: map[uint64]*peer{}}
	p := &peer{name: "p", udpTok: 42, seqFrames: true, out: make(chan outMsg, 8),
		conn: fakeConn{remote: &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 5000}}}
	s.byTok[42] = p
	t0 := time.Now()
	hello := func(from string, sock int, at time.Time) {
		s.udpDatagram(udpIn{sock, netip.MustParseAddrPort(from), datagram{typ: dgHello, token: 42}}, at)
	}
	ack := func(from string, at time.Time) {
		s.udpDatagram(udpIn{0, netip.MustParseAddrPort(from), datagram{typ: dgAck, token: 42, newest: 1}}, at)
	}
	hello("127.0.0.1:1000", 0, t0)
	s.control(p, MsgUDPOK, t0)
	if !p.udpOn || p.udpAddr.String() != "127.0.0.1:1000" || p.needKey {
		t.Fatalf("first hello: on %v at %v, key %v", p.udpOn, p.udpAddr, p.needKey)
	}

	// Rebinding: the new port counts, the old one no longer does, a stranger never.
	hello("127.0.0.1:2000", 0, t0)
	hello("127.0.0.2:2000", 0, t0)
	hello("127.0.0.1:3000", 1, t0)
	if p.udpAddr.String() != "127.0.0.1:2000" {
		t.Fatalf("bound to %v after the rebind", p.udpAddr)
	}
	ack("127.0.0.1:1000", t0.Add(time.Second))
	if !p.udpAck.Equal(t0) {
		t.Fatal("an ack from the old port counted")
	}
	ack("127.0.0.1:2000", t0.Add(time.Second))
	if !p.udpAck.Equal(t0.Add(time.Second)) {
		t.Fatal("an ack from the new port did not count")
	}

	// The timeout goes with the round trip.
	t1 := p.udpAck
	p.srtt = time.Second
	s.checkUDP(p, t1.Add(3*time.Second))
	if !p.udpOn {
		t.Fatal("a path of 1 s round trips fell back after 3 s")
	}
	t2 := t1.Add(4*time.Second + time.Millisecond)
	s.checkUDP(p, t2)
	if p.udpOn || !p.needKey {
		t.Fatal("no fallback after four round trips")
	}

	// The first fallback holds nothing, but a confirmation from before it is stale: only the
	// answer to a hello since counts, by MsgUDPOK or by an ack datagram.
	p.needKey = false
	s.control(p, MsgUDPOK, t2)
	ack("127.0.0.1:2000", t2)
	if p.udpOn {
		t.Fatal("a confirmation from before the fallback put the frames on UDP")
	}
	hello("127.0.0.1:2000", 0, t2)
	ack("127.0.0.1:2000", t2.Add(time.Millisecond))
	if !p.udpOn || !p.needKey {
		t.Fatalf("after the answer: on %v, key %v", p.udpOn, p.needKey)
	}

	// The second fallback in a row holds: a hello goes unanswered and binds nothing.
	t3 := t2.Add(time.Second)
	s.udpFallback(p, t3, "test")
	if p.udpFalls != 2 || !p.udpHoldTo.Equal(t3.Add(udpHold(2))) {
		t.Fatalf("second fallback: %d in a row, held %v", p.udpFalls, p.udpHoldTo.Sub(t3))
	}
	p.needKey = false
	held := t3.Add(udpHold(2) / 2)
	hello("127.0.0.1:4000", 0, held)
	s.control(p, MsgUDPOK, held)
	if p.udpOn || p.udpAddr.String() != "127.0.0.1:2000" {
		t.Fatalf("held, yet on %v at %v", p.udpOn, p.udpAddr)
	}
	t4 := p.udpHoldTo
	hello("127.0.0.1:4000", 0, t4)
	s.control(p, MsgUDPOK, t4)
	if !p.udpOn || p.udpAddr.String() != "127.0.0.1:4000" || !p.needKey {
		t.Fatalf("after the hold: on %v at %v, key %v", p.udpOn, p.udpAddr, p.needKey)
	}

	// A fallback after a settled stretch starts the count again.
	s.udpFallback(p, t4.Add(udpSettled), "test")
	if p.udpFalls != 1 || !p.udpHoldTo.Equal(t4.Add(udpSettled)) {
		t.Fatalf("after a settled stretch: %d in a row", p.udpFalls)
	}
	if n := strings.Count(strings.Join(lines, "\n"), "moved"); n != 1 {
		t.Fatalf("%d moves logged: %q", n, lines)
	}
}

func TestUDPTimeoutAndHold(t *testing.T) {
	for _, c := range []struct{ srtt, want time.Duration }{
		{0, udpTimeoutMin}, {130 * time.Millisecond, udpTimeoutMin}, {time.Second, 4 * time.Second},
	} {
		if got := udpTimeout(c.srtt); got != c.want {
			t.Errorf("udpTimeout(%v) = %v, want %v", c.srtt, got, c.want)
		}
	}
	want := []time.Duration{0, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 10 * time.Second, 10 * time.Second}
	for i, w := range want {
		if got := udpHold(i + 1); got != w {
			t.Errorf("udpHold(%d) = %v, want %v", i+1, got, w)
		}
	}
}

// playUntil plays until ok holds or d is out, and says whether it held; worst is the longest
// wait for a frame.
func playUntil(t *testing.T, c *Client, r *Replica, d time.Duration, ok func() bool) (held bool, worst time.Duration) {
	t.Helper()
	last := time.Now()
	play(t, c, r, d, func() bool {
		now := time.Now()
		worst, last = max(worst, now.Sub(last)), now
		held = ok()
		return held
	})
	return held, worst
}

// UDP that drops out comes back: twice the relay drops everything for longer than the
// timeout, frames go over TCP with the reason shown, and once it passes again they come back
// over UDP, the replica applying every frame in order throughout.
func TestUDPRecoversAfterFallback(t *testing.T) {
	t.Parallel()
	s, l := udpHostLog(t)
	rl := newRelay(t, s.udps[0].LocalAddr().String())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	c, wel, err := Dial(ctx, s.Addrs()[0], Hello{Name: "tester", Version: "test", UDP: true, UDPVia: rl.addr()})
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	r := NewReplica(wel.W, wel.H, wel.Terrain, wel.You, wel.Seed)
	onUDP := func() bool { return c.Transport() == "udp" && r.Synced }
	if ok, _ := playUntil(t, c, r, 3*time.Second, onUDP); !ok {
		t.Fatal("frames never came over UDP")
	}
	for round := 1; round <= 2; round++ {
		rl.block.Store(true)
		lost := func() bool { return c.Transport() == "tcp (udp: lost, retrying)" }
		// Generous: on a loaded machine the round trip the fallback waits on runs long.
		if ok, worst := playUntil(t, c, r, 8*time.Second, lost); !ok {
			t.Fatalf("round %d: still %q while blocked", round, c.Transport())
		} else if worst > udpTimeoutMin+500*time.Millisecond {
			t.Fatalf("round %d: frames stopped for %v going to TCP", round, worst)
		}
		if n := l.count("over TCP again"); n != round {
			t.Fatalf("round %d: %d fallbacks logged", round, n)
		}
		rl.block.Store(false)
		start := time.Now()
		ok, worst := playUntil(t, c, r, udpHold(round)+3*time.Second, onUDP)
		if !ok {
			t.Fatalf("round %d: still %q %v after the path came back; host: %q", round, c.Transport(), time.Since(start), l.all())
		}
		if worst > 500*time.Millisecond {
			t.Fatalf("round %d: frames stopped for %v going back to UDP", round, worst)
		}
		if n := l.count("gets frames over UDP"); n != round+1 {
			t.Fatalf("round %d: %d switches to UDP logged", round, n)
		}
		t.Logf("round %d: back on UDP %v after the path came back", round, time.Since(start).Round(time.Millisecond))
	}
}

// natRelay forwards datagrams between a client and a host through an upstream socket that can
// be swapped for one on another port, as a NAT that rebinds the client's mapping does.
type natRelay struct {
	pc     *net.UDPConn
	host   *net.UDPAddr
	client atomic.Pointer[netip.AddrPort]
	up     atomic.Pointer[net.UDPConn]
}

func newNATRelay(t *testing.T, host string) *natRelay {
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	ha, _ := net.ResolveUDPAddr("udp", host)
	r := &natRelay{pc: pc, host: ha}
	r.rebind(t)
	t.Cleanup(func() {
		pc.Close()
		r.up.Load().Close()
	})
	go func() {
		buf := make([]byte, 2048)
		for {
			n, from, err := pc.ReadFromUDPAddrPort(buf)
			if err != nil {
				return
			}
			r.client.Store(&from)
			_, _ = r.up.Load().Write(buf[:n])
		}
	}()
	return r
}

// rebind moves the upstream to a new port; what the host sends the old one is lost.
func (r *natRelay) rebind(t *testing.T) {
	up, err := net.DialUDP("udp", nil, r.host)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		buf := make([]byte, 2048)
		for {
			n, err := up.Read(buf)
			if err != nil {
				if isClosed(err) {
					return
				}
				continue
			}
			if c := r.client.Load(); c != nil {
				_, _ = r.pc.WriteToUDPAddrPort(buf[:n], *c)
			}
		}
	}()
	if old := r.up.Swap(up); old != nil {
		old.Close()
	}
}

// A NAT that gives the client's mapping a new port mid-game costs a moment, not the UDP path:
// the client's hello from the new port moves the host's binding before the timeout.
func TestUDPFollowsANewPort(t *testing.T) {
	t.Parallel()
	s, l := udpHostLog(t)
	rl := newNATRelay(t, s.udps[0].LocalAddr().String())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	c, wel, err := Dial(ctx, s.Addrs()[0], Hello{Name: "tester", Version: "test", UDP: true, UDPVia: rl.pc.LocalAddr().String()})
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	r := NewReplica(wel.W, wel.H, wel.Terrain, wel.You, wel.Seed)
	onUDP := func() bool { return c.Transport() == "udp" && r.Synced }
	if ok, _ := playUntil(t, c, r, 3*time.Second, onUDP); !ok {
		t.Fatal("frames never came over UDP")
	}
	for range 2 {
		rl.rebind(t)
		moved := l.count("moved")
		ok, worst := playUntil(t, c, r, 3*time.Second, func() bool { return l.count("moved") > moved })
		if !ok {
			t.Fatal("the host never followed the new port")
		}
		if worst >= udpTimeoutMin {
			t.Fatalf("frames stopped for %v", worst)
		}
		// Frames keep coming as datagrams for a while after it.
		playUntil(t, c, r, time.Second, func() bool { return false })
		if c.Transport() != "udp" {
			t.Fatalf("on %q after the move", c.Transport())
		}
	}
	if n := l.count("over TCP again"); n != 0 {
		t.Fatalf("%d fallbacks for a new port", n)
	}
}
