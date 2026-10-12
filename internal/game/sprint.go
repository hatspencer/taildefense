package game

// The chase: every creep that has a survivor to go for runs faster than a survivor walks, so
// walking away is no escape; a survivor has to sprint, fight, or get behind a wall. Some of
// the dead are sprinters on top of that: in bursts they outrun even a sprinting survivor, and
// whoever keeps running gets away only while one stops to catch its breath.

const (
	chaseSpeed  = 6.6  // tiles per second: a tenth faster than a survivor without boots
	sprintSpeed = 10.5 // a sprinter's burst: faster than a survivor sprinting
	sprintFor   = 3.5  // seconds a burst lasts
	sprintRest  = 4    // seconds before the next
)

// sprintSpeed is how fast c chases a survivor this tick, given its speed otherwise, and spends
// a sprinter's burst.
func (c *Creep) sprintSpeed(speed float32) float32 {
	// Rain, snow and a slowing shot hold a chaser back as much as anything.
	mul := speed / Creeps[c.Kind].Speed
	if !c.Sprinter || c.sprint <= 0 {
		return max(speed, chaseSpeed*mul)
	}
	if c.sprint -= Dt; c.sprint <= 0 {
		c.sprint = -sprintRest
	}
	return sprintSpeed * mul
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
