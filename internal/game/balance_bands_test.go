package game

import (
	"math"
	"sort"
	"testing"
)

// The turrets' identities and the bands their value keeps, measured on the balance bench
// (balance_test.go). The bands are loose on purpose: they catch a turret or an evolution that
// has fallen out of its job or come to dominate, not a few per cent either way.

func t3(k StructKind) rig { return rig{name: shortName(k) + " 3", turret: k, lv: lv(3, 3, 3, 3)} }

// laneValue is r's hit points taken per 100 gold, alone beside the lane at wave.
func laneValue(r rig, wave int) float32 {
	res := runLane(laneOne(r), laneWave(wave), wave, 0)
	return res.killed / float32(res.gold) * 100
}

func median(v []float32) float32 {
	s := append([]float32(nil), v...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[len(s)/2]
}

// No evolution dominates or is a dead end: every one that fights stays within a band of the
// median per gold in a late lane, and frost's two, which only slow, buy at least nearly what
// more of their partner would beside it.
func TestEvolutionsKeepToABand(t *testing.T) {
	const wave = 29
	var vals []float32
	var names []string
	for _, k := range turretKinds {
		if k == STurretFrost {
			continue
		}
		for e := uint8(1); e <= 2; e++ {
			r := evoRig(k, e)
			vals = append(vals, laneValue(r, wave))
			names = append(names, r.name)
		}
	}
	m := median(vals)
	for i, v := range vals {
		if v < .65*m || v > 1.45*m {
			t.Errorf("%s: %.0f hp per 100 gold at wave %d, the median evolution %.0f", names[i], v, wave, m)
		}
	}
	kinds := laneWave(wave)
	for e := uint8(1); e <= 2; e++ {
		gain, own := supportGain(t3(STurretGun), []piece{{evoRig(STurretFrost, e), 1, 0}}, kinds, wave)
		if gain < .8*own {
			t.Errorf("%s beside a gun turret adds %.0f per 100 gold, more gun %.0f", Evolutions[STurretFrost][e-1].Name, gain, own)
		}
	}
}

// Every turret at level 0 earns its place early: the fighting ones take a real share of a
// wave 9 lane alone, and frost beside a gun turret buys more than more gun would.
func TestEveryTurretIsUsefulAtLevelZero(t *testing.T) {
	const wave = 9
	kinds := laneWave(wave)
	for _, k := range turretKinds {
		if k == STurretFrost {
			continue
		}
		if res := runLane(laneOne(rig{turret: k}), kinds, wave, 0); res.share < .2 {
			t.Errorf("a %s at level 0 takes %.0f%% of a wave %d lane", Structs[k].Name, res.share*100, wave)
		}
	}
	gain, own := supportGain(t3(STurretGun), []piece{{rig{turret: STurretFrost}, 1, 0}}, laneWave(19), 19)
	if gain < own {
		t.Errorf("a frost tower beside a gun turret adds %.0f per 100 gold, more gun %.0f", gain, own)
	}
}

// Nothing is useless by waves 20 to 30: every turret at level 3 and every evolution keeps at
// least half the median's value per gold in a wave 29 lane, frost by what it adds beside a gun.
func TestNothingIsUselessLate(t *testing.T) {
	const wave = 29
	var vals []float32
	var names []string
	for _, r := range turretRigs() {
		if r.lv == lv(0, 0, 0, 0) || r.lv == lv(5, 5, 5, 5) {
			continue
		}
		v := float32(0)
		if r.turret == STurretFrost {
			v, _ = supportGain(t3(STurretGun), []piece{{r, 1, 0}}, laneWave(wave), wave)
		} else {
			v = laneValue(r, wave)
		}
		vals = append(vals, v)
		names = append(names, r.name)
	}
	m := median(vals)
	for i, v := range vals {
		if v < .5*m {
			t.Errorf("%s: %.0f per 100 gold at wave %d, the median %.0f", names[i], v, wave, m)
		}
	}
}

// bossGoldSecs is the gold that went into r times the seconds it takes to kill a wave 20
// abomination: lower is a better boss killer for the gold.
func bossGoldSecs(r rig) float32 { return ttk(r, CBoss, 0, 20, 400) * float32(r.cost()) }

// The sniper is the boss killer: at the same levels it kills an abomination for less gold and
// time than any other turret, its spotter and anti-materiel too, and by far at level 0.
func TestTheSniperKillsBosses(t *testing.T) {
	snipers := []rig{t3(STurretSniper), evoRig(STurretSniper, 1), evoRig(STurretSniper, 2)}
	worst := float32(0)
	for _, r := range snipers {
		worst = max(worst, bossGoldSecs(r))
	}
	for _, k := range turretKinds {
		if k == STurretSniper || k == STurretFrost {
			continue
		}
		for _, r := range []rig{t3(k), evoRig(k, 1), evoRig(k, 2)} {
			if g := bossGoldSecs(r); g < 1.2*worst {
				t.Errorf("%s kills an abomination for %.0f gold-seconds, the worst sniper %.0f", r.name, g, worst)
			}
		}
	}
	if s0, m0 := bossGoldSecs(rig{turret: STurretSniper}), bossGoldSecs(rig{turret: STurretMissile}); s0 > m0/1.5 {
		t.Errorf("at level 0 a sniper kills a boss for %.0f gold-seconds, a missile battery %.0f", s0, m0)
	}
}

// Missiles are a big blast but inaccurate: a battery's missiles come down spread round a lone
// creep that stands still, and do less to it than they would landing true.
func TestMissilesBlastWideButScatter(t *testing.T) {
	st := TurretStats(STurretMissile, lv(0, 0, 0, 0))
	if st.Blast < Structs[STurretCannon].Blast*.9 || st.Scatter <= 0 {
		t.Fatalf("missile blast %.1f scatter %.1f", st.Blast, st.Scatter)
	}
	a := newArena(1)
	a.arm(rig{turret: STurretMissile})
	a.w.SpawnCreep(CWalker, a.ox+8, a.oy)
	c := &a.w.Creeps[0]
	c.HP = 1e6
	a.w.grid.build(a.w.Creeps)
	a.w.stepTurrets()
	var off float32
	for _, r := range a.w.Rockets {
		lx, ly := r.X+r.VX*r.TTL, r.Y+r.VY*r.TTL
		off = max(off, float32(math.Hypot(float64(lx-c.X), float64(ly-c.Y))))
	}
	if off < .2 {
		t.Errorf("a salvo of %d came down within %.2f of its mark", len(a.w.Rockets), off)
	}
	r := rig{turret: STurretMissile}
	true_ := st.Damage * float32(st.Salvo) * st.Rate
	if got := dummyDPS(r, CWalker, false, 8, 1); got > .9*true_ {
		t.Errorf("a missile battery does %.0f a second to a lone walker, %.0f landing true", got, true_)
	}
	// Against a quick creep running at it, more of them miss than against a slow one.
	quick, _ := clearTime(r, mix{"hounds", []CreepKind{CHound}, []int{1}}, 13, 20, walk, false)
	slow, _ := clearTime(r, mix{"walkers", []CreepKind{CWalker}, []int{1}}, 13, 20, walk, false)
	hq, hw := Creeps[CHound].HP, Creeps[CWalker].HP
	if quick/hq < slow/hw {
		t.Errorf("hounds die at %.2f s per base hp, walkers %.2f", quick/hq, slow/hw)
	}
}

// The tesla chains on crowds: it clears a pack faster than a gun turret at the same levels,
// and what a pack is to it beside one creep is far more than to the gun; and a crowd bunched
// in a lane it takes for its gold better than the gun, the cheapest turret there is.
func TestTheTeslaChainsOnCrowds(t *testing.T) {
	tesla, gun := t3(STurretTesla), t3(STurretGun)
	tp, _ := clearTime(tesla, mixPack, 6, 20, still, false)
	gp, _ := clearTime(gun, mixPack, 6, 20, still, false)
	if !(tp < gp) {
		t.Errorf("a pack takes the tesla %.1f s, the gun %.1f s", tp, gp)
	}
	td, gd := dummyDPS(tesla, CWalker, false, 4, 1), dummyDPS(gun, CWalker, false, 4, 1)
	// A pack's seconds times one creep's damage a second: how many creeps' worth it hits at once.
	if te, ge := 1/(tp*td), 1/(gp*gd); te < 1.5*ge {
		t.Errorf("tesla %.1f s on a pack, %.0f/s on one; gun %.1f s, %.0f/s", tp, td, gp, gd)
	}
	// Bunched up, and at a wave where neither takes the whole of it, so the gold is what
	// limits them: the swarm at level 0, the last wave's mix at 3.
	value := func(r rig, wave int) float32 {
		res := runLaneGap(laneOne(r), laneWave(wave), wave, 0, supportGap)
		return res.killed / float32(res.gold) * 100
	}
	for _, c := range []struct {
		tesla, gun rig
		wave       int
	}{{rig{turret: STurretTesla}, rig{turret: STurretGun}, 20}, {tesla, gun, 29}} {
		if tv, gv := value(c.tesla, c.wave), value(c.gun, c.wave); tv < gv {
			t.Errorf("wave %d lane at level %d: the tesla %.0f per 100 gold, the gun %.0f", c.wave, c.tesla.lv[0], tv, gv)
		}
	}
}

// The cannon is slow, heavy splash: it fires the least often of the crowd turrets, each shell
// a handful of gun rounds, and a blob is where it beats the gun for its gold.
func TestTheCannonIsSlowHeavySplash(t *testing.T) {
	cn, gn := Structs[STurretCannon], Structs[STurretGun]
	// The missile battery fires as seldom, but a salvo at a time.
	for _, k := range []StructKind{STurretGun, STurretTesla} {
		if Structs[k].Rate <= cn.Rate {
			t.Errorf("a %s fires %.2f/s, the cannon %.2f/s", Structs[k].Name, Structs[k].Rate, cn.Rate)
		}
	}
	if cn.Damage < 4*gn.Damage || cn.Blast < 2 {
		t.Errorf("cannon %.0f dmg %.1f blast, gun %.0f", cn.Damage, cn.Blast, gn.Damage)
	}
	c, g := rig{turret: STurretCannon}, rig{turret: STurretGun}
	cp, _ := clearTime(c, mixPack, 6, 10, still, false)
	gp, _ := clearTime(g, mixPack, 6, 10, still, false)
	if cp*float32(c.cost()) >= gp*float32(g.cost()) {
		t.Errorf("a pack takes the cannon %.1f s for %d gold, the gun %.1f s for %d", cp, c.cost(), gp, g.cost())
	}
}

// Frost is control that multiplies the others: it barely hurts on its own, its special track
// deepens the slow, and beside any partner its gold buys about what more of the partner would.
func TestFrostMultipliesTheOthers(t *testing.T) {
	f, g := t3(STurretFrost), t3(STurretGun)
	if fd, gd := dummyDPS(f, CWalker, false, 4, 1), dummyDPS(g, CWalker, false, 4, 1); fd > .1*gd {
		t.Errorf("frost does %.0f/s to a walker, a gun turret %.0f/s", fd, gd)
	}
	prev := float32(0)
	for l := uint8(0); l <= MaxLevel; l++ {
		c := TurretStats(STurretFrost, lv(0, 0, 0, l)).Chill
		if c <= prev || c > maxChill {
			t.Errorf("frost special %d chills %.2f, the level before %.2f", l, c, prev)
		}
		prev = c
	}
	const wave = 29
	kinds := laneWave(wave)
	for _, p := range []rig{t3(STurretGun), t3(STurretCannon), t3(STurretTesla), t3(STurretMissile)} {
		gain, own := supportGain(p, []piece{{f, 1, 0}}, kinds, wave)
		if gain < .65*own {
			t.Errorf("frost 3 beside %s adds %.0f per 100 gold, more of it %.0f", p.name, gain, own)
		}
	}
}

// Traps are worth their cost: spikes and vents on the road take about what a gun turret's
// gold would, mines bunched creeps late, and tar beside a gun turret adds what more gun would.
func TestTrapsAreWorthTheirCost(t *testing.T) {
	for _, wave := range []int{9, 29} {
		kinds := laneWave(wave)
		gun := runLane(laneOne(rig{turret: STurretGun}), kinds, wave, 0)
		per := gun.killed / float32(gun.gold)
		for _, r := range []struct {
			name string
			ps   []piece
		}{{"spikes", trapRow(rigSpikes, 5)}, {"vents", trapRow(rigVent, 2)}} {
			if res := runLane(r.ps, kinds, wave, 0); res.killed/float32(res.gold) < .6*per {
				t.Errorf("wave %d: %s take %.0f per 100 gold, a gun turret %.0f", wave, r.name, res.killed/float32(res.gold)*100, per*100)
			}
		}
	}
	const wave = 29
	kinds := laneWave(wave)
	gun := runLaneGap(laneOne(rig{turret: STurretGun}), kinds, wave, 0, supportGap)
	if res := runLaneGap(trapRow(rigMine, 5), kinds, wave, 0, supportGap); res.killed/float32(res.gold) < .6*gun.killed/float32(gun.gold) {
		t.Errorf("mines take %.0f per 100 gold, a gun turret %.0f", res.killed/float32(res.gold)*100, gun.killed/float32(gun.gold)*100)
	}
	if gain, own := supportGain(t3(STurretGun), trapRow(rigTar, 5), laneWave(19), 19); gain < .6*own {
		t.Errorf("tar beside a gun turret adds %.0f per 100 gold, more gun %.0f", gain, own)
	}
}

// The Overload clears the chaff at the walls at every wave, and only dents the big ones.
func TestTheOverloadClearsTheChaff(t *testing.T) {
	for _, wave := range []int{10, 20, 30} {
		w := New(3)
		w.Wave = wave
		d := w.overloadDamage()
		for _, k := range []CreepKind{CWalker, CRunner, CSwarmer, CHound, CSpitter, CHurler} {
			if hp := Creeps[k].HP * HPScale(wave); d < hp {
				t.Errorf("wave %d: the Overload deals %.0f, a %s has %.0f", wave, d, Creeps[k].Name, hp)
			}
		}
		if hp := Creeps[CBrute].HP * HPScale(wave); d >= hp {
			t.Errorf("wave %d: the Overload deals %.0f, a brute has only %.0f", wave, d, hp)
		}
	}
}
