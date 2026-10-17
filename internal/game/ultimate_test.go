package game

import "testing"

// A survivor's own damage fills the meter; a turret's does not.
func TestDamageChargesTheUltimate(t *testing.T) {
	w := newBare(3)
	p, _ := w.Join("ana", "ana@example")
	w.Queue = []Spawn{{At: 1e9}}
	w.SpawnCreep(CBoss, p.X+6, p.Y)
	i := int32(len(w.Creeps) - 1)
	w.turretFire = true
	w.damage(i, 500, int8(p.ID))
	w.turretFire = false
	if p.Ult != 0 {
		t.Fatalf("a turret's damage charged %.3f", p.Ult)
	}
	w.damage(i, 500, int8(p.ID))
	if p.Ult <= 0 {
		t.Fatal("no charge from 500 damage")
	}
	// Nothing fills it while one runs.
	before := p.Ult
	p.Buff, p.BuffLeft = WSMG, 5
	w.damage(i, 500, int8(p.ID))
	if p.Ult != before {
		t.Fatal("charged while an ultimate ran")
	}
}

// Dead Eye marks, holds fire, then kills every walker in sight and hurts a brute.
func TestDeadEyeShootsEverythingInSight(t *testing.T) {
	w := newBare(3)
	p, _ := w.Join("ana", "ana@example")
	w.Queue = []Spawn{{At: 1e9}}
	for k := 0; k < 4; k++ {
		w.SpawnCreep(CWalker, p.X+3+float32(k), p.Y+2)
	}
	w.SpawnCreep(CBrute, p.X-5, p.Y)
	for i := range w.Creeps {
		w.Creeps[i].Asleep = true
	}
	p.Ult = 1
	if err := w.Cast(p, AbUltimate, p.X, p.Y); err != nil {
		t.Fatal(err)
	}
	if !p.marking() {
		t.Fatal("not marking")
	}
	run(w, TickRate*2, func() bool { return !p.marking() })
	walkers, brute := 0, false
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if c.Kind == CWalker {
			walkers++
		}
		if c.Kind == CBrute {
			brute = true
			if c.HP >= Creeps[CBrute].HP {
				t.Fatal("the brute was not hit")
			}
		}
	}
	if walkers > 0 || !brute {
		t.Fatalf("%d walkers left, brute alive %v", walkers, brute)
	}
}

// The rifle's ultimate goes through a whole line, and no round is spent under an ultimate.
func TestRailgunPiercesEverything(t *testing.T) {
	w := newBare(3)
	p, _ := w.Join("ana", "ana@example")
	w.Queue = []Spawn{{At: 1e9}}
	p.Weapons[WRifle] = WeaponState{Owned: true, Ammo: 5}
	p.Cur = WRifle
	p.Buff, p.BuffLeft = WRifle, 10
	for k := 0; k < 8; k++ {
		w.SpawnCreep(CWalker, p.X+2+float32(k)*.9, p.Y)
	}
	w.grid.build(w.Creeps)
	st := w.playerStats(p)
	w.hitscan(int8(p.ID), p.X, p.Y, 0, 20, 1, st.Pierce, 0, uint8(WRifle)+TracerUlt)
	for i := range w.Creeps {
		if w.Creeps[i].HP >= Creeps[CWalker].HP {
			t.Fatalf("walker %d of 8 not hit", i+1)
		}
	}
}

// The MIRV splits into bomblets over its point.
func TestClusterRocketSplits(t *testing.T) {
	w := newBare(3)
	p, _ := w.Join("ana", "ana@example")
	w.Queue = []Spawn{{At: 1e9}}
	p.Weapons[WLauncher] = WeaponState{Owned: true, Ammo: 4}
	p.Cur, p.Ult = WLauncher, 1
	if err := w.Cast(p, AbUltimate, p.X+8, p.Y); err != nil {
		t.Fatal(err)
	}
	if !run(w, TickRate*2, func() bool {
		n := 0
		for _, e := range w.Effects {
			if e.Kind == EffGrenade {
				n++
			}
		}
		return n == mirvBomblets
	}) {
		t.Fatal("no bomblets")
	}
}

// Berserk shrugs off slows and stuns.
func TestBerserkShrugsOffStuns(t *testing.T) {
	w := newBare(3)
	p, _ := w.Join("ana", "ana@example")
	p.Weapons[WCrowbar].Owned = true
	p.Cur, p.Buff, p.BuffLeft = WCrowbar, WCrowbar, 8
	p.slow(2)
	p.stun(2)
	if p.slowLeft > 0 || p.Stunned() {
		t.Fatal("slowed or stunned while berserk")
	}
}

// A grenade from level 4 leaves the ground burning.
func TestAHighGrenadeLeavesFire(t *testing.T) {
	w := newBare(3)
	p, _ := w.Join("ana", "ana@example")
	w.Queue = []Spawn{{At: 1e9}}
	p.Abil[AbGrenade].Lv = 4
	if err := w.Cast(p, AbGrenade, p.X+6, p.Y); err != nil {
		t.Fatal(err)
	}
	if !run(w, TickRate*2, func() bool {
		for _, e := range w.Effects {
			if e.Kind == EffNapalm {
				return true
			}
		}
		return false
	}) {
		t.Fatal("no fire")
	}
	p.Gold = 1e6
	a := &w.Structs[w.Armory]
	p.X, p.Y = a.CX(), a.CY()+2
	if err := w.BuyAbility(p, AbGrenade); err != nil {
		t.Fatal(err)
	}
	if w.BuyAbility(p, AbGrenade) == nil {
		t.Fatal("a grenade past level 5")
	}
	if w.BuyAbility(p, AbDash) != nil || w.BuyAbility(p, AbDash) != nil || w.BuyAbility(p, AbDash) != nil || w.BuyAbility(p, AbDash) == nil {
		t.Fatal("dash does not stop at level 3")
	}
}

// A structure the creeps destroy leaves a ghost; FixAll rebuilds it and mends the rest, and
// only between waves.
func TestFixAllRebuildsAndRepairs(t *testing.T) {
	w := New(5)
	w.PhaseLeft = 1e6
	p, _ := w.Join("ana", "ana@example")
	wall, turret := -1, -1
	for i := range w.Structs {
		switch w.Structs[i].Kind {
		case SWall:
			if wall < 0 {
				wall = i
			}
		case STurretGun:
			if turret < 0 {
				turret = i
			}
		}
	}
	wx, wy := w.Structs[wall].X, w.Structs[wall].Y
	w.Structs[wall].HP = 0
	w.Structs[turret].HP = w.Structs[turret].MaxHP / 2
	w.Step()
	if s := &w.Structs[wall]; s.Alive || !s.Ghost {
		t.Fatalf("destroyed wall: alive %v ghost %v", s.Alive, s.Ghost)
	}
	cost := w.FixCost()
	if cost <= Structs[SWall].Price {
		t.Fatalf("fix cost %d", cost)
	}
	p.Gold = 1000
	rebuilt, mended, err := w.FixAll(p)
	if err != nil || rebuilt != 1 || mended != 1 {
		t.Fatalf("rebuilt %d mended %d: %v", rebuilt, mended, err)
	}
	if spent := 1000 - p.Gold; spent != cost {
		t.Fatalf("spent %d, quoted %d", spent, cost)
	}
	if si := w.StructAt(int(wx), int(wy)); si < 0 || w.Structs[si].Kind != SWall {
		t.Fatal("the wall is not back")
	}
	if !w.Structs[turret].mended() {
		t.Fatal("the turret is not mended")
	}
	if _, _, err := w.FixAll(p); err == nil {
		t.Fatal("fixed a whole base")
	}
	// A ghost built over is gone.
	si := w.StructAt(int(wx), int(wy))
	w.Structs[si].HP = 0
	w.Step()
	if _, err := w.Sell(p, si); err == nil {
		t.Fatal("sold a destroyed wall")
	}
	w.place(SGate, int(wx), int(wy), int8(p.ID))
	for i := range w.Structs {
		if w.Structs[i].Ghost {
			t.Fatal("a ghost under a gate")
		}
	}
	w.Phase = PhaseWave
	w.Structs[turret].HP = 1
	if _, _, err := w.FixAll(p); err == nil {
		t.Fatal("fixed during a wave")
	}
}
