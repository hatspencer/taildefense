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
	}
}
