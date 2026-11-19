package game

import "testing"

// lit sets up a burster on open ground running at a survivor who neither shoots nor dies, a few
// tiles off, and steps until its fuse is lit.
func lit(t *testing.T) (*World, *Player, *Creep) {
	t.Helper()
	w := newBare(4)
	w.Phase = PhaseWave
	w.Queue = []Spawn{{At: 1e9}}
	p := mustJoin(t, w, "ana")
	p.MaxHP, p.HP = 1e4, 1e4
	p.Weapons[p.Cur].Ammo, p.Weapons[p.Cur].Reload = 0, 1e9
	x, y := openRow(w, 14)
	if x == 0 {
		t.Fatal("no open ground")
	}
	if !w.SpawnCreep(CBurster, x+4, y) {
		t.Fatal("no creep")
	}
	p.X, p.Y = x+9, y
	for i := 0; i < TickRate*3 && w.Creeps[0].Swing != SwingWindup; i++ {
		w.Step()
	}
	if c := &w.Creeps[0]; c.Swing != SwingWindup {
		t.Fatalf("never lit its fuse: %.1f tiles off", p.X-c.X)
	}
	return w, p, &w.Creeps[0]
}

// A burster that reaches a survivor stands while its fuse burns, then blows up: it hurts and
// stuns them, is gone, and leaves the ground burning.
func TestTheBursterBlowsUpOnASurvivor(t *testing.T) {
	w, p, c := lit(t)
	at := c.X
	id := c.ID
	gone := func() bool {
		for i := range w.Creeps {
			if w.Creeps[i].ID == id {
				return false
			}
		}
		return true
	}
	for i := 0; i < TickRate && !gone(); i++ {
		if c.X != at {
			t.Fatal("moved while its fuse burned")
		}
		w.Step()
	}
	if !gone() {
		t.Fatal("never went off")
	}
	if lost := p.MaxHP - p.HP; lost < Creeps[CBurster].Damage*.5 {
		t.Fatalf("the blast took %.0f", lost)
	}
	if !p.Stunned() {
		t.Fatal("not stunned at the heart of the blast")
	}
	fire := false
	for _, e := range w.Effects {
		fire = fire || e.Kind == EffNapalm
	}
	if !fire {
		t.Fatal("no burning ground")
	}
}

// A survivor who runs once the fuse is lit gets clear of the blast.
func TestRunningFromALitBursterGetsClear(t *testing.T) {
	w, p, c := lit(t)
	p.X = c.X + burstReach + 1
	for i := 0; i < TickRate && len(w.Creeps) > 0; i++ {
		w.Step()
	}
	if len(w.Creeps) > 0 {
		t.Fatal("never went off")
	}
	if p.HP < p.MaxHP || p.Stunned() {
		t.Fatalf("hurt (%.0f) or stunned from beyond the blast", p.MaxHP-p.HP)
	}
}

// The fire a burster leaves burns the creeps in it.
func TestTheBursterFireBurnsCreeps(t *testing.T) {
	w, _, c := lit(t)
	if !w.SpawnCreep(CWalker, c.X, c.Y+.6) {
		t.Fatal("no walker")
	}
	wid := w.Creeps[len(w.Creeps)-1].ID
	walker := func() *Creep {
		for i := range w.Creeps {
			if w.Creeps[i].ID == wid {
				return &w.Creeps[i]
			}
		}
		return nil
	}
	for i := 0; i < TickRate && len(w.Effects) == 0; i++ {
		if k := walker(); k != nil {
			k.stunLeft = 1 // held in the blast and the fire
		}
		w.Step()
	}
	k := walker()
	if k == nil {
		return // burned up already
	}
	hp := k.HP
	for i := 0; i < TickRate; i++ {
		if k = walker(); k == nil {
			return
		}
		k.stunLeft = 1
		w.Step()
	}
	if k = walker(); k != nil && k.HP >= hp {
		t.Fatal("the fire didn't burn a walker standing in it")
	}
}
