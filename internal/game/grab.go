package game

import "math"

// The grab: a mauler or a goliath that gets its hands on a survivor, close enough to reach
// them, picks them up, holds them overhead a moment and hurls them away behind it, back the
// way it came and into whatever follows it. Whoever is caught can do nothing; the team can,
// as enough damage on the creep while it holds them makes it let go. The throw ends in a fall
// that hurts and stuns, or sooner against a wall, which hurts the same. Both are faster than
// the brute and the abomination, and charge (sprint.go) to close in, so keeping clear of them
// takes running, not walking.

// grabDef is a kind's grab.
type grabDef struct {
	reach float32 // tiles past its radius and the survivor's that it reaches to grab
	hold  float32 // seconds it holds them up before the throw
	throw float32 // tiles thrown
	hurt  float32 // the fall
	stun  float32 // seconds stunned where they land
	every float32 // seconds after a throw before it can grab again
	free  float32 // the share of its max health that, shot off it while it holds, frees them
}

// grabs is indexed by creep kind; a zero reach is a kind that does not grab.
var grabs = [NumCreepKinds]grabDef{
	CMauler:  {reach: .6, hold: .9, throw: 7, hurt: 35, stun: 1.2, every: 6, free: .12},
	CGoliath: {reach: .8, hold: 1.1, throw: 10, hurt: 55, stun: 1.8, every: 5, free: .06},
}

// throwFlight is the seconds a thrown survivor is in the air, whatever the distance; the
// page arcs them over it (THROW_FLIGHT in web/src/protocol.ts).
const throwFlight = .7

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
	if c.grab > 0 {
		c.grab -= Dt
		return false
	}
	if tp == nil || tp.held || tp.fly > 0 || tp.Shield > 0 || tp.unstoppable() {
		return false
	}
	// Not in the middle of a slam.
	if sd := &slams[c.Kind]; sd.radius > 0 && c.slam > sd.every-sd.windup {
		return false
	}
	dx, dy := tp.X-c.X, tp.Y-c.Y
	if r := d.Radius + PlayerRadius + gd.reach; dx*dx+dy*dy > r*r {
		return false
	}
	c.grip, c.hold, c.gripHP = tp.ID+1, gd.hold, c.HP
	c.Face = float32(math.Atan2(float64(dy), float64(dx)))
	c.Swing = SwingWindup
	tp.held, tp.holder = true, c.ID
	tp.walk.reset()
	w.note(2, "a %s has %s  ·  shoot it to make it let go", d.Name, tp.Name)
	return true
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
