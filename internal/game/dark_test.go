package game

import "testing"

func TestNightShortensSightOutsideTheBase(t *testing.T) {
	for _, d := range []Difficulty{DiffEasy, DiffNormal, DiffHard, DiffBrutal} {
		w := NewGame(5, d)
		p, _ := w.Join("ana", "ana@example")
		far := w.sightRange(p, 28)
		if far != 28 {
			t.Fatalf("%s: a rifle at the base sees %.1f", d, far)
		}
		p.X = w.CoreX + 40
		dark := w.diff().Dark
		if got := w.sightRange(p, 28); (dark == 0) != (got == 28) || dark > 0 && got > dark+1 {
			t.Fatalf("%s: a rifle out in the wastes sees %.1f", d, got)
		}
		// With the rifle in hand its scope sees twice as far.
		p.Cur = WRifle
		if got := w.sightRange(p, 28); dark > 0 && got != min(28, 2*dark+1) {
			t.Fatalf("%s: through the scope a rifle sees %.1f", d, got)
		}
	}
}

// At night a survivor's bullet goes through what nobody can see: a rifle shot down a line
// misses the creep out in the dark and hits the one in sight, and by day it hits both.
func TestNightShotsOnlyFindWhatIsSeen(t *testing.T) {
	for _, d := range []Difficulty{DiffNormal, DiffHard} {
		w := NewGame(5, d)
		w.PhaseLeft = 1e6
		for _, c := range w.Creeps {
			w.freeIDs = append(w.freeIDs, c.ID)
		}
		w.Creeps = w.Creeps[:0]
		p, _ := w.Join("ana", "ana@example")
		p.X, p.Y = w.CoreX+40, w.CoreY
		for x := p.X - 1; x < p.X+20; x++ {
			w.Terrain[int(p.Y)*w.W+int(x)] = TGrass
		}
		w.SpawnCreep(CWalker, p.X+3, p.Y)
		w.SpawnCreep(CWalker, p.X+15, p.Y)
		for i := range w.Creeps {
			w.Creeps[i].HP, w.Creeps[i].MaxHP, w.Creeps[i].Asleep = 1e6, 1e6, true
		}
		w.discover()
		w.grid.build(w.Creeps)
		w.hitscan(int8(p.ID), p.X, p.Y, 0, 28, 10, 5, 0, 0)
		near, far := w.Creeps[0].HP < 1e6, w.Creeps[1].HP < 1e6
		if !near {
			t.Fatalf("%s: the creep in sight was missed", d)
		}
		if night := w.diff().Dark > 0; far == night {
			t.Fatalf("%s: the creep out in the dark hit: %v", d, far)
		}
		// With only the one in the dark left, a gun at night has nothing to aim at.
		w.Creeps[0].X = p.X - 30
		w.grid.build(w.Creeps)
		if got := w.nearestSeen(p.X, p.Y, 28); (got < 0) != (w.diff().Dark > 0) {
			t.Fatalf("%s: picked target %d", d, got)
		}
	}
}
