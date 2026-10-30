package game

// A survivor's hit stuns a creep for a moment: it stops dead, its attack held where it was, so
// its blows come later but still come. A shotgun's load stops it longest, and longer with each
// level of its special track. The big ones shake it off
// quicker. A creep just stunned can't be
// stunned again for a little while, so a fast gun doesn't pin one in place, and turrets and
// burning ground never stun, or the base would hold the waves still.

const (
	stunFor      = .25 // seconds a hit stops a creep
	stunGap      = .5  // seconds after a stun before the next can land
	slugMul      = 2.5 // a shotgun's load stops them this many times longer
	slugMulLevel = .3  // and this much more for each level of its special track
)

// A creep's blow slows a survivor: for a moment they walk at half speed, though they keep
// firing. A hurler's bone, from far off, slows them longest, then the abomination's and a
// brute's blows. The same gap
// keeps a swarm from holding a survivor slowed.

// playerSlow is how long a blow from each kind of creep slows a survivor, in seconds.
var playerSlow = [NumCreepKinds]float32{CWalker: .4, CRunner: .3, CSwarmer: .25, CBrute: 1, CSpitter: .4, CBoss: 1.5, CHurler: 2.2, CMother: 1.2, CHound: .25, CMauler: 1.2, CGoliath: 1.6}

// Seconds a fuel pump going up slows a survivor; how much of their speed a slowed survivor
// keeps; the gap before they can be slowed again.
const (
	blastSlow     = .8
	slowSpeed     = .5
	playerSlowGap = .6
)

// slow slows survivor p for t seconds, unless they were slowed too lately.
func (p *Player) slow(t float32) {
	if !p.Alive || p.Shield > 0 || p.slowLeft > 0 || p.slowCool > 0 || p.unstoppable() {
		return
	}
	p.slowLeft, p.slowCool = t, t+playerSlowGap
}

// A slam stuns a survivor (slam.go): they stand where it threw them, neither moving nor
// firing, their order waiting for them. A second slam while stunned stuns them no longer.

// stun stops survivor p for t seconds, unless they are stopped for longer already.
func (p *Player) stun(t float32) {
	if p.Alive && p.Shield <= 0 && !p.unstoppable() {
		p.stunLeft = max(p.stunLeft, t)
	}
}

// Stunned reports whether survivor p is stopped: by a slam or a fall, or held or thrown by a
// mauler or a goliath (grab.go).
func (p *Player) Stunned() bool { return p.stunLeft > 0 || p.held || p.fly > 0 }

// SlowLeft is how many seconds survivor p still walks at slowSpeed; the page needs it to
// predict its own walk.
func (p *Player) SlowLeft() float32 { return max(p.slowLeft, 0) }

// tickSlow counts a survivor's slow and stun down, once a tick.
func (p *Player) tickSlow() {
	if p.slowCool > 0 {
		p.slowCool -= Dt
	}
	if p.slowLeft > 0 {
		p.slowLeft -= Dt
	}
	if p.stunLeft > 0 {
		p.stunLeft -= Dt
	}
}

// stun stops creep c for a moment, mul times as long as a hit does (longer for a shotgun's
// load), unless it was stunned too lately.
func (c *Creep) stun(mul float32) {
	if c.stunLeft > 0 || c.stunCool > 0 {
		return
	}
	t := float32(stunFor)
	switch c.Kind {
	case CBrute, CMauler:
		t = .15
	case CBoss, CMother, CGoliath:
		t = .08
	}
	t *= mul
	c.stunLeft, c.stunCool = t, t+stunGap
}

// slowed is the share of its pace a slowed creep keeps.
func (c *Creep) slowed() float32 { return 1 - c.slowBy }

// chill slows creep c for secs, taking by of its pace: the deepest slow on it holds until
// the last runs out.
func (c *Creep) chill(secs, by float32) {
	if c.Slow <= 0 || by > c.slowBy {
		c.slowBy = by
	}
	c.Slow = max(c.Slow, secs)
}

// stunned counts a stun down and reports whether the creep is stopped this tick.
func (c *Creep) stunned() bool {
	if c.stunCool > 0 {
		c.stunCool -= Dt
	}
	if c.stunLeft <= 0 {
		return false
	}
	c.stunLeft -= Dt
	c.swung = c.Swing
	return true
}
