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
//     brought down to split the ground in a line ahead. Everything in the line takes a crushing
//     blow and a share of its health, sundered to the full and stunned; then the fissure erupts
//     in bursts until it closes. Nothing stops the survivor till then.
//   - Worldbreaker, bought once at the armory for a greatsword fully upgraded and evolved: as
//     the fissure closes the whole line detonates in a shockwave, and every creep the shockwave
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

	// Worldsplitter: the seconds the blade is raised, the fissure's length and how far either
	// side of its line it reaches; the blow, as times the swing and a share of the creep's
	// health (a boss's); its stun, as times a hit's.
	splitWindup = .8
	splitLen    = 12
	splitHalf   = 1.5
	splitMul    = 5
	splitCut    = .25
	splitBoss   = .08
	splitStun   = 30
	// The eruption: seconds it lasts, a burst every splitEvery, each times the swing and a share
	// of the creep's health, and its stun as times a hit's: what walks onto the fissure is held
	// there, thrown up by the bursts.
	splitErupt      = 4
	splitEvery      = .5
	splitBurstMul   = .8
	splitBurstShare = .03
	splitBurstBoss  = .01
	splitBurstStun  = 6
	// splitTail is how long the ultimate runs past the fissure closing, so nothing Worldbreaker
	// deals fills the meter again.
	splitTail = .2

	// Worldbreaker: its price; the shockwave's reach either side of the line, its blow as times
	// the swing and a share of the creep's health (a boss's), its stun and throw; the charges,
	// their jumps (Stormbreaker's, and beside a Tesla coil within breakerCoil tiles), how far
	// each leaps, and each strike as times the swing; Ashen Colossus's burn on what they strike.
	BreakerCost     = 3000
	breakerBranch   = 3 // evolveWeapon's branch for it
	breakerReach    = 6
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

// Blasts of the greatsword's ultimate: a burst of the fissure erupting, Worldbreaker going off.
const (
	BlastErupt   = 20
	BlastBreaker = 21
)

// TracerSplit is Worldsplitter's cut, from the survivor to the end of the fissure.
const TracerSplit = 47

// Worldbreaker as the armory offers it.
const (
	BreakerName = "Worldbreaker"
	BreakerDesc = "Worldsplitter's fissure closes in a shockwave 6 tiles either side of the line, and every creep it catches carries a Tesla charge that leaps 5 times from creep to creep: 7 with Stormbreaker, 9 beside a Tesla coil; with Ashen Colossus each leap sets its creep burning. Needs every track full and an evolution."
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

// raiseSplit starts Worldsplitter towards x, y: the blade raised, the line it will split.
func (w *World) raiseSplit(p *Player, x, y float32) {
	ang := p.Aim
	if dx, dy := x-p.X, y-p.Y; dx*dx+dy*dy > 1e-4 {
		ang = float32(math.Atan2(float64(dy), float64(dx)))
	}
	p.Aim = ang
	p.Art, p.ArtLeft, p.ArtTotal = ArtSplit, splitWindup, splitWindup
	p.artX0, p.artY0 = p.X, p.Y
	p.artX, p.artY = p.X+cos32(ang)*splitLen, p.Y+sin32(ang)*splitLen
	p.Order = Order{Kind: OrderIdle}
	p.walk.reset()
}

// inLine gathers the creeps within half of the line from x0, y0 to x1, y1 (and their own
// size), into a slice of their own.
func (w *World) inLine(x0, y0, x1, y1, half float32) []int32 {
	lx, ly := x1-x0, y1-y0
	l2 := lx*lx + ly*ly
	var out []int32
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

// awayFrom throws creep i d tiles straight out from the line from x0, y0 to x1, y1.
func (w *World) awayFrom(i int32, x0, y0, x1, y1, d float32) {
	c := &w.Creeps[i]
	lx, ly := x1-x0, y1-y0
	l := sqrt32(lx*lx+ly*ly) + 1e-6
	nx, ny := -ly/l, lx/l
	if (c.X-x0)*nx+(c.Y-y0)*ny < 0 {
		nx, ny = -nx, -ny
	}
	w.push(i, nx, ny, d)
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

// worldsplit brings Worldsplitter down: the cut along its line, and the fissure left open. It is
// the greatsword's whatever was taken in hand while it was raised.
func (w *World) worldsplit(p *Player) {
	st := p.Weapons[WGreat].Stats(WGreat)
	w.mastery, w.crit, w.critMul = st.Mastery, st.Crit, st.CritMul
	owner := int8(p.ID)
	x0, y0, x1, y1 := p.X, p.Y, p.artX, p.artY
	w.sunder, w.sunderCap = sunderCap(st.Mastery)+1, sunderCap(st.Mastery)
	defer func() { w.sunder = 0 }()
	for _, i := range w.inLine(x0, y0, x1, y1, splitHalf) {
		w.hit(i, st.Damage*splitMul+w.healthShare(i, splitCut, splitBoss), owner, splitStun)
	}
	w.tracer(x0, y0, x1, y1, TracerSplit)
	w.pumpsIn((x0+x1)/2, (y0+y1)/2, splitHalf, owner, pumpChain)
	var lv uint8
	if p.Weapons[WGreat].Breaker {
		lv = 1
	}
	lv |= p.evo(WGreat) << 1
	w.Effects = append(w.Effects, Effect{Kind: EffFissure, X0: x0, Y0: y0, X: x1, Y: y1, R: splitHalf,
		Left: splitErupt, Total: splitErupt, Damage: st.Damage, Owner: owner, Lv: lv})
	p.Swings++
}

// stepFissure is a tick of the fissure: a burst every splitEvery, and Worldbreaker as it closes.
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
	for _, i := range w.inLine(e.X0, e.Y0, e.X, e.Y, e.R) {
		w.hit(i, e.Damage*splitBurstMul+w.healthShare(i, splitBurstShare, splitBurstBoss), e.Owner, splitBurstStun)
	}
	for k := 0; k < 3; k++ {
		u := w.rng.Float32()
		w.Blasts = append(w.Blasts, Blast{e.X0 + (e.X-e.X0)*u, e.Y0 + (e.Y-e.Y0)*u, e.R, BlastErupt})
	}
	if e.Left <= 0 && e.Lv&1 != 0 {
		w.worldbreak(e, p)
	}
}

// worldbreak is the fissure closing in Worldbreaker: the line goes off in a shockwave, and every
// creep it catches carries a charge that leaps on from creep to creep.
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
	caught := w.inLine(e.X0, e.Y0, e.X, e.Y, breakerReach)
	mx, my := (e.X0+e.X)/2, (e.Y0+e.Y)/2
	for _, i := range caught {
		c := &w.Creeps[i]
		lx, ly := e.X-e.X0, e.Y-e.Y0
		l2 := lx*lx + ly*ly + 1e-6
		u := clampf(((c.X-e.X0)*lx+(c.Y-e.Y0)*ly)/l2, 0, 1)
		dx, dy := c.X-(e.X0+lx*u), c.Y-(e.Y0+ly*u)
		edge := sqrt32(dx*dx+dy*dy) / breakerReach
		w.hit(i, (e.Damage*breakerMul+w.healthShare(i, breakerShare, breakerBoss))*(1-.4*min(edge, 1)), e.Owner, breakerStun)
		w.awayFrom(i, e.X0, e.Y0, e.X, e.Y, breakerPush)
	}
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
	for _, u := range []float32{0, .5, 1} {
		w.Blasts = append(w.Blasts, Blast{e.X0 + (e.X-e.X0)*u, e.Y0 + (e.Y-e.Y0)*u, breakerReach, BlastBreaker})
	}
	w.pumpsIn(mx, my, breakerReach, e.Owner, pumpChain)
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
