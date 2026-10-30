// Package netsim impairs a network path between a td host and its players: delay, jitter,
// loss and a bandwidth cap, each direction on its own. It works as a proxy in front of the
// host, so the netcode is measured as it ships, with no hooks in the game.
package netsim

import (
	"math/rand/v2"
	"time"
)

// Profile is what one direction of a path does to the traffic on it.
type Profile struct {
	// Delay is added to everything; Jitter spreads it uniformly over Delay±Jitter.
	Delay, Jitter time.Duration
	// Loss is the chance a packet is lost, 0 to 1. Over TCP nothing is dropped: a lost
	// segment holds the direction for a retransmit timeout, as a real one would.
	Loss float64
	// Bandwidth caps the direction in bytes a second; 0 is unlimited.
	Bandwidth int
	// Reorder lets jitter overtake: a datagram may arrive before one sent earlier. Only
	// UDP honours it, a stream never reorders.
	Reorder bool
	// Burst, when set, makes the losses come in bursts, as on a radio link; see Burst.
	Burst *Burst
	// Outages are spans of wall time in which nothing gets through at all, as when a phone's
	// hotspot drops off the mast. A datagram sent in one is lost; a TCP segment is resent on
	// the retransmit timer, doubling, and arrives with the first resend after the outage.
	Outages []Outage
}

// Burst is a two state loss model (Gilbert-Elliott): in the good state a packet is lost with
// the Profile's Loss, in the bad state with Loss here, and before each packet the state moves
// from good to bad with Enter and from bad to good with Leave. A burst lasts 1/Leave packets
// on average, and the bad state holds Enter/(Enter+Leave) of them.
type Burst struct {
	Enter, Leave, Loss float64
}

// Outage is a span of wall time with no link.
type Outage struct {
	From, To time.Time
}

// segment is the payload of one TCP segment on a path with a common MTU, used to turn a read
// of many kilobytes into the number of segments a loss could hit.
const segment = 1448

// minRTO is Linux's floor for the retransmit timeout.
const minRTO = 200 * time.Millisecond

// RTO is how long a lost TCP segment holds its direction: the kernel's SRTT+4*RTTVAR with
// the round trip taken as twice this direction's delay, as if the path were symmetric.
func (p Profile) RTO() time.Duration {
	return max(minRTO, 2*p.Delay+4*p.Jitter)
}

// shaper decides when each chunk or datagram of one direction is delivered. It is used from
// that direction's reading goroutine only, so it needs no lock.
type shaper struct {
	p        Profile
	rng      *rand.Rand
	linkFree time.Time // when the capped link has sent everything before
	last     time.Time // the latest release so far, which an ordered direction never undercuts
	bad      bool      // in Burst's bad state
}

// lose decides whether the next packet is lost, moving Burst's state first.
func (s *shaper) lose() bool {
	loss := s.p.Loss
	if b := s.p.Burst; b != nil {
		if s.bad {
			s.bad = s.rng.Float64() >= b.Leave
		} else {
			s.bad = s.rng.Float64() < b.Enter
		}
		if s.bad {
			loss = b.Loss
		}
	}
	return loss > 0 && s.rng.Float64() < loss
}

// out is the outage t falls in, if any.
func (s *shaper) out(t time.Time) (Outage, bool) {
	for _, o := range s.p.Outages {
		if !t.Before(o.From) && t.Before(o.To) {
			return o, true
		}
	}
	return Outage{}, false
}

func newShaper(p Profile, seed uint64, stream uint64) *shaper {
	return &shaper{p: p, rng: rand.New(rand.NewPCG(seed, stream))}
}

// stream schedules n bytes read from a TCP connection at now. Release times only grow, so
// jitter never reorders bytes, and a loss stalls everything behind it, as head of line
// blocking does.
func (s *shaper) stream(now time.Time, n int) time.Time {
	at := s.send(now, n)
	segs := (n + segment - 1) / segment
	for range segs {
		if s.lose() {
			// In a burst the resend may be lost too, each time after twice the wait, as the
			// kernel backs off, so a burst costs a stall of its own length and then some.
			// Losses on their own cost one timeout each, as the Profile says.
			rto := s.p.RTO()
			at = at.Add(rto)
			for k := 0; k < 6 && s.p.Burst != nil && s.lose(); k++ {
				rto *= 2
				at = at.Add(rto)
			}
			break
		}
	}
	if o, ok := s.out(now); ok {
		for rto, t := s.p.RTO(), at; ; rto *= 2 {
			if t = t.Add(rto); !t.Before(o.To) {
				at = t
				break
			}
		}
	}
	at = later(at, s.last)
	s.last = at
	return at
}

// datagram schedules one datagram of n bytes, or drops it.
func (s *shaper) datagram(now time.Time, n int) (time.Time, bool) {
	if _, out := s.out(now); s.lose() || out {
		return time.Time{}, false
	}
	at := s.send(now, n)
	if !s.p.Reorder {
		at = later(at, s.last)
	}
	s.last = later(at, s.last)
	return at, true
}

// send puts n bytes on the link behind those before them and returns when they come out the
// far end, before any loss.
func (s *shaper) send(now time.Time, n int) time.Time {
	out := now
	if s.p.Bandwidth > 0 {
		start := later(now, s.linkFree)
		s.linkFree = start.Add(time.Duration(float64(n) / float64(s.p.Bandwidth) * float64(time.Second)))
		out = s.linkFree
	}
	d := s.p.Delay
	if s.p.Jitter > 0 {
		d += time.Duration(s.rng.Int64N(int64(2*s.p.Jitter)+1)) - s.p.Jitter
	}
	return out.Add(max(d, 0))
}

func later(a, b time.Time) time.Time {
	if a.Before(b) {
		return b
	}
	return a
}

// sleepUntil waits for t, or returns false early when done closes.
func sleepUntil(t time.Time, done <-chan struct{}) bool {
	d := time.Until(t)
	if d <= 0 {
		return true
	}
	tm := time.NewTimer(d)
	defer tm.Stop()
	select {
	case <-tm.C:
		return true
	case <-done:
		return false
	}
}
