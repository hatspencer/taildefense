package game

import "testing"

// loneTurret sets up a base with no turrets but one of kind k, west of the generator, and
// no creeps.
func loneTurret(t *testing.T, k StructKind) (*World, *Structure) {
	t.Helper()
	w := New(5)
	w.Creeps, w.freeIDs = w.Creeps[:0], append(w.freeIDs[:0], 1, 2, 3, 4)
	for i := range w.Structs {
		if Structs[w.Structs[i].Kind].Turret {
			w.Structs[i].Alive = false
		}
	}
	si := w.place(k, int(w.CoreX)-6, int(w.CoreY)-6, -1)
	return w, &w.Structs[si]
}

func spawnAt(t *testing.T, w *World, k CreepKind, x, y float32) *Creep {
	t.Helper()
	if !w.SpawnCreep(k, x, y) {
		t.Fatalf("no room for a %s at %.0f,%.0f", Creeps[k].Name, x, y)
	}
	c := &w.Creeps[len(w.Creeps)-1]
	c.HP = 1e4
	return c
}

// A sniper tower passes over the creep next to it for the toughest one it can reach.
func TestASniperShootsTheToughest(t *testing.T) {
	w, s := loneTurret(t, STurretSniper)
	near := spawnAt(t, w, CWalker, s.CX(), s.CY()+3)
	far := spawnAt(t, w, CBrute, s.CX()+12, s.CY()-4)
	far.HP = 2e4
	w.grid.build(w.Creeps)
	w.stepTurrets()
	if near.HP != 1e4 || far.HP >= 2e4 {
		t.Fatalf("near %v, far %v: the sniper should have hit only the brute", near.HP, far.HP)
	}
}

// A missile battery's salvo goes at as many creeps as it has missiles, and every track
// upgrade adds to what it does.
func TestAMissileSalvoSpreadsOut(t *testing.T) {
	w, s := loneTurret(t, STurretMissile)
	var cs []*Creep
	for _, at := range [][2]float32{{4, 0}, {0, 5}, {6, 6}} {
		cs = append(cs, spawnAt(t, w, CWalker, s.CX()+at[0], s.CY()+at[1]))
	}
	w.grid.build(w.Creeps)
	w.stepTurrets()
	if len(w.Rockets) != Structs[STurretMissile].Salvo {
		t.Fatalf("%d missiles in the air", len(w.Rockets))
	}
	for i := 0; i < TickRate && len(w.Rockets) > 0; i++ {
		w.grid.build(w.Creeps)
		w.stepRockets()
	}
	for i, c := range cs {
		if c.HP >= 1e4 {
			t.Errorf("creep %d was not hit", i)
		}
	}
	base := TurretStats(STurretMissile, [NumTracks]uint8{})
	up := TurretStats(STurretMissile, [NumTracks]uint8{1, 1, 1, 1})
	if up.Damage <= base.Damage || up.Rate <= base.Rate || up.Range <= base.Range || up.Salvo != base.Salvo+1 {
		t.Fatalf("upgraded %+v, base %+v", up, base)
	}
}
