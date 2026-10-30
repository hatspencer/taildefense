package web

import (
	"math"
	"time"

	"taildefense/internal/netplay"
)

// cmdLog remembers the commands relayed to the host lately, by wire seq, so an ack can be
// timed and named in the page's own seq. Older entries are overwritten: a command not
// acked within cmdLogSize more is past timing anyway.
type cmdLog struct {
	next  uint16 // the seq the next command goes out with
	acked uint16 // the last seq acked
	ring  [cmdLogSize]sentCmd
}

const cmdLogSize = 128

type sentCmd struct {
	seq  uint16
	at   time.Time
	op   uint8
	page *float64 // the page's seq for it, when it gave one
	live bool     // sent and not yet acked
}

func newCmdLog() *cmdLog { return &cmdLog{next: 1} }

// sent stamps a command about to go to the host and remembers it.
func (l *cmdLog) sent(c *netplay.Cmd, page *float64, now time.Time) {
	c.Seq = l.next
	l.ring[l.next%cmdLogSize] = sentCmd{seq: l.next, at: now, op: c.Op, page: page, live: true}
	l.next++
}

// ackResult is what an ack meant: the time from sending the acked command to its ack, ms,
// for every command it newly covers (the acked one last), and the page's seq of the newest
// of them that had one.
type ackResult struct {
	ms   []float64
	page *float64
}

// ack takes the host's ack of everything up to seq.
func (l *cmdLog) ack(seq uint16, now time.Time) ackResult {
	var r ackResult
	// Acks are cumulative; walk the seqs newly covered, at most the ring's worth.
	n := min(int(seq-l.acked), cmdLogSize)
	for i := n - 1; i >= 0; i-- {
		s := seq - uint16(i)
		e := &l.ring[s%cmdLogSize]
		if !e.live || e.seq != s {
			continue
		}
		e.live = false
		r.ms = append(r.ms, float64(now.Sub(e.at))/float64(time.Millisecond))
		if e.page != nil {
			r.page = e.page
		}
	}
	l.acked = seq
	return r
}

// netStats is what the relay measures of its link to the host and to the page, for the
// page's F3 readout.
type netStats struct {
	lastFrame time.Time
	arrive    netplay.Window // ms between frames from the host
	rtt       netplay.Window // echo round trips, ms
	ackMs     netplay.Window // command to ack, ms
	// Echoes carry a count: one returning with count k means every echo before it that
	// has not come back never will (the stream is ordered), so they are lost.
	echoSent, echoBack, echoTop uint32
	pageDrop                    uint32 // frames the page was too slow for
	host                        *netplay.Stats
	via                         string // how frames come from the host: "udp" or "tcp"
}

func newNetStats() *netStats {
	return &netStats{arrive: netplay.Window{Span: 10 * time.Second}, rtt: netplay.Window{Span: time.Minute},
		ackMs: netplay.Window{Span: 10 * time.Second}}
}

// arrivalBuckets are the lower bounds of the frame inter-arrival histogram, ms.
var arrivalBuckets = [...]float64{0, 5, 10, 20, 35, 50, 75, 100, 150, 250}

func (n *netStats) frame(now time.Time) {
	if !n.lastFrame.IsZero() {
		n.arrive.Add(now, float64(now.Sub(n.lastFrame))/float64(time.Millisecond))
	}
	n.lastFrame = now
}

// echo counts an echo going out and gives its count.
func (n *netStats) echo() uint32 {
	n.echoSent++
	return n.echoSent
}

// echoed takes a returned echo with count k.
func (n *netStats) echoed(k uint32, rtt time.Duration, now time.Time) {
	n.echoBack++
	n.echoTop = max(n.echoTop, k)
	n.rtt.Add(now, float64(rtt)/float64(time.Millisecond))
}

// msg is the page's netstats message.
func (n *netStats) msg(now time.Time) map[string]any {
	r1 := func(v float64) float64 { return math.Round(v*10) / 10 }
	m := map[string]any{"t": "netstats", "pageDrop": n.pageDrop}
	// Echoes are counted from 1, so the top count is how many of them went out before it.
	m["lost"] = n.echoTop - min(n.echoBack, n.echoTop)
	if q, ok := n.rtt.Quantiles(now, 0.99); ok {
		m["rttP99"] = r1(q[0])
	}
	if q, ok := n.arrive.Quantiles(now, 0.5, 0.99, 1); ok {
		hist := make([]int, len(arrivalBuckets))
		for _, v := range n.arrive.Values(now) {
			b := len(arrivalBuckets) - 1
			for b > 0 && v < arrivalBuckets[b] {
				b--
			}
			hist[b]++
		}
		m["arrv"] = map[string]any{"p50": r1(q[0]), "p99": r1(q[1]), "max": r1(q[2]), "hist": hist}
	}
	if n.via != "" {
		m["via"] = n.via
	}
	if q, ok := n.ackMs.Quantiles(now, 0.5, 0.99); ok {
		m["ack"] = map[string]any{"p50": r1(q[0]), "p99": r1(q[1])}
	}
	if h := n.host; h != nil {
		ms := func(t uint16) float64 { return float64(t) / 10 }
		m["host"] = map[string]any{"drop": h.Dropped, "resync": h.Resyncs, "q": h.QMax, "qCap": h.QCap,
			"tickP50": ms(h.TickP50), "tickP99": ms(h.TickP99), "tickMax": ms(h.TickMax)}
	}
	return m
}
