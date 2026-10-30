package game

import (
	"strings"
	"testing"
)

// openLine is a spot in w with n tiles of open ground east of it, out of the base.
func openLine(t *testing.T, w *World, n int) (float32, float32) {
	t.Helper()
	for y := 10; y < w.H-10; y++ {
		for x := 10; x < w.W-n-10; x++ {
			fx, fy := float32(x)+.5, float32(y)+.5
			if dx, dy := fx-w.CoreX, fy-w.CoreY; dx*dx+dy*dy < 30*30 {
				continue
			}
			ok := true
			for k := 0; k <= n && ok; k++ {
				ok = CanStand(w, fx+float32(k), fy) && CanStand(w, fx+float32(k), fy-1) && CanStand(w, fx+float32(k), fy+1)
			}
			if ok {
				return fx, fy
			}
		}
	}
	t.Fatal("no open ground")
	return 0, 0
}

// A legendary is found, never sold, and comes with its own art and two evolutions; of the rest,
// only the crowbar has them.
func TestLegendariesAreFoundNotSold(t *testing.T) {
	for k := WeaponKind(0); k < NumWeapons; k++ {
		if !k.Legendary() && k != WCrowbar {
			if Arts[k].Name != "" {
				t.Errorf("the %s has a weapon art", Weapons[k].Name)
			}
			continue
		}
		if k.Sold() {
			t.Errorf("the armory sells the %s", Weapons[k].Name)
		}
		if Arts[k].Name == "" || LegendEvos[k][0].Name == "" || LegendEvos[k][1].Name == "" {
			t.Errorf("the %s has no art or evolutions", Weapons[k].Name)
		}
	}
	w := newBare(3)
	p := mustJoin(t, w, "ana")
	p.Gold = 1e6
	if err := w.BuyWeapon(p, WKatana); err == nil {
		t.Error("bought a katana")
	}
}

// A legendary cuts harder than a maxed crowbar, and the katana's cuts bleed a creep: blood
// loss bursts for a share of its hp.
func TestTheKatanaBleedsAndOutcutsTheCrowbar(t *testing.T) {
	// Level for level, on one brute and on a crowd.
	for _, l := range []uint8{0, 2, MaxLevel} {
		crow := weaponDPS(weaponRig(WCrowbar, l), CBrute, 0, benchClose, false)
		for _, k := range []WeaponKind{WKatana, WGreat} {
			if d := weaponDPS(weaponRig(k, l), CBrute, 0, benchClose, false); d < crow*1.4 {
				t.Errorf("level %d: a %s does %.0f a second on a brute, the crowbar %.0f", l, Weapons[k].Name, d, crow)
			}
		}
	}
	a := newArena(10)
	a.arm(weaponRig(WKatana, 0))
	a.w.SpawnCreep(CBrute, a.ox+1.5, a.oy)
	a.w.Creeps[0].HP = 1e6
	burst := false
	for range 6 * TickRate {
		a.w.Blasts = a.w.Blasts[:0]
		a.tick(still)
		for _, b := range a.w.Blasts {
			burst = burst || b.Kind == BlastBleed
		}
	}
	if !burst {
		t.Fatal("six seconds of katana and no blood loss")
	}
	// A pair cuts faster than one.
	one := weaponDPS(weaponRig(WKatana, 2), CBrute, 0, benchClose, false)
	r := weaponRig(WKatana, 2)
	r.dual = true
	if two := weaponDPS(r, CBrute, 0, benchClose, false); two < one*1.4 {
		t.Errorf("two katanas do %.0f a second, one %.0f", two, one)
	}
}

// With a legendary in hand, F is its weapon art: Flash Draw crosses the ground in one cut and
// takes every creep along the line; without one, F is still the dash.
func TestFlashDrawCutsTheWholeLine(t *testing.T) {
	w := newBare(5)
	w.PhaseLeft = 1e6
	p := mustJoin(t, w, "ana")
	p.HP, p.MaxHP = 1e6, 1e6
	x, y := openLine(t, w, 8)
	p.X, p.Y = x, y
	p.Weapons[WKatana] = WeaponState{Owned: true}
	p.Cur = WKatana
	var ids []uint16
	for _, d := range []float32{2, 4, 6} {
		if !w.SpawnCreep(CBrute, x+d, y+.3) {
			t.Fatal("no creep")
		}
		c := &w.Creeps[len(w.Creeps)-1]
		c.HP = 1e5
		ids = append(ids, c.ID)
	}
	if err := w.Cast(p, AbDash, x+20, y); err != nil {
		t.Fatal(err)
	}
	if p.Art != ArtFlash {
		t.Fatal("F with a katana in hand is not Flash Draw")
	}
	if err := w.Cast(p, AbDash, x+20, y); err == nil {
		t.Fatal("drew twice at once")
	}
	run(w, TickRate, func() bool { return p.Art == ArtNone })
	if p.X < x+Arts[WKatana].Range-.5 {
		t.Errorf("the draw went %.1f tiles, want %g", p.X-x, Arts[WKatana].Range)
	}
	for _, id := range ids {
		for i := range w.Creeps {
			if c := &w.Creeps[i]; c.ID == id && c.HP >= 1e5 {
				t.Errorf("the creep at %.0f was not cut", c.X-x)
			}
		}
	}
	if err := w.Cast(p, AbDash, x, y); err == nil || p.ArtCool <= 0 {
		t.Error("Flash Draw has no cooldown")
	}
	// With the pistol in hand, F dashes.
	p.ArtCool = 0
	p.Cur = WPistol
	p.Abil[AbDash].Lv = 1
	if err := w.Cast(p, AbDash, p.X-5, p.Y); err != nil || p.Art != ArtNone {
		t.Errorf("F with a pistol: %v, art %d", err, p.Art)
	}
}

// Skyfall leaps, nothing touches the survivor in the air, and the landing stuns all round.
func TestSkyfallLandsAndStuns(t *testing.T) {
	w := newBare(5)
	w.PhaseLeft = 1e6
	p := mustJoin(t, w, "ana")
	x, y := openLine(t, w, 8)
	p.X, p.Y = x, y
	p.Weapons[WGreat] = WeaponState{Owned: true}
	p.Cur = WGreat
	if !w.SpawnCreep(CBrute, x+6, y) {
		t.Fatal("no creep")
	}
	c := &w.Creeps[len(w.Creeps)-1]
	id := c.ID
	c.HP = 1e5
	if err := w.Cast(p, AbDash, x+6, y); err != nil {
		t.Fatal(err)
	}
	hp := p.HP
	w.hurtPlayer(p, 50)
	if p.HP != hp {
		t.Error("hurt in the air")
	}
	run(w, TickRate, func() bool { return p.Art == ArtNone })
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.ID == id && (c.HP >= 1e5 || !c.stunned()) {
			t.Errorf("the landing left the creep at %.0f hp, stunned %v", c.HP, c.stunned())
		}
	}
}

// A legendary evolves once its tracks add up to EvolveAt, at the armory, into one of two.
func TestALegendaryEvolves(t *testing.T) {
	w := newBare(7)
	p := mustJoin(t, w, "ana")
	a := &w.Structs[w.Armory]
	p.X, p.Y = a.CX(), a.CY()+2
	p.Gold = 1e5
	if err := w.EvolveWeapon(p, WPistol, 1); err == nil {
		t.Fatal("evolved a pistol")
	}
	if err := w.EvolveWeapon(p, WKatana, 1); err == nil {
		t.Fatal("evolved a katana nobody carries")
	}
	p.Weapons[WKatana] = WeaponState{Owned: true, Lv: [NumTracks]uint8{3, 3, 3, 2}}
	if err := w.EvolveWeapon(p, WKatana, 1); err == nil {
		t.Fatal("evolved at 11")
	}
	p.Weapons[WKatana].Lv[3] = 3
	g := p.Gold
	if err := w.EvolveWeapon(p, WKatana, 2); err != nil {
		t.Fatal(err)
	}
	if p.Gold != g-LegendEvoCost || p.Weapons[WKatana].Evo != 2 {
		t.Fatalf("paid %d, evo %d", g-p.Gold, p.Weapons[WKatana].Evo)
	}
	p.Cur = WKatana
	if ArtRange(p) <= Arts[WKatana].Range {
		t.Error("Moonlit Edge draws no further")
	}
	if err := w.EvolveWeapon(p, WKatana, 1); err == nil {
		t.Fatal("evolved twice")
	}
}

// Every map has its shrines far out, and an altar gives a legendary; a second katana makes a
// pair.
func TestTheShrinesHoldLegendaries(t *testing.T) {
	for seed := uint64(1); seed <= 20; seed++ {
		w := New(seed)
		idx := w.shrineIdx()
		if len(idx) == 0 {
			t.Fatalf("seed %d: no shrine", seed)
		}
		for _, i := range idx {
			s := &w.Sites[i]
			if dx, dy := s.SX-w.CoreX, s.SY-w.CoreY; dx*dx+dy*dy < 40*40 {
				t.Errorf("seed %d: a shrine %.0f tiles from the generator", seed, sqrt32(dx*dx+dy*dy))
			}
			if s.Guard == 0 {
				t.Errorf("seed %d: an unguarded shrine", seed)
			}
		}
	}
	w := newBare(4)
	p := mustJoin(t, w, "ana")
	si := w.shrineIdx()[0]
	p.Weapons[WGreat] = WeaponState{Owned: true}
	w.search(p, si)
	if !p.Weapons[WKatana].Owned || p.Cur != WKatana {
		t.Fatal("the altar gave no katana to one who carries the greatsword")
	}
	if n := w.Notes[len(w.Notes)-1].Text; !strings.Contains(n, "legendary") {
		t.Errorf("the altar's note: %q", n)
	}
	w.Sites[si].Searched = false
	w.search(p, si)
	if !p.Weapons[WKatana].Dual {
		t.Fatal("a second katana did not make a pair")
	}
	// Carrying all there is, the altar sharpens what is in hand.
	w.Sites[si].Searched = false
	lv := p.Weapons[WKatana].Lv
	w.search(p, si)
	if p.Weapons[WKatana].Lv == lv {
		t.Error("no whetstones for one who carries every legendary")
	}
}

// The crowbar has an art too: Home Run winds back, then hits a wide arc for triple damage and
// hurls what it hits; it evolves as the legendaries do.
func TestTheCrowbarHitsAHomeRun(t *testing.T) {
	w := newBare(5)
	w.PhaseLeft = 1e6
	p := mustJoin(t, w, "ana")
	x, y := openLine(t, w, 8)
	p.X, p.Y = x, y
	p.Weapons[WCrowbar] = WeaponState{Owned: true}
	p.Cur = WCrowbar
	if !w.SpawnCreep(CRunner, x+1.5, y) {
		t.Fatal("no creep")
	}
	c := &w.Creeps[len(w.Creeps)-1]
	id := c.ID
	c.HP = 1e5
	if err := w.Cast(p, AbDash, x+5, y); err != nil {
		t.Fatal(err)
	}
	if p.Art != ArtHomeRun {
		t.Fatal("F with the crowbar in hand is not Home Run")
	}
	run(w, TickRate, func() bool { return p.Art == ArtNone })
	if p.X != x || p.Y != y {
		t.Error("Home Run took a step")
	}
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.ID == id && (c.HP >= 1e5 || c.X < x+2) {
			t.Errorf("the creep took %.0f and stands at %.1f", 1e5-c.HP, c.X-x)
		}
	}

	a := &w.Structs[w.Armory]
	p.X, p.Y = a.CX(), a.CY()+2
	p.Gold = 1e5
	p.Weapons[WCrowbar].Lv = [NumTracks]uint8{3, 3, 3, 3}
	if err := w.EvolveWeapon(p, WCrowbar, 2); err != nil {
		t.Fatal(err)
	}
	// Scrap King: a kill pays again and heals.
	p.X, p.Y = x, y
	p.HP = 50
	w.Creeps = w.Creeps[:0]
	if !w.SpawnCreep(CBrute, x+1, y) {
		t.Fatal("no creep")
	}
	w.Creeps[0].HP = 1
	g := p.Gold
	w.shoot(p, w.playerStats(p), 0)
	if p.HP <= 50 || p.Gold <= g {
		t.Errorf("Scrap King: hp %.0f, paid %d more for a brute", p.HP, p.Gold-g)
	}
}
