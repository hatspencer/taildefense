package game

import (
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"strings"
)

// The legendary blades: a katana and a greatsword, never sold, found only where the map is
// most dangerous (the gas station's counter, the crashed plane's hold, and the shrines out in
// the wilds, where nothing else is). They are melee weapons with more to them than a swing:
//
//   - a rule of their own: a katana's cuts build up blood loss, and when it fills it bursts for
//     a share of the creep's health; a greatsword staggers what it hits, and every third swing in
//     a row is a follow-through that shakes the ground round where it lands;
//   - a weapon art on F, in place of the dash while one is in hand: the katana's Flash Draw, a
//     drawn cut that carries the survivor through a line of creeps, and the greatsword's Skyfall,
//     a leap that comes down on a crowd;
//   - an ultimate on Q, as every weapon has;
//   - two evolutions each, bought once the tracks add up to EvolveAt, as a turret evolves.
//
// A second katana, found, goes in the other hand: a pair swings dualKatana times as fast.

// Arts: the weapon art running, by the legendary that has it.
const (
	ArtNone    uint8 = iota
	ArtFlash         // the katana's Flash Draw: a drawn stance, then a cut through everything on the way to a point
	ArtSkyfall       // the greatsword's Skyfall: a leap through the air, coming down on a point
)

// ArtDef is a legendary's weapon art.
type ArtDef struct {
	Name   string
	Desc   string
	Range  float32
	Cool   float32 // seconds before it can be used again
	Windup float32 // seconds from the key to the cut: the draw, or the leap's flight
}

// Arts is indexed by WeaponKind; only the legendaries have one.
var Arts = [NumWeapons]ArtDef{
	WKatana: {Name: "Flash Draw", Desc: "A breath with the blade sheathed, then one drawn cut that carries you through every creep on the way to a point: triple damage, heavy bleed.", Range: 7, Cool: 6, Windup: flashDraw},
	WGreat:  {Name: "Skyfall", Desc: "Leap to a point, untouchable in the air, and bring the blade down on everything round it: a heavy blow that stuns and throws them back.", Range: 7, Cool: 9, Windup: skyfallFlight},
}

// LegendEvo is one of a legendary's two evolutions.
type LegendEvo struct {
	Name string
	Desc string
}

// LegendEvos is indexed by WeaponKind, then branch 1 and 2 at 0 and 1.
var LegendEvos = [NumWeapons][2]LegendEvo{
	WKatana: {
		{"Crimson Fang", "Bleed builds 60% faster. Each burst of blood loss heals you and spatters bleed onto every creep near it, so one burst sets off the next."},
		{"Moonlit Edge", "Every swing looses a crescent of moonlight 5.5 tiles ahead through up to six creeps, and Flash Draw reaches 3 tiles further."},
	},
	WGreat: {
		{"Ashen Colossus", "Every hit sets its creep burning, the follow-through leaves the ground on fire, and Skyfall lands in a ring of flame."},
		{"Stormbreaker", "Every swing throws lightning from what it hits to three more creeps, and Skyfall calls a thunderbolt down with it: wider, and stunning twice as long."},
	},
}

// LegendEvoCost is the gold an evolution of a legendary costs.
const LegendEvoCost = 1500

// The legendaries' numbers.
const (
	dualKatana = 1.7 // a pair of katanas swings this many times as fast as one

	// Blood loss: what a katana's cut builds, and what each level of its special adds; it
	// bursts at bleedFull, for bleedShare of the creep's full health (bleedBoss for a boss) and
	// bleedFlat more, armour and all; it drains at bleedDrain a second.
	katanaBleed      = 22
	katanaBleedLevel = 6
	bleedFull        = 100
	bleedShare       = .16
	bleedBoss        = .05
	bleedFlat        = 30
	bleedDrain       = 10

	// The greatsword: how many times a hit's stun its blows stop a creep for, and more each
	// level of its special track; how far each pushes it back; its follow-through.
	greatStagger      = 3
	greatStaggerLevel = .4
	greatShove        = .35
	followEvery       = 3   // every third swing in a row is a follow-through
	followMul         = 1.6 // which hits this many times as hard
	followQuake       = 2.6 // and shakes the ground this far round where it lands, for half
	followLapse       = 1.6 // seconds without a swing before the chain starts over

	flashDraw     = .3  // seconds the katana is held sheathed before the cut
	flashWidth    = 1.3 // tiles either side of its line the cut reaches
	flashMul      = 3   // times the katana's damage the cut deals
	flashBleed    = 70
	skyfallFlight = .6  // seconds in the air
	skyfallMul    = 2.4 // times the greatsword's damage the landing deals at its heart
	skyfallRadius = 3
	skyfallStun   = 6 // times a hit's stun

	// Crimson Fang: the share of their health a burst gives back, the bleed it spatters, how far.
	fangHeal   = .06
	fangSplash = 45
	fangReach  = 2.5
	// Moonlit Edge's crescent.
	moonReach = 5.5
	moonHits  = 6
	moonMul   = .6
	moonDraw  = 3 // tiles further Flash Draw goes
	// Ashen Colossus: the burn of each hit, and more a level of the special; the follow-through's fire.
	ashBurn      = 10
	ashBurnLevel = 3
	ashFire      = 3 // seconds the ground burns
	// Stormbreaker's lightning: jumps from each swing's first creep, how far, for what share.
	stormJumps = 3
	stormHop   = 4
	stormMul   = .45
)

// Tracers of the legendaries: a swing of each, under its ultimate, the follow-through, Flash
// Draw's cut, Moonlit Edge's crescent.
const (
	TracerKatana    = 38
	TracerGreat     = 39
	TracerKatanaUlt = 40
	TracerGreatUlt  = 41
	TracerFlash     = 42
	TracerMoon      = 43
	TracerFollow    = 44
)

// Blasts of the legendaries: a creep's blood loss bursting, Skyfall coming down.
const (
	BlastBleed   = 17
	BlastSkyfall = 18
)

// unstoppable reports whether nothing slows, stuns or grabs p: Berserk, Titan's Wrath, or in
// the air in a Skyfall.
func (p *Player) unstoppable() bool {
	return p.ulting(WCrowbar) || p.ulting(WGreat) || p.Art == ArtSkyfall
}

// evo is the evolution of the legendary k p carries, 0 for none.
func (p *Player) evo(k WeaponKind) uint8 { return p.Weapons[k].Evo }

// swingLegend is a swing of the legendary in p's hands: the cut itself, then its rules.
func (w *World) swingLegend(p *Player, st Stats, ang float32, ult bool) {
	owner := int8(p.ID)
	k := p.Cur
	p.Swings++
	dmg, kind := st.Damage, uint8(TracerKatana)
	follow := false
	if k == WGreat {
		kind = TracerGreat
		if p.chainLeft <= 0 {
			p.chain = 0
		}
		p.chain++
		p.chainLeft = followLapse
		follow = ult || p.chain%followEvery == 0
		if follow {
			dmg *= followMul
			kind = TracerFollow
		}
	}
	if ult {
		kind = TracerKatanaUlt
		if k == WGreat {
			kind = TracerGreatUlt
		}
	}
	hits := w.melee(owner, p.X, p.Y, ang, st.Range, st.Spread, dmg, kind, st.Hits, st.Stun)
	dx, dy := float32(math.Cos(float64(ang))), float32(math.Sin(float64(ang)))
	evo := p.evo(k)
	switch k {
	case WKatana:
		bleed := st.Bleed
		if ult {
			bleed *= 2
		}
		if evo == 1 {
			bleed *= 1.6
		}
		for _, i := range hits {
			w.bleed(i, bleed, p)
		}
		if evo == 2 {
			// The crescent: a narrow, long reach ahead, through whatever stands in it.
			for _, i := range w.melee(owner, p.X, p.Y, ang, moonReach, .3, dmg*moonMul, TracerMoon, moonHits, 1) {
				w.bleed(i, bleed*.5, p)
			}
		}
	case WGreat:
		for _, i := range hits {
			c := &w.Creeps[i]
			if st.Shove > 0 {
				ox, oy := c.X-p.X, c.Y-p.Y
				if d := sqrt32(ox*ox + oy*oy); d > 1e-3 {
					w.push(i, ox/d, oy/d, st.Shove)
				}
			}
			if evo == 1 {
				w.ignite(i, ashBurn+ashBurnLevel*float32(p.Weapons[k].Lv[TrackSpecial]))
			}
		}
		if evo == 2 && len(hits) > 0 {
			w.storm(p, hits[0], dmg*stormMul)
		}
		if follow {
			// The ground shakes round where the blade comes down.
			qx, qy := p.X+dx*st.Range*.7, p.Y+dy*st.Range*.7
			w.quake(owner, qx, qy, followQuake, dmg*.5, 1.5)
			if evo == 1 {
				w.Effects = append(w.Effects, Effect{Kind: EffNapalm, X0: qx, Y0: qy, X: qx, Y: qy, R: 2,
					Left: ashFire, Total: ashFire, Damage: ashBurn * 1.5 * lateScale(w.Wave), Owner: owner})
			}
		}
	}
}

// quake is a blow of the ground round x, y: everything within r takes dmg, less at the edge,
// stunned stun times as long as a hit, and is thrown back from it.
func (w *World) quake(owner int8, x, y, r, dmg, stun float32) {
	cands := w.near[:0]
	w.grid.each(x, y, r, func(i int32) bool {
		c := &w.Creeps[i]
		if dx, dy := c.X-x, c.Y-y; c.HP > 0 && dx*dx+dy*dy <= r*r && !w.hidden(c) {
			cands = append(cands, i)
		}
		return true
	})
	for _, i := range cands {
		c := &w.Creeps[i]
		dx, dy := c.X-x, c.Y-y
		d := sqrt32(dx*dx + dy*dy)
		w.hit(i, dmg*(1-.5*d/r), owner, stun)
		if d > 1e-3 {
			w.push(i, dx/d, dy/d, .6)
		}
	}
	w.near = cands[:0]
}

// storm throws Stormbreaker's lightning from creep first to the nearest creeps round it.
func (w *World) storm(p *Player, first int32, dmg float32) {
	owner := int8(p.ID)
	from := first
	done := w.near[:0]
	done = append(done, first)
	for j := 0; j < stormJumps; j++ {
		c := &w.Creeps[from]
		best, bi := float32(stormHop*stormHop), int32(-1)
		w.grid.each(c.X, c.Y, stormHop, func(i int32) bool {
			o := &w.Creeps[i]
			if o.HP <= 0 || w.hidden(o) {
				return true
			}
			for _, d := range done {
				if d == i {
					return true
				}
			}
			if dx, dy := o.X-c.X, o.Y-c.Y; dx*dx+dy*dy < best {
				best, bi = dx*dx+dy*dy, i
			}
			return true
		})
		if bi < 0 {
			break
		}
		o := &w.Creeps[bi]
		w.tracer(c.X, c.Y, o.X, o.Y, TracerArc)
		w.damage(bi, dmg, owner)
		done = append(done, bi)
		from = bi
	}
	w.near = done[:0]
}

// bleed builds blood loss on creep i from p's cut; when it fills, it bursts.
func (w *World) bleed(i int32, amt float32, p *Player) {
	c := &w.Creeps[i]
	if c.HP <= 0 {
		return
	}
	if c.Bleed += amt; c.Bleed < bleedFull {
		return
	}
	c.Bleed = 0
	share := float32(bleedShare)
	if c.Kind.Boss() {
		share = bleedBoss
	}
	dmg := c.MaxHP*share + bleedFlat*lateScale(w.Wave)
	x, y := c.X, c.Y
	w.noArmor = true
	w.hit(i, dmg, int8(p.ID), 1)
	w.noArmor = false
	w.Blasts = append(w.Blasts, Blast{x, y, 1, BlastBleed})
	if p.evo(WKatana) == 1 {
		// Crimson Fang drinks it, and spatters it onto what stands near.
		p.HP = min(p.MaxHP, p.HP+p.MaxHP*fangHeal)
		near := w.near[:0]
		w.grid.each(x, y, fangReach, func(j int32) bool {
			if o := &w.Creeps[j]; j != i && o.HP > 0 && (o.X-x)*(o.X-x)+(o.Y-y)*(o.Y-y) <= fangReach*fangReach {
				near = append(near, j)
			}
			return true
		})
		w.near = near[:0]
		// Copied out: a burst it sets off spatters in turn, through the same scratch.
		spat := append([]int32(nil), near...)
		for _, j := range spat {
			w.bleed(j, fangSplash, p)
		}
	}
}

// stepBleed drains creep c's blood loss a tick.
func (c *Creep) stepBleed() {
	if c.Bleed > 0 {
		c.Bleed = max(c.Bleed-bleedDrain*Dt, 0)
	}
}

// ArtRange is how far p's weapon art reaches.
func ArtRange(p *Player) float32 {
	r := Arts[p.Cur].Range
	if p.Cur == WKatana && p.evo(WKatana) == 2 {
		r += moonDraw
	}
	return r
}

// art starts the weapon art of the legendary in p's hands towards x, y.
func (w *World) art(p *Player, x, y float32) error {
	k := p.Cur
	d := &Arts[k]
	if p.Art != ArtNone {
		return fmt.Errorf("%s is under way", d.Name)
	}
	if p.ArtCool > 0 {
		return fmt.Errorf("%s is ready in %.0fs", d.Name, math.Ceil(float64(p.ArtCool)))
	}
	dx, dy := x-p.X, y-p.Y
	dist := sqrt32(dx*dx + dy*dy)
	if r := ArtRange(p); dist > r {
		dx, dy, dist = dx/dist*r, dy/dist*r, r
	}
	ang := float32(math.Atan2(float64(dy), float64(dx)))
	if dist < 1e-3 {
		ang, dist = p.Aim, 0
	}
	// As far along the way as the survivor can go, stopping short of anything solid.
	ex, ey := p.X, p.Y
	cx, cy := float32(math.Cos(float64(ang))), float32(math.Sin(float64(ang)))
	for t := float32(.25); t <= dist; t += .25 {
		nx, ny := p.X+cx*t, p.Y+cy*t
		if !CanStand(w, nx, ny) {
			break
		}
		ex, ey = nx, ny
	}
	p.Art = ArtFlash
	if k == WGreat {
		p.Art = ArtSkyfall
	}
	p.ArtLeft, p.ArtTotal = d.Windup, d.Windup
	p.artX0, p.artY0, p.artX, p.artY = p.X, p.Y, ex, ey
	p.ArtCool = d.Cool
	p.Aim = ang
	p.Order = Order{Kind: OrderIdle}
	p.walk.reset()
	return nil
}

// stepArt carries a weapon art on a tick: Flash Draw holds its stance, then cuts; Skyfall flies,
// then lands.
func (w *World) stepArt(p *Player) {
	p.Moving, p.Firing = false, false
	p.ArtLeft -= Dt
	if p.Art == ArtSkyfall {
		u := clampf(1-p.ArtLeft/p.ArtTotal, 0, 1)
		p.X, p.Y = p.artX0+(p.artX-p.artX0)*u, p.artY0+(p.artY-p.artY0)*u
	}
	if p.ArtLeft > 0 {
		return
	}
	art := p.Art
	p.Art, p.ArtLeft = ArtNone, 0
	w.shooter = int8(p.ID)
	defer func() { w.shooter = -1 }()
	switch art {
	case ArtFlash:
		w.flashDraw(p)
	case ArtSkyfall:
		w.skyfall(p)
	}
}

// flashDraw is the katana's drawn cut: the survivor goes the whole way at once, and every creep
// within flashWidth of the line takes it.
func (w *World) flashDraw(p *Player) {
	st := w.playerStats(p)
	x0, y0, x1, y1 := p.X, p.Y, p.artX, p.artY
	lx, ly := x1-x0, y1-y0
	l2 := lx*lx + ly*ly
	cands := w.near[:0]
	mx, my := (x0+x1)/2, (y0+y1)/2
	w.grid.each(mx, my, sqrt32(l2)/2+flashWidth+1, func(i int32) bool {
		c := &w.Creeps[i]
		if c.HP <= 0 || w.hidden(c) {
			return true
		}
		u := float32(0)
		if l2 > 0 {
			u = clampf(((c.X-x0)*lx+(c.Y-y0)*ly)/l2, 0, 1)
		}
		dx, dy := c.X-(x0+lx*u), c.Y-(y0+ly*u)
		if r := flashWidth + Creeps[c.Kind].Radius; dx*dx+dy*dy <= r*r {
			cands = append(cands, i)
		}
		return true
	})
	w.near = cands[:0]
	hits := append([]int32(nil), cands...)
	for _, i := range hits {
		w.hit(i, st.Damage*flashMul, int8(p.ID), 2)
		w.bleed(i, flashBleed, p)
	}
	w.tracer(x0, y0, x1, y1, TracerFlash)
	p.X, p.Y = x1, y1
	p.Swings++
}

// skyfall is the greatsword coming down where the leap lands.
func (w *World) skyfall(p *Player) {
	st := w.playerStats(p)
	p.X, p.Y = p.artX, p.artY
	r, stun := float32(skyfallRadius), float32(skyfallStun)
	evo := p.evo(WGreat)
	if evo == 2 {
		r++
		stun *= 2
	}
	w.quake(int8(p.ID), p.X, p.Y, r, st.Damage*skyfallMul, stun)
	w.pumpsIn(p.X, p.Y, r, int8(p.ID), pumpChain)
	w.Blasts = append(w.Blasts, Blast{p.X, p.Y, r, BlastSkyfall})
	if evo == 2 {
		w.Blasts = append(w.Blasts, Blast{p.X, p.Y, r, 8}) // the thunderbolt, drawn as the storm's
	}
	if evo == 1 {
		w.Effects = append(w.Effects, Effect{Kind: EffNapalm, X0: p.X, Y0: p.Y, X: p.X, Y: p.Y, R: r,
			Left: ashFire + 1, Total: ashFire + 1, Damage: ashBurn * 2 * lateScale(w.Wave), Owner: int8(p.ID)})
	}
	p.Swings++
}

// EvolveWeapon evolves p's legendary k into branch 1 or 2, for LegendEvoCost, once its
// tracks add up to EvolveAt.
func (w *World) EvolveWeapon(p *Player, k WeaponKind, branch uint8) error {
	switch {
	case !k.Legendary():
		return errors.New("only a legendary blade evolves")
	case branch < 1 || branch > 2:
		return errors.New("no such evolution")
	case !p.Weapons[k].Owned:
		return fmt.Errorf("you do not carry the %s", Weapons[k].Name)
	case p.Weapons[k].Evo != 0:
		return fmt.Errorf("your %s has evolved already", Weapons[k].Name)
	case !w.atArmory(p):
		return errNotAtArmory
	}
	sum := 0
	for _, l := range p.Weapons[k].Lv {
		sum += int(l)
	}
	if sum < EvolveAt {
		return fmt.Errorf("a legendary evolves once its tracks add up to %d", EvolveAt)
	}
	if err := w.pay(p, LegendEvoCost); err != nil {
		return err
	}
	p.Weapons[k].Evo = branch
	w.note(1, "%s's %s evolved into %s", p.Name, Weapons[k].Name, LegendEvos[k][branch-1].Name)
	return nil
}

// legendFor is a legendary p could be given: one they do not carry, or a second katana for one
// who carries one; NumWeapons when there is none.
func (w *World) legendFor(p *Player) WeaponKind {
	var c []WeaponKind
	for k := WeaponKind(0); k < NumWeapons; k++ {
		if k.Legendary() && w.canTake(p, k) {
			c = append(c, k)
		}
	}
	if len(c) == 0 {
		return NumWeapons
	}
	return c[w.rng.IntN(len(c))]
}

// giveLegend hands p a legendary they can take, and puts it in their hands; a second katana
// goes in the other hand.
func (w *World) giveLegend(p *Player) (string, bool) {
	k := w.legendFor(p)
	if k == NumWeapons {
		return "", false
	}
	if p.Weapons[k].Owned {
		p.Weapons[k].Dual = true
		p.Cur = k
		return "a second katana: a pair, one in each hand", true
	}
	p.Weapons[k] = WeaponState{Owned: true, Ammo: Weapons[k].Mag}
	p.Cur = k
	return "the legendary " + Weapons[k].Name, true
}

// legendChance is how often the gas station's counter or the plane's hold has a legendary in it.
const legendChance = .3

// ---- the shrines -------------------------------------------------------------------------

// The shrines: two on every map, far out in the wilds, ruins of some older faith than the
// church's. A walled court of broken stone, pillars down its length and a pair of gate posts
// at its mouth, which faces the generator; an altar at the far end, and on it a legendary
// blade. The dead keep it: a lair's guards round a champion, and more rise from the court when
// someone first walks in and again when they kneel at the altar.

// The shrine in its own frame, as the church's: x across, y along towards its gate. '#' is
// wall, 'o' a pillar, 'A' the altar, '.' flagstones, 's' where it is searched from, ' ' ground
// left as it was.
var shrinePlan = [...]string{
	"  #########  ",
	" ##.......## ",
	"##...AAA...##",
	"#.....s.....#",
	"#..o.....o..#",
	"#...........#",
	"...o.....o...",
	"#...........#",
	"#..o.....o..#",
	"#...........#",
	"##.........##",
	" #.........# ",
	"   o.....o   ",
}

const (
	shrineW, shrineL = 13, 13
	shrineYard       = 3  // ground cleared round it
	shrineCount      = 2  // on every map
	shrineGap        = 14 // from the other landmarks
	shrineApart      = 60 // from each other
)

// shrines raises the shrines far out, clear of the other landmarks and of each other, each
// open to the rest of the map and facing the middle. Houses where they stand are flattened.
func shrines(t []Tile, w, h int, rng *rand.Rand, road []bool, houses []ruin) []ruin {
	open := openFromMiddle(t, w, h)
	const r = shrineL/2 + shrineYard
	for n := 0; n < shrineCount; n++ {
		type pick struct{ x, y, fx, fy int }
		var best pick
		bestScore := math.MaxInt
		for try := 0; try < 500; try++ {
			x, y := r+4+rng.IntN(w-2*r-8), r+4+rng.IntN(h-2*r-8)
			if math.Hypot(float64(x-w/2), float64(y-h/2)) < tierMid+10 {
				continue
			}
			clash := false
			for _, o := range houses {
				gap := 0
				switch {
				case o.shrine:
					gap = shrineApart
				case o.outpost || o.station || o.plane || o.church:
					gap = shrineGap
				}
				if gap > 0 && o.x < x+r+gap && x-r-gap < o.x+o.w && o.y < y+r+gap && y-r-gap < o.y+o.h {
					clash = true
				}
			}
			if clash {
				continue
			}
			score, reached := 0, 0
			for dy := -r; dy <= r; dy++ {
				for dx := -r; dx <= r; dx++ {
					i := (y+dy)*w + x + dx
					if open[i] && (abs(dx) == r || abs(dy) == r) {
						reached++
					}
					switch {
					case road[i]:
						score += 4
					case t[i] == TWater:
						score += 6
					case t[i].Solid():
						score++
					}
				}
			}
			if reached < 8 {
				continue
			}
			if score = score*64 + rng.IntN(64); score < bestScore {
				fx, fy := sign(w/2-x), 0
				if abs(h/2-y)*w > abs(w/2-x)*h {
					fx, fy = 0, sign(h/2-y)
				}
				best, bestScore = pick{x, y, fx, fy}, score
			}
		}
		if bestScore == math.MaxInt {
			return houses
		}
		houses = shrine(t, w, best.x, best.y, best.fx, best.fy, houses)
	}
	return houses
}

// shrineAt is where tile lx, ly of a shrine whose plan's middle is at cx, cy and whose gate
// faces fx, fy lands.
func shrineAt(cx, cy, fx, fy, lx, ly int) (int, int) {
	sx, sy := fy, -fx
	ox, oy := lx-shrineW/2, ly-shrineL/2
	return cx + ox*sx + oy*fx, cy + ox*sy + oy*fy
}

// shrine builds one shrine round cx, cy, its gate towards fx, fy.
func shrine(t []Tile, w, cx, cy, fx, fy int, houses []ruin) []ruin {
	const r = shrineL/2 + shrineYard
	kept := houses[:0]
	for _, o := range houses {
		if !o.outpost && !o.station && !o.plane && !o.church && !o.shrine && o.x <= cx+r && cx-r < o.x+o.w && o.y <= cy+r && cy-r < o.y+o.h {
			for y := o.y; y < o.y+o.h; y++ {
				for x := o.x; x < o.x+o.w; x++ {
					t[y*w+x] = TDirt
				}
			}
			continue
		}
		kept = append(kept, o)
	}
	for dy := -r; dy <= r; dy++ {
		for dx := -r; dx <= r; dx++ {
			if i := (cy+dy)*w + cx + dx; t[i].Solid() {
				t[i] = TGrass
			}
		}
	}
	x0, y0, x1, y1 := 1<<30, 1<<30, 0, 0
	sx, sy := cx, cy
	for ly, row := range shrinePlan {
		for lx, c := range row {
			x, y := shrineAt(cx, cy, fx, fy, lx, ly)
			switch c {
			case '#', 'o', 'A':
				t[y*w+x] = TRock
			case '.', 's':
				t[y*w+x] = TFloor
			}
			if c == 's' {
				sx, sy = x, y
			}
			x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)
		}
	}
	yaw := float32(math.Atan2(float64(fy), float64(fx)))
	return append(kept, ruin{x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: sx, cy: sy, shrine: true, yaw: yaw})
}

// shrineIdx lists the site indices of the shrines.
func (w *World) shrineIdx() []int {
	if w.shrineList == nil || w.shrinesFor != len(w.Sites) {
		w.shrineList = []int{}
		for i := range w.Sites {
			if w.Sites[i].Kind == SiteShrine {
				w.shrineList = append(w.shrineList, i)
			}
		}
		w.shrinesFor = len(w.Sites)
	}
	return w.shrineList
}

// inShrine reports whether p is inside shrine si's court.
func (w *World) inShrine(si int, p *Player) bool {
	s := &w.Sites[si]
	return p.X > float32(s.X)+1 && p.Y > float32(s.Y)+1 && p.X < float32(s.X)+float32(s.W)-1 && p.Y < float32(s.Y)+float32(s.H)-1
}

// searchShrine hands over what lies on the altar: a legendary blade, and something rare or
// better besides. Someone who carries every legendary there is gets its whetstones instead:
// levels on the one in their hands, or on the first they carry.
func (w *World) searchShrine(p *Player, s *Site) {
	var got []string
	if g, ok := w.giveLegend(p); ok {
		got = append(got, g)
	} else {
		k := p.Cur
		if !k.Legendary() {
			for o := WeaponKind(0); o < NumWeapons; o++ {
				if o.Legendary() && p.Weapons[o].Owned {
					k = o
					break
				}
			}
		}
		if g, ok := w.giveUpgrade(p, k, 2); ok {
			got = append(got, strings.Replace(g, "parts", "whetstones", 1))
		}
	}
	r := max(RollRarity(w.rng.Float64(), w.Luck(p, s)), Rare)
	got = append(got, w.grant(p, r, FavorNone))
	p.Dry = 0
	w.Blasts = append(w.Blasts, Blast{s.SX, s.SY, 2, 5})
	w.note(1, "%s took what lay on the shrine's altar: %s  ·  legendary", p.Name, strings.Join(got, " and "))
}
