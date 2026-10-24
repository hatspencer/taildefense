package game

// A spitter's spit is a glob, not a hit: as its windup ends it is spat at where its mark
// stands then, leading nothing, and flies there at spitSpeed. It splashes whoever is within
// spitR of that spot when it lands, so a survivor who keeps moving (or steps aside once the
// spitter rears back) is clear of it, and one standing still to build, search, revive or
// shoot is not. It used to land the moment it was spat, on wherever the survivor was, so it
// followed them however they moved.
const (
	spitSpeed = 8   // tiles a second: a walking survivor (6) crossing its line is gone by the time it lands
	spitR     = .55 // the splash, past the survivor's own radius
	spitMin   = .15 // seconds in the air at least, however close
)

// spit sends c's glob at where tp stands.
func (w *World) spit(c *Creep, d *CreepDef, tp *Player) {
	dx, dy := tp.X-c.X, tp.Y-c.Y
	flight := max(sqrt32(dx*dx+dy*dy)/spitSpeed, spitMin)
	w.Effects = append(w.Effects, Effect{Kind: EffSpit, X0: c.X, Y0: c.Y, X: tp.X, Y: tp.Y, R: spitR,
		Left: flight, Total: flight, Damage: d.Damage, Owner: -1, Lv: uint8(c.Kind)})
}

// spitLands is a glob splashing: every survivor it touches is hurt and slowed.
func (w *World) spitLands(e *Effect) {
	r := e.R + PlayerRadius
	for _, p := range w.Players {
		if !p.Alive {
			continue
		}
		if dx, dy := p.X-e.X, p.Y-e.Y; dx*dx+dy*dy <= r*r {
			w.hurtPlayer(p, e.Damage)
			p.slow(playerSlow[CreepKind(e.Lv)])
		}
	}
}
