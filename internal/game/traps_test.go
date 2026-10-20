package game

import "testing"

// trapLane is a maze world with a trap of kind k on the way in, 6 tiles north of the open
// gates, and a walker a little further out on the same line.
func trapLane(t *testing.T, k StructKind) (*World, *Structure) {
	t.Helper()
	w := mazeWorld(t)
	cx, cy := int(w.CoreX), int(w.CoreY)
	si := w.place(k, cx, cy-baseRadius-6, -1)
	w.SpawnCreep(CWalker, float32(cx)+.5, float32(cy-baseRadius-12))
	return w, &w.Structs[si]
}

func TestATrapStopsNobody(t *testing.T) {
	w := mazeWorld(t)
	cx, cy := int(w.CoreX), int(w.CoreY)
	before := w.MazeDist(cx, cy-30)
	for x := cx - 3; x <= cx+3; x++ {
		w.place(STrapSpikes, x, cy-baseRadius-6, -1)
	}
	w.updateFlow()
	if d := w.MazeDist(cx, cy-30); d != before {
		t.Fatalf("a row of spikes changed the way in from %.0f to %.0f", before, d)
	}
	if !CanStand(w, float32(cx)+.5, float32(cy-baseRadius-6)+.5) {
		t.Fatal("a survivor can't stand on a spike strip")
	}
	p := mustJoin(t, w, "ana")
	p.X, p.Y, p.Gold = float32(cx)+.5, float32(cy-baseRadius-5)+.5, 1000
	if err := w.CanBuild(p, SWall, cx, cy-baseRadius-6); err == nil {
		t.Fatal("a wall went up on a spike strip")
	}
}

func TestSpikesCutWhatWalksOverAndWear(t *testing.T) {
	w, s := trapLane(t, STrapSpikes)
	c := &w.Creeps[0]
	hp := c.HP
	run(w, TickRate*10, func() bool { return c.Y > float32(s.Y)+2 })
	if c.HP >= hp-5 {
		t.Fatalf("a walker crossed spikes and lost only %.1f", hp-c.HP)
	}
	if s.HP >= s.MaxHP {
		t.Fatal("the spikes did not wear")
	}
}

func TestTarSlowsWhatWadesThrough(t *testing.T) {
	w, s := trapLane(t, STrapTar)
	c := &w.Creeps[0]
	run(w, TickRate*10, func() bool { return c.Slow > 0 || c.Y > float32(s.Y)+1 })
	if c.Slow <= 0 {
		t.Fatal("a walker in tar is not slowed")
	}
}

func TestAMineBlowsOnceAndLeavesAGhost(t *testing.T) {
	w, s := trapLane(t, STrapMine)
	c := &w.Creeps[0]
	run(w, TickRate*10, func() bool { return !s.Alive })
	if s.Alive || !s.Ghost {
		t.Fatalf("mine alive %v ghost %v", s.Alive, s.Ghost)
	}
	if c.HP > 0 {
		t.Fatalf("a walker lived through a mine with %.0f", c.HP)
	}
}

func TestAFlameVentSetsCreepsAlight(t *testing.T) {
	w, s := trapLane(t, STrapVent)
	c := &w.Creeps[0]
	run(w, TickRate*10, func() bool { return s.Cool > 0 })
	if c.Burn <= 0 {
		t.Fatal("the vent burst and the walker is not burning")
	}
}
