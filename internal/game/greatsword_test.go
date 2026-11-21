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

// Worldsplitter: raised untouchable, then slammed into the ground in a shockwave every way that
// takes a share of everything in reach, sunders and stuns it and throws back what lives (a boss
// stands firm), and the ground round the blade left erupting; nothing it deals fills the meter.
func TestWorldsplitterSlamsTheGround(t *testing.T) {
	a := greatRig(t, 1, true)
	w, p := a.w, a.p
	at := [][2]float32{{3, 0}, {-3, 0}, {0, -3}, {-4, 4}} // in reach, all round
	for _, d := range at {
		w.SpawnCreep(CBrute, a.ox+d[0], a.oy+d[1])
	}
	w.SpawnCreep(CBrute, a.ox+splitReach+2, a.oy) // out of reach
	w.SpawnCreep(CGoliath, a.ox, a.oy+3)          // a boss on the cracked ground
	for i := range w.Creeps {
		w.Creeps[i].HP = w.Creeps[i].MaxHP * 50 // only shares, stuns and throws are measured here
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
	for k, d := range at {
		c := &w.Creeps[k]
		took := (c.MaxHP*50 - c.HP) / c.MaxHP
		if took < splitCut*splitEdge {
			t.Errorf("the slam took %.0f%% of a brute at %v, want at least %.0f%%", 100*took, d, 100*splitCut*splitEdge)
		}
		if c.Sunder != sunderCap(1) || c.stunLeft <= 0 {
			t.Errorf("a brute at %v: sunder %d, stunned %.1fs", d, c.Sunder, c.stunLeft)
		}
		was := d[0]*d[0] + d[1]*d[1]
		if dx, dy := c.X-a.ox, c.Y-a.oy; dx*dx+dy*dy < was+1 || dx*d[0]+dy*d[1] <= 0 {
			t.Errorf("a brute at %v was not thrown back: now at %.1f, %.1f", d, dx, dy)
		}
	}
	out, boss := &w.Creeps[len(at)], &w.Creeps[len(at)+1]
	if out.HP != out.MaxHP*50 {
		t.Error("the slam hit a brute out of its reach")
	}
	if boss.HP > boss.MaxHP*(50-splitBoss*splitEdge) || boss.stunLeft <= 0 {
		t.Errorf("the slam took %.0f%% of a goliath and stunned it %.1fs", 100*(boss.MaxHP*50-boss.HP)/boss.MaxHP, boss.stunLeft)
	}
	if boss.X != a.ox || boss.Y != a.oy+3 {
		t.Error("the slam threw a goliath")
	}
	if len(w.Effects) != 1 || w.Effects[0].Kind != EffFissure {
		t.Fatalf("no cracked ground left: %v", w.Effects)
	}
	after := boss.HP
	for range splitErupt * TickRate {
		splitTick(a)
	}
	if boss.HP >= after {
		t.Error("the cracked ground never erupted under the goliath")
	}
	if len(w.Effects) != 0 {
		t.Error("the cracked ground never closed")
	}
	if p.Ult != 0 {
		t.Errorf("Worldsplitter filled the meter to %.2f", p.Ult)
	}
	if out.HP != out.MaxHP*50 {
		t.Error("without Worldbreaker the closing ground hit a brute out of reach")
	}
}

// Worldbreaker: bought once, for a greatsword full and evolved; as the cracked ground closes it
// goes off in a wider shockwave, and every creep the shockwave catches throws a charge on, Stormbreaker's further,
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
		w.SpawnCreep(CBrute, a.ox, a.oy+9)
		for k := range 12 {
			w.SpawnCreep(CBrute, a.ox, a.oy+13+3*float32(k))
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

// heldShare is the share of the time the creeps of a block of n of kind stand stunned while
// the survivor swings the blade k, all tracks at l, at them for 20 s.
func heldShare(k WeaponKind, l, evo uint8, dual bool, kind CreepKind, n int) float64 {
	a := newArena(25)
	w, p := a.w, a.p
	ws := &p.Weapons[k]
	ws.Owned, ws.Lv, ws.Evo, ws.Dual = true, lv(l, l, l, l), evo, dual
	p.Cur = k
	at := func(j int) (float32, float32) {
		return a.ox + 1.2 + float32(j%4)*.8, a.oy + float32(j/4-n/8)*.8
	}
	for j := range n {
		x, y := at(j)
		w.SpawnCreep(kind, x, y)
	}
	every := 1 / w.playerStats(p).Rate
	next, held, all := float32(0), 0, 0
	for range 20 * TickRate {
		w.Tick++
		for j := range w.Creeps {
			c := &w.Creeps[j]
			c.HP, c.MaxHP = 1e9, 1e9 // bleed and cleave take shares of it: only stuns are measured
			c.X, c.Y = at(j)
		}
		w.grid.build(w.Creeps)
		if next -= Dt; next <= 0 {
			w.swingLegend(p, w.playerStats(p), 0, false)
			next += every
		}
		for j := range w.Creeps {
			w.Creeps[j].stepSunder()
			if w.Creeps[j].stunned() {
				held++
			}
			all++
		}
	}
	return float64(held) / float64(all)
}

// The greatsword stuns more than the katana: each blow for longer, and one landing on a creep
// already stopped renews it, so its slower swing still keeps what it strikes held, a goliath
// alone or a crowd.
func TestTheGreatswordStunsMoreThanTheKatana(t *testing.T) {
	for _, kind := range []CreepKind{CWalker, CBrute, CGoliath} {
		for _, n := range []int{1, 16} {
			g := heldShare(WGreat, MaxLevel, 1, false, kind, n)
			k := heldShare(WKatana, MaxLevel, 1, true, kind, n)
			t.Logf("%-8s x%-2d held: greatsword %3.0f%%, pair of katanas %3.0f%%", Creeps[kind].Name, n, g*100, k*100)
			if g <= k {
				t.Errorf("%d %s held %.0f%% of the time by a greatsword, %.0f%% by a pair of katanas", n, Creeps[kind].Name, g*100, k*100)
			}
		}
	}
	if g := heldShare(WGreat, MaxLevel, 1, false, CGoliath, 1); g < .95 {
		t.Errorf("a full greatsword holds a goliath %.0f%% of the time", g*100)
	}
}
