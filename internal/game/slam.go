package game

import "math"

// The slam: an outpost's warlord, once awake, now and then stops, rears up and brings both
// fists down, and the ground round it heaves. The blow is telegraphed for slamWindup seconds
// by a ring on the ground (EffSlam); whoever is still inside it when it lands is hurt and
// thrown clear.
const (
	slamEvery  = 6.5 // seconds from one slam to the next
	slamWindup = 1.2
	slamRadius = 4.5
	slamHurt   = 50 // to a survivor at the warlord's feet, half at the ring's edge
	slamThrow  = 1.6
	slamStart  = 2 // seconds after first closing in before the first slam
)

// bossSlam runs the slam of warlord c going after tp, and reports whether it took the
// warlord's tick: it stands still while it winds up.
func (w *World) bossSlam(c *Creep, tp *Player) bool {
	if c.Kind != CBoss || c.Home == 0 {
		return false
	}
	if c.slam > slamEvery-slamWindup {
		c.slam -= Dt
		c.Swing = SwingWindup
		return true
	}
	if tp == nil {
		c.slam = max(c.slam, slamStart)
		return false
	}
	dx, dy := tp.X-c.X, tp.Y-c.Y
	if dx*dx+dy*dy > (slamRadius-.5)*(slamRadius-.5) {
		c.slam = max(c.slam-Dt, min(c.slam, slamStart))
		return false
	}
	if c.slam -= Dt; c.slam > 0 {
		return false
	}
	c.slam = slamEvery
	c.Swing = SwingWindup
	c.Face = float32(math.Atan2(float64(dy), float64(dx)))
	w.Effects = append(w.Effects, Effect{Kind: EffSlam, X0: c.X, Y0: c.Y, X: c.X, Y: c.Y, R: slamRadius, Left: slamWindup, Total: slamWindup, Damage: slamHurt, Owner: -1})
	return true
}

// slamLands is a slam coming down: survivors inside the ring are hurt and thrown out of it.
func (w *World) slamLands(e *Effect) {
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
			p.X, p.Y = Move(w, p.X, p.Y, dx/d*slamThrow/8, dy/d*slamThrow/8)
		}
		p.walk.reset()
	}
	w.Blasts = append(w.Blasts, Blast{e.X, e.Y, e.R, 3})
}
