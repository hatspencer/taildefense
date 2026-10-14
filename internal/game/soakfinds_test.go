package game

import "testing"

// A creep's id is not handed out again in the tick it went: a client diffing this tick
// against the last would take the newcomer for the old creep, keep its kind, and slide it
// across the map. The playtest soak found an abomination dropped as a straggler coming
// back the same tick as a wanderer, still drawn as an abomination.
func TestAnIDIsNotReusedInTheTickItIsFreed(t *testing.T) {
	w := newBare(4)
	w.Phase = PhaseWave
	if !w.SpawnCreep(CBoss, w.CoreX+30, w.CoreY) {
		t.Fatal("no boss")
	}
	gone := w.Creeps[0].ID
	w.dropStragglers()
	if !w.SpawnCreep(CWalker, w.CoreX-30, w.CoreY) {
		t.Fatal("no walker")
	}
	if w.Creeps[0].ID == gone {
		t.Fatalf("the walker took the boss's id %d in the same tick", gone)
	}
	if err := w.Check(); err != nil {
		t.Fatal(err)
	}
	w.Step()
	if err := w.Check(); err != nil {
		t.Fatal(err)
	}
	if n := len(w.freeIDs) + len(w.Creeps); n != MaxCreeps || len(w.freed) != 0 {
		t.Fatalf("the boss's id is not free again the next tick: %d free, %d creeps, %d held", len(w.freeIDs), len(w.Creeps), len(w.freed))
	}
}

// A survivor back at the base is never put inside something built on the spot they come
// back to: they could not walk out. The playtest soak found one stuck in a wall there.
func TestARespawnIsNeverInsideAStructure(t *testing.T) {
	w := newBare(6)
	p, _ := w.Join("ana", "ana@example")
	x, y := int(w.CoreX+.5), int(w.CoreY+3.8)
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			if w.StructAt(x+dx, y+dy) < 0 && !w.At(x+dx, y+dy).Solid() {
				w.place(SWall, x+dx, y+dy, 0)
			}
		}
	}
	w.respawn(p)
	if !CanStand(w, p.X, p.Y) {
		t.Fatalf("respawned inside something at %.1f,%.1f", p.X, p.Y)
	}
	if dx, dy := p.X-w.CoreX, p.Y-w.CoreY; dx*dx+dy*dy > 8*8 {
		t.Fatalf("respawned %.1f,%.1f, far from the generator", p.X, p.Y)
	}
}
