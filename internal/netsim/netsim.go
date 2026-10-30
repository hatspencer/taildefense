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
}

func newShaper(p Profile, seed uint64, stream uint64) *shaper {
	return &shaper{p: p, rng: rand.New(rand.NewPCG(seed, stream))}
}

// stream schedules n bytes read from a TCP connection at now. Release times only grow, so
// jitter never reorders bytes, and a loss stalls everything behind it, as head of line
// blocking does.
func (s *shaper) stream(now time.Time, n int) time.Time {
	at := s.send(now, n)
	if s.p.Loss > 0 {
		segs := (n + segment - 1) / segment
		for range segs {
			if s.rng.Float64() < s.p.Loss {
				at = at.Add(s.p.RTO())
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
	if s.p.Loss > 0 && s.rng.Float64() < s.p.Loss {
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
