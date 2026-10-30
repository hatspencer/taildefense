package game

import "testing"

// A blades game has no guns anywhere: a survivor starts with the crowbar and a choice, picks
// once, and neither the armory, the loot nor the gas station hands over a gun.
func TestABladesGameHasNoGuns(t *testing.T) {
	w := newBare(3)
	w.Mode = ModeBlades
	p := mustJoin(t, w, "ana")
	if p.Cur != WCrowbar || !p.Picking || p.Weapons[WPistol].Owned {
		t.Fatalf("joined holding %s, picking %v", Weapons[p.Cur].Name, p.Picking)
	}
	if err := w.PickBlade(p, WPistol); err == nil {
		t.Fatal("picked a pistol")
	}
	if err := w.PickBlade(p, WGreat); err != nil {
		t.Fatal(err)
	}
	if p.Cur != WGreat || p.Picking || p.Weapons[WCrowbar].Owned {
		t.Fatalf("picked the greatsword: holding %s, picking %v, crowbar %v", Weapons[p.Cur].Name, p.Picking, p.Weapons[WCrowbar].Owned)
	}
	if err := w.PickBlade(p, WKatana); err == nil {
		t.Fatal("picked twice")
	}

	a := &w.Structs[w.Armory]
	p.X, p.Y = a.CX(), a.CY()+2
	p.Gold = 1e6
	if err := w.BuyWeapon(p, WShotgun); err == nil {
		t.Error("bought a shotgun")
	}
	for range 2000 {
		w.grant(p, Rarity(w.rng.IntN(int(NumRarities))), FavorNone)
	}
	for k := range p.Weapons {
		if p.Weapons[k].Owned && !w.allows(WeaponKind(k)) {
			t.Errorf("the loot gave a %s", Weapons[k].Name)
		}
	}
	for i := range w.Sites {
		if w.Sites[i].Kind == SiteStation {
			w.search(p, i)
			if !p.Weapons[WKatana].Owned {
				t.Error("the gas station gave no katana in a blades game")
			}
			break
		}
	}
	if err := w.Check(); err != nil {
		t.Fatal(err)
	}
	if nw := w.Restart(9); nw.Mode != ModeBlades || !nw.Players[0].Picking {
		t.Error("a restart forgot the mode")
	}
}

// A standard game starts with the pistol and no choice to make.
func TestAStandardGameHasNoPick(t *testing.T) {
	w := newBare(3)
	p := mustJoin(t, w, "ana")
	if p.Picking || p.Cur != WPistol {
		t.Fatalf("picking %v, holding %s", p.Picking, Weapons[p.Cur].Name)
	}
	if err := w.PickBlade(p, WKatana); err == nil {
		t.Fatal("picked a katana in a standard game")
	}
}

func TestParseMode(t *testing.T) {
	for s, want := range map[string]Mode{"": ModeStandard, "Blades": ModeBlades, " standard ": ModeStandard, "1": ModeBlades} {
		if m, err := ParseMode(s); err != nil || m != want {
			t.Errorf("ParseMode(%q) = %v, %v", s, m, err)
		}
	}
	if _, err := ParseMode("guns"); err == nil {
		t.Error("read guns as a mode")
	}
}
