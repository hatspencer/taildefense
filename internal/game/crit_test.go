package game

import "testing"

// A melee weapon's crit chance and its multiplier grow with every level bought on it; guns
// have none.
func TestMeleeCritsGrowWithTheWeapon(t *testing.T) {
	for _, k := range []WeaponKind{WCrowbar, WKatana, WGreat} {
		prev := (&WeaponState{Owned: true}).Stats(k)
		if prev.Crit <= 0 || prev.CritMul <= 1 {
			t.Errorf("%s just found: crit %.2f x%.2f", Weapons[k].Name, prev.Crit, prev.CritMul)
		}
		for l := uint8(1); l <= MaxLevel; l++ {
			s := (&WeaponState{Owned: true, Lv: lv(l, l, l, l)}).Stats(k)
			if s.Crit <= prev.Crit || s.CritMul <= prev.CritMul {
				t.Errorf("%s level %d: crit %.2f->%.2f x%.2f->x%.2f", Weapons[k].Name, l, prev.Crit, s.Crit, prev.CritMul, s.CritMul)
			}
			prev = s
		}
	}
	if s := (&WeaponState{Owned: true, Lv: lv(MaxLevel, MaxLevel, MaxLevel, MaxLevel), Evo: 1}).Stats(WShotgun); s.Crit != 0 {
		t.Errorf("a shotgun crits %.2f", s.Crit)
	}
}

// A critical hit deals critMul times the damage and shows on the creep.
func TestACriticalHitHitsHarder(t *testing.T) {
	w := newBare(4)
	p := mustJoin(t, w, "ana")
	x, y := openRow(w, 14)
	if x == 0 || !w.SpawnCreep(CWalker, x+5, y) {
		t.Fatal("no ground or no creep")
	}
	c := &w.Creeps[0]
	c.HP, c.MaxHP = 1e4, 1e4
	w.noArmor = true
	w.crit, w.critMul = 1, 2.5
	w.damage(0, 10, int8(p.ID))
	w.crit = 0
	w.damage(0, 10, int8(p.ID))
	if got := 1e4 - c.HP; got != 35 {
		t.Errorf("a crit and a plain hit of 10 took %.1f, want 35", got)
	}
	n := 0
	for _, b := range w.Blasts {
		if b.Kind == BlastCrit {
			n++
		}
	}
	if n != 1 {
		t.Errorf("%d crit blasts, want 1", n)
	}
}
