package game

// A survivor's hit stuns a creep for a moment: it stops dead, its attack held where it was, so
// its blows come later but still come. A shotgun's load stops it longest. The big ones shake it off
// quicker. A creep just stunned can't be
// stunned again for a little while, so a fast gun doesn't pin one in place, and turrets and
// burning ground never stun, or the base would hold the waves still.

const (
	stunFor = .25 // seconds a hit stops a creep
	stunGap = .5  // seconds after a stun before the next can land
	slugMul = 2.5 // a shotgun's point-blank load stops them this many times longer
)

// A creep's blow stuns a survivor too: they stop where they stand and hold their fire for a
// moment. A brute's or the abomination's blow, and a slam, stops them longest. The same gap
// keeps a swarm from pinning a survivor in place.

// playerStun is how long a blow from each kind of creep stops a survivor, in seconds.
var playerStun = [NumCreepKinds]float32{CWalker: .2, CRunner: .15, CSwarmer: .12, CBrute: .5, CSpitter: .2, CBoss: .8}

// Seconds a slam (brute's, abomination's) and a fuel pump going up stop a survivor.
const (
	slamStunBrute = .6
	slamStunBoss  = 1
	blastStun     = .4
	playerStunGap = .6
)

// stun stops survivor p for t seconds, unless they were stunned too lately.
func (p *Player) stun(t float32) {
	if !p.Alive || p.stunLeft > 0 || p.stunCool > 0 {
		return
	}
	p.stunLeft, p.stunCool = t, t+playerStunGap
}

// stunned counts a survivor's stun down and reports whether they are stopped this tick.
func (p *Player) stunned() bool {
	if p.stunCool > 0 {
		p.stunCool -= Dt
	}
	if p.stunLeft <= 0 {
		return false
	}
	p.stunLeft -= Dt
	return true
}

// stun stops creep c for a moment, longer for a shotgun's load, unless it was stunned too lately.
func (c *Creep) stun(slug bool) {
	if c.stunLeft > 0 || c.stunCool > 0 {
		return
	}
	t := float32(stunFor)
	switch c.Kind {
	case CBrute:
		t = .15
	case CBoss:
		t = .08
	}
	if slug {
		t *= slugMul
	}
	c.stunLeft, c.stunCool = t, t+stunGap
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
