package game

import (
	"reflect"
	"testing"
)

func TestBrutalBaseHasNoWalls(t *testing.T) {
	for d := DiffEasy; d < NumDifficulties; d++ {
		n := map[StructKind]int{}
		for _, s := range NewGame(5, d).Structs {
			n[s.Kind]++
		}
		if bare := n[SWall] == 0 && n[SGate] == 0; bare != (d == DiffBrutal) {
			t.Errorf("%s starts with %d walls and %d gates", d, n[SWall], n[SGate])
		}
		if n[SCore] != 1 || n[SArmory] != 1 || n[STurretGun] != 4 {
			t.Errorf("%s starts with %v", d, n)
		}
	}
}

// A restart on the world's own seed is the same map, fresh, whatever was done to it.
func TestRestartOnTheSameMap(t *testing.T) {
	fresh := NewGame(5, DiffNormal)
	w := NewGame(5, DiffNormal)
	w.Join("ana", "ana@example")
	w.remove(w.StructAt(w.W/2, w.H/2-baseRadius))
	w.Sites[0].Searched = true
	run(w, 60, func() bool { return false })
	nw := w.Restart(w.Seed)
	if nw.Seed != w.Seed || !reflect.DeepEqual(nw.Terrain, fresh.Terrain) ||
		!reflect.DeepEqual(nw.Structs, fresh.Structs) || !reflect.DeepEqual(nw.Sites, fresh.Sites) {
		t.Fatal("not the same map, fresh")
	}
	if reflect.DeepEqual(w.Restart(6).Terrain, fresh.Terrain) {
		t.Fatal("another seed is the same map")
	}
}
