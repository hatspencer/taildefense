package game

import (
	"testing"
)

// greatRig is a survivor at the bench holding a greatsword fully bought, evolved into evo,
// tempered or not.
func greatRig(t *testing.T, evo uint8, tempered bool) *arena {
	t.Helper()
	a := newArena(25)
	ws := &a.p.Weapons[WGreat]
	ws.Owned, ws.Lv, ws.Evo, ws.Dual = true, lv(MaxLevel, MaxLevel, MaxLevel, MaxLevel), evo, tempered
	a.p.Cur = WGreat
	a.p.Abil[AbUltimate].Lv = 1
	return a
}

// splitTick steps what Worldsplitter needs: the survivor's art, the ultimate's clock, the
// effects on the ground and the creeps' sunder, burning and stuns.
func splitTick(a *arena) {
	w, p := a.w, a.p
	w.Tick++
	w.freeIDs = append(w.freeIDs, w.freed...)
	w.freed = w.freed[:0]
	w.grid.build(w.Creeps)
	if p.Art != ArtNone {
		w.stepArt(p)
	}
	if p.BuffLeft > 0 {
		p.BuffLeft = max(p.BuffLeft-Dt, 0)
	}
	w.stepEffects()
	for i := range w.Creeps {
		c := &w.Creeps[i]
		c.stepSunder()
		if c.Burn > 0 {
			c.Burn -= Dt
			c.HP -= c.BurnDPS * w.burnMul() * Dt
		}
		c.stunned()
	}
	w.reap()
}

// A greatsword's blows sunder what they land on: armour comes off, and every hit on it, anyone's,
// lands harder, up to a cap that mastery raises; it falls off a while after the last blow.
func TestTheGreatswordSunders(t *testing.T) {
	a := greatRig(t, 1, false)
	a.w.SpawnCreep(CBrute, a.ox+2, a.oy)
	c := &a.w.Creeps[0]
	c.HP = 1e6
	a.w.grid.build(a.w.Creeps)
	before := c.HP
	a.w.damage(0, 100, -1)
	plain := before - c.HP
	for range 30 {
		a.w.swingLegend(a.p, a.w.playerStats(a.p), 0, false)
	}
	if want := sunderCap(1); c.Sunder != want {
		t.Fatalf("a full greatsword stacked %d sunder, want its cap %d", c.Sunder, want)
	}
	if sunderCap(0) >= sunderCap(1) {
		t.Error("mastery does not raise the sunder a greatsword stacks")
	}
	before = c.HP
	a.w.damage(0, 100, -1)
	if got := before - c.HP; got < plain*1.5 {
		t.Errorf("a hit on a sundered brute did %.0f, on a fresh one %.0f", got, plain)
	}
	for range sunderFor*TickRate + 1 {
		c.stepSunder()
	}
	if c.Sunder != 0 {
		t.Errorf("sunder %d still on after %d s", c.Sunder, sunderFor)
	}
}

// A second greatsword is forged into the first: one blade in hand, as far as a full pair of
// katanas in mastery and crits.
func TestASecondGreatswordTempersTheFirst(t *testing.T) {
	w := newBare(4)
	p := mustJoin(t, w, "ana")
	p.Weapons[WGreat] = WeaponState{Owned: true, Lv: lv(MaxLevel, MaxLevel, MaxLevel, MaxLevel), Evo: 2}
	if !w.canTake(p, WGreat) {
		t.Fatal("no hand free for a second greatsword")
	}
	w.Guns = append(w.Guns, Gun{ID: 1, Kind: WGreat, Breaker: true})
	w.pickUp(p, 0)
	ws := &p.Weapons[WGreat]
	if !ws.Dual || !ws.Breaker {
		t.Fatalf("picked up a second greatsword: tempered %v, Worldbreaker %v", ws.Dual, ws.Breaker)
	}
	if w.canTake(p, WGreat) {
		t.Error("room for a third greatsword")
	}
	if m := ws.Mastery(WGreat); m != masteryMax {
		t.Errorf("a full tempered greatsword has mastery %.2f, a full pair of katanas %.2f", m, masteryMax)
	}
	pair := WeaponState{Owned: true, Lv: ws.Lv, Evo: 1, Dual: true}
	gc, _ := ws.crit(WGreat)
	kc, _ := pair.crit(WKatana)
	if gc != kc {
		t.Errorf("a tempered greatsword crits %.2f, a pair of katanas %.2f", gc, kc)
	}
	plain := WeaponState{Owned: true, Lv: ws.Lv, Evo: 2}
	if ws.Stats(WGreat).Rate != plain.Stats(WGreat).Rate {
		t.Error("tempering changed the greatsword's swing rate")
	}
}

// Worldsplitter: raised untouchable, then a cut along its line that takes a share of everything
// in it, sunders and stuns it, and a fissure left erupting; nothing it deals fills the meter.
func TestWorldsplitterSplitsTheGround(t *testing.T) {
	a := greatRig(t, 1, true)
	w, p := a.w, a.p
	w.SpawnCreep(CBrute, a.ox+6, a.oy)       // in the line
	w.SpawnCreep(CBrute, a.ox+6, a.oy+4)     // beside it
	w.SpawnCreep(CGoliath, a.ox+10, a.oy+.5) // a boss in it
	for i := range w.Creeps {
		w.Creeps[i].HP = w.Creeps[i].MaxHP * 50 // only shares and stuns are measured here
	}
	p.Ult = 1
	if err := w.Cast(p, AbUltimate, a.ox+12, a.oy); err != nil {
		t.Fatal(err)
	}
	if p.Art != ArtSplit || !p.unstoppable() {
		t.Fatal("Worldsplitter is not raised, or its wielder can be stopped")
	}
	hp := p.HP
	w.hurtPlayer(p, 50)
	if p.HP != hp {
		t.Error("hurt while raising Worldsplitter")
	}
	if err := w.Cast(p, AbDash, a.ox+3, a.oy); err == nil {
		t.Error("Skyfall leapt while Worldsplitter was raised")
	}
	for range int(splitWindup*TickRate) + 1 {
		splitTick(a)
	}
	in, beside, boss := &w.Creeps[0], &w.Creeps[1], &w.Creeps[2]
	if in.HP > in.MaxHP*(50-splitCut) {
		t.Errorf("the cut took %.0f%% of a brute in its line, want at least %.0f%%", 100*(in.MaxHP*50-in.HP)/in.MaxHP, 100*splitCut)
	}
	if boss.HP > boss.MaxHP*(50-splitBoss) {
		t.Errorf("the cut took %.0f%% of a goliath in its line", 100*(boss.MaxHP*50-boss.HP)/boss.MaxHP)
	}
	if in.Sunder != sunderCap(1) || in.stunLeft <= 0 {
		t.Errorf("a brute in the line: sunder %d, stunned %.1fs", in.Sunder, in.stunLeft)
	}
	if beside.HP != beside.MaxHP*50 {
		t.Error("the cut hit a brute 4 tiles off its line")
	}
	if len(w.Effects) != 1 || w.Effects[0].Kind != EffFissure {
		t.Fatalf("no fissure left open: %v", w.Effects)
	}
	after := in.HP
	for range splitErupt * TickRate {
		splitTick(a)
	}
	if in.HP >= after {
		t.Error("the fissure never erupted under the brute")
	}
	if len(w.Effects) != 0 {
		t.Error("the fissure never closed")
	}
	if p.Ult != 0 {
		t.Errorf("Worldsplitter filled the meter to %.2f", p.Ult)
	}
	if beside.HP != beside.MaxHP*50 {
		t.Error("without Worldbreaker the closing fissure hit a brute 4 tiles off")
	}
}

// Worldbreaker: bought once, for a greatsword full and evolved; as the fissure closes the line
// goes off, and every creep the shockwave catches throws a charge on, Stormbreaker's further,
// further still beside a Tesla coil.
func TestWorldbreakerChargesLeap(t *testing.T) {
	w := newBare(7)
	p := mustJoin(t, w, "ana")
	p.Gold = 1e6
	p.X, p.Y = w.Structs[w.Armory].CX(), w.Structs[w.Armory].CY()+2
	p.Weapons[WGreat] = WeaponState{Owned: true, Lv: lv(MaxLevel, MaxLevel, MaxLevel, MaxLevel)}
	ws := &p.Weapons[WGreat]
	if err := w.EvolveWeapon(p, WGreat, breakerBranch); err == nil {
		t.Error("bought Worldbreaker for a greatsword not yet evolved")
	}
	ws.Evo = 2
	ws.Lv[0] = MaxLevel - 1
	if err := w.EvolveWeapon(p, WGreat, breakerBranch); err == nil {
		t.Error("bought Worldbreaker for a greatsword with a track short")
	}
	ws.Lv[0] = MaxLevel
	if err := w.EvolveWeapon(p, WGreat, breakerBranch); err != nil || !ws.Breaker {
		t.Fatalf("Worldbreaker: %v", err)
	}
	if err := w.EvolveWeapon(p, WGreat, breakerBranch); err == nil {
		t.Error("bought Worldbreaker twice")
	}

	jumps := func(coil bool) int {
		a := greatRig(t, 2, false)
		w, p := a.w, a.p
		p.Weapons[WGreat].Breaker = true
		if coil {
			a.build(rig{turret: STurretTesla}, -3, 0)
			a.built = false
		}
		// One creep in the shockwave, a long chain of them leading off out of it.
		w.SpawnCreep(CBrute, a.ox+6, a.oy+5)
		for k := range 12 {
			w.SpawnCreep(CBrute, a.ox+6, a.oy+9+3*float32(k))
		}
		for i := range w.Creeps {
			w.Creeps[i].HP = 1e7
		}
		p.Ult = 1
		if err := w.Cast(p, AbUltimate, a.ox+12, a.oy); err != nil {
			t.Fatal(err)
		}
		n := 0
		for range int((splitWindup+splitErupt)*TickRate) + 2 {
			w.Tracers = w.Tracers[:0]
			splitTick(a)
			for _, tr := range w.Tracers {
				if tr.Kind == TracerArc {
					n++
				}
			}
		}
		return n
	}
	if n := jumps(false); n != breakerStorm {
		t.Errorf("Stormbreaker's charge leapt %d times, want %d", n, breakerStorm)
	}
	if n := jumps(true); n != breakerCoilJump {
		t.Errorf("beside a Tesla coil Stormbreaker's charge leapt %d times, want %d", n, breakerCoilJump)
	}
}

// The greatsword is the crowd blade and, fully taken, stands up to a goliath close to a pair of
// katanas: the bench at wave 25.
func TestAFullGreatswordIsTheCrowdBlade(t *testing.T) {
	gsw := rig{name: "GSW", weapon: WGreat, lv: lv(MaxLevel, MaxLevel, MaxLevel, MaxLevel), dual: true}
	pair := rig{name: "KTNx2", weapon: WKatana, lv: lv(MaxLevel, MaxLevel, MaxLevel, MaxLevel), dual: true}
	g := weaponTTK(CGoliath, 25, weaponDPS(gsw, CGoliath, 0, 2, false))
	k := weaponTTK(CGoliath, 25, weaponDPS(pair, CGoliath, 0, 2, false))
	t.Logf("goliath on wave 25: tempered greatsword %.1f s, pair of katanas %.1f s (unevolved)", g, k)
	if g > 3*k || g > 10 {
		t.Errorf("a full tempered greatsword kills a goliath in %.1f s, a pair of katanas in %.1f s", g, k)
	}
	heavy, _ := clearMix(gsw, mixHeavy, 3, 25, true, 0, false)
	army, _ := clearMix(gsw, mixArmy, 3, 25, true, 0, false)
	t.Logf("wave 25 walking in from 3: heavy %.1f s, army %.1f s", heavy, army)
	if heavy > 3 || army > 3 {
		t.Errorf("a full greatsword took %.1f s on the heavy mix and %.1f s on the army", heavy, army)
	}
}
