package game

import "math"

// Traps are buildings laid flat on the ground, three tiles by three, that the dead walk over,
// and survivors too, without noticing them. They are not walls and nothing paths round them,
// so they sit in their own grid (floorAt), out of the one creeps and survivors are stopped by.
// They never wear out and nothing breaks them; each goes off by itself, on a cooldown, when
// creeps are there, and does something no turret does:
//
//   - The bait pit, when at least baitMin creeps are within its reach, drags every one of
//     them (bosses excepted) into a knot at its middle and holds them there for baitHold
//     seconds: a stream turned into the blob cannons, teslas and missiles were made for. It
//     does no damage. A creep is dragged only along open ground in a straight line to the pit:
//     one behind a wall is left where it is, and one that meets an obstacle on the way stops
//     at it. A creep one pit holds no other takes.
//   - The catapult pit flings up to catapultMax small creeps standing on it (never a brute
//     or a boss) the way it faces, set when it was placed, each within catapultSpread of
//     that line and catapultMin to catapultFar tiles from its middle, by the sim's own dice.
//     A throw whose spot is no ground to land on is shortened along its line to the last
//     that is, and one with none past catapultShort is not made. Where it aims is the
//     builder's choice: into a bait pit, under the guns, back up the road, or into the base.
//     In the air a creep is out of reach and harms nothing; it comes down catapultAir
//     seconds later for a share of its full health, armour or not, stunned.
//
// What they do counts as turret fire: it never turns a creep on anyone, and a creep the fall
// kills pays the team, the catapult's builder credited with it.

const (
	baitReach      = 7     // tiles from the pit's middle it drags from, at level 1
	baitReachLevel = .75   // and what each level past the first adds
	baitHold       = 4     // seconds it holds them, at level 1
	baitHoldLevel  = .5    // and what each level adds
	baitCool       = 9     // seconds it recharges after a hold
	baitMin        = 4     // creeps in reach it takes to go off
	baitPull       = 8     // tiles a second it drags a creep
	baitPullBig    = 3.5   // and a brute or a mauler, heavier
	baitKnot       = .9    // tiles round its middle the knot spreads over
	catapultMax    = 3     // creeps it throws at once, at most, at any level
	catapultCool   = 3     // seconds it rearms in, at level 1
	catapultCoolLv = .4    // and what each level takes off
	catapultFall   = .35   // of its full health a creep's fall takes, at level 1
	catapultFallLv = .05   // and what each level adds
	catapultMin    = 6     // tiles a throw goes, at least
	catapultFar    = 10    // and at most
	catapultShort  = 2     // tiles a throw is shortened to, at least, finding somewhere to land
	catapultSpread = .2618 // radians either side of its facing a throw goes, 15 degrees
	catapultStep   = .5    // tiles a throw is shortened by at a time
	catapultAir    = .9    // seconds a thrown creep is in the air
	catapultStun   = 1     // seconds it lies stunned where it lands
	catapultSnap   = .45   // seconds the catapult's arm stands sprung, for the page
	trapCharge     = 15    // steps a trap's charge is sent in, full when ready
	knotTurn       = 2.399963
)

// BaitReach, BaitHold, CatapultCool and CatapultFall are a trap's numbers at its level.
func BaitReach(level uint8) float32 { return baitReach + baitReachLevel*float32(level-1) }

// BaitHold is the seconds a bait pit of level holds what it grabbed.
func BaitHold(level uint8) float32 { return baitHold + baitHoldLevel*float32(level-1) }

// CatapultCool is the seconds a catapult of level takes to rearm.
func CatapultCool(level uint8) float32 { return catapultCool - catapultCoolLv*float32(level-1) }

// CatapultFall is the share of its full health a catapult of level's throw takes off a creep.
func CatapultFall(level uint8) float32 { return catapultFall + catapultFallLv*float32(level-1) }

// CatapultAir is the seconds a thrown creep is in the air, for the page's arc.
const CatapultAir = catapultAir

// CatapultStun is the seconds a thrown creep is stunned once it lands, for the page to lay it
// down.
const CatapultStun = catapultStun

// FloorAt is the trap on tile x, y, or -1.
func (w *World) FloorAt(x, y int) int {
	if x < 0 || y < 0 || x >= w.W || y >= w.H {
		return -1
	}
	return int(w.floorAt[y*w.W+x])
}

// Held reports whether a bait pit holds creep c; Airborne whether a catapult threw it and it
// has not come down.
func (c *Creep) Held() bool { return c.bait > 0 }

// Airborne reports whether creep c is in the air, thrown by a catapult.
func (c *Creep) Airborne() bool { return c.air > 0 }

// trapped reports whether a trap has c, so it neither walks nor attacks this tick.
func (c *Creep) trapped() bool { return c.bait > 0 || c.air > 0 }

// big reports whether c is a brute or a mauler: dragged slowly, never thrown.
func (c *Creep) big() bool { return Creeps[c.Kind].Size >= 2 && !c.Kind.Boss() }

// TrapCharge is what the page shows of trap s: whether it is going off (a bait pit holding,
// a catapult's arm sprung) and how far it has recharged, 0 to trapCharge, full when ready.
func (s *Structure) TrapCharge() (busy bool, charge uint8) {
	var cd float32
	switch s.Kind {
	case STrapBait:
		cd = baitCool
	case STrapCatapult:
		cd = CatapultCool(s.Level)
	default:
		return false, 0
	}
	busy = s.Hold > 0
	if s.Kind == STrapBait && busy {
		return true, 0
	}
	if s.Cool <= 0 {
		return busy, trapCharge
	}
	return busy, uint8(min(max((1-s.Cool/cd)*trapCharge, 0), trapCharge-1))
}

// stepTraps runs the traps, once a tick: what they hold and threw moves, and those ready and
// with creeps on them go off.
func (w *World) stepTraps() {
	w.turretFire = true
	defer func() { w.turretFire = false }()
	for i := range w.Creeps {
		c := &w.Creeps[i]
		switch {
		case c.HP <= 0:
		case c.air > 0:
			w.fly(int32(i))
		case c.bait > 0:
			w.drag(c)
		}
	}
	for si := range w.Structs {
		s := &w.Structs[si]
		if !s.Alive {
			continue
		}
		switch s.Kind {
		case STrapBait:
			w.stepBait(si, s)
		case STrapCatapult:
			w.stepCatapult(si, s)
		}
	}
}

// ---- the bait pit ----------------------------------------------------------------------

func (w *World) stepBait(si int, s *Structure) {
	if s.Hold > 0 {
		if s.Hold -= Dt; s.Hold <= 0 {
			s.Hold, s.Cool = 0, baitCool
		}
		return
	}
	if s.Cool > 0 {
		s.Cool -= Dt
		return
	}
	x, y, r := s.CX(), s.CY(), BaitReach(s.Level)
	n := 0
	w.grid.each(x, y, r, func(i int32) bool {
		if w.baitable(&w.Creeps[i], x, y, r) {
			n++
		}
		return n < baitMin
	})
	if n < baitMin {
		return
	}
	hold := BaitHold(s.Level)
	w.grid.each(x, y, r, func(i int32) bool {
		if c := &w.Creeps[i]; w.baitable(c, x, y, r) {
			c.bait, c.baitLeft = int16(si+1), hold
			c.Chase, c.Swing, c.swung, c.jam = -1, SwingNone, SwingNone, 0
		}
		return true
	})
	s.Hold = hold
}

// baitable reports whether a bait pit at x, y reaching r takes creep c: free of the traps, no
// boss, awake, within reach and with open ground straight to it.
func (w *World) baitable(c *Creep, x, y, r float32) bool {
	if c.HP <= 0 || c.trapped() || c.Kind.Boss() || c.Asleep {
		return false
	}
	dx, dy := x-c.X, y-c.Y
	return dx*dx+dy*dy <= r*r && w.clearWalk(c.X, c.Y, x, y)
}

// clearWalk reports whether a creep could be dragged in a straight line from x0, y0 to x1, y1:
// no solid ground and nothing it is stopped by anywhere on the way.
func (w *World) clearWalk(x0, y0, x1, y1 float32) bool {
	dx, dy := x1-x0, y1-y0
	d := sqrt32(dx*dx + dy*dy)
	for t := float32(0); t < d; t += .25 {
		if ok, _ := w.creepFree(x0+dx*t/d, y0+dy*t/d); !ok {
			return false
		}
	}
	ok, _ := w.creepFree(x1, y1)
	return ok
}

// drag pulls creep c, held by a bait pit, towards its place in the knot, and lets it go when
// the hold is up. It never moves onto ground a creep can't stand on: at an obstacle it stops.
func (w *World) drag(c *Creep) {
	s := &w.Structs[c.bait-1]
	if c.baitLeft -= Dt; c.baitLeft <= 0 || !s.Alive || s.Kind != STrapBait {
		c.bait, c.baitLeft = 0, 0
		return
	}
	a := float64(c.ID) * knotTurn
	k := baitKnot * sqrt32(float32(math.Mod(float64(c.ID)*.618034, 1)))
	tx, ty := s.CX()+k*float32(math.Cos(a)), s.CY()+k*float32(math.Sin(a))
	dx, dy := tx-c.X, ty-c.Y
	d := sqrt32(dx*dx + dy*dy)
	if d < 1e-4 {
		return
	}
	step := float32(baitPull)
	if c.big() {
		step = baitPullBig
	}
	step = min(step*Dt, d)
	nx, ny := c.X+dx/d*step, c.Y+dy/d*step
	ok1, _ := w.creepFree(nx, ny)
	ok2, _ := w.creepFree(nx, c.Y)
	ok3, _ := w.creepFree(c.X, ny)
	if ok1 && ok2 && ok3 {
		c.X, c.Y = nx, ny
	}
}

// ---- the catapult pit ------------------------------------------------------------------

func (w *World) stepCatapult(si int, s *Structure) {
	if s.Hold > 0 {
		s.Hold -= Dt
	}
	if s.Cool > 0 {
		s.Cool -= Dt
		return
	}
	// The small creeps standing on it, the catapultMax nearest its middle.
	var pick [catapultMax]int32
	var pd [catapultMax]float32
	n := 0
	x, y := s.CX(), s.CY()
	w.grid.each(x, y, 2.2, func(i int32) bool {
		c := &w.Creeps[i]
		if c.HP <= 0 || c.trapped() || c.Kind.Boss() || c.big() || c.Asleep || w.FloorAt(int(c.X), int(c.Y)) != si {
			return true
		}
		dx, dy := c.X-x, c.Y-y
		d := dx*dx + dy*dy
		j := n
		if n < catapultMax {
			n++
		} else if d >= pd[catapultMax-1] {
			return true
		} else {
			j = catapultMax - 1
		}
		for ; j > 0 && (pd[j-1] > d || pd[j-1] == d && pick[j-1] > i); j-- {
			pick[j], pd[j] = pick[j-1], pd[j-1]
		}
		pick[j], pd[j] = i, d
		return true
	})
	thrown := 0
	for _, i := range pick[:n] {
		if w.throw(i, s) {
			thrown++
		}
	}
	if thrown > 0 {
		s.Cool, s.Hold = CatapultCool(s.Level), catapultSnap
	}
}

// throw flings creep i off catapult s the way it faces, if there is ground to land on.
func (w *World) throw(i int32, s *Structure) bool {
	c := &w.Creeps[i]
	a := float64(s.Facing)*math.Pi/4 + float64(w.rng.Float32()*2-1)*catapultSpread
	far := catapultMin + w.rng.Float32()*(catapultFar-catapultMin)
	ca, sa := float32(math.Cos(a)), float32(math.Sin(a))
	ox, oy := s.CX(), s.CY()
	for d := far; d >= catapultShort; d -= catapultStep {
		x, y := ox+ca*d, oy+sa*d
		if x < 0 || y < 0 {
			continue
		}
		lx, ly := floor32(x)+.5, floor32(y)+.5
		if !w.landsOK(lx, ly) {
			continue
		}
		c.air, c.ax, c.ay = catapultAir, lx, ly
		c.fall, c.thrower = CatapultFall(s.Level), s.Owner
		c.Chase, c.Swing, c.swung, c.Siege, c.jam = -1, SwingNone, SwingNone, -1, 0
		return true
	}
	return false
}

// landsOK reports whether a thrown creep may come down at x, y: on the map, on open ground
// (no wall, structure or water), and somewhere it can walk on from.
func (w *World) landsOK(x, y float32) bool {
	if ok, _ := w.creepFree(x, y); !ok {
		return false
	}
	return w.flow.dist[int(y)*w.W+int(x)] < unreachable
}

// fly carries thrown creep i on towards where it lands, and brings it down there.
func (w *World) fly(i int32) {
	c := &w.Creeps[i]
	k := min(Dt/c.air, 1)
	c.X += (c.ax - c.X) * k
	c.Y += (c.ay - c.Y) * k
	if c.air -= Dt; c.air > 0 {
		return
	}
	c.air = 0
	c.X, c.Y = c.ax, c.ay
	if ok, _ := w.creepFree(c.X, c.Y); !ok {
		// Something was built where it was coming down: it lands beside it.
		w.besideFree(c)
	}
	c.ox, c.oy = c.X, c.Y
	w.noArmor = true
	w.damage(i, c.fall*c.MaxHP, c.thrower)
	w.noArmor = false
	c.stunLeft, c.stunCool = max(c.stunLeft, catapultStun), max(c.stunCool, catapultStun+stunGap)
}

// besideFree moves c to the nearest open tile round it, within two, if there is one.
func (w *World) besideFree(c *Creep) {
	for r := 1; r <= 2; r++ {
		for dy := -r; dy <= r; dy++ {
			for dx := -r; dx <= r; dx++ {
				if x, y := c.X+float32(dx), c.Y+float32(dy); abs(dx) == r || abs(dy) == r {
					if ok, _ := w.creepFree(x, y); ok {
						c.X, c.Y = x, y
						return
					}
				}
			}
		}
	}
}
