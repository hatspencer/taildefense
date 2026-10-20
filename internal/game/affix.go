package game

import (
	"math"
	"strings"
)

// Affixes are what makes one wave unlike the last: from wave affixFrom, each but the boss
// waves comes with one, and from affixTwo with two, rolled at the start of the break before
// it together with the sides it comes from, so the break can say what is coming and the team
// can build for it (forecast).
//
//   - Armoured: every creep shrugs off affixArmor more of each hit, which the gun turret's
//     small rounds feel most; the sniper and the cannon are the answer.
//   - Hasty: every creep a fifth faster, less time under the guns of a short maze.
//   - Sappers: some of the walkers and runners carry a charge and walk straight for the
//     walls, ignoring the maze, and blow up against the first structure they reach.
//   - Splitters: some of the walkers, runners and brutes burst into two swarmers when they die.
type Affix uint8

const (
	AffixArmoured Affix = 1 << iota
	AffixHasty
	AffixSappers
	AffixSplitters
	numAffixes = 4
)

// AffixNames name the affixes, bit by bit.
var AffixNames = [numAffixes]string{"armoured", "hasty", "sappers", "splitters"}

const (
	affixFrom    = 4   // the first wave with an affix
	affixTwo     = 15  // the first with two
	affixArmor   = 3   // flat armour an armoured wave's creeps gain
	affixHaste   = 1.2 // a hasty wave's speed
	sapperShare  = .2  // of a sappers wave's walkers and runners
	splitShare   = .35 // of a splitters wave's walkers, runners and brutes
	sapperDamage = 280 // to every structure in reach of the blast
	sapperReach  = 1.6 // tiles
	splitInto    = 2   // swarmers a splitter bursts into
	splitSpread  = .45 // how far from where it fell they land
)

// String is "armoured and sappers"; "" for none.
func (a Affix) String() string {
	var n []string
	for i := 0; i < numAffixes; i++ {
		if a&(1<<i) != 0 {
			n = append(n, AffixNames[i])
		}
	}
	return strings.Join(n, " and ")
}

// rollAffix is wave's affixes, never all the last wave's again.
func (w *World) rollAffix(wave int) Affix {
	if wave < affixFrom || wave%10 == 0 {
		return 0
	}
	n := 1
	if wave >= affixTwo {
		n = 2
	}
	var a Affix
	for try := 0; try < 8; try++ {
		a = 0
		for bits := 0; bits < n; {
			b := Affix(1) << w.rng.IntN(numAffixes)
			if a&b == 0 {
				a |= b
				bits++
			}
		}
		if a != w.Affix {
			break
		}
	}
	return a
}

// forecast rolls the next wave's sides and affixes and says them, for the break before it.
// On the settings where the sides go unsaid, only the affixes are told.
func (w *World) forecast() {
	next := w.Wave + 1
	w.nextFronts = w.pickFronts(next)
	w.NextAffix = w.rollAffix(next)
	w.NextFrom = 0
	if !w.diff().Unsaid {
		for _, n := range w.frontNames {
			w.NextFrom |= compassBit(n)
		}
	}
	if w.NextAffix != 0 {
		w.note(1, "scouts report wave %d: %s", next, w.NextAffix.Describe())
	}
}

// Describe is what an affix means, for the forecast.
func (a Affix) Describe() string {
	var n []string
	for i, d := range [numAffixes]string{
		"armoured, shrugging off small rounds",
		"hasty, a fifth faster",
		"sappers, carrying charges straight for the walls",
		"splitters, bursting into swarmers when they die",
	} {
		if a&(1<<i) != 0 {
			n = append(n, d)
		}
	}
	return strings.Join(n, "; ")
}

// compassBit is the bit of a compass name, east first and round by south, as compass names
// them.
func compassBit(name string) uint8 {
	for i, n := range [8]string{"east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"} {
		if n == name {
			return 1 << i
		}
	}
	return 0
}

// mark gives a creep of the wave just spawned its share of the wave's affixes.
func (w *World) mark(c *Creep) {
	c.Aff = w.Affix & (AffixArmoured | AffixHasty)
	switch c.Kind {
	case CWalker, CRunner:
		if w.Affix&AffixSappers != 0 && w.rng.Float32() < sapperShare {
			c.Aff |= AffixSappers
		} else if w.Affix&AffixSplitters != 0 && w.rng.Float32() < splitShare {
			c.Aff |= AffixSplitters
		}
	case CBrute:
		if w.Affix&AffixSplitters != 0 && w.rng.Float32() < splitShare {
			c.Aff |= AffixSplitters
		}
	}
}

// breaks reports whether creep c breaks what is in its way rather than walking round it: a
// frenzied creep, or a sapper.
func (c *Creep) breaks() bool { return c.Frenzy || c.Aff&AffixSappers != 0 }

// sap is a sapper blowing up against structure si: everything in reach but the generator and
// the armory is hit, and the sapper is gone, for nobody's bounty.
func (w *World) sap(c *Creep) {
	for i := range w.Structs {
		s := &w.Structs[i]
		if !s.Alive || i == w.Core || s.Kind == SArmory {
			continue
		}
		if dx, dy := clampf(c.X, float32(s.X), float32(s.X)+float32(s.W))-c.X, clampf(c.Y, float32(s.Y), float32(s.Y)+float32(s.H))-c.Y; dx*dx+dy*dy <= sapperReach*sapperReach {
			s.HP -= sapperDamage
		}
	}
	c.HP, c.LastHit = 0, -1
	w.Blasts = append(w.Blasts, Blast{c.X, c.Y, sapperReach, 0})
}

// split is a splitter that fell at x, y bursting into swarmers.
func (w *World) split(x, y float32) {
	for i := 0; i < splitInto; i++ {
		a := float32(i)*3.1416 + w.rng.Float32()
		sx, sy := x+cos32(a)*splitSpread, y+sin32(a)*splitSpread
		if !CanStand(w, sx, sy) {
			sx, sy = x, y
		}
		if w.SpawnCreep(CSwarmer, sx, sy) {
			w.Creeps[len(w.Creeps)-1].Aff = w.Affix & (AffixArmoured | AffixHasty)
		}
	}
}

// armor is what creep c shrugs off each hit.
func (c *Creep) armor() float32 {
	a := Creeps[c.Kind].Armor
	if c.Aff&AffixArmoured != 0 {
		a += affixArmor
	}
	return a
}

func clampf(v, lo, hi float32) float32 { return min(max(v, lo), hi) }
func cos32(a float32) float32          { return float32(math.Cos(float64(a))) }
func sin32(a float32) float32          { return float32(math.Sin(float64(a))) }
