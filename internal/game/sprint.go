package game

// Sprinters: some of the dead run faster than a survivor once they have one to chase, but
// only in bursts, so whoever keeps running gets away while it catches its breath.

const (
	sprintSpeed = 6.6 // tiles per second: a tenth faster than a survivor without boots
	sprintFor   = 3.5 // seconds a burst lasts
	sprintRest  = 4   // seconds before the next
)

// sprintSpeed is how fast c chases a survivor this tick, given its speed otherwise, and spends
// its burst.
func (c *Creep) sprintSpeed(speed float32) float32 {
	if !c.Sprinter || c.sprint <= 0 {
		return speed
	}
	if c.sprint -= Dt; c.sprint <= 0 {
		c.sprint = -sprintRest
	}
	// Rain, snow and a slowing shot hold a sprinter back as much as anything.
	return speed / Creeps[c.Kind].Speed * sprintSpeed
}

// rest is a tick of a sprinter catching its breath, or getting its burst back while it
// chases nobody.
func (c *Creep) rest() {
	switch {
	case !c.Sprinter:
	case c.sprint < 0:
		if c.sprint += Dt; c.sprint >= 0 {
			c.sprint = sprintFor
		}
	case c.Chase < 0:
		c.sprint = min(c.sprint+Dt/2, sprintFor)
	}
}
