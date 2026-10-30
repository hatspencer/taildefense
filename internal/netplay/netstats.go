package netplay

import (
	"math"
	"slices"
	"time"
)

// Ack is the host saying it applied a player's commands up to Seq, and that their effect is
// in the frame of Tick, which it queued just before the ack.
type Ack struct {
	Seq  uint16
	Tick uint32
}

func (a Ack) encode() []byte {
	var b enc
	b.u16(a.Seq)
	b.u32(a.Tick)
	return b.b
}

// DecodeAck reads a MsgAck payload.
func DecodeAck(p []byte) (Ack, error) {
	d := &dec{b: p}
	a := Ack{Seq: d.u16(), Tick: d.u32()}
	return a, d.err
}

// Stats is how the host's link to one player is doing, sent to that player every 2 s.
// Durations are in tenths of a millisecond.
type Stats struct {
	Dropped uint32 // frames not queued since joining because the player's queue was full
	Resyncs uint32 // keyframes sent to catch up after a drop
	QMax    uint8  // the deepest the player's out queue got since the last stats
	QCap    uint8  // how deep it can get
	// The time between the host's ticks over the last 10 s: one tick (33 ms) when it keeps up.
	TickP50, TickP99, TickMax uint16
}

func (s Stats) encode() []byte {
	var b enc
	b.u32(s.Dropped)
	b.u32(s.Resyncs)
	b.u8(s.QMax)
	b.u8(s.QCap)
	b.u16(s.TickP50)
	b.u16(s.TickP99)
	b.u16(s.TickMax)
	return b.b
}

// DecodeStats reads a MsgStats payload.
func DecodeStats(p []byte) (Stats, error) {
	d := &dec{b: p}
	s := Stats{Dropped: d.u32(), Resyncs: d.u32(), QMax: d.u8(), QCap: d.u8(), TickP50: d.u16(), TickP99: d.u16(), TickMax: d.u16()}
	return s, d.err
}

// Window keeps timed samples for a while and answers percentiles over them. It is for
// readouts every few seconds: a quantile sorts a copy, which is cheap at a few hundred.
type Window struct {
	Span time.Duration
	at   []time.Time
	v    []float64
}

// Add records v at now and forgets what fell out of the span.
func (w *Window) Add(now time.Time, v float64) {
	w.at = append(w.at, now)
	w.v = append(w.v, v)
	w.trim(now)
}

func (w *Window) trim(now time.Time) {
	i := 0
	for i < len(w.at) && now.Sub(w.at[i]) > w.Span {
		i++
	}
	if i > 0 {
		w.at = append(w.at[:0], w.at[i:]...)
		w.v = append(w.v[:0], w.v[i:]...)
	}
}

// Values are the samples still in the span at now.
func (w *Window) Values(now time.Time) []float64 {
	w.trim(now)
	return w.v
}

// Quantiles gives the q-th of the samples in the span for each q, nearest rank; ok is false
// with no samples.
func (w *Window) Quantiles(now time.Time, qs ...float64) (out []float64, ok bool) {
	v := slices.Clone(w.Values(now))
	out = make([]float64, len(qs))
	if len(v) == 0 {
		return out, false
	}
	slices.Sort(v)
	for i, q := range qs {
		k := int(math.Ceil(q*float64(len(v)))) - 1
		out[i] = v[min(max(k, 0), len(v)-1)]
	}
	return out, true
}
