package game

import (
	"math"
	"strings"
	"testing"
)

func TestWavesComeFromDifferentSides(t *testing.T) {
	w := New(3)
	w.Join("ana", "ana@example")
	if len(w.edgePts) < 20 {
		t.Fatalf("only %d places along the edge", len(w.edgePts))
	}
	sides := map[string]bool{}
	last := ""
	for wave := 1; wave <= 12; wave++ {
		q := w.plan(wave, 1)
		said := w.frontsSaid()
		if said == "" || said == last && wave < 4 {
			t.Fatalf("wave %d from %q after %q", wave, said, last)
		}
		last = said
		for _, n := range w.frontNames {
			sides[n] = true
		}
		if wave < 4 {
			// One side: every creep comes in within a quarter turn of the others.
			b := w.bearing(q[0].X, q[0].Y)
			for _, s := range q {
				if angleOff(w.bearing(s.X, s.Y), b) > math.Pi/2 {
					t.Fatalf("wave %d is spread all round: %q", wave, said)
				}
			}
		}
	}
	if len(sides) < 4 {
		t.Fatalf("twelve waves came from only %v", sides)
	}
	w.startWave()
	if n := w.Notes[len(w.Notes)-1].Text; !strings.Contains(n, "incoming from the ") {
		t.Fatalf("the wave's notice doesn't say where: %q", n)
	}
	for _, d := range []Difficulty{DiffHard, DiffBrutal} {
		w := NewGame(3, d)
		w.Join("ana", "ana@example")
		w.startWave()
		if n := w.Notes[len(w.Notes)-1].Text; strings.Contains(n, " from ") {
			t.Fatalf("on %s the wave's notice says where: %q", d, n)
		}
	}
}
