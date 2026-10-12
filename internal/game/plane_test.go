package game

import (
	"strings"
	"testing"
)

func TestThePlaneCrashIsOutInTheWildsAndHeldHard(t *testing.T) {
	for seed := uint64(1); seed <= 30; seed++ {
		w := New(seed)
		si := w.plane()
		if si < 0 {
			t.Fatalf("seed %d: no crashed plane", seed)
		}
		s := &w.Sites[si]
		if s.Tier == 0 || s.Guard != 4 || s.Guards < 8 {
			t.Errorf("seed %d: plane tier %d, guard %d with %d guards", seed, s.Tier, s.Guard, s.Guards)
		}
		st := &w.Sites[w.station()]
		if dx, dy := st.SX-s.SX, st.SY-s.SY; dx*dx+dy*dy < 30*30 {
			t.Errorf("seed %d: the plane came down on the gas station", seed)
		}
		// The hull and the tail are solid; the engines too, until they blow.
		tx, ty := planeFrame(s.SX, s.SY, s.Yaw, tailX, tailY)
		if CanStand(w, s.SX, s.SY) || CanStand(w, tx, ty) {
			t.Errorf("seed %d: the plane can be walked through", seed)
		}
		for _, i := range w.pumps() {
			if e := &w.Sites[i]; e.Kind == SiteTank && (CanStand(w, e.SX, e.SY) || planeDist(s, e.SX, e.SY) < .5) {
				t.Errorf("seed %d: an engine is walkable or inside the hull", seed)
			}
		}
		for i := range w.Sites {
			if o := &w.Sites[i]; o.Kind != SitePlane && o.Kind != SiteTank && planeDist(s, o.SX, o.SY) < 3 {
				t.Errorf("seed %d: a %s lies in the plane", seed, SiteDefs[o.Kind].lower())
			}
		}
	}
}

func TestRaidingThePlane(t *testing.T) {
	w := newBare(4)
	p, _ := w.Join("ana", "ana@example")
	p.HP, p.MaxHP = 1e6, 1e6
	si := w.plane()
	s := &w.Sites[si]
	// Walking into the wreckage springs an ambush.
	x, y := planeFrame(s.SX, s.SY, s.Yaw, 0, planeHalfW+PlayerRadius+.2)
	p.X, p.Y = x, y
	w.ambushOnEntry(p)
	if s.Sprung != 1 {
		t.Fatal("no ambush in the wreckage")
	}
	if !siteReached(s, p.X, p.Y) {
		t.Fatal("can't search the plane from beside its hull")
	}
	w.search(p, si)
	n := w.Notes[len(w.Notes)-1].Text
	if !strings.Contains(n, "crashed plane's hold") || !strings.Contains(n, "manual") {
		t.Fatalf("the hold gave %q", n)
	}
	// An engine goes up when shot, and says so.
	var e int
	for _, i := range w.pumps() {
		if w.Sites[i].Kind == SiteTank {
			e = i
		}
	}
	w.lightPump(e, int8(p.ID), Dt)
	w.Notes = w.Notes[:0]
	w.stepPumps()
	if !w.Sites[e].Searched {
		t.Fatal("the engine didn't go up")
	}
	found := false
	for _, n := range w.Notes {
		found = found || strings.Contains(n.Text, "crashed plane's engines")
	}
	if !found {
		t.Fatal("nobody heard the engine go up")
	}
}

func TestTheNewWrecksGiveWhatTheyHold(t *testing.T) {
	w := newBare(6)
	p, _ := w.Join("ana", "ana@example")
	seen := map[SiteKind]bool{}
	for seed := uint64(1); seed <= 10; seed++ {
		for _, s := range New(seed).Sites {
			seen[s.Kind] = true
		}
	}
	for _, k := range []SiteKind{SiteFire, SiteArmored, SiteCamper, SiteMoto} {
		if !seen[k] {
			t.Errorf("no %s on ten maps", SiteDefs[k].lower())
		}
	}
	// A fire engine always has a medkit; an armoured van pays in gold.
	w.Sites = append(w.Sites, Site{Kind: SiteFire, SX: 5, SY: 5}, Site{Kind: SiteArmored, SX: 9, SY: 5})
	p.Medkits = 0
	w.search(p, len(w.Sites)-2)
	if p.Medkits != 1 {
		t.Error("no medkit in the fire engine")
	}
	g := p.Gold
	for i := 0; i < 20; i++ {
		w.Sites[len(w.Sites)-1].Searched = false
		w.search(p, len(w.Sites)-1)
	}
	if p.Gold-g < 20*60 {
		t.Errorf("twenty armoured vans paid %d gold", p.Gold-g)
	}
}
