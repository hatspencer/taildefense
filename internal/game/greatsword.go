package game

import (
	"errors"
	"math"
)

// The greatsword's own rules, past the swing, the stagger and the shockwave (legend.go):
//
//   - Sunder: every blow it deals, the swing, its shockwave, Skyfall and Worldsplitter, cracks
//     the creep it lands on. Each stack strips a share of its armour and makes every hit on it,
//     the team's and the turrets' too, land harder; they fall off a while after the last blow.
//     Mastery lets more stack. It is how the slow blade gets through a brute or a goliath that
//     the katana's blood loss eats from inside: one cracks it open for everyone.
//   - The follow-through cleaves: besides hitting harder, it takes a share of each creep's
//     health, as the katana's bursts do.
//   - Tempered: a second greatsword found is not wielded but forged into the first, which counts
//     as the katana's second does for mastery and crits, so a full greatsword reaches a full
//     pair's 1.2.
//   - Worldsplitter, its ultimate: the blade raised a moment, the survivor untouchable, then
//     slammed into the ground at their feet. The shockwave goes out every way: everything in
//     reach takes a crushing blow and a share of its health, a little less at the edge, is
//     sundered to the full, stunned and, if it lives, thrown back. The ground cracked round the
//     blade erupts in bursts until it closes. Nothing stops the survivor till then.
//   - Worldbreaker, bought once at the armory for a greatsword fully upgraded and evolved: as
//     the cracks close the ground detonates in a wider shockwave, and every creep it
//     catches carries a charge that leaps from creep to creep. Stormbreaker's leap further, more
//     still beside a Tesla coil; Ashen Colossus's set what they strike burning.

const (
	// Sunder: what each stack takes off a creep's armour and adds to every hit on it; the most
	// that stack, and what mastery at 1 adds to that; the seconds they hold after the last blow.
	sunderArmor     = .2
	sunderStep      = .08
	sunderMost      = 5
	sunderMostLevel = 4
	sunderFor       = 5
	followSunder    = 2 // a follow-through's blow cracks deeper
	skyfallSunder   = 3

	// The follow-through's cleave: the share of a creep's health it takes, and what mastery at
	// 1 adds; for a boss.
	cleave          = .03
	cleaveLevel     = .07
	cleaveBoss      = .01
	cleaveBossLevel = .07

	// Worldsplitter: the seconds the blade is raised; the shockwave's reach round the survivor;
	// the blow, as times the swing and a share of the creep's health (a boss's), and what is
	// left of it at the edge; its stun, as times a hit's; how far it throws a creep it does not
	// kill (less at the edge, and a boss stands firm); the reach of the cracked ground.
	splitWindup = .8
	splitReach  = 7
	splitMul    = 5
	splitCut    = .25
	splitBoss   = .08
	splitEdge   = .7
	splitStun   = 30
	splitPush   = 4
	splitCrack  = 4
	// The eruption: seconds it lasts, a burst every splitEvery, each times the swing and a share
	// of the creep's health, and its stun as times a hit's: what walks back onto the cracked
	// ground is held there, thrown up by the bursts.
	splitErupt      = 4
	splitEvery      = .5
	splitBurstMul   = .8
	splitBurstShare = .03
	splitBurstBoss  = .01
	splitBurstStun  = 6
	// splitTail is how long the ultimate runs past the cracks closing, so nothing Worldbreaker
	// deals fills the meter again.
	splitTail = .2

	// Worldbreaker: its price; the shockwave's reach round the blade, its blow as times
	// the swing and a share of the creep's health (a boss's), its stun and throw; the charges,
	// their jumps (Stormbreaker's, and beside a Tesla coil within breakerCoil tiles), how far
	// each leaps, and each strike as times the swing; Ashen Colossus's burn on what they strike.
	BreakerCost     = 3000
	breakerBranch   = 3 // evolveWeapon's branch for it
	breakerReach    = 10
	breakerMul      = 4
	breakerShare    = .1
	breakerBoss     = .03
	breakerStun     = 20
	breakerPush     = 1.5
	breakerJumps    = 5
	breakerStorm    = 7
	breakerCoilJump = 9
	breakerCoil     = 5
	breakerHop      = 5
	breakerZap      = 1.5
	breakerStormZap = 2
	breakerBurn     = 30
)

// Blasts of the greatsword's ultimate: a burst of the cracked ground erupting, Worldbreaker
// going off.
const (
	BlastErupt   = 20
	BlastBreaker = 21
)

// TracerSplit is Worldsplitter's slam, from the survivor out to the shockwave's reach the way
// they face: the blade bites just ahead of them along it.
const TracerSplit = 47

// Worldbreaker as the armory offers it.
const (
	BreakerName = "Worldbreaker"
	BreakerDesc = "Worldsplitter's cracked ground closes in a shockwave 10 tiles round the blade, and every creep it catches carries a Tesla charge that leaps 5 times from creep to creep: 7 with Stormbreaker, 9 beside a Tesla coil; with Ashen Colossus each leap sets its creep burning. Needs every track full and an evolution."
)

// temperedNote is what a survivor is told when a second greatsword is forged into theirs.
const temperedNote = "forged into the first, a tempered greatsword"

// sunderCap is the most sunder a greatsword of mastery m stacks on a creep.
func sunderCap(m float32) uint8 { return uint8(sunderMost + sunderMostLevel*min(m, 1)) }

// sunderHit cracks c by the greatsword's blow being dealt.
func (w *World) sunderHit(c *Creep) {
	c.Sunder = min(c.Sunder+w.sunder, max(w.sunderCap, c.Sunder))
	c.sunderLeft = sunderFor
}

// sunderArmor is the share of its armour a sundered creep keeps.
func (c *Creep) sunderArmor() float32 { return max(1-sunderArmor*float32(c.Sunder), 0) }

// sundered is what every hit on c is multiplied by.
func (c *Creep) sundered() float32 { return 1 + sunderStep*float32(c.Sunder) }

// stepSunder lets the sunder fall off a while after the last blow.
func (c *Creep) stepSunder() {
	if c.Sunder > 0 {
		if c.sunderLeft -= Dt; c.sunderLeft <= 0 {
			c.Sunder, c.sunderLeft = 0, 0
		}
	}
}

// healthShare is a share of creep i's full health, boss of it for a boss.
func (w *World) healthShare(i int32, share, boss float32) float32 {
	c := &w.Creeps[i]
	if c.Kind.Boss() {
		share = boss
	}
	return share * c.MaxHP
}

// cleave is the share of creep i's health a follow-through of mastery m takes.
func (w *World) cleave(i int32, m float32) float32 {
	m = min(m, 1)
	return w.healthShare(i, cleave+cleaveLevel*m, cleaveBoss+cleaveBossLevel*m)
}

// raiseSplit starts Worldsplitter facing x, y: the blade raised over the survivor.
func (w *World) raiseSplit(p *Player, x, y float32) {
	ang := p.Aim
	if dx, dy := x-p.X, y-p.Y; dx*dx+dy*dy > 1e-4 {
		ang = float32(math.Atan2(float64(dy), float64(dx)))
	}
	p.Aim = ang
	p.Art, p.ArtLeft, p.ArtTotal = ArtSplit, splitWindup, splitWindup
	p.artX0, p.artY0 = p.X, p.Y
	p.Order = Order{Kind: OrderIdle}
	p.walk.reset()
}

// inLine appends to out the creeps within half of the line from x0, y0 to x1, y1 (and their
// own size), so a caller can gather into a fresh slice (nil) or a reused scratch one.
func (w *World) inLine(out []int32, x0, y0, x1, y1, half float32) []int32 {
	lx, ly := x1-x0, y1-y0
	l2 := lx*lx + ly*ly
	w.grid.each((x0+x1)/2, (y0+y1)/2, sqrt32(l2)/2+half+1, func(i int32) bool {
		c := &w.Creeps[i]
		if c.HP <= 0 || w.hidden(c) {
			return true
		}
		u := float32(0)
		if l2 > 0 {
			u = clampf(((c.X-x0)*lx+(c.Y-y0)*ly)/l2, 0, 1)
		}
		dx, dy := c.X-(x0+lx*u), c.Y-(y0+ly*u)
		if r := half + Creeps[c.Kind].Radius; dx*dx+dy*dy <= r*r {
			out = append(out, i)
		}
		return true
	})
	return out
}

// artName is the name of art a.
func artName(a uint8) string {
	switch a {
	case ArtFlash:
		return Arts[WKatana].Name
	case ArtSkyfall:
		return Arts[WGreat].Name
	case ArtHomeRun:
		return Arts[WCrowbar].Name
	case ArtSplit:
		return Ultimates[WGreat].Name
	}
	return ""
}

// worldsplit slams Worldsplitter into the ground: the shockwave out every way, and the cracks
// left open round the blade. It is the greatsword's whatever was taken in hand while it was
// raised.
func (w *World) worldsplit(p *Player) {
	st := p.Weapons[WGreat].Stats(WGreat)
	w.mastery, w.crit, w.critMul = st.Mastery, st.Crit, st.CritMul
	owner := int8(p.ID)
	x, y := p.X, p.Y
	w.sunder, w.sunderCap = sunderCap(st.Mastery)+1, sunderCap(st.Mastery)
	defer func() { w.sunder = 0 }()
	w.shockwave(owner, x, y, splitReach, func(i int32) float32 {
		return st.Damage*splitMul + w.healthShare(i, splitCut, splitBoss)
	}, splitEdge, splitStun, splitPush)
	w.tracer(x, y, x+cos32(p.Aim)*splitReach, y+sin32(p.Aim)*splitReach, TracerSplit)
	w.pumpsIn(x, y, splitReach, owner, pumpChain)
	var lv uint8
	if p.Weapons[WGreat].Breaker {
		lv = 1
	}
	lv |= p.evo(WGreat) << 1
	w.Effects = append(w.Effects, Effect{Kind: EffFissure, X0: x, Y0: y, X: x, Y: y, R: splitCrack,
		Left: splitErupt, Total: splitErupt, Damage: st.Damage, Owner: owner, Lv: lv})
	p.Swings++
}

// shockwave is the ground going out every way from x, y to r: each creep in reach takes
// dmg(i), down to edge of it at r, is stunned stun times as long as a hit, and, if it lives,
// is thrown push straight out from x, y, half that at r.
func (w *World) shockwave(owner int8, x, y, r float32, dmg func(i int32) float32, edge, stun, push float32) {
	for _, i := range w.inLine(nil, x, y, x, y, r) {
		c := &w.Creeps[i]
		dx, dy := c.X-x, c.Y-y
		d := sqrt32(dx*dx + dy*dy)
		u := min(d/r, 1)
		w.hit(i, dmg(i)*(1-(1-edge)*u), owner, stun)
		if c.HP <= 0 {
			continue
		}
		if d < 1e-3 {
			a := w.rng.Float32() * 2 * math.Pi
			dx, dy, d = cos32(a), sin32(a), 1
		}
		w.push(i, dx/d, dy/d, push*(1-.5*u))
	}
}

// stepFissure is a tick of the cracked ground: a burst every splitEvery, and Worldbreaker as it
// closes.
func (w *World) stepFissure(e *Effect) {
	if int((e.Left+Dt)/splitEvery) == int(e.Left/splitEvery) && e.Left > 0 {
		return
	}
	var p *Player
	if e.Owner >= 0 && int(e.Owner) < len(w.Players) {
		p = w.Players[e.Owner]
	}
	if p != nil {
		m := p.Weapons[WGreat].Mastery(WGreat)
		w.mastery, w.sunder, w.sunderCap = m, 1, sunderCap(m)
		w.crit, w.critMul = p.Weapons[WGreat].crit(WGreat)
		defer func() { w.mastery, w.sunder, w.crit, w.critMul = 0, 0, 0, 0 }()
	}
	for _, i := range w.inLine(nil, e.X0, e.Y0, e.X, e.Y, e.R) {
		w.hit(i, e.Damage*splitBurstMul+w.healthShare(i, splitBurstShare, splitBurstBoss), e.Owner, splitBurstStun)
	}
	for k := 0; k < 4; k++ {
		a, d := w.rng.Float32()*2*math.Pi, e.R*(.3+.7*w.rng.Float32())
		w.Blasts = append(w.Blasts, Blast{e.X + cos32(a)*d, e.Y + sin32(a)*d, 1.5, BlastErupt})
	}
	if e.Left <= 0 && e.Lv&1 != 0 {
		w.worldbreak(e, p)
	}
}

// worldbreak is the cracked ground closing in Worldbreaker: it goes off in a shockwave round the
// blade, and every creep it catches carries a charge that leaps on from creep to creep.
func (w *World) worldbreak(e *Effect, p *Player) {
	evo := e.Lv >> 1
	jumps, zap, burn := breakerJumps, float32(breakerZap), float32(0)
	switch evo {
	case 1:
		burn = breakerBurn * lateScale(w.Wave)
	case 2:
		jumps, zap = breakerStorm, breakerStormZap
		if p != nil && w.coilNear(p.X, p.Y, breakerCoil) {
			jumps = breakerCoilJump
		}
	}
	caught := w.inLine(nil, e.X, e.Y, e.X, e.Y, breakerReach)
	w.shockwave(e.Owner, e.X, e.Y, breakerReach, func(i int32) float32 {
		return e.Damage*breakerMul + w.healthShare(i, breakerShare, breakerBoss)
	}, .6, breakerStun, breakerPush)
	w.sunder = 0 // the charges' strikes are lightning, not the blade
	for _, i := range caught {
		if w.Creeps[i].HP > 0 {
			w.arc(e.Owner, i, e.Damage*zap, jumps, breakerHop, burn)
		} else if a, ok := w.nearestTo(i, breakerHop); ok {
			// One the blow killed still passes its charge on.
			w.tracer(w.Creeps[i].X, w.Creeps[i].Y, w.Creeps[a].X, w.Creeps[a].Y, TracerArc)
			w.damage(a, e.Damage*zap, e.Owner)
			w.arc(e.Owner, a, e.Damage*zap, jumps-1, breakerHop, burn)
		}
	}
	w.Blasts = append(w.Blasts, Blast{e.X, e.Y, breakerReach, BlastBreaker})
	w.pumpsIn(e.X, e.Y, breakerReach, e.Owner, pumpChain)
	w.note(1, "Worldbreaker!")
}

// nearestTo is the living creep nearest creep i within r, but i.
func (w *World) nearestTo(i int32, r float32) (int32, bool) {
	c := &w.Creeps[i]
	best, bi := r*r, int32(-1)
	w.grid.each(c.X, c.Y, r, func(j int32) bool {
		o := &w.Creeps[j]
		if j == i || o.HP <= 0 || w.hidden(o) {
			return true
		}
		if dx, dy := o.X-c.X, o.Y-c.Y; dx*dx+dy*dy < best {
			best, bi = dx*dx+dy*dy, j
		}
		return true
	})
	return bi, bi >= 0
}

// coilNear reports whether a standing Tesla coil is within r of x, y, whoever built it.
func (w *World) coilNear(x, y, r float32) bool {
	for si := range w.Structs {
		s := &w.Structs[si]
		if s.Alive && s.Kind == STurretTesla {
			if dx, dy := s.CX()-x, s.CY()-y; dx*dx+dy*dy <= r*r {
				return true
			}
		}
	}
	return false
}

// CanBreak reports whether p's greatsword may take Worldbreaker: every track full, evolved,
// and not already.
func CanBreak(ws *WeaponState) bool {
	if !ws.Owned || ws.Evo == 0 || ws.Breaker {
		return false
	}
	for _, l := range ws.Lv {
		if l < MaxLevel {
			return false
		}
	}
	return true
}

// buyBreaker gives p's greatsword Worldbreaker, at the armory, for BreakerCost.
func (w *World) buyBreaker(p *Player) error {
	ws := &p.Weapons[WGreat]
	switch {
	case !ws.Owned:
		return errors.New("you do not carry the greatsword")
	case ws.Breaker:
		return errors.New("your greatsword has Worldbreaker already")
	case !CanBreak(ws):
		return errors.New("Worldbreaker takes a greatsword with every track full and evolved")
	case !w.atArmory(p):
		return errNotAtArmory
	}
	if err := w.pay(p, BreakerCost); err != nil {
		return err
	}
	ws.Breaker = true
	w.note(1, "%s's greatsword will break the world", p.Name)
	return nil
}
