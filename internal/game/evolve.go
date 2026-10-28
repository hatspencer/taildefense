package game

import (
	"errors"
	"fmt"
)

// A base that grows: what the team does with its gold past the next turret.
//
//   - The generator goes up tiers, a project the whole team pays into, a hundred at a time
//     (PayIn). Tier II unlocks the amplifier pylon; tier III the turrets' evolutions and the
//     generator's Overload. Each tier makes the generator tougher, and shows on its model.
//   - A turret whose tracks add up to evolveAt can evolve, once, into one of two branches, for
//     its price again (Evolve): each answers a different wave, so the choice is the team's.
//   - The amplifier pylon makes every turret within its reach fire faster; more than one in
//     reach doesn't add up, so where it goes matters more than how many.
//   - The Overload, once a wave, shocks and freezes everything round the generator: the team's
//     last word when a wave gets to the walls.

const (
	MaxTier        = 3
	TierStep       = 100 // gold a pay-in puts into the generator
	tierGrowth     = .3  // of its base HP the generator gains with each tier
	PylonTier      = 2   // the tier that unlocks the amplifier pylon
	EvolveTier     = 3   // the tier that unlocks evolutions
	OverloadTier   = 3   // and the Overload
	EvolveAt       = 12  // a turret's track levels that must add up to this to evolve
	pylonAmp       = .15 // the fire rate a pylon in reach adds
	OverloadReach  = 18  // tiles round the generator's centre: out over the walls
	overloadBase   = 120 // the Overload's damage at wave 1, growing with the creeps' health
	overloadFreeze = 1.5 // seconds the Overload freezes what it hits
	cryoEvery      = 3   // a cryo tower freezes on every third pulse
	cryoFreeze     = .8  // seconds
	markFor        = 5   // seconds a spotter's mark lasts
	markBonus      = .25 // more damage a marked creep takes from everything
	napalmBurn     = .35 // a napalm missile's burning, per second, as a share of its damage
)

// tierBase is the gold that takes the generator from tier i+1 to i+2, for one player.
var tierBase = [MaxTier - 1]int32{600, 1600}

// TierNames name the generator's tiers.
var TierNames = [MaxTier + 1]string{"", "I", "II", "III"}

// BlastOverload is the generator's Overload going off, BlastNapalm a napalm missile bursting.
const (
	BlastOverload = 15
	BlastNapalm   = 16
)

// TierCost is the gold the next tier takes in all, more with every player who is playing;
// 0 at the top.
func (w *World) TierCost() int32 {
	if w.Tier >= MaxTier {
		return 0
	}
	return int32(float32(tierBase[w.Tier-1]) * (1 + .5*float32(w.active()-1)))
}

// PayIn puts TierStep of p's gold into the generator's next tier, or what is left of it, and
// raises the tier once it is paid.
func (w *World) PayIn(p *Player) error {
	if w.Phase == PhaseOver {
		return errOver
	}
	cost := w.TierCost()
	if cost == 0 {
		return errors.New("the generator is at its last tier")
	}
	amt := min(int32(TierStep), cost-w.TierPaid)
	if err := w.pay(p, amt); err != nil {
		return err
	}
	w.TierPaid += amt
	p.PaidIn += amt
	if w.TierPaid < cost {
		w.note(0, "%s paid %d into the generator · %d / %d for tier %s", p.Name, amt, w.TierPaid, cost, TierNames[w.Tier+1])
		return nil
	}
	w.Tier++
	w.TierPaid = 0
	core := &w.Structs[w.Core]
	grow := Structs[SCore].HP * tierGrowth
	core.MaxHP += grow
	core.HP += grow
	switch w.Tier {
	case PylonTier:
		w.note(1, "the generator is at tier II: amplifier pylons can be built")
	case EvolveTier:
		w.note(1, "the generator is at tier III: turrets can evolve, and the Overload is ready once a wave")
	}
	return nil
}

// OverloadReady reports whether the Overload can go off now.
func (w *World) OverloadReady() bool {
	return w.Tier >= OverloadTier && w.Phase == PhaseWave && !w.Overloaded
}

// Overload shocks every creep within OverloadReach of the generator and freezes it, once a
// wave, from anyone. It counts as turret fire: it turns nobody on anyone.
func (w *World) Overload(p *Player) error {
	switch {
	case w.Tier < OverloadTier:
		return fmt.Errorf("the generator needs tier %s for the Overload", TierNames[OverloadTier])
	case w.Phase != PhaseWave:
		return errors.New("the Overload is for a wave")
	case w.Overloaded:
		return errors.New("the Overload has gone off this wave already")
	}
	w.Overloaded = true
	w.turretFire = true
	defer func() { w.turretFire = false }()
	x, y, r := w.CoreX+.5, w.CoreY+.5, float32(OverloadReach)
	dmg := w.overloadDamage()
	w.grid.each(x, y, r, func(i int32) bool {
		c := &w.Creeps[i]
		if dx, dy := c.X-x, c.Y-y; dx*dx+dy*dy <= r*r {
			w.damage(i, dmg, int8(p.ID))
			c.stunLeft = max(c.stunLeft, overloadFreeze)
		}
		return true
	})
	w.Blasts = append(w.Blasts, Blast{x, y, r, BlastOverload})
	w.note(1, "%s overloaded the generator", p.Name)
	return nil
}

// overloadDamage is what the Overload deals each creep it reaches this wave.
func (w *World) overloadDamage() float32 {
	return overloadBase * HPScale(max(w.Wave, 1))
}

// evoFx is what an evolution does past its numbers.
type evoFx uint8

const (
	fxNone   evoFx = iota
	fxPierce       // its rounds ignore armour
	fxCryo         // every cryoEvery pulse freezes what it reaches
	fxStorm        // its damage grows with the rain
	fxSpot         // its target is marked: everything hits it harder for a while
	fxNapalm       // its missiles set what they hit alight
	fxLob          // it lobs over walls: it needs no clear shot
)

// Evolution is one branch a turret can evolve into: multipliers on its numbers (0 leaves
// one as it is), additions, and what it does besides.
type Evolution struct {
	Name, Desc                 string
	Damage, Rate, Range, Blast float32
	Slow, Hop, Chill           float32
	Pierce, Chains, Salvo      int
	fx                         evoFx
}

// Evolutions are the two branches of each turret kind, 1 and 2 in a Structure's Evo.
var Evolutions = [NumStructKinds][2]Evolution{
	STurretGun: {
		{Name: "Gatling", Desc: "Spins up to over twice the fire rate, each round a little lighter.", Damage: .75, Rate: 2.2},
		{Name: "Penetrator", Desc: "Armour-piercing rounds that hit harder: armoured waves shrug off nothing.", Damage: 1.3, fx: fxPierce},
	},
	STurretCannon: {
		{Name: "Mortar", Desc: "Lobs heavier shells much further, over walls and all.", Damage: 1.2, Rate: .85, Range: 1.8, fx: fxLob},
		{Name: "Shrapnel", Desc: "Shells that burst far wider.", Damage: .9, Blast: 1.7},
	},
	STurretFrost: {
		{Name: "Cryo", Desc: "Every third pulse freezes everything in reach solid for a moment.", fx: fxCryo},
		{Name: "Blizzard", Desc: "A far wider, longer, deeper cold.", Range: 1.6, Slow: .8, Chill: .1},
	},
	STurretTesla: {
		{Name: "Storm conductor", Desc: "Hits a fifth harder and feeds on the weather: up to twice that in rain, and two more jumps.", Damage: 1.2, Chains: 2, fx: fxStorm},
		{Name: "Arc web", Desc: "Jumps much further, to many more creeps.", Chains: 4, Hop: 2},
	},
	STurretSniper: {
		{Name: "Spotter", Desc: "Marks what it shoots: everything hits it a quarter harder for 5 s.", fx: fxSpot},
		{Name: "Anti-materiel", Desc: "A heavier round through everything in its line, armour and all.", Damage: 1.4, Pierce: 8, fx: fxPierce},
	},
	STurretMissile: {
		{Name: "Swarm", Desc: "Twice the missiles, each lighter.", Damage: .6, Salvo: 1},
		{Name: "Napalm", Desc: "Missiles that set everything they burst on alight.", fx: fxNapalm},
	},
}

// evolution is s's evolution, or nil.
func evolution(s *Structure) *Evolution {
	if s.Evo == 0 || s.Evo > 2 {
		return nil
	}
	return &Evolutions[s.Kind][s.Evo-1]
}

// apply applies evolution e to a turret's numbers.
func (e *Evolution) apply(st *TurretStat) {
	mul := func(v *float32, m float32) {
		if m != 0 {
			*v *= m
		}
	}
	mul(&st.Damage, e.Damage)
	mul(&st.Rate, e.Rate)
	mul(&st.Range, e.Range)
	mul(&st.Blast, e.Blast)
	st.Slow += e.Slow
	st.Chill = min(st.Chill+e.Chill, maxChill)
	st.Hop += e.Hop
	st.Pierce += e.Pierce
	st.Chains += e.Chains
	// A swarm's missiles double rather than add.
	st.Salvo += e.Salvo * st.Salvo
}

// StructStats is a turret's numbers as it stands: its tracks and its evolution.
func StructStats(s *Structure) TurretStat {
	st := TurretStats(s.Kind, s.Lv)
	if e := evolution(s); e != nil {
		e.apply(&st)
	}
	return st
}

// TrackSum is the sum of a turret's track levels.
func TrackSum(s *Structure) int {
	n := 0
	for _, l := range s.Lv {
		n += int(l)
	}
	return n
}

// Evolve turns turret si into its branch (1 or 2) for its price again.
func (w *World) Evolve(p *Player, si int, branch uint8) error {
	if si < 0 || si >= len(w.Structs) || !w.Structs[si].Alive {
		return errors.New("nothing to evolve there")
	}
	s := &w.Structs[si]
	switch {
	case !Structs[s.Kind].Turret || Evolutions[s.Kind][0].Name == "":
		return fmt.Errorf("a %s cannot evolve", Structs[s.Kind].Name)
	case branch < 1 || branch > 2:
		return errors.New("no such evolution")
	case s.Evo != 0:
		return fmt.Errorf("this %s has evolved already", Structs[s.Kind].Name)
	case w.Tier < EvolveTier:
		return fmt.Errorf("the generator needs tier %s for evolutions", TierNames[EvolveTier])
	case TrackSum(s) < EvolveAt:
		return fmt.Errorf("a turret evolves once its tracks add up to %d", EvolveAt)
	}
	if err := w.pay(p, Structs[s.Kind].Price); err != nil {
		return err
	}
	s.Evo = branch
	grow := Structs[s.Kind].HP * .5
	s.MaxHP += grow
	s.HP += grow
	w.note(0, "%s evolved a %s into a %s", p.Name, Structs[s.Kind].Name, Evolutions[s.Kind][branch-1].Name)
	return nil
}

// pylonNear reports whether an amplifier pylon stands within reach of turret s.
func (w *World) pylonNear(s *Structure) bool {
	r := Structs[SPylon].Range
	for _, pi := range w.pylons {
		p := &w.Structs[pi]
		if dx, dy := p.CX()-s.CX(), p.CY()-s.CY(); dx*dx+dy*dy <= r*r {
			return true
		}
	}
	return false
}

// findPylons lists the standing pylons, for this tick's turrets.
func (w *World) findPylons() {
	w.pylons = w.pylons[:0]
	for i := range w.Structs {
		if s := &w.Structs[i]; s.Alive && s.Kind == SPylon {
			w.pylons = append(w.pylons, int32(i))
		}
	}
}
