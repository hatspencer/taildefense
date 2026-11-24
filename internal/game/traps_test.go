package game

import (
	"math"
	"testing"
)

// trapAt is a maze world with a trap of kind k built by a survivor, its middle on tile
// cx, cy-baseRadius-off: north of the open gates, on the way in.
func trapAt(t *testing.T, k StructKind, off int) (*World, *Player, int) {
	t.Helper()
	w := mazeWorld(t)
	p := mustJoin(t, w, "ana")
	p.X, p.Y = w.CoreX, w.CoreY+3 // at home, out of the way
	cx, cy := int(w.CoreX), int(w.CoreY)
	si := w.place(k, cx-1, cy-baseRadius-off-1, int8(p.ID))
	return w, p, si
}

// stepTrapsOnce is one tick of the traps alone, the grid built first as Step builds it.
func stepTrapsOnce(w *World) {
	w.grid.build(w.Creeps)
	w.stepTraps()
}

func TestATrapStopsNobody(t *testing.T) {
	w := mazeWorld(t)
	cx, cy := int(w.CoreX), int(w.CoreY)
	before := w.MazeDist(cx, cy-30)
	for x := cx - 7; x <= cx+5; x += 3 {
		w.place(STrapBait, x, cy-baseRadius-8, -1)
	}
	w.updateFlow()
	if d := w.MazeDist(cx, cy-30); d != before {
		t.Fatalf("a row of bait pits changed the way in from %.0f to %.0f", before, d)
	}
	if !CanStand(w, float32(cx)+.5, float32(cy-baseRadius-7)+.5) {
		t.Fatal("a survivor can't stand on a bait pit")
	}
	p := mustJoin(t, w, "ana")
	p.X, p.Y, p.Gold = float32(cx)+.5, float32(cy-baseRadius-5)+.5, 1000
	if err := w.CanBuild(p, SWall, cx, cy-baseRadius-7); err == nil {
		t.Fatal("a wall went up on a bait pit")
	}
	// A trap's three by three footprint is checked whole: one tile of it on another trap, a
	// wall or a turret and it is refused.
	if err := w.CanBuild(p, STrapCatapult, cx-1, cy-baseRadius-6); err == nil {
		t.Fatal("a catapult went down overlapping a bait pit")
	}
	w.place(SWall, cx+1, cy-baseRadius-3, -1)
	if err := w.CanBuild(p, STrapCatapult, cx-1, cy-baseRadius-5); err == nil {
		t.Fatal("a catapult went down over a wall")
	}
	if err := w.CanBuild(p, STrapCatapult, cx-4, cy-baseRadius-5); err != nil {
		t.Fatalf("a catapult on open ground: %v", err)
	}
}

// Nothing breaks a trap: a sapper, a burster, a slam and a bile sac leave it whole.
func TestTrapsArePermanent(t *testing.T) {
	w, _, si := trapAt(t, STrapCatapult, 6)
	s := &w.Structs[si]
	x, y := s.CX(), s.CY()
	w.SpawnCreep(CWalker, x, y)
	w.sap(&w.Creeps[0])
	w.SpawnCreep(CBurster, x, y)
	w.burst(&w.Creeps[1], -1)
	w.structsIn(x, y, 3, 500)
	if s.HP < s.MaxHP {
		t.Fatalf("the catapult took %.0f", s.MaxHP-s.HP)
	}
}

// The bait pit drags what is in reach into a knot at its middle and holds it there, a boss
// excepted; the walkers held do not attack.
func TestTheBaitPitKnotsWhatIsInReach(t *testing.T) {
	w, _, si := trapAt(t, STrapBait, 10)
	s := &w.Structs[si]
	x, y := s.CX(), s.CY()
	for i := range 6 {
		a := float64(i) * math.Pi / 3
		w.SpawnCreep(CWalker, x+5*float32(math.Cos(a)), y+5*float32(math.Sin(a)))
	}
	w.SpawnCreep(CBrute, x-4, y-2)
	w.SpawnCreep(CBoss, x+3, y+3)
	boss := &w.Creeps[len(w.Creeps)-1]
	bx, by := boss.X, boss.Y
	stepTrapsOnce(w)
	if s.Hold <= 0 {
		t.Fatal("the bait pit did not go off with seven creeps in reach")
	}
	for range TickRate * 2 {
		stepTrapsOnce(w)
	}
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if c.Kind == CBoss {
			if c.Held() || c.X != bx || c.Y != by {
				t.Fatalf("the boss was moved from %.1f,%.1f to %.1f,%.1f", bx, by, c.X, c.Y)
			}
			continue
		}
		if !c.Held() {
			t.Fatalf("a %s in reach is not held", Creeps[c.Kind].Name)
		}
		if d := math.Hypot(float64(c.X-x), float64(c.Y-y)); d > baitKnot+.05 {
			t.Fatalf("a %s held %.1f from the middle after 2 s", Creeps[c.Kind].Name, d)
		}
	}
	// Held, a walker next to a survivor does not swing at them.
	p := mustJoin(t, w, "bo")
	p.X, p.Y = x+.6, y
	hp := p.HP
	run(w, TickRate, func() bool { return false })
	if p.HP < hp {
		t.Fatalf("a held walker hurt a survivor for %.0f", hp-p.HP)
	}
	// Let go after the hold, and recharging.
	run(w, TickRate*3, func() bool { return false })
	for i := range w.Creeps {
		if w.Creeps[i].Held() {
			t.Fatal("a creep is still held after the hold")
		}
	}
	if s.Cool <= 0 {
		t.Fatal("the bait pit is not recharging")
	}
}

// Too few in reach and the pit waits; and a creep one pit holds stays with it.
func TestTheBaitPitWaitsForACrowdAndKeepsWhatItHas(t *testing.T) {
	w, _, si := trapAt(t, STrapBait, 10)
	s := &w.Structs[si]
	x, y := s.CX(), s.CY()
	for i := range baitMin - 1 {
		w.SpawnCreep(CWalker, x+float32(i), y+3)
	}
	stepTrapsOnce(w)
	if s.Hold > 0 {
		t.Fatalf("the pit went off with %d creeps in reach", baitMin-1)
	}
	w.SpawnCreep(CWalker, x-2, y+3)
	stepTrapsOnce(w)
	if s.Hold <= 0 {
		t.Fatal("the pit did not go off with enough in reach")
	}
	// A second pit in reach of the same creeps finds none to take.
	o := w.place(STrapBait, int(x)+3, int(y)+2, -1)
	stepTrapsOnce(w)
	if w.Structs[o].Hold > 0 {
		t.Fatal("a second pit took creeps the first holds")
	}
	for i := range w.Creeps {
		if c := &w.Creeps[i]; int(c.bait) != si+1 {
			t.Fatalf("creep %d is held by %d, not the first pit %d", c.ID, c.bait-1, si)
		}
	}
}

// Nothing is dragged through a wall: a creep with a wall between it and the pit is left
// where it is, and none ever stands on a wall's tile.
func TestTheBaitPitDragsNothingThroughAWall(t *testing.T) {
	w, _, si := trapAt(t, STrapBait, 10)
	s := &w.Structs[si]
	x, y := s.CX(), s.CY()
	// A wall across the east side, two tiles out.
	wx := int(x) + 3
	for ty := int(y) - 5; ty <= int(y)+5; ty++ {
		w.place(SWall, wx, ty, -1)
	}
	w.updateFlow()
	for i := range 5 {
		w.SpawnCreep(CWalker, x-3, y-2+float32(i))
	}
	w.SpawnCreep(CWalker, float32(wx)+2.5, y)
	behind := &w.Creeps[len(w.Creeps)-1]
	bx := behind.X
	for range TickRate * 3 {
		stepTrapsOnce(w)
		for i := range w.Creeps {
			c := &w.Creeps[i]
			if w.StructAt(int(c.X), int(c.Y)) >= 0 {
				t.Fatalf("creep %d dragged onto a wall at %.1f,%.1f", c.ID, c.X, c.Y)
			}
		}
	}
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.X >= float32(wx) && (c.Held() || c.X != bx) {
			t.Fatalf("the walker behind the wall was taken: held %v, x %.1f from %.1f", c.Held(), c.X, bx)
		}
	}
}

// pad is a catapult world with n creeps of kind k on its tiles.
func pad(t *testing.T, k CreepKind, n int) (*World, *Player, *Structure) {
	t.Helper()
	w, p, si := trapAt(t, STrapCatapult, 12)
	s := &w.Structs[si]
	for i := range n {
		w.SpawnCreep(k, float32(s.X)+.3+float32(i%3)*1.1, float32(s.Y)+.3+float32(i/3%3)*1.1)
	}
	return w, p, &w.Structs[si]
}

func TestTheCatapultThrowsThreeAtMost(t *testing.T) {
	w, _, s := pad(t, CWalker, 9)
	stepTrapsOnce(w)
	n := 0
	for i := range w.Creeps {
		if w.Creeps[i].Airborne() {
			n++
		}
	}
	if n != catapultMax {
		t.Fatalf("one firing threw %d of 9, want %d", n, catapultMax)
	}
	if s.Cool <= 0 {
		t.Fatal("the catapult is not rearming")
	}
	// Rearmed, it throws three more, never more.
	for range TickRate * 6 {
		was := s.Cool
		before := airborne(w)
		stepTrapsOnce(w)
		if was <= 0 {
			if d := airborne(w) - before; d > catapultMax {
				t.Fatalf("one firing threw %d", d)
			}
		}
	}
}

func airborne(w *World) int {
	n := 0
	for i := range w.Creeps {
		if w.Creeps[i].Airborne() {
			n++
		}
	}
	return n
}

func TestTheCatapultLeavesTheBigOnesBe(t *testing.T) {
	for _, k := range []CreepKind{CBrute, CMauler, CBoss, CMother, CGoliath} {
		w, _, s := pad(t, k, 1)
		c := &w.Creeps[0]
		c.X, c.Y = s.CX(), s.CY()
		for range TickRate * 5 {
			stepTrapsOnce(w)
			if c.Airborne() {
				t.Fatalf("the catapult threw a %s", Creeps[k].Name)
			}
		}
		if s.Cool > 0 {
			t.Fatalf("the catapult went off under a %s", Creeps[k].Name)
		}
	}
}

// landings is where each creep came down on the catapult in w over ticks of play.
func landings(w *World, ticks int) [][2]float32 {
	var out [][2]float32
	was := map[uint16]bool{}
	for range ticks {
		w.Step()
		for i := range w.Creeps {
			c := &w.Creeps[i]
			if was[c.ID] && !c.Airborne() {
				out = append(out, [2]float32{c.X, c.Y})
			}
			was[c.ID] = c.Airborne()
		}
	}
	return out
}

// aimed is a catapult, facing f, out in the open north of the base, built by a survivor.
func aimed(t *testing.T, f uint8) (*World, *Structure) {
	t.Helper()
	w := mazeWorld(t)
	p := mustJoin(t, w, "ana")
	cx, cy := int(w.CoreX), int(w.CoreY)
	p.X, p.Y, p.Gold = float32(cx)+.5, float32(cy-baseRadius-20)+.5, 100000
	if err := w.BuildFacing(p, STrapCatapult, cx-1, cy-baseRadius-21, f); err != nil {
		t.Fatal(err)
	}
	si := w.floorAt[(cy-baseRadius-20)*w.W+cx]
	return w, &w.Structs[si]
}

// throwFrom puts three walkers on catapult s, lets it go off once and gives where each that
// was thrown is coming down, clearing them away after.
func throwFrom(w *World, s *Structure) [][2]float32 {
	for k := range 3 {
		w.SpawnCreep(CWalker, float32(s.X)+.5+float32(k), s.CY())
	}
	s.Cool, s.Hold = 0, 0
	stepTrapsOnce(w)
	var out [][2]float32
	for i := range w.Creeps {
		if c := &w.Creeps[i]; c.Airborne() {
			out = append(out, [2]float32{c.ax, c.ay})
		}
		w.freeIDs = append(w.freeIDs, w.Creeps[i].ID)
	}
	w.Creeps = w.Creeps[:0]
	return out
}

// A catapult throws the way it faces, within 15 degrees of it, 6 to 10 tiles out, whichever
// of the eight ways it was built facing; a landing spot is a tile's middle, so each is
// allowed the half diagonal of a tile on top.
func TestTheCatapultThrowsAlongItsFacing(t *testing.T) {
	const slack = .71
	for f := range uint8(8) {
		w, s := aimed(t, f)
		if s.Facing != f {
			t.Fatalf("built facing %d, it faces %d", f, s.Facing)
		}
		want := float64(f) * math.Pi / 4
		n := 0
		for range 20 {
			for _, l := range throwFrom(w, s) {
				n++
				dx, dy := float64(l[0]-s.CX()), float64(l[1]-s.CY())
				d := math.Hypot(dx, dy)
				if d < catapultMin-slack || d > catapultFar+slack {
					t.Fatalf("facing %d: thrown %.1f tiles", f, d)
				}
				off := math.Abs(math.Remainder(math.Atan2(dy, dx)-want, 2*math.Pi))
				if off > catapultSpread+math.Asin(slack/d) {
					t.Fatalf("facing %d: thrown %.0f degrees off its facing", f, off*180/math.Pi)
				}
			}
		}
		if n < 50 {
			t.Fatalf("facing %d: only %d of 60 were thrown on open ground", f, n)
		}
	}
}

// Where the spot a throw would reach is no ground to land on, it comes down at the last
// open tile short of it along its line; with none past the least throw, it is not thrown.
func TestABlockedThrowFallsShortOrNotAtAll(t *testing.T) {
	w, s := aimed(t, 0)
	x0, y0 := int(s.CX()), int(s.CY())
	water := func(from int) {
		for y := y0 - 6; y <= y0+6; y++ {
			for x := x0 + from; x <= x0+14; x++ {
				w.Terrain[y*w.W+x] = TWater
			}
		}
	}
	water(5)
	n := 0
	for range 10 {
		for _, l := range throwFrom(w, s) {
			n++
			if d := l[0] - s.CX(); d > 5 || d < catapultShort-.71 || w.At(int(l[0]), int(l[1])).Solid() {
				t.Fatalf("thrown at water 4.5 tiles off, it came down at %.1f,%.1f, %.1f out", l[0], l[1], d)
			}
		}
	}
	if n == 0 {
		t.Fatal("with open ground short of the water nothing was thrown")
	}
	water(2)
	for range 10 {
		if got := throwFrom(w, s); len(got) > 0 {
			t.Fatalf("with water from 1.5 tiles out, %d were thrown, to %v", len(got), got)
		}
	}
	if s.Cool > 0 {
		t.Fatal("the catapult rearmed having thrown nothing")
	}
}

// fallShare is the share of a walker's full health a level 1 catapult's fall takes at wave.
func fallShare(t *testing.T, wave int, aff Affix) float32 {
	w, _, _ := pad(t, CWalker, 1)
	w.Wave = wave
	c := &w.Creeps[0]
	hp := Creeps[CWalker].HP * HPScale(wave) * 10 // to live through it
	c.HP, c.MaxHP, c.Aff = hp, hp, aff
	stepTrapsOnce(w)
	if !c.Airborne() {
		t.Fatalf("wave %d: the walker was not thrown", wave)
	}
	for c.Airborne() {
		stepTrapsOnce(w)
	}
	return (hp - c.HP) / hp
}

func TestTheFallTakesTheSameShareEveryWave(t *testing.T) {
	s5, s29, armoured := fallShare(t, 5, 0), fallShare(t, 29, 0), fallShare(t, 29, AffixArmoured)
	if math.Abs(float64(s5-catapultFall)) > .001 || math.Abs(float64(s29-s5)) > .001 || math.Abs(float64(armoured-s5)) > .001 {
		t.Fatalf("the fall took %.3f at wave 5, %.3f at 29, %.3f armoured, want %.2f", s5, s29, armoured, float32(catapultFall))
	}
}

// A creep the fall kills pays the team, its kill the catapult's builder's.
func TestAFallKillPaysTheTeam(t *testing.T) {
	w, p, _ := pad(t, CWalker, 1)
	q := mustJoin(t, w, "bo")
	q.X, q.Y = p.X+1, p.Y
	c := &w.Creeps[0]
	c.HP = c.MaxHP * catapultFall * .5
	g0, h0 := p.Gold, q.Gold
	run(w, TickRate*2, func() bool { return len(w.Creeps) == 0 })
	if len(w.Creeps) != 0 {
		t.Fatal("the fall did not kill the walker")
	}
	if p.Kills != 1 {
		t.Fatalf("the builder has %d kills", p.Kills)
	}
	if p.Gold <= g0 || q.Gold <= h0 {
		t.Fatalf("the team was not paid: builder %d → %d, teammate %d → %d", g0, p.Gold, h0, q.Gold)
	}
}

// In the air a creep is out of every turret's reach.
func TestAThrownCreepIsOutOfReach(t *testing.T) {
	w, _, s := pad(t, CWalker, 1)
	stepTrapsOnce(w)
	w.grid.build(w.Creeps)
	if w.nearestVisible(s.CX(), s.CY(), 30) >= 0 {
		t.Fatal("a turret could shoot a creep in the air")
	}
}

// The same seed throws the same way.
func TestCatapultThrowsAreDeterministic(t *testing.T) {
	throws := func() [][2]float32 {
		w, _, s := pad(t, CWalker, 0)
		w.Phase, w.Queue = PhaseWave, []Spawn{{At: 1e9}}
		for i := range 20 {
			w.SpawnCreep(CWalker, s.CX()-3+float32(i%6), s.CY()-8-float32(i/6))
		}
		return landings(w, TickRate*20)
	}
	a, b := throws(), throws()
	if len(a) == 0 || len(a) != len(b) {
		t.Fatalf("%d landings, then %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("landing %d at %v, then %v", i, a[i], b[i])
		}
	}
}
