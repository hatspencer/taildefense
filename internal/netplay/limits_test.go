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
