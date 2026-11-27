package game

import (
	"math"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The page draws the places from its own copy of their plans (web/src/scene/places.ts): a
// copy that drifted would draw walls where there are none.
func TestThePageHasThePlansAsLaid(t *testing.T) {
	src, err := os.ReadFile("../../web/src/scene/places.ts")
	if err != nil {
		t.Fatal(err)
	}
	for name, plan := range map[string][]string{"CHECKPOINT_PLAN": checkpointPlan[:], "CEMETERY_PLAN": cemeteryPlan[:], "CAMP_PLAN": campPlan[:]} {
		m := regexp.MustCompile(`(?s)export const ` + name + ` = \[(.*?)\];`).FindSubmatch(src)
		if m == nil {
			t.Errorf("no %s in places.ts", name)
			continue
		}
		var rows []string
		for _, r := range regexp.MustCompile(`'([^']*)'`).FindAllSubmatch(m[1], -1) {
			rows = append(rows, string(r[1]))
		}
		if strings.Join(rows, "\n") != strings.Join(plan, "\n") {
			t.Errorf("places.ts's %s is not landmarks.go's", name)
		}
	}
}

// Every map has one checkpoint, one cemetery and one quarantine camp, each searched from a spot
// a survivor can reach, and nothing inside the cemetery's railings or the camp's wire is sealed
// off: a grave the dead climb out of, or a tent, can be walked to.
func TestEveryMapHasItsLandmarks(t *testing.T) {
	for seed := uint64(1); seed <= 20; seed++ {
		w := New(seed)
		var n [NumSiteKinds]int
		for i := range w.Sites {
			s := &w.Sites[i]
			n[s.Kind]++
			if s.Kind != SiteCheckpoint && s.Kind != SiteCemetery && s.Kind != SiteCamp {
				continue
			}
			if !CanStand(w, s.SX, s.SY) || !w.reachable(s.SX, s.SY) {
				t.Errorf("seed %d: the %s is searched from %.1f,%.1f, out of reach", seed, SiteDefs[s.Kind].lower(), s.SX, s.SY)
			}
			if !s.Kind.Walled() {
				t.Errorf("seed %d: the %s is not searched from inside", seed, SiteDefs[s.Kind].lower())
			}
			if s.Kind == SiteCheckpoint {
				continue
			}
			for y := int(s.Y); y < int(s.Y)+int(s.H); y++ {
				for x := int(s.X); x < int(s.X)+int(s.W); x++ {
					if !w.At(x, y).Solid() && !w.reachable(float32(x)+.5, float32(y)+.5) {
						t.Errorf("seed %d: tile %d,%d in the %s is sealed off", seed, x, y, SiteDefs[s.Kind].lower())
					}
				}
			}
		}
		if n[SiteCheckpoint] != 1 || n[SiteCemetery] != 1 || n[SiteCamp] != 1 {
			t.Errorf("seed %d: %d checkpoints, %d cemeteries, %d camps", seed, n[SiteCheckpoint], n[SiteCemetery], n[SiteCamp])
		}
	}
}

// The checkpoint stands across a road and leaves it open: the four road ends still lead every
// creep to the generator, and none of the spawn points is shut in by a landmark or a hamlet.
// No way in winds much further than the straight line: nothing built across it sends the
// creeps far round.
func TestTheRoadsStillLeadIn(t *testing.T) {
	worst, sum, n := float32(0), float32(0), 0
	for seed := uint64(1); seed <= 20; seed++ {
		w := New(seed)
		for _, sp := range w.SpawnPts {
			if !w.reachable(sp[0], sp[1]) {
				t.Errorf("seed %d: spawn point %.0f,%.0f cannot reach the generator", seed, sp[0], sp[1])
				continue
			}
			// The field counts 10 a tile straight and 14 across, and the base's walls on top.
			d := float32(w.flow.dist[int(sp[1])*w.W+int(sp[0])]) / 10
			dx, dy := sp[0]-w.CoreX, sp[1]-w.CoreY
			r := d / float32(math.Sqrt(float64(dx*dx+dy*dy)))
			worst, sum, n = max(worst, r), sum+d, n+1
		}
	}
	if worst > 1.6 {
		t.Errorf("a way in is %.2f times the straight line", worst)
	}
	t.Logf("ways in: %.0f tiles on average, the worst %.2f times the straight line", sum/float32(n), worst)
}

// Robbing the crypt pays gold and a rare find, and raises the dead all over the yard, once.
func TestRobbingTheCryptRaisesTheDead(t *testing.T) {
	w := newBare(4)
	p := mustJoin(t, w, "ana")
	p.HP, p.MaxHP = 1e6, 1e6
	si := -1
	for i := range w.Sites {
		if w.Sites[i].Kind == SiteCemetery {
			si = i
		}
	}
	s := &w.Sites[si]
	p.X, p.Y = s.SX, s.SY
	gold := p.Gold
	w.ambushOnSearch(si, p)
	w.search(p, si)
	if p.Gold <= gold {
		t.Error("the crypt held no gold")
	}
	risen := 0
	for _, c := range w.Creeps {
		if c.Home == int16(si+1) {
			risen++
			if c.X < float32(s.X) || c.Y < float32(s.Y) || c.X > float32(s.X)+float32(s.W) || c.Y > float32(s.Y)+float32(s.H) {
				t.Errorf("one of the dead rose at %.1f,%.1f, outside the cemetery", c.X, c.Y)
			}
		}
	}
	if s.Sprung != 1 || risen < 6 {
		t.Fatalf("sprung %d, %d risen", s.Sprung, risen)
	}
	s.Searched = false
	n := len(w.Creeps)
	w.ambushOnSearch(si, p)
	if len(w.Creeps) != n {
		t.Error("the graves opened twice")
	}
}

// Hamlets: a few clusters of houses along the roads, every one with a door to its street.
func TestHamletsLineTheRoads(t *testing.T) {
	for seed := uint64(1); seed <= 20; seed++ {
		_, houses := generate(seed, MapW, MapH)
		n := 0
		for _, h := range houses {
			if h.hamlet {
				n++
			}
		}
		if n < 8 {
			t.Errorf("seed %d: %d houses in hamlets", seed, n)
		}
	}
}
