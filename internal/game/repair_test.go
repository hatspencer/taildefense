package game

import "testing"

func TestRepairChargesByTheHitPoint(t *testing.T) {
	w := New(5)
	w.PhaseLeft = 1e6
	p, _ := w.Join("ana", "ana@example")
	s := &w.Structs[w.Core]
	p.X, p.Y = s.CX(), s.CY()+float32(s.H)/2+1
	// As good as full, the way the survivors see it: nothing to mend.
	s.HP = s.MaxHP - .3
	if w.OrderRepair(p, w.Core) == nil {
		t.Fatal("a full generator taken in for repair")
	}
	// 50 hp at .1 gold each costs 5 gold.
	s.HP, p.Gold = s.MaxHP-50, 1000
	if err := w.OrderRepair(p, w.Core); err != nil {
		t.Fatal(err)
	}
	run(w, TickRate*10, func() bool { return p.Order.Kind != OrderRepair })
	if !s.mended() || p.Order.Kind == OrderRepair {
		t.Fatalf("not mended: %.1f of %.0f", s.HP, s.MaxHP)
	}
	if spent := 1000 - p.Gold; spent < 4 || spent > 5 {
		t.Fatalf("50 hp cost %d gold", spent)
	}
	// Chipped every tick while being mended, it costs what the chips add up to, not a coin a
	// tick: half a hit point a tick for five seconds is 50 hp, so 5 gold.
	s.HP, p.Gold = s.MaxHP-1, 1000
	if err := w.OrderRepair(p, w.Core); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < TickRate*5; i++ {
		s.HP -= .5
		w.Step()
	}
	if spent := 1000 - p.Gold; spent > 7 {
		t.Fatalf("chip damage drained %d gold", spent)
	}
}
