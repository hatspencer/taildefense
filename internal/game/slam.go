package game

import "math"

// The slam: a brute or an abomination, once it has a survivor in reach, stops, rears up and
// brings both fists down, and the ground round it heaves. The blow is telegraphed for a
// moment by a ring on the ground (EffSlam); whoever is still inside it when it lands is hurt
// and thrown clear. The abomination's ring is the bigger, and hurts the more.

// slamDef is a kind's slam.
type slamDef struct {
	every, windup, radius, hurt, throw float32
}

// slams is indexed by creep kind; a zero radius is a kind that does not slam.
var slams = [NumCreepKinds]slamDef{
	CBrute: {every: 4.5, windup: .9, radius: 5.5, hurt: 34, throw: 1.4},
	CBoss:  {every: 4, windup: 1.1, radius: 8, hurt: 65, throw: 2.2},
}

// slamStart is how long after a survivor first comes within the ring before the first slam.
const slamStart = .5

// bossSlam runs the slam of brute or abomination c going after tp, and reports whether it
// took the creep's tick: it stands still while it winds up.
func (w *World) bossSlam(c *Creep, tp *Player) bool {
	sd := &slams[c.Kind]
	if sd.radius == 0 {
		return false
	}
	if c.slam > sd.every-sd.windup {
		c.slam -= Dt
		c.Swing = SwingWindup
		return true
	}
	if tp == nil {
		c.slam = max(c.slam, slamStart)
		return false
	}
	// Anyone inside the ring will do, not only the one it is after.
	dx, dy := tp.X-c.X, tp.Y-c.Y
	if dx*dx+dy*dy > sd.radius*sd.radius && w.nearestPlayer(c.X, c.Y, sd.radius) == nil {
		c.slam = max(c.slam-Dt, min(c.slam, slamStart))
		return false
	}
	if c.slam -= Dt; c.slam > 0 {
		return false
	}
	c.slam = sd.every
	c.Swing = SwingWindup
	c.Face = float32(math.Atan2(float64(dy), float64(dx)))
	w.Effects = append(w.Effects, Effect{Kind: EffSlam, X0: c.X, Y0: c.Y, X: c.X, Y: c.Y, R: sd.radius, Left: sd.windup, Total: sd.windup, Damage: sd.hurt, Owner: -1})
	return true
}

// slamLands is a slam coming down: survivors inside the ring are hurt and thrown out of it.
func (w *World) slamLands(e *Effect) {
	throw := slams[CBrute].throw
	if e.R >= slams[CBoss].radius {
		throw = slams[CBoss].throw
	}
	for _, p := range w.Players {
		if !p.Alive {
			continue
		}
		dx, dy := p.X-e.X, p.Y-e.Y
		dd := dx*dx + dy*dy
		if dd > e.R*e.R {
			continue
		}
		d := sqrt32(dd)
		w.hurtPlayer(p, e.Damage*(1-.5*d/e.R))
		if !p.Alive {
			continue
		}
		if d < 1e-3 {
			dx, dy, d = 1, 0, 1
		}
		// Thrown clear in small steps, so a wall stops the throw rather than being jumped.
		for k := 0; k < 8; k++ {
			p.X, p.Y = Move(w, p.X, p.Y, dx/d*throw/8, dy/d*throw/8)
		}
		p.walk.reset()
	}
	w.Blasts = append(w.Blasts, Blast{e.X, e.Y, e.R, 3})
}
