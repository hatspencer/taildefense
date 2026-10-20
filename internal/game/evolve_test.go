package game

import "testing"

// tierUp pays the generator up to tier n from p's pocket.
func tierUp(t *testing.T, w *World, p *Player, n uint8) {
	t.Helper()
	for w.Tier < n {
		p.Gold += TierStep
		if err := w.PayIn(p); err != nil {
			t.Fatalf("pay in at tier %d: %v", w.Tier, err)
		}
	}
}

func TestTheTeamPaysTheGeneratorUpATier(t *testing.T) {
	w := newBare(7)
	p := mustJoin(t, w, "ana")
	core := &w.Structs[w.Core]
	hp := core.MaxHP
	cost := w.TierCost()
	p.Gold = TierStep
	if err := w.PayIn(p); err != nil {
		t.Fatal(err)
	}
	if w.Tier != 1 || w.TierPaid != TierStep || p.Gold != 0 {
		t.Fatalf("tier %d paid %d gold left %d", w.Tier, w.TierPaid, p.Gold)
	}
	if err := w.PayIn(p); err == nil {
		t.Fatal("paid in with no gold")
	}
	tierUp(t, w, p, 2)
	if p.PaidIn != cost || core.MaxHP <= hp {
		t.Fatalf("paid %d of %d; generator %v → %v", p.PaidIn, cost, hp, core.MaxHP)
	}
	tierUp(t, w, p, MaxTier)
	p.Gold = 1000
	if err := w.PayIn(p); err == nil {
		t.Fatal("paid in past the last tier")
	}
}

func TestThePylonWaitsForTierTwoAndSpeedsTurretsUp(t *testing.T) {
	w := mazeWorld(t)
	p := mustJoin(t, w, "ana")
	cx, cy := int(w.CoreX), int(w.CoreY)
	p.X, p.Y, p.Gold = float32(cx)+.5, float32(cy-baseRadius-4)+.5, 5000
	if err := w.CanBuild(p, SPylon, cx, cy-baseRadius-5); err == nil {
		t.Fatal("a pylon went up at tier I")
	}
	tierUp(t, w, p, PylonTier)
	if err := w.CanBuild(p, SPylon, cx, cy-baseRadius-5); err != nil {
		t.Fatalf("no pylon at tier II: %v", err)
	}
	gun := &w.Structs[w.place(STurretGun, cx+1, cy-baseRadius-5, -1)]
	far := &w.Structs[w.place(STurretGun, cx+12, cy-baseRadius-5, -1)]
	w.place(SPylon, cx, cy-baseRadius-5, -1)
	w.findPylons()
	if !w.pylonNear(gun) || w.pylonNear(far) {
		t.Fatalf("pylon reaches the near gun %v, the far one %v", w.pylonNear(gun), w.pylonNear(far))
	}
}

func TestATurretEvolvesOnceAtTierThree(t *testing.T) {
	w := newBare(7)
	p := mustJoin(t, w, "ana")
	cx, cy := int(w.CoreX), int(w.CoreY)
	si := w.place(STurretGun, cx, cy-baseRadius-5, -1)
	s := &w.Structs[si]
	s.Lv = [NumTracks]uint8{3, 3, 3, 3}
	p.Gold = 5000
	if err := w.Evolve(p, si, 1); err == nil {
		t.Fatal("evolved at tier I")
	}
	tierUp(t, w, p, EvolveTier)
	s.Lv = [NumTracks]uint8{3, 3, 3, 2}
	p.Gold = 5000
	if err := w.Evolve(p, si, 1); err == nil {
		t.Fatal("evolved with its tracks at 11")
	}
	s.Lv[TrackSpecial] = 3
	before := StructStats(s)
	if err := w.Evolve(p, si, 1); err != nil {
		t.Fatal(err)
	}
	if after := StructStats(s); after.Rate <= before.Rate*2 {
		t.Fatalf("a gatling fires %.1f/s, the gun %.1f/s", after.Rate, before.Rate)
	}
	if err := w.Evolve(p, si, 2); err == nil {
		t.Fatal("evolved twice")
	}
	if Spent(s) < 2*Structs[STurretGun].Price {
		t.Fatalf("an evolved gun is worth only %d", Spent(s))
	}
}

func TestAPenetratorIgnoresArmour(t *testing.T) {
	w := mazeWorld(t)
	n := len(w.Creeps)
	w.SpawnCreep(CBrute, w.CoreX, w.CoreY-34)
	c := &w.Creeps[n]
	hp := c.HP
	w.damage(int32(n), 20, -1)
	plain := hp - c.HP
	w.noArmor = true
	w.damage(int32(n), 20, -1)
	w.noArmor = false
	if pierced := hp - plain - c.HP; pierced <= plain {
		t.Fatalf("armour-piercing took %.1f, plain %.1f", pierced, plain)
	}
}

func TestTheOverloadGoesOffOnceAWave(t *testing.T) {
	w := mazeWorld(t)
	p := mustJoin(t, w, "ana")
	tierUp(t, w, p, OverloadTier)
	if err := w.Overload(p); err == nil {
		t.Fatal("overloaded between waves")
	}
	w.startWave()
	w.Queue = nil
	n := len(w.Creeps)
	w.SpawnCreep(CWalker, w.CoreX, w.CoreY-baseRadius-3)
	w.SpawnCreep(CWalker, w.CoreX, w.CoreY-40)
	w.grid.build(w.Creeps)
	near, far := w.Creeps[n].HP, w.Creeps[n+1].HP
	if !w.OverloadReady() {
		t.Fatal("the overload is not ready in a wave")
	}
	if err := w.Overload(p); err != nil {
		t.Fatal(err)
	}
	if w.Creeps[n].HP >= near || w.Creeps[n].stunLeft <= 0 || w.Creeps[n+1].HP != far {
		t.Fatalf("near %.0f→%.0f stun %.1f, far %.0f→%.0f", near, w.Creeps[n].HP, w.Creeps[n].stunLeft, far, w.Creeps[n+1].HP)
	}
	if err := w.Overload(p); err == nil || w.OverloadReady() {
		t.Fatal("overloaded twice in a wave")
	}
}
