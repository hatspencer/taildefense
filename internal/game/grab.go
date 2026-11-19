package game

import "math"

// The grab: a mauler or a goliath that gets close enough to a survivor stops and reaches for
// them, arms out (lunge seconds, the dodge: a step back out of reach and its hands close on
// nothing; and enough damage on it while it reaches makes it flinch and drop its arms, and
// any blow from a survivor puts its next reach off a moment), and if it gets its hands on them picks them up, holds them overhead a moment and
// hurls them away behind it, back the way it came and into whatever follows it. Whoever is caught can do nothing; the team can,
// as enough damage on the creep while it holds them makes it let go. The throw ends in a fall
// that hurts and stuns, or sooner against a wall, which hurts the same. Both are faster than
// the brute and the abomination, and charge (sprint.go) to close in, so keeping clear of them
// takes running, not walking.

// grabDef is a kind's grab.
type grabDef struct {
	reach  float32 // tiles past its radius and the survivor's that it reaches to grab
	lunge  float32 // seconds it reaches, arms out, before its hands close
	miss   float32 // seconds after its hands close on nothing before it can reach again
	flinch float32 // the share of its max health that, dealt while it reaches, stops the reach
	hold   float32 // seconds it holds them up before the throw
	throw  float32 // tiles thrown
	hurt   float32 // the fall
	stun   float32 // seconds stunned where they land
	every  float32 // seconds after a throw before it can grab again
	free   float32 // the share of its max health that, shot off it while it holds, frees them
}

// grabs is indexed by creep kind; a zero reach is a kind that does not grab.
var grabs = [NumCreepKinds]grabDef{
	CMauler:  {reach: .6, lunge: .4, miss: 1.5, flinch: .05, hold: .9, throw: 7, hurt: 35, stun: 1.2, every: 6, free: .12},
	CGoliath: {reach: .8, lunge: .5, miss: 1.2, flinch: .02, hold: 1.1, throw: 10, hurt: 55, stun: 1.8, every: 5, free: .06},
}

// throwFlight is the seconds a thrown survivor is in the air, whatever the distance; the
// page arcs them over it (THROW_FLIGHT in web/src/protocol.ts).
const throwFlight = .7

// grabFlinch is the seconds a blow from a survivor puts off a grabber's next reach.
const grabFlinch = .35

// creepGrab runs the grab of c going after tp, and reports whether it took the creep's tick:
// it stands while it has someone in its hands.
func (w *World) creepGrab(c *Creep, d *CreepDef, tp *Player) bool {
	gd := &grabs[c.Kind]
	if gd.reach == 0 {
		return false
	}
	if c.grip > 0 {
		p := w.Players[c.grip-1]
		if !p.Alive || !p.held || p.holder != c.ID {
			c.grip = 0
			return false
		}
		c.Swing = SwingWindup
		// Held up in front of it: drawn in to its hands from where they stood, so never into
		// a wall the creep stands by.
		ax, ay := float32(math.Cos(float64(c.Face))), float32(math.Sin(float64(c.Face)))
		p.X, p.Y = Move(w, p.X, p.Y, c.X+ax*(d.Radius+.2)-p.X, c.Y+ay*(d.Radius+.2)-p.Y)
		if c.hold -= Dt; c.hold > 0 {
			return true
		}
		// Over its shoulder, behind it.
		c.grip, c.grab = 0, gd.every
		c.Swing = SwingStrike
		p.held = false
		p.fly, p.flyX, p.flyY = throwFlight, -ax*gd.throw/throwFlight, -ay*gd.throw/throwFlight
		p.flyHurt, p.flyStun = gd.hurt, gd.stun
		return true
	}
	if c.lunge > 0 {
		// Reaching, arms out; then its hands close on whoever is still in reach.
		if c.HP < c.gripHP-gd.flinch*c.MaxHP {
			// Hurt enough while it reached: it flinches and drops its arms.
			c.lunge, c.grab = 0, gd.miss
			return true
		}
		c.Swing = SwingWindup
		if c.lunge -= Dt; c.lunge > 0 {
			return true
		}
		if i := int(c.lungeAt) - 1; i < len(w.Players) && w.grabbable(c, d, w.Players[i]) {
			w.grabHold(c, d, w.Players[i])
		} else {
			c.grab = gd.miss
		}
		return true
	}
	if c.grab > 0 {
		c.grab -= Dt
		return false
	}
	// Not in the middle of a slam.
	if sd := &slams[c.Kind]; sd.radius > 0 && c.slam > sd.every-sd.windup {
		return false
	}
	if !w.grabbable(c, d, tp) {
		return false
	}
	c.lunge, c.lungeAt, c.gripHP = gd.lunge, tp.ID+1, c.HP
	c.Face = float32(math.Atan2(float64(tp.Y-c.Y), float64(tp.X-c.X)))
	c.Swing = SwingWindup
	return true
}

// grabbable reports whether c can get its hands on tp: in its reach, on their feet, and
// neither shielded, unstoppable nor just back up from a stun.
func (w *World) grabbable(c *Creep, d *CreepDef, tp *Player) bool {
	if tp == nil || !tp.Alive || tp.held || tp.fly > 0 || tp.Shield > 0 || tp.unstoppable() || tp.steady > 0 {
		return false
	}
	dx, dy := tp.X-c.X, tp.Y-c.Y
	r := d.Radius + PlayerRadius + grabs[c.Kind].reach
	return dx*dx+dy*dy <= r*r
}

// grabHold has c pick tp up.
func (w *World) grabHold(c *Creep, d *CreepDef, tp *Player) {
	c.grip, c.hold, c.gripHP = tp.ID+1, grabs[c.Kind].hold, c.HP
	c.Face = float32(math.Atan2(float64(tp.Y-c.Y), float64(tp.X-c.X)))
	c.Swing = SwingWindup
	tp.held, tp.holder = true, c.ID
	tp.walk.reset()
	w.note(2, "a %s has %s  ·  shoot it to make it let go", d.Name, tp.Name)
}

// stepHeld runs a survivor in a creep's hands or thrown through the air for one tick. One
// whose holder is gone is dropped where they are; one in the air comes down when the flight
// is over, or sooner against whatever stops them, and the fall hurts and stuns.
func (w *World) stepHeld(p *Player) {
	if p.held {
		// Its holder gone, or shot loose: dropped where they hang, a moment to find their feet.
		// Checked here rather than in the creep's tick, which a hit's stun skips.
		i := w.creepIndex(p.holder)
		if i >= 0 && w.Creeps[i].grip == p.ID+1 {
			c := &w.Creeps[i]
			if c.HP >= c.gripHP-grabs[c.Kind].free*c.MaxHP {
				return
			}
			c.grip, c.grab = 0, grabs[c.Kind].every
			w.note(1, "%s is free of the %s", p.Name, Creeps[c.Kind].Name)
		}
		p.held = false
		p.stun(.4)
		return
	}
	if p.fly <= 0 {
		return
	}
	p.fly -= Dt
	landed := p.fly <= 0
	// In small steps, so a wall stops the throw rather than being jumped.
	for k := 0; k < 4 && !landed; k++ {
		sx, sy := p.flyX*Dt/4, p.flyY*Dt/4
		nx, ny := Move(w, p.X, p.Y, sx, sy)
		if abs32(nx-p.X-sx)+abs32(ny-p.Y-sy) > 1e-4 {
			landed = true
		}
		p.X, p.Y = nx, ny
	}
	if !landed {
		return
	}
	p.fly = 0
	p.walk.reset()
	w.Blasts = append(w.Blasts, Blast{p.X, p.Y, 1.2, 3})
	w.hurtPlayer(p, p.flyHurt)
	p.stun(p.flyStun)
}

// Held reports whether survivor p is in a creep's hands.
func (p *Player) Held() bool { return p.held }

// Airborne reports whether survivor p is flying through the air, thrown.
func (p *Player) Airborne() bool { return p.fly > 0 }
