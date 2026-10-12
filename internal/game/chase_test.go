package game

import "testing"

// A ruin with its door on the far side: the creep outside goes round to the door and in.
func TestCreepsFindTheDoorOfARuin(t *testing.T) {
	w := New(5)
	w.PhaseLeft = 1e6
	w.Creeps, w.freeIDs = w.Creeps[:0], w.freeIDs[:0]
	for i := MaxCreeps - 1; i >= 0; i-- {
		w.freeIDs = append(w.freeIDs, uint16(i))
	}
	ox, oy := int(w.CoreX)+24, int(w.CoreY)-8
	for y := oy; y < oy+16; y++ {
		for x := ox; x < ox+16; x++ {
			w.Terrain[y*w.W+x] = TGrass
			if w.structAt[y*w.W+x] >= 0 {
				t.Skip("a structure where the ruin goes")
			}
		}
	}
	// An 8x8 room at ox+4, oy+4, its door in the east wall.
	for i := 0; i < 8; i++ {
		for _, xy := range [][2]int{{ox + 4 + i, oy + 4}, {ox + 4 + i, oy + 11}, {ox + 4, oy + 4 + i}, {ox + 11, oy + 4 + i}} {
			w.Terrain[xy[1]*w.W+xy[0]] = TRock
		}
	}
	w.Terrain[(oy+7)*w.W+ox+11] = TGrass
	w.Terrain[(oy+8)*w.W+ox+11] = TGrass
	p, _ := w.Join("ana", "ana@example")
	p.HP, p.MaxHP = 1e6, 1e6
	p.X, p.Y = float32(ox)+6.5, float32(oy)+8
	w.SpawnCreep(CWalker, float32(ox)+1.5, float32(oy)+8)
	c := &w.Creeps[0]
	c.Hunt, c.HuntLeft, c.HP = int8(p.ID), 1e6, 1e6 // the survivor shoots back
	hp := p.HP
	run(w, TickRate*20, func() bool { return p.HP < hp })
	if p.HP >= hp {
		t.Fatalf("the walker never got in: it is at %.1f,%.1f", w.Creeps[0].X, w.Creeps[0].Y)
	}
	if w.Creeps[0].X < float32(ox)+5 {
		t.Fatal("hit through the wall")
	}
}

// Shooting brings one creep; that one brings the rest round it.
func TestOneWokenCreepBringsTheOthers(t *testing.T) {
	w := New(5)
	w.PhaseLeft = 1e6
	w.Creeps, w.freeIDs = w.Creeps[:0], w.freeIDs[:0]
	for i := MaxCreeps - 1; i >= 0; i-- {
		w.freeIDs = append(w.freeIDs, uint16(i))
	}
	p, _ := w.Join("ana", "ana@example")
	p.HP, p.MaxHP = 1e6, 1e6
	x, y := w.CoreX+20, w.CoreY
	for k := 0; k < 6; k++ {
		w.SpawnCreep(CWalker, x+float32(k%3), y+float32(k/3))
		w.Creeps[k].Wander, w.Creeps[k].HP = true, 1e6
	}
	p.X, p.Y = x-12, y
	w.Creeps[0].Hunt, w.Creeps[0].HuntLeft = int8(p.ID), 10
	run(w, TickRate, func() bool { return false })
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.Hunt != int8(p.ID) {
			t.Fatalf("creep %d at %.0f,%.0f never joined in", i, c.X, c.Y)
		}
	}
}
