package game

import "testing"

// mazeWorld is a bare world with the ground north of the base cleared to grass, its north
// gates open and every other one shut, and no turrets to shoot what walks it, for a maze to be
// built on.
func mazeWorld(t *testing.T) *World {
	t.Helper()
	w := newBare(7)
	for i := range w.Structs {
		if Structs[w.Structs[i].Kind].Turret {
			w.remove(i)
		}
	}
	cx, cy := int(w.CoreX), int(w.CoreY)
	for y := cy - 48; y < cy-baseRadius; y++ {
		for x := cx - 30; x <= cx+30; x++ {
			w.Terrain[y*w.W+x] = TGrass
		}
	}
	for i := -1; i <= 1; i++ {
		si := w.StructAt(cx+i, cy-baseRadius)
		if si < 0 || w.Structs[si].Kind != SGate {
			t.Fatalf("no gate at %d,%d", cx+i, cy-baseRadius)
		}
		w.Structs[si].Open = true
	}
	w.flowDirt = true
	w.updateFlow()
	return w
}

// wallRow puts a row of walls from x0 to x1 on row y.
func wallRow(w *World, x0, x1, y int) {
	for x := x0; x <= x1; x++ {
		w.place(SWall, x, y, -1)
	}
}

// hurt is how many structures but the generator have been hit.
func hurt(w *World) int {
	n := 0
	for i := range w.Structs {
		if s := &w.Structs[i]; s.Alive && i != w.Core && s.HP < s.MaxHP {
			n++
		}
	}
	return n
}

func TestAShutBaseIsBrokenIntoAndAnOpenGateWalkedThrough(t *testing.T) {
	w := newBare(7)
	cx, cy := int(w.CoreX), int(w.CoreY)
	if d := w.MazeDist(cx, cy-30); d >= 0 {
		t.Fatalf("the starting base is shut, yet the maze reaches it from %.0f tiles", d)
	}
	w = mazeWorld(t)
	if d := w.MazeDist(cx, cy-30); d < 25 || d > 40 {
		t.Fatalf("through the open gate the way in is %.0f tiles", d)
	}
	for i := 0; i < 8; i++ {
		w.SpawnCreep(CWalker, w.CoreX+float32(i%4)-2, w.CoreY-30-float32(i/4))
	}
	core := &w.Structs[w.Core]
	run(w, TickRate*40, func() bool { return core.HP < core.MaxHP-50 })
	if core.HP >= core.MaxHP-50 {
		t.Fatal("the walkers never reached the generator through the open gate")
	}
	if n := hurt(w); n > 0 {
		t.Fatalf("%d walls or gates were hit with a gate open", n)
	}
}

func TestCreepsWalkALongMazeRatherThanBreakIt(t *testing.T) {
	w := mazeWorld(t)
	cx, cy := int(w.CoreX), int(w.CoreY)
	// A long wall across the way in: round either end is some 30 tiles further than through.
	wallRow(w, cx-14, cx+14, cy-24)
	w.updateFlow()
	straight := float32(cy - baseRadius - (cy - 34))
	if d := w.MazeDist(cx, cy-34); d < straight+20 {
		t.Fatalf("the way round is only %.0f tiles", d)
	}
	for i := 0; i < 6; i++ {
		w.SpawnCreep(CWalker, w.CoreX+float32(i)-3, w.CoreY-34)
	}
	core := &w.Structs[w.Core]
	run(w, TickRate*60, func() bool { return core.HP < core.MaxHP-30 })
	if core.HP >= core.MaxHP-30 {
		t.Fatal("the walkers never came round the wall to the generator")
	}
	if n := hurt(w); n > 0 {
		t.Fatalf("%d structures hit by walkers with a way round", n)
	}
}

func TestAFrenziedCreepBreaksThroughTheMaze(t *testing.T) {
	w := mazeWorld(t)
	cx, cy := int(w.CoreX), int(w.CoreY)
	wallRow(w, cx-14, cx+14, cy-24)
	w.updateFlow()
	w.SpawnCreep(CWalker, w.CoreX, w.CoreY-34)
	c := &w.Creeps[0]
	w.frenzy(c)
	run(w, TickRate*20, func() bool { return hurt(w) > 0 })
	if hurt(w) == 0 {
		t.Fatal("a frenzied walker walked round rather than through")
	}
}

func TestPatienceRunsOutInALongWalkInsideTheRing(t *testing.T) {
	w := mazeWorld(t)
	cx, cy := int(w.CoreX), int(w.CoreY)
	wallRow(w, cx-14, cx+14, cy-24)
	w.updateFlow()
	w.SpawnCreep(CWalker, w.CoreX, w.CoreY-34)
	w.Step()
	c := &w.Creeps[0]
	if c.trekMax < 34*w.diff().Patience {
		t.Fatalf("a creep 34 tiles in will walk only %.0f", c.trekMax)
	}
	// Most of its patience gone already: the long way round finishes it.
	c.trek = c.trekMax - 20
	run(w, TickRate*30, func() bool { return w.Creeps[0].Frenzy })
	if !w.Creeps[0].Frenzy {
		t.Fatal("the walker never lost its patience")
	}
}

func TestBigCreepsSmashOneTileLanesAndWalkWideOnes(t *testing.T) {
	for _, lane := range []int{1, 2} {
		w := mazeWorld(t)
		cx, cy := int(w.CoreX), int(w.CoreY)
		// A lane north from the open gates, walled both sides, the only way in.
		for y := cy - 30; y < cy-baseRadius; y++ {
			w.place(SWall, cx-1, y, -1)
			w.place(SWall, cx+lane, y, -1)
		}
		w.updateFlow()
		w.SpawnCreep(CBrute, w.CoreX+.5, w.CoreY-34)
		core := &w.Structs[w.Core]
		run(w, TickRate*90, func() bool { return core.HP < core.MaxHP || hurt(w) > 0 })
		switch {
		case lane == 1 && hurt(w) == 0:
			t.Error("a brute walked a lane one tile wide")
		case lane == 2 && hurt(w) > 0:
			t.Error("a brute broke walls with a lane two tiles wide to walk")
		case lane == 2 && core.HP == core.MaxHP:
			t.Error("a brute never got down a lane two tiles wide")
		}
	}
}

func TestACreepDoesNotClawAtAWallForASurvivorBehindIt(t *testing.T) {
	w := mazeWorld(t)
	cx, cy := int(w.CoreX), int(w.CoreY)
	p := mustJoin(t, w, "ana")
	p.HP, p.MaxHP = 1e6, 1e6
	p.X, p.Y = float32(cx-8)+.5, float32(cy-baseRadius)+1.5
	p.Order.Kind = OrderHold
	p.Weapons[p.Cur].Ammo, p.Weapons[p.Cur].Reload = 0, 1e9
	w.SpawnCreep(CWalker, p.X, p.Y-4)
	w.Step()
	c := &w.Creeps[0]
	trek := c.trek
	run(w, TickRate*3, func() bool { return false })
	if n := hurt(w); n > 0 {
		t.Fatalf("%d walls hit for a survivor on the other side", n)
	}
	if w.Creeps[0].trek <= trek+2 {
		t.Fatal("wanting a survivor it can't reach did not wear its patience")
	}
}

func TestAGateIsWorkedFromBesideItAndNotShutOnACreep(t *testing.T) {
	w := mazeWorld(t)
	cx, cy := int(w.CoreX), int(w.CoreY)
	si := w.StructAt(cx, cy+baseRadius)
	p := mustJoin(t, w, "ana")
	if err := w.OrderGate(p, si); err != nil {
		t.Fatal(err)
	}
	g := &w.Structs[si]
	if !run(w, TickRate*10, func() bool { return g.Open }) {
		t.Fatal("the gate never opened")
	}
	w.updateFlow()
	if d := w.MazeDist(cx, cy+baseRadius+3); d < 0 || d > 18 {
		t.Fatalf("with the south gate open the way in from the south is %.0f", d)
	}
	// Straight back: it is still swinging.
	if err := w.OrderGate(p, si); err != nil {
		t.Fatal(err)
	}
	run(w, TickRate*gateTime*2, func() bool { return false })
	if !g.Open {
		t.Fatal("the gate shut again before it settled")
	}
	g.Cool = 0
	w.SpawnCreep(CWalker, g.CX(), g.CY())
	w.Creeps[len(w.Creeps)-1].stunLeft = 1e3 // it stands in the gateway
	if err := w.OrderGate(p, si); err != nil {
		t.Fatal(err)
	}
	run(w, TickRate*gateTime*2, func() bool { return false })
	if !g.Open {
		t.Fatal("the gate shut on a creep")
	}
	// Players walk a shut gate as ever.
	if !CanStand(w, g.CX(), g.CY()) {
		t.Fatal("a survivor can't stand in a gateway")
	}
}
