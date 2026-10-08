package game

import (
	"math/rand/v2"
	"strings"
	"testing"
)

func TestSitesAreReachableAndFixedBySeed(t *testing.T) {
	for seed := uint64(1); seed <= 10; seed++ {
		w := New(seed)
		var n [NumSiteKinds]int
		for i, s := range w.Sites {
			n[s.Kind]++
			if !CanStand(w, s.SX, s.SY) {
				t.Errorf("seed %d: site %d (%s) cannot be stood at", seed, i, SiteDefs[s.Kind].Name)
			}
			if dx, dy := s.SX-w.CoreX, s.SY-w.CoreY; dx*dx+dy*dy < 28*28 {
				t.Errorf("seed %d: site %d is inside the base", seed, i)
			}
		}
		wrecks, kinds := 0, 0
		for k := SiteKind(0); k < NumSiteKinds; k++ {
			if k.Wreck() && n[k] > 0 {
				wrecks += n[k]
				kinds++
			}
		}
		if n[SiteHouse] < 25 || wrecks < 15 || kinds < 4 || n[SiteCrate] < 10 {
			t.Errorf("seed %d: sites %v", seed, n)
		}
		if again := New(seed); len(again.Sites) != len(w.Sites) || again.Sites[len(w.Sites)-1] != w.Sites[len(w.Sites)-1] {
			t.Errorf("seed %d: sites differ between two worlds", seed)
		}
	}
	// Placing sites must not change the terrain a seed makes.
	w := New(3)
	g := Generate(3, w.W, w.H)
	diff := 0
	for i := range g {
		if g[i] != w.Terrain[i] {
			diff++
		}
	}
	if diff > 2000 { // the base and the spawn clearings
		t.Errorf("%d tiles differ from Generate", diff)
	}
}

func TestLuckShiftsRarity(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	count := func(luck float64) [NumRarities]int {
		var c [NumRarities]int
		for i := 0; i < 100000; i++ {
			c[RollRarity(rng.Float64(), luck)]++
		}
		return c
	}
	plain := count(0)
	for r, wt := range rarityWeight {
		got := float64(plain[r]) / 1000
		if got < wt-1.5 || got > wt+1.5 {
			t.Errorf("%v: %.1f%%, want about %.0f%%", Rarity(r), got, wt)
		}
	}
	lucky := count(4)
	if lucky[Junk] >= plain[Junk] || lucky[Rare] <= plain[Rare] || lucky[Jackpot] <= plain[Jackpot] {
		t.Errorf("luck did not help: %v vs %v", lucky, plain)
	}
}

func TestSearchPaysOnceAndAHitStartsItOver(t *testing.T) {
	w := newBare(4)
	p, _ := w.Join("sam", "sam@example")
	si := -1
	for i, s := range w.Sites {
		if s.Kind == SiteCrate {
			si = i
			break
		}
	}
	s := &w.Sites[si]
	p.X, p.Y = s.SX, s.SY
	before := p.Gold
	if err := w.OrderLoot(p, si); err != nil {
		t.Fatal(err)
	}
	w.Step()
	w.Step()
	if p.Search <= 0 {
		t.Fatal("the search did not start")
	}
	w.hurtPlayer(p, 1)
	w.Step()
	if p.Search != 0 {
		t.Fatalf("a hit left the search at %.2fs", p.Search)
	}
	if !run(w, TickRate*5, func() bool { return s.Searched }) {
		t.Fatalf("never searched; order %v search %.2f", p.Order.Kind, p.Search)
	}
	if p.Order.Kind != OrderIdle {
		t.Error("the order did not end")
	}
	found := p.Gold != before || p.Weapons[p.Cur].Lv != [NumTracks]uint8{} || p.Cur != WPistol
	for g := range p.Gear {
		found = found || p.Gear[g] > 0
	}
	for a := 1; a < NumAbilities; a++ {
		found = found || p.Abil[a].Lv > 0
	}
	if !found {
		t.Error("the search gave nothing")
	}
	if err := w.OrderLoot(p, si); err == nil {
		t.Error("searched the same site twice")
	}
}

func TestEveryFindCanBeGiven(t *testing.T) {
	w := New(9)
	p, _ := w.Join("lu", "lu@example")
	for i := 0; i < 400; i++ {
		r := Rarity(i % int(NumRarities))
		gold := p.Gold
		if what := w.grant(p, r, FavorNone); what == "" {
			t.Fatalf("%v: no description", r)
		}
		if p.Gold < gold {
			t.Fatal("a find cost gold")
		}
	}
	// By now nearly everything is owned and maxed; the finds must have turned into gold.
	if p.Gold < 10000 {
		t.Errorf("gold %d", p.Gold)
	}
}

func TestRestockRefillsSome(t *testing.T) {
	w := New(2)
	for i := range w.Sites {
		w.Sites[i].Searched = true
	}
	n := w.restock()
	if n == 0 || n == len(w.Sites) {
		t.Errorf("restocked %d of %d", n, len(w.Sites))
	}
}

func TestWrecksHaveTheirOwnTwists(t *testing.T) {
	w := New(13)
	p, _ := w.Join("ana", "ana@example")
	for i := range w.Sites {
		s := &w.Sites[i]
		if s.Kind == SiteArmy && s.Guard < 2 {
			t.Fatalf("an army truck with guard level %d", s.Guard)
		}
	}
	s := &w.Sites[0]
	s.Kind, s.Searched, s.Guard = SiteAmbulance, false, 2
	p.HP = 10
	w.search(p, 0)
	if p.HP != p.MaxHP {
		t.Fatalf("the ambulance kit should patch the searcher up, hp %v", p.HP)
	}
	s.Kind, s.Searched = SiteBus, false
	w.Notes = w.Notes[:0]
	w.search(p, 0)
	if n := w.Notes[len(w.Notes)-1].Text; !strings.Contains(n, " and ") {
		t.Fatalf("a bus gives two finds: %q", n)
	}
}
