package game

import "testing"

// spitAt puts a spitter on open ground with a survivor 5 tiles off, out of ammo, and plays
// four seconds: standing still, or walking up and down across its line. It reports how much
// the spit took off them.
func spitAt(t *testing.T, moving bool) float32 {
	t.Helper()
	w := newBare(4)
	w.Phase = PhaseWave
	w.Queue = []Spawn{{At: 1e9}}
	p, _ := w.Join("ana", "ana@example")
	p.MaxHP, p.HP = 1e4, 1e4
	p.Weapons[p.Cur].Ammo, p.Weapons[p.Cur].Reload = 0, 1e9
	x, y := openRow(w, 10)
	if x == 0 {
		t.Fatal("no open ground")
	}
	if !w.SpawnCreep(CSpitter, x, y) {
		t.Fatal("no spitter")
	}
	sx, sy := x+5, y
	for i := range 4 * TickRate {
		p.X, p.Y = sx, sy
		if moving {
			// Walking, 6 tiles a second, a tile and a half each way of the line.
			s := float32(i%TickRate) / TickRate * 6
			if s > 3 {
				s = 6 - s
			}
			p.Y = sy - 1.5 + s
		}
		w.Step()
	}
	return p.MaxHP - p.HP
}

// A spitter's glob flies to where its mark stood: standing still it lands, walking about it
// misses. It used to land the moment it was spat, wherever the survivor had got to.
func TestSpitCanBeDodged(t *testing.T) {
	if hurt := spitAt(t, false); hurt < Creeps[CSpitter].Damage {
		t.Fatalf("standing still in front of a spitter for 4 s cost %.1f", hurt)
	}
	if hurt := spitAt(t, true); hurt > Creeps[CSpitter].Damage {
		t.Errorf("walking about in front of a spitter for 4 s cost %.1f: its spit follows them", hurt)
	}
}

// It is in the air for its distance over spitSpeed, and a step aside clears it.
func TestSpitFliesBeforeItLands(t *testing.T) {
	w := newBare(4)
	p, _ := w.Join("ana", "ana@example")
	w.Effects = w.Effects[:0]
	if !w.SpawnCreep(CSpitter, p.X+6, p.Y) {
		t.Fatal("no spitter")
	}
	w.spit(&w.Creeps[len(w.Creeps)-1], &Creeps[CSpitter], p)
	e := w.Effects[len(w.Effects)-1]
	if e.Kind != EffSpit || e.Left < .7 || e.Left > .8 {
		t.Fatalf("a glob spat 6 tiles is kind %d, %.2f s in the air", e.Kind, e.Left)
	}
	hp := p.HP
	p.X += 2
	for range TickRate {
		w.stepEffects()
	}
	if p.HP < hp {
		t.Errorf("a glob landing 2 tiles from a survivor hurt them %.1f", hp-p.HP)
	}
	p.X -= 2
	w.spit(&w.Creeps[len(w.Creeps)-1], &Creeps[CSpitter], p)
	for range TickRate {
		w.stepEffects()
	}
	if p.HP >= hp {
		t.Error("a glob landing on a survivor standing still did nothing")
	}
}
