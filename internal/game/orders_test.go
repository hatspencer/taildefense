package game

import "testing"

func run(w *World, ticks int, until func() bool) bool {
	for i := 0; i < ticks; i++ {
		w.Step()
		if until() {
			return true
		}
	}
	return false
}

func TestAMoveOrderWalksOutOfTheBaseThroughAGate(t *testing.T) {
	w := New(3)
	p, _ := w.Join("ana", "ana@example")
	// Straight north of the generator, well outside the wall.
	gx, gy := w.CoreX+.5, w.CoreY-18
	for w.At(int(gx), int(gy)).Solid() || w.StructAt(int(gx), int(gy)) >= 0 {
		gx++
	}
	w.MoveTo(p, gx, gy, false)
	if len(p.walk.pts) == 0 {
		t.Fatal("no path planned")
	}
	if !run(w, TickRate*20, func() bool { return p.Order.Kind == OrderIdle }) {
		t.Fatalf("still walking after 20s at %.1f,%.1f", p.X, p.Y)
	}
	if dx, dy := p.X-gx, p.Y-gy; dx*dx+dy*dy > .3*.3 {
		t.Fatalf("stopped at %.1f,%.1f, wanted %.1f,%.1f", p.X, p.Y, gx, gy)
	}
}

func TestAnUnreachablePointWalksAsNearAsItGets(t *testing.T) {
	w := New(3)
	p, _ := w.Join("ana", "ana@example")
	core := &w.Structs[w.Core]
	w.MoveTo(p, core.CX(), core.CY(), false)
	run(w, TickRate*10, func() bool { return p.Order.Kind == OrderIdle })
	if p.Order.Kind != OrderIdle {
		t.Fatal("never gave up walking into the generator")
	}
	if dx, dy := p.X-core.CX(), p.Y-core.CY(); dx*dx+dy*dy > 3*3 {
		t.Fatalf("stopped %.1f,%.1f away", dx, dy)
	}
}

func TestIdleSurvivorsShootAndAttackMoveStopsToFight(t *testing.T) {
	w := New(7)
	p, _ := w.Join("ana", "ana@example")
	w.Phase = PhaseWave
	w.Queue = []Spawn{{At: 1e9}}
	w.SpawnCreep(CWalker, p.X+6, p.Y)
	if !run(w, TickRate*10, func() bool { return len(w.Creeps) == 0 }) {
		t.Fatal("an idle survivor did not kill a walker in range")
	}
	// Attack-move into a creep: the walk pauses while it dies.
	w.SpawnCreep(CWalker, p.X, p.Y+9)
	w.MoveTo(p, p.X, p.Y+12, true)
	if !run(w, TickRate*10, func() bool { return len(w.Creeps) == 0 }) {
		t.Fatal("attack-move did not kill the walker")
	}
	if p.Kills != 2 {
		t.Errorf("kills %d", p.Kills)
	}
}

func TestAttackOrderChasesOneCreep(t *testing.T) {
	w := New(7)
	p, _ := w.Join("ana", "ana@example")
	w.Phase = PhaseWave
	w.Queue = []Spawn{{At: 1e9}}
	w.SpawnCreep(CWalker, p.X+4, p.Y)    // nearer, not the target
	w.SpawnCreep(CBrute, p.X+30, p.Y+30) // outside range, through the gate
	w.Step()
	target := w.Creeps[1].ID
	if err := w.AttackCreep(p, target); err != nil {
		t.Fatal(err)
	}
	run(w, TickRate*2, func() bool { return false })
	if w.creepIndex(target) >= 0 && w.Creeps[w.creepIndex(target)].HP == w.Creeps[w.creepIndex(target)].MaxHP && !p.Moving {
		t.Fatal("not chasing the brute")
	}
}

func TestABuildOrderWalksThereAndBuilds(t *testing.T) {
	w := New(5)
	p, _ := w.Join("bo", "bo@example")
	p.Gold = 1000
	x, y := int(w.CoreX)+8, int(w.CoreY)+8
	for w.At(x, y).Solid() || w.StructAt(x, y) >= 0 {
		x++
	}
	if err := w.OrderBuild(p, STurretGun, x, y); err != nil {
		t.Fatal(err)
	}
	if !run(w, TickRate*10, func() bool { return w.StructKindAt(x, y) == STurretGun }) {
		t.Fatalf("not built; at %.1f,%.1f, order %v, toasts %v", p.X, p.Y, p.Order.Kind, w.Toasts)
	}
	if p.Gold != 1000-Structs[STurretGun].Price {
		t.Errorf("gold %d", p.Gold)
	}
	if err := w.OrderBuild(p, STurretGun, int(w.CoreX)+60, int(w.CoreY)); err == nil {
		t.Error("ordered a build outside the build radius")
	}
}

func TestRepairOrderPaysAndHeals(t *testing.T) {
	w := New(5)
	p, _ := w.Join("bo", "bo@example")
	si := -1
	for i := range w.Structs {
		if w.Structs[i].Kind == SWall {
			si = i
			break
		}
	}
	s := &w.Structs[si]
	s.HP = s.MaxHP / 2
	gold := p.Gold
	if err := w.OrderRepair(p, si); err != nil {
		t.Fatal(err)
	}
	if !run(w, TickRate*30, func() bool { return s.HP >= s.MaxHP }) {
		t.Fatalf("hp %.0f/%.0f, order %v", s.HP, s.MaxHP, p.Order.Kind)
	}
	if p.Gold >= gold {
		t.Error("repair was free")
	}
}

func TestAbilities(t *testing.T) {
	w := New(7)
	p, _ := w.Join("ana", "ana@example")
	w.Phase = PhaseWave
	w.Queue = []Spawn{{At: 1e9}}
	if err := w.Cast(p, AbGrenade, p.X+5, p.Y); err == nil {
		t.Fatal("cast a locked grenade")
	}
	p.Gold = 10000
	a := &w.Structs[w.Armory]
	p.X, p.Y = a.CX(), a.CY()+2
	if err := w.BuyAbility(p, AbGrenade); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		w.SpawnCreep(CWalker, p.X+5, p.Y+float32(i)*.3-.6)
	}
	w.Step()
	hp := w.Creeps[0].HP
	if err := w.Cast(p, AbGrenade, p.X+5, p.Y); err != nil {
		t.Fatal(err)
	}
	if err := w.Cast(p, AbGrenade, p.X+5, p.Y); err == nil {
		t.Fatal("cast twice without a cooldown")
	}
	if len(w.Effects) != 1 {
		t.Fatalf("effects %v", w.Effects)
	}
	p.Order.Kind = OrderHold
	p.Weapons[p.Cur].Ammo = 0 // only the grenade does damage
	p.Weapons[p.Cur].Reload = 100
	run(w, TickRate, func() bool { return false })
	if len(w.Effects) != 0 {
		t.Fatal("the grenade never landed")
	}
	if len(w.Creeps) > 0 && w.Creeps[0].HP >= hp {
		t.Fatal("the grenade did no damage")
	}

	// Every weapon's signature casts.
	for k := WeaponKind(0); k < NumWeapons; k++ {
		p.Weapons[k].Owned = true
		p.Cur = k
		p.Abil[AbSignature].Cool = 0
		if err := w.Cast(p, AbSignature, p.X+4, p.Y); err != nil {
			t.Fatalf("%s: %v", Signatures[k].Name, err)
		}
		w.Step()
	}

	// A dash stops at walls.
	core := &w.Structs[w.Core]
	p.X, p.Y = core.CX(), core.CY()+4
	p.Abil[AbDash] = AbilityState{Lv: 3}
	if err := w.Cast(p, AbDash, core.CX(), core.CY()); err != nil {
		t.Fatal(err)
	}
	if !CanStand(w, p.X, p.Y) || p.Y < core.CY()+1.5 {
		t.Fatalf("dashed into the generator: %.1f,%.1f", p.X, p.Y)
	}
}
