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
	// tick: 15 hit points a second (more than half a point a tick, or it counts as whole) for
	// five seconds is 75 hp, so 7.5 gold.
	s.HP, p.Gold = s.MaxHP-1, 1000
	if err := w.OrderRepair(p, w.Core); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < TickRate*5; i++ {
		s.HP -= 15.1 * Dt
		w.Step()
	}
	if spent := 1000 - p.Gold; spent > 10 {
		t.Fatalf("chip damage drained %d gold", spent)
	}
}

// Mending a structure always costs less than selling it and building it again, at any health:
// the repair rate is capped where the flat rate would make a cheap wall better rebuilt.
func TestRepairBeatsSellingAndRebuilding(t *testing.T) {
	for _, k := range Buildable {
		for lv := uint8(1); lv <= MaxStructLevel; lv++ {
			s := Structure{Kind: k, Level: lv, MaxHP: Structs[k].HP}
			if Structs[k].Turret {
				s.Lv[0] = lv - 1
			}
			s.MaxHP += Structs[k].HP * StructGrowth(k) * float32(lv-1)
			for f := float32(0); f < 1; f += .05 {
				s.HP = s.MaxHP * f
				repair := (s.MaxHP - s.HP) * RepairRate(&s)
				if rebuild := float32(Spent(&s) - SellValue(&s)); repair > rebuild {
					t.Fatalf("%s level %d at %.0f%%: repair %.1f, sell and rebuild %.1f", Structs[k].Name, lv, f*100, repair, rebuild)
				}
			}
		}
	}
}

// Standing right by the generator slowly heals a survivor, mid-wave too; a few steps off, not.
func TestTheGeneratorHealsWhoStandsByIt(t *testing.T) {
	w := newBare(4)
	w.Phase = PhaseWave
	w.Queue = []Spawn{{At: 1e9}}
	p, _ := w.Join("ana", "ana@example")
	core := &w.Structs[w.Core]
	for _, c := range []struct {
		x    float32
		want bool
	}{{core.CX() + float32(core.W)/2 + 1, true}, {core.CX() + float32(core.W)/2 + 4, false}} {
		p.X, p.Y, p.HP = c.x, core.CY(), 50
		p.Order = Order{}
		for i := 0; i < TickRate*5; i++ {
			w.stepPlayers()
		}
		if healed := p.HP > 50; healed != c.want {
			t.Fatalf("%.1f tiles from the generator's side: HP %.1f", c.x-core.CX()-float32(core.W)/2, p.HP)
		}
		if c.want && p.HP > 50+coreHeal*5+1 {
			t.Fatalf("healed too fast: HP %.1f", p.HP)
		}
	}
}
