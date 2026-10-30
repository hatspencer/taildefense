package netsim

import (
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

// echoServer answers every TCP connection with what it reads.
func echoServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return ln.Addr().String()
}

func proxy(t *testing.T, target string, up, down Profile) net.Conn {
	t.Helper()
	p, err := Listen(target, up, down, 1)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	c, err := net.Dial("tcp", p.Addr())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func roundTrip(t *testing.T, c net.Conn) time.Duration {
	t.Helper()
	start := time.Now()
	if _, err := c.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(c, make([]byte, 1)); err != nil {
		t.Fatal(err)
	}
	return time.Since(start)
}

func TestDelay(t *testing.T) {
	c := proxy(t, echoServer(t), Profile{Delay: 30 * time.Millisecond}, Profile{Delay: 20 * time.Millisecond})
	for range 5 {
		// Both directions' delays add up; the slack is for a busy machine's scheduler.
		if rt := roundTrip(t, c); rt < 50*time.Millisecond || rt > 90*time.Millisecond {
			t.Fatalf("round trip %v, want about 50ms", rt)
		}
	}
}

func TestJitterKeepsOrder(t *testing.T) {
	jit := Profile{Delay: 5 * time.Millisecond, Jitter: 20 * time.Millisecond}
	c := proxy(t, echoServer(t), jit, jit)
	const n = 400
	go func() {
		for i := range uint32(n) {
			_, _ = c.Write(binary.BigEndian.AppendUint32(nil, i))
			// Spaced, so each write is a read of its own and gets its own jitter.
			time.Sleep(200 * time.Microsecond)
		}
	}()
	b := make([]byte, 4)
	for i := range uint32(n) {
		if _, err := io.ReadFull(c, b); err != nil {
			t.Fatal(err)
		}
		if got := binary.BigEndian.Uint32(b); got != i {
			t.Fatalf("read %d where %d was due: jitter reordered the stream", got, i)
		}
	}
}

func TestBandwidth(t *testing.T) {
	c := proxy(t, echoServer(t), Profile{}, Profile{Bandwidth: 200 << 10})
	const size = 100 << 10
	start := time.Now()
	go func() { _, _ = c.Write(make([]byte, size)) }()
	if _, err := io.ReadFull(c, make([]byte, size)); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d < 400*time.Millisecond || d > 900*time.Millisecond {
		t.Fatalf("100 KiB at 200 KiB/s took %v, want about 500ms", d)
	}
}

func TestLossStallsForRTO(t *testing.T) {
	c := proxy(t, echoServer(t), Profile{Loss: 1}, Profile{})
	if rt := roundTrip(t, c); rt < minRTO || rt > minRTO+80*time.Millisecond {
		t.Fatalf("a lost segment came through in %v, want one RTO of %v", rt, minRTO)
	}
}

func TestRTO(t *testing.T) {
	if got := (Profile{Delay: 10 * time.Millisecond}).RTO(); got != minRTO {
		t.Errorf("short path RTO %v, want the floor %v", got, minRTO)
	}
	if got := (Profile{Delay: 120 * time.Millisecond, Jitter: 30 * time.Millisecond}).RTO(); got != 360*time.Millisecond {
		t.Errorf("long path RTO %v, want 360ms", got)
	}
}

func TestProxyClose(t *testing.T) {
	p, err := Listen(echoServer(t), Profile{Delay: time.Hour}, Profile{}, 1)
	if err != nil {
		t.Fatal(err)
	}
	c, err := net.Dial("tcp", p.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = c.Write([]byte("held for an hour"))
	time.Sleep(20 * time.Millisecond)
	done := make(chan struct{})
	go func() { p.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close waited on a chunk in flight")
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("the client's connection outlived the proxy")
	}
	if _, err := net.Dial("tcp", p.Addr()); err == nil {
		t.Fatal("a closed proxy still accepts")
	}
}

// udpSink counts the sequence numbers that reach it, in order of arrival.
func udpSink(t *testing.T) (string, <-chan uint32) {
	t.Helper()
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	_ = pc.SetReadBuffer(4 << 20)
	got := make(chan uint32, 1<<16)
	go func() {
		b := make([]byte, 64)
		for {
			n, _, err := pc.ReadFromUDP(b)
			if err != nil {
				close(got)
				return
			}
			if n == 4 {
				got <- binary.BigEndian.Uint32(b)
			}
		}
	}()
	return pc.LocalAddr().String(), got
}

// sendUDP sends n numbered datagrams through a fresh proxy and returns the numbers that
// arrived, in arrival order, once the path has gone quiet.
func sendUDP(t *testing.T, up Profile, seed uint64, n int, gap time.Duration) []uint32 {
	t.Helper()
	target, got := udpSink(t)
	p, err := ListenUDP(target, up, Profile{}, seed)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	c, err := net.Dial("udp", p.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for i := range uint32(n) {
		_, _ = c.Write(binary.BigEndian.AppendUint32(nil, i))
		if gap > 0 {
			time.Sleep(gap)
		} else if i%50 == 49 {
			// A breath now and then, so no socket buffer overflows and drops on its own.
			time.Sleep(time.Millisecond)
		}
	}
	var out []uint32
	for {
		select {
		case v := <-got:
			out = append(out, v)
		case <-time.After(up.Delay + up.Jitter + 200*time.Millisecond):
			return out
		}
	}
}

func TestUDPLoss(t *testing.T) {
	const n = 2000
	a := sendUDP(t, Profile{Loss: 0.3}, 7, n, 0)
	if rate := 1 - float64(len(a))/n; rate < 0.25 || rate > 0.35 {
		t.Fatalf("lost %.1f%% of datagrams, want about 30%%", 100*rate)
	}
	b := sendUDP(t, Profile{Loss: 0.3}, 7, n, 0)
	if len(a) != len(b) {
		t.Fatalf("the same seed lost %d then %d", n-len(a), n-len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("the same seed lost different datagrams: %d then %d at %d", a[i], b[i], i)
		}
	}
}

func TestUDPDelay(t *testing.T) {
	target, got := udpSink(t)
	p, err := ListenUDP(target, Profile{Delay: 40 * time.Millisecond}, Profile{}, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	c, err := net.Dial("udp", p.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	start := time.Now()
	_, _ = c.Write([]byte{0, 0, 0, 9})
	select {
	case <-got:
		if d := time.Since(start); d < 40*time.Millisecond || d > 80*time.Millisecond {
			t.Fatalf("a datagram took %v, want about 40ms", d)
		}
	case <-time.After(time.Second):
		t.Fatal("the datagram never arrived")
	}
}

func TestUDPReorder(t *testing.T) {
	jit := Profile{Delay: 10 * time.Millisecond, Jitter: 10 * time.Millisecond}
	if out := outOfOrder(sendUDP(t, jit, 3, 300, 500*time.Microsecond)); out != 0 {
		t.Errorf("%d datagrams overtaken without Reorder", out)
	}
	jit.Reorder = true
	if out := outOfOrder(sendUDP(t, jit, 3, 300, 500*time.Microsecond)); out == 0 {
		t.Error("no datagram overtaken with Reorder and jitter 40 times the gap")
	}
}

func outOfOrder(v []uint32) int {
	n := 0
	for i := 1; i < len(v); i++ {
		if v[i] < v[i-1] {
			n++
		}
	}
	return n
}

func TestUDPReplies(t *testing.T) {
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	go func() {
		b := make([]byte, 64)
		for {
			n, from, err := pc.ReadFromUDP(b)
			if err != nil {
				return
			}
			_, _ = pc.WriteToUDP(b[:n], from)
		}
	}()
	p, err := ListenUDP(pc.LocalAddr().String(), Profile{Delay: 10 * time.Millisecond}, Profile{Delay: 10 * time.Millisecond}, 1)
	if err != nil {
		t.Fatal(err)
	}
	c, err := net.Dial("udp", p.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	start := time.Now()
	_, _ = c.Write([]byte("ping"))
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	b := make([]byte, 8)
	n, err := c.Read(b)
	if err != nil || string(b[:n]) != "ping" {
		t.Fatalf("reply %q %v", b[:n], err)
	}
	if d := time.Since(start); d < 20*time.Millisecond {
		t.Errorf("reply in %v, want both delays, 20ms", d)
	}
	done := make(chan struct{})
	go func() { p.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("UDPProxy.Close hung")
	}
}
