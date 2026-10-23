package game

import "testing"

// grabbed sets up a mauler or a goliath on open ground with a survivor in its reach, who
// neither shoots nor dies, and steps until it has them.
func grabbed(t *testing.T, k CreepKind) (*World, *Player, *Creep, float32) {
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
	cx := x + 11
	if !w.SpawnCreep(k, cx, y) {
		t.Fatal("no creep")
	}
	p.X, p.Y = cx+Creeps[k].Radius+PlayerRadius+.3, y
	for i := 0; i < TickRate && !p.Held(); i++ {
		w.Step()
	}
	if !p.Held() || !p.Stunned() {
		t.Fatalf("%s: not grabbed, or not stopped while held", Creeps[k].Name)
	}
	return w, p, &w.Creeps[0], cx
}

// A mauler that gets its hands on a survivor holds them up, then throws them away behind it,
// and the fall hurts and stuns.
func TestTheMaulerGrabsAndThrows(t *testing.T) {
	w, p, _, cx := grabbed(t, CMauler)
	flew := false
	for i := 0; i < TickRate*3 && (p.Held() || p.Airborne() || !flew); i++ {
		w.Step()
		flew = flew || p.Airborne()
	}
	gd := grabs[CMauler]
	if !flew || p.X > cx-gd.throw*.6 {
		t.Fatalf("thrown %v, landed at %.1f, %.1f behind the mauler", flew, p.X, cx-p.X)
	}
	if lost := p.MaxHP - p.HP; lost < gd.hurt {
		t.Fatalf("the fall took %.0f, want at least %.0f", lost, gd.hurt)
	}
	if !p.Stunned() {
		t.Fatal("not stunned on landing")
	}
}

// Enough damage on a goliath while it holds a survivor makes it let go of them.
func TestShootingTheGrabberFreesTheSurvivor(t *testing.T) {
	w, p, c, _ := grabbed(t, CGoliath)
	w.damage(0, c.MaxHP*grabs[CGoliath].free+Creeps[CGoliath].Armor+1, 0)
	w.Step()
	if p.Held() || p.Airborne() {
		t.Fatal("still held, or thrown, after it was shot loose")
	}
	if c.grab <= 0 {
		t.Fatal("it may grab again at once")
	}
}

// A hound chasing a survivor outruns one walking, even in the best boots, but not one
// sprinting, unless it is in a burst.
func TestHoundsOutrunAWalkingSurvivor(t *testing.T) {
	c := Creep{Kind: CHound}
	p := Player{}
	p.Gear[GearBoots] = MaxLevel
	if s := c.sprintSpeed(Creeps[CHound].Speed); s <= p.Speed() || s >= 6*sprintMul {
		t.Fatalf("a hound chases at %.1f, a survivor walks at %.1f in the best boots", s, p.Speed())
	}
}

// The Huey's door gunner covers the survivors: the creep with one in its hands first, then
// the creep closest to one, not the creep closest to the Huey.
func TestTheDoorGunnerCoversTheSurvivors(t *testing.T) {
	w := newBare(4)
	p := mustJoin(t, w, "ana")
	x, y := openRow(w, 14)
	p.X, p.Y = x+12, y
	w.SpawnCreep(CWalker, x+1, y)  // by the Huey
	w.SpawnCreep(CWalker, x+11, y) // by the survivor
	w.SpawnCreep(CMauler, x+6, y)
	w.grid.build(w.Creeps)
	near := []*Player{p}
	if i := w.heliTarget(x, y, near); i != 1 {
		t.Fatalf("shot creep %d, not the one by the survivor", i)
	}
	w.Creeps[2].grip = p.ID + 1
	if i := w.heliTarget(x, y, near); i != 2 {
		t.Fatalf("shot creep %d, not the one holding the survivor", i)
	}
}
