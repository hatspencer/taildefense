package game

import (
	"math"
	"testing"
)

// A wreck is solid: walking straight at it stops at its side, and a search ordered from off
// its end walks round to it and gets done.
func TestWrecksAreSolidButSearchable(t *testing.T) {
	w := newBare(3)
	p, _ := w.Join("ana", "ana@example")
	tried := 0
	for si := range w.Sites {
		s := &w.Sites[si]
		if !s.Kind.Wreck() || s.Guard > 0 {
			continue
		}
		hl, _ := wreckHalf(s.Kind)
		c, sn := float32(math.Cos(float64(s.Yaw))), float32(math.Sin(float64(s.Yaw)))
		// Across its middle, from one side to the other.
		ax, ay := s.SX+sn*2, s.SY-c*2
		if !CanStand(w, ax, ay) || !CanStand(w, s.SX-sn*2, s.SY+c*2) {
			continue
		}
		// And somewhere to stand off its end.
		ex, ey := s.SX+c*(hl+1.5), s.SY+sn*(hl+1.5)
		if !CanStand(w, ex, ey) {
			continue
		}
		tried++
		p.X, p.Y = ax, ay
		ang := float32(math.Atan2(float64(c), float64(-sn)))
		for i := 0; i < TickRate*2; i++ {
			w.Steer(p, ang, true)
			w.Step()
			if wreckDist(s, p.X, p.Y) < PlayerRadius-.01 {
				t.Fatalf("site %d (%s): walked into it, %.2f from its box", si, SiteDefs[s.Kind].Name, wreckDist(s, p.X, p.Y))
			}
		}
		w.Steer(p, 0, false)

		p.X, p.Y = ex, ey
		if err := w.OrderLoot(p, si); err != nil {
			t.Fatal(err)
		}
		if !run(w, TickRate*12, func() bool { return s.Searched }) {
			t.Fatalf("site %d (%s): never searched from its end; at %.1f,%.1f, %.2f from it, order %v",
				si, SiteDefs[s.Kind].Name, p.X, p.Y, wreckDist(s, p.X, p.Y), p.Order.Kind)
		}
		if tried == 3 {
			return
		}
	}
	if tried == 0 {
		t.Fatal("no wreck with room round it")
	}
}
