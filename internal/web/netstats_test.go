package web

import (
	"testing"
	"time"

	"taildefense/internal/netplay"
)

// The relay's seqs run on across the wrap, an ack covers every command up to it, timed from
// when each went out, and names the page's seq of the newest of them that had one.
func TestAnAckMapsBackToThePagesSeq(t *testing.T) {
	l := newCmdLog()
	l.next, l.acked = 65534, 65533
	t0 := time.Unix(1000, 0)
	p7, p9 := 7.0, 9.0
	var cs [4]netplay.Cmd
	l.sent(&cs[0], &p7, t0)
	l.sent(&cs[1], nil, t0.Add(10*time.Millisecond))
	l.sent(&cs[2], &p9, t0.Add(20*time.Millisecond))
	l.sent(&cs[3], nil, t0.Add(30*time.Millisecond))
	if cs[0].Seq != 65534 || cs[1].Seq != 65535 || cs[2].Seq != 0 || cs[3].Seq != 1 {
		t.Fatalf("seqs %d %d %d %d", cs[0].Seq, cs[1].Seq, cs[2].Seq, cs[3].Seq)
	}
	r := l.ack(0, t0.Add(60*time.Millisecond))
	if len(r.ms) != 3 || r.ms[0] != 60 || r.ms[2] != 40 || r.page == nil || *r.page != 9 {
		t.Fatalf("ack 0: %+v", r)
	}
	// The same ack again covers nothing new.
	if r := l.ack(0, t0.Add(70*time.Millisecond)); len(r.ms) != 0 || r.page != nil {
		t.Fatalf("ack 0 again: %+v", r)
	}
	r = l.ack(1, t0.Add(80*time.Millisecond))
	if len(r.ms) != 1 || r.ms[0] != 50 || r.page != nil {
		t.Fatalf("ack 1: %+v", r)
	}
}

func TestNetStatsMessage(t *testing.T) {
	n := newNetStats()
	t0 := time.Unix(1000, 0)
	m := n.msg(t0)
	if _, ok := m["arrv"]; ok {
		t.Fatalf("arrivals with no frames: %v", m)
	}
	for _, gap := range []int{0, 50, 50, 50, 140} {
		t0 = t0.Add(time.Duration(gap) * time.Millisecond)
		n.frame(t0)
	}
	for range 3 {
		n.echo()
	}
	n.echoed(1, 30*time.Millisecond, t0)
	n.echoed(3, 40*time.Millisecond, t0) // 2 never came back
	m = n.msg(t0)
	a := m["arrv"].(map[string]any)
	hist := a["hist"].([]int)
	if a["p50"] != 50.0 || a["max"] != 140.0 || hist[5] != 3 || hist[7] != 1 {
		t.Fatalf("arrivals %v", a)
	}
	if m["lost"] != uint32(1) || m["rttP99"] != 40.0 {
		t.Fatalf("echoes: lost %v rtt p99 %v", m["lost"], m["rttP99"])
	}
}

// A page that falls behind loses the oldest frames waiting, not the newest.
func TestOfferKeepsTheNewestFrames(t *testing.T) {
	out := make(chan []byte, 4)
	dropped := 0
	for i := byte(0); i < 7; i++ {
		if !offer(out, []byte{i}) {
			dropped++
		}
	}
	if dropped != 3 {
		t.Fatalf("dropped %d frames of 7 into a queue of 4, want 3", dropped)
	}
	for want := byte(3); want < 7; want++ {
		if got := <-out; got[0] != want {
			t.Fatalf("queued frame %d, want %d", got[0], want)
		}
	}
}
