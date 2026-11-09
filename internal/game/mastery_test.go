package game

import (
	"math"
	"testing"
)

// fullBlade is legendary blade k fully bought and evolved, a pair if dual.
func fullBlade(dual bool) WeaponState {
	return WeaponState{Owned: true, Lv: lv(MaxLevel, MaxLevel, MaxLevel, MaxLevel), Evo: 1, Dual: dual}
}

// A blade's mastery grows with every level, its evolution and a second katana, and with it the
// blade hits harder, stuns longer and has its art back sooner; nothing else has any.
func TestMasteryGrowsWithTheBlade(t *testing.T) {
	for _, k := range []WeaponKind{WKatana, WGreat} {
		prev := WeaponState{Owned: true}
		if m := prev.Mastery(k); m != 0 {
			t.Errorf("a %s just found has mastery %.2f", Weapons[k].Name, m)
		}
		for l := uint8(1); l <= MaxLevel; l++ {
			ws := WeaponState{Owned: true, Lv: lv(l, l, l, l)}
			a, b := prev.Stats(k), ws.Stats(k)
			if b.Damage <= a.Damage || b.Stun <= a.Stun || ArtCooldown(k, &ws) >= ArtCooldown(k, &prev) {
				t.Errorf("%s level %d: damage %.0f->%.0f stun %.1f->%.1f art %.1fs->%.1fs", Weapons[k].Name, l,
					a.Damage, b.Damage, a.Stun, b.Stun, ArtCooldown(k, &prev), ArtCooldown(k, &ws))
			}
			prev = ws
		}
		full := fullBlade(false)
		if m := full.Mastery(k); m != 1 {
			t.Errorf("a full %s has mastery %.2f", Weapons[k].Name, m)
		}
		if c := ArtCooldown(k, &full); c > 1.2 {
			t.Errorf("a full %s's art is back in %.1fs", Weapons[k].Name, c)
		}
	}
	pair := fullBlade(true)
	if m := pair.Mastery(WKatana); math.Abs(float64(m-masteryMax)) > 1e-6 {
		t.Errorf("a full pair of katanas has mastery %.2f, want %.2f", m, masteryMax)
	}
	gun := WeaponState{Owned: true, Lv: lv(MaxLevel, MaxLevel, MaxLevel, MaxLevel), Evo: 1}
	if gun.Mastery(WShotgun) != 0 || gun.Mastery(WCrowbar) != 0 {
		t.Error("mastery on a weapon that is no legendary blade")
	}
}

// masteryRig is a bare world with a survivor holding ws as blade k on open ground, and a
// mauler a step east of them.
func masteryRig(t *testing.T, k WeaponKind, ws WeaponState) (*World, *Player, *Creep) {
	t.Helper()
	w := newBare(11)
	w.PhaseLeft = 1e6
	p := mustJoin(t, w, "ana")
	x, y := openLine(t, w, 8)
	p.X, p.Y = x, y
	p.Weapons[k] = ws
	p.Cur = k
	if !w.SpawnCreep(CMauler, x+2, y) {
		t.Fatal("no mauler")
	}
	c := &w.Creeps[len(w.Creeps)-1]
	c.HP, c.MaxHP = 1e6, 1e6
	w.grid.build(w.Creeps)
	return w, p, c
}

// A mastered blade's stun stops a mauler's slam winding up, ring and all; a blade just found
// does not.
func TestAMasteredBladeBreaksASlam(t *testing.T) {
	for _, tc := range []struct {
		k      WeaponKind
		ws     WeaponState
		break_ bool
	}{
		{WKatana, WeaponState{Owned: true}, false},
		{WKatana, fullBlade(true), true},
		{WGreat, fullBlade(false), true},
	} {
		w, p, c := masteryRig(t, tc.k, tc.ws)
		c.slam = 0
		if !w.bossSlam(c, p) || c.slam <= slams[CMauler].every-slams[CMauler].windup {
			t.Fatal("the mauler did not wind up")
		}
		w.swingLegend(p, w.playerStats(p), 0, false)
		ring := false
		for _, e := range w.Effects {
			ring = ring || e.Kind == EffSlam
		}
		if winding := c.slam > slams[CMauler].every-slams[CMauler].windup; ring == tc.break_ || winding == tc.break_ {
			t.Errorf("%s mastery %.2f: ring %v, winding %v, want broken %v", Weapons[tc.k].Name, tc.ws.Mastery(tc.k), ring, winding, tc.break_)
		}
	}
}

// A mastered blade's stun makes a mauler let go of the teammate it holds.
func TestAMasteredBladeBreaksAGrab(t *testing.T) {
	w, p, c := masteryRig(t, WKatana, fullBlade(true))
	q := mustJoin(t, w, "bo")
	q.X, q.Y = c.X+1.4, c.Y
	if !w.creepGrab(c, &Creeps[CMauler], q) || !q.held {
		t.Fatal("the mauler did not grab")
	}
	w.swingLegend(p, w.playerStats(p), 0, false)
	w.stepHeld(q)
	if c.grip != 0 || q.held {
		t.Errorf("still held: grip %d, held %v", c.grip, q.held)
	}
}

// Every greatsword swing shakes the ground where it lands, out past the swing, harder and
// further with mastery.
func TestTheGreatswordSendsAShockwave(t *testing.T) {
	reach := func(ws WeaponState) (hurt bool) {
		w := newBare(13)
		w.PhaseLeft = 1e6
		p := mustJoin(t, w, "ana")
		x, y := openLine(t, w, 10)
		p.X, p.Y = x, y
		p.Weapons[WGreat] = ws
		p.Cur = WGreat
		st := w.playerStats(p)
		// Past the swing's reach, ahead: only the shockwave can get there.
		if !w.SpawnCreep(CWalker, x+st.Range+3.5, y) {
			t.Fatal("no creep")
		}
		c := &w.Creeps[len(w.Creeps)-1]
		c.HP, c.MaxHP = 1e6, 1e6
		w.grid.build(w.Creeps)
		w.swingLegend(p, st, 0, false)
		return c.HP < 1e6
	}
	if reach(WeaponState{Owned: true}) {
		t.Error("a greatsword just found shakes the ground 3.5 tiles past its reach")
	}
	if !reach(fullBlade(false)) {
		t.Error("a full greatsword's shockwave did not reach 3.5 tiles past its swing")
	}
}

// A mastered blade in hand takes some of every blow.
func TestAMasteredBladeGuards(t *testing.T) {
	w := newBare(17)
	p := mustJoin(t, w, "ana")
	p.Weapons[WKatana] = fullBlade(true)
	p.Cur = WKatana
	p.HP, p.MaxHP = 1000, 1000
	w.hurtPlayer(p, 100)
	if got, want := 1000-p.HP, float32(100*(1-masteryGuard)); math.Abs(float64(got-want)) > .01 {
		t.Errorf("took %.1f of 100, want %.1f", got, want)
	}
}
