package game

import (
	"errors"
	"fmt"
	"math"
)

// Ability slots: the weapon's ultimate on Q, then the bought abilities on Shift, F and V.
const (
	AbUltimate = iota // the equipped weapon's ultimate, charged by fighting
	AbGrenade
	AbDash
	AbAirstrike
	NumAbilities
)

// MaxAbilityLevel is the most levels any bought ability has; each has its own Max.
const MaxAbilityLevel = 5

// AbilityDef is one ability slot. Cool and Costs are per level: Cool[l-1] at level l,
// Costs[l] to go from l to l+1, for the first Max of them.
type AbilityDef struct {
	Name   string
	Key    string // what the client binds it to
	Desc   string
	Range  float32
	Radius [MaxAbilityLevel]float32 // area hit, per level; 0 for none
	Cool   [MaxAbilityLevel]float32
	Costs  [MaxAbilityLevel]int32
	Max    uint8 // its highest level
	Always bool  // owned from the start, not bought
}

// Abilities is indexed by slot.
var Abilities = [NumAbilities]AbilityDef{
	AbUltimate: {Name: "Ultimate", Key: "Q", Desc: "The equipped weapon's ultimate, charged by fighting.", Max: 1, Always: true},
	AbGrenade: {Name: "Grenade", Key: "Shift", Desc: "Lobbed at a point, bursts after a moment. Bigger, harder and sooner each level; from level 4 it leaves the ground burning.",
		Range: 12, Radius: [5]float32{3, 3.5, 4, 4.5, 5}, Cool: [5]float32{8, 7, 6, 5.5, 5}, Costs: [5]int32{200, 400, 700, 1100, 1600}, Max: 5},
	AbDash:      {Name: "Dash", Key: "F", Desc: "Leap towards a point, out of a crowd. Further and sooner each level.", Range: 5, Cool: [5]float32{10, 8, 6}, Costs: [5]int32{150, 350, 650}, Max: 3},
	AbAirstrike: {Name: "Airstrike", Key: "V", Desc: "Mark a point anywhere near; two seconds later it is levelled.", Range: 40, Radius: [5]float32{5, 6, 7}, Cool: [5]float32{75, 65, 55}, Costs: [5]int32{600, 1200, 2000}, Max: 3},
}

// A grenade's blast is grenadeBase + grenadeStep a level; from grenadeFireLv it leaves a pool
// burning for grenadeFire seconds at grenadeFireDPS a level.
const (
	grenadeBase    = 50
	grenadeStep    = 70
	grenadeFireLv  = 4
	grenadeFire    = 4
	grenadeFireDPS = 6
)

// UltDef is a weapon's ultimate.
type UltDef struct {
	Name   string
	Desc   string
	Time   float32 // seconds it runs; for Dead Eye, the seconds spent marking
	Range  float32 // for one cast at a point, how far; 0 for one on the survivor
	Radius float32 // area round the point
}

// Ultimates is indexed by WeaponKind.
var Ultimates = [NumWeapons]UltDef{
	WPistol:   {Name: "Dead Eye", Desc: "Mark every creep in sight for 1.5 seconds, walking slowly, then shoot each once: deadly to anything short of a brute.", Time: deadEyeMark},
	WShotgun:  {Name: "Dragon's breath", Desc: "8 seconds of incendiary loads at 2.5 times the rate with no reloading: every pellet sets its creep burning and pushes it back.", Time: 8},
	WSMG:      {Name: "Run and gun", Desc: "10 seconds of twice the fire rate with no reloading, a quarter more speed and sprinting that never tires.", Time: 10},
	WRifle:    {Name: "Railgun", Desc: "10 seconds of every shot going through every creep in its line, without reloading.", Time: 10},
	WMinigun:  {Name: "Overdrive", Desc: "10 seconds of 80% more fire rate, two more pierce, half the spread and no reloading, in red-hot rounds.", Time: 10},
	WLauncher: {Name: "Cluster MIRV", Desc: "One rocket to a point that splits over it into ten bomblets, each hitting like a rocket.", Range: 24, Radius: mirvRadius},
	WCrowbar:  {Name: "Berserk", Desc: "8 seconds of swinging twice as fast, every hit healing you, shrugging off slows and stuns.", Time: 8},
}

// The ultimate's charge comes from the damage a survivor deals with their own hands, and from
// revives. Only the hit points a hit takes count, not what it would have done past the
// creep's last, so a big round on a small creep fills it no faster than a small one. Waves
// grow, so the meter is measured against the wave: it is full after ultWaves times ultShare
// of the hit points in a lone survivor's wave, at this difficulty's wave size and creep
// health, about what a survivor in the thick of it takes off in ultWaves waves while the
// turrets do the rest; bots fill it every two or three. Turrets and burning ground add
// nothing, and nothing fills it while an ultimate runs.
const (
	ultWaves     = 3
	ultShare     = .37
	ultPerRevive = .15
)

// ultFull is the damage that fills the meter this wave. Every hit asks, so it is worked out
// once for each wave and difficulty.
func (w *World) ultFull() float32 {
	if w.ult.full == 0 || w.ult.wave != w.Wave || w.ult.diff != w.Diff {
		wave := max(w.Wave, 1)
		d := w.diff()
		w.ult.full = ultWaves * ultShare * Budget(wave, 1) * d.Count * Creeps[CWalker].HP * HPScale(wave) * d.HP
		w.ult.wave, w.ult.diff = w.Wave, w.Diff
	}
	return w.ult.full
}

// lateScale is what the grenade, the airstrike and Dead Eye's heavy shot are multiplied by on
// wave: 1 up to lateFrom, then as much as the creeps' health has grown since. Their damage is
// bought by level, and the levels run out by mid game, while the creeps keep growing; without
// it a fully bought grenade's blast was three walkers' health on wave 10 and not one by wave 30,
// a key nobody pressed. Scaled, it does late what it did on lateFrom.
func lateScale(wave int) float32 { return max(1, HPScale(wave)/HPScale(lateFrom)) }

const lateFrom = 10

// Dead Eye's numbers: seconds marking, walking at deadEyeWalk of the speed; how far it sees,
// as a share past the gun's range; what each shot does to a brute or a boss.
const (
	deadEyeMark  = 1.5
	deadEyeWalk  = .5
	deadEyeReach = 1.3
	deadEyeHeavy = 200
)

// The MIRV's bomblets and how far round its point they spread.
const (
	mirvBomblets = 10
	mirvRadius   = 4.5
)

// Berserk heals this share of the damage each hit deals.
const berserkLeech = .3

// AbilityRange is how far a slot reaches for this player right now.
func AbilityRange(p *Player, slot int) float32 {
	switch slot {
	case AbUltimate:
		return Ultimates[p.Cur].Range
	case AbDash:
		return Abilities[AbDash].Range + 1.5*float32(p.Abil[AbDash].Lv)
	}
	return Abilities[slot].Range
}

// ulting reports whether p's ultimate for weapon k runs with k in hand.
func (p *Player) ulting(k WeaponKind) bool { return p.BuffLeft > 0 && p.Buff == k && p.Cur == k }

// marking reports whether p is marking targets for Dead Eye, whatever is in hand.
func (p *Player) marking() bool { return p.BuffLeft > 0 && p.Buff == WPistol }

// Charge adds to p's ultimate meter, unless one runs already.
func (p *Player) charge(v float32) {
	if p.BuffLeft <= 0 {
		p.Ult = min(p.Ult+v, 1)
	}
}

// playerStats is the equipped weapon's numbers with any running ultimate.
func (w *World) playerStats(p *Player) Stats {
	st := p.Weapons[p.Cur].Stats(p.Cur)
	st.Range *= w.rangeMul()
	if p.Cur == WMinigun {
		st.Rate *= p.spinRate()
	}
	if p.ulting(p.Cur) {
		switch p.Cur {
		case WShotgun:
			st.Rate *= 2.5
			st.Burn = max(st.Burn, 18)
		case WSMG:
			st.Rate *= 2
		case WRifle:
			st.Pierce = 1000
		case WMinigun:
			st.Rate *= 1.8
			st.Pierce += 2
			st.Spread *= .5
		case WCrowbar:
			st.Rate *= 2
		}
	}
	return st
}

// Cast uses an ability at x, y. A point out of reach is pulled in to the edge of the range.
func (w *World) Cast(p *Player, slot int, x, y float32) error {
	if slot < 0 || slot >= NumAbilities {
		return errors.New("no such ability")
	}
	if !p.Alive {
		return errors.New("you are down")
	}
	if p.Stunned() {
		return errors.New("you are stunned")
	}
	if w.Phase == PhaseOver {
		return errOver
	}
	a := &p.Abil[slot]
	if a.Lv == 0 {
		return fmt.Errorf("%s is locked; buy it at the armory", Abilities[slot].Name)
	}
	if slot == AbUltimate {
		if p.BuffLeft > 0 {
			return fmt.Errorf("%s is still going", Ultimates[p.Buff].Name)
		}
		if p.Ult < 1 {
			return fmt.Errorf("%s is charging (%.0f%%)", Ultimates[p.Cur].Name, math.Floor(float64(p.Ult*100)))
		}
	} else if a.Cool > 0 {
		return fmt.Errorf("%s is ready in %.0fs", Abilities[slot].Name, math.Ceil(float64(a.Cool)))
	}
	if r := AbilityRange(p, slot); r > 0 {
		dx, dy := x-p.X, y-p.Y
		if d := sqrt32(dx*dx + dy*dy); d > r {
			x, y = p.X+dx/d*r, p.Y+dy/d*r
		}
	}
	ang := float32(math.Atan2(float64(y-p.Y), float64(x-p.X)))
	lv := float32(a.Lv)
	w.shooter = int8(p.ID)
	defer func() { w.shooter = -1 }()
	owner := int8(p.ID)
	switch slot {
	case AbUltimate:
		w.ultimate(p, x, y)
		return nil
	case AbGrenade:
		const flight = .7
		w.Effects = append(w.Effects, Effect{Kind: EffGrenade, X0: p.X, Y0: p.Y, X: x, Y: y, R: Abilities[AbGrenade].Radius[a.Lv-1],
			Left: flight, Total: flight, Damage: (grenadeBase + grenadeStep*lv) * lateScale(w.Wave), Owner: owner, Lv: a.Lv})
	case AbDash:
		w.dash(p, ang, sqrt32((x-p.X)*(x-p.X)+(y-p.Y)*(y-p.Y)))
	case AbAirstrike:
		const delay = 2
		w.Effects = append(w.Effects, Effect{Kind: EffAirstrike, X0: x, Y0: y, X: x, Y: y, R: Abilities[AbAirstrike].Radius[a.Lv-1],
			Left: delay, Total: delay, Damage: (100 + 250*lv) * lateScale(w.Wave), Owner: owner})
	}
	a.Cool = Abilities[slot].Cool[a.Lv-1]
	p.Aim = ang
	return nil
}

// ultimate spends a full meter on the equipped weapon's ultimate. Most run for a while,
// through playerStats and the firing loop; the MIRV goes off at once and Dead Eye shoots when
// its marking is done (see deadEye).
func (w *World) ultimate(p *Player, x, y float32) {
	p.Ult = 0
	if p.Cur == WLauncher {
		st := w.playerStats(p)
		const speed = 22
		dx, dy := x-p.X, y-p.Y
		d := sqrt32(dx*dx+dy*dy) + 1e-6
		p.Aim = float32(math.Atan2(float64(dy), float64(dx)))
		w.Rockets = append(w.Rockets, Projectile{X: p.X, Y: p.Y, VX: dx / d * speed, VY: dy / d * speed,
			TTL: d / speed, Damage: st.Damage, Blast: st.Blast, Owner: int8(p.ID), Cluster: mirvBomblets})
		return
	}
	p.Buff, p.BuffLeft = p.Cur, Ultimates[p.Cur].Time
	w.note(1, "%s: %s!", p.Name, Ultimates[p.Cur].Name)
}

// deadEye is Dead Eye's volley, once the marking is done: one shot at every creep the survivor
// can see within reach. Anything short of a brute dies; a brute or a boss takes a heavy round.
func (w *World) deadEye(p *Player) {
	if !p.Alive {
		return
	}
	st := WeaponStats(WPistol, p.Weapons[WPistol].Lv)
	reach := st.Range * w.rangeMul() * deadEyeReach
	owner := int8(p.ID)
	w.shooter = owner
	w.grid.each(p.X, p.Y, reach, func(i int32) bool {
		c := &w.Creeps[i]
		dx, dy := c.X-p.X, c.Y-p.Y
		if c.HP <= 0 || dx*dx+dy*dy > reach*reach || w.hidden(c) || !w.clearShot(p.X, p.Y, c.X, c.Y) {
			return true
		}
		dmg := deadEyeHeavy * lateScale(w.Wave)
		if !c.Kind.Heavy() {
			// Enough to kill outright, armour and all.
			dmg = c.HP + c.armor() + 1
			dmg = max(dmg, c.HP*4)
		}
		w.damage(i, dmg, owner)
		w.tracer(p.X, p.Y, c.X, c.Y, uint8(WPistol)+TracerUlt)
		return true
	})
	w.shooter = -1
}

// TracerUlt is added to a weapon's tracer kind for a shot fired under its ultimate.
const TracerUlt = 8

// mirv scatters the cluster rocket's bomblets round where it burst.
func (w *World) mirv(r *Projectile) {
	for i := 0; i < int(r.Cluster); i++ {
		a := w.rng.Float32() * 2 * math.Pi
		d := mirvRadius * sqrt32(w.rng.Float32())
		x, y := r.X+float32(math.Cos(float64(a)))*d, r.Y+float32(math.Sin(float64(a)))*d
		flight := .35 + .3*w.rng.Float32()
		w.Effects = append(w.Effects, Effect{Kind: EffGrenade, X0: r.X, Y0: r.Y, X: x, Y: y, R: r.Blast,
			Left: flight, Total: flight, Damage: r.Damage, Owner: r.Owner})
	}
}

// dash moves the player up to dist along ang, stopping short of anything in the way.
func (w *World) dash(p *Player, ang, dist float32) {
	dx, dy := float32(math.Cos(float64(ang))), float32(math.Sin(float64(ang)))
	x, y := p.X, p.Y
	for t := float32(.25); t <= dist; t += .25 {
		nx, ny := p.X+dx*t, p.Y+dy*t
		if !CanStand(w, nx, ny) {
			break
		}
		x, y = nx, ny
	}
	w.tracer(p.X, p.Y, x, y, TracerDash)
	p.X, p.Y = x, y
	p.Order = Order{Kind: OrderIdle}
	p.walk.reset()
}

// TracerDash marks a dash's streak.
const TracerDash = 33

// stepEffects runs grenades, napalm and airstrikes.
func (w *World) stepEffects() {
	// A sac of bile bursting leaves a pool of acid behind: what is added while they run is
	// kept for next tick.
	n := len(w.Effects)
	live := w.Effects[:0]
	for _, e := range w.Effects[:n] {
		e.Left -= Dt
		w.shooter = e.Owner
		switch e.Kind {
		case EffNapalm:
			x, y, r, dps, owner := e.X, e.Y, e.R, e.Damage, e.Owner
			w.grid.each(x, y, r, func(i int32) bool {
				c := &w.Creeps[i]
				dx, dy := c.X-x, c.Y-y
				if dx*dx+dy*dy <= r*r {
					w.burning = true
					w.damage(i, dps*Dt, owner)
					w.burning = false
					w.ignite(i, dps*.5)
				}
				return true
			})
		case EffGrenade:
			if e.Left <= 0 {
				w.explode(e.X, e.Y, e.R, e.Damage, e.Owner, 0)
				if e.Lv >= grenadeFireLv {
					w.Effects = append(w.Effects, Effect{Kind: EffNapalm, X0: e.X, Y0: e.Y, X: e.X, Y: e.Y, R: e.R * .7,
						Left: grenadeFire, Total: grenadeFire, Damage: grenadeFireDPS * float32(e.Lv) * lateScale(w.Wave), Owner: e.Owner})
				}
			}
		case EffDrop:
			w.stepDrop(&e)
		case EffSlam:
			if e.Left <= 0 {
				w.slamLands(&e)
			}
		case EffBile:
			if e.Left <= 0 {
				w.bileLands(&e)
			}
		case EffAcid:
			w.stepAcid(&e)
		case EffSpit:
			if e.Left <= 0 {
				w.spitLands(&e)
			}
		case EffAirstrike:
			if e.Left <= 0 {
				w.explode(e.X, e.Y, e.R, e.Damage, e.Owner, 4)
				for i := 0; i < 4; i++ {
					a := float64(i)*math.Pi/2 + .4
					w.explode(e.X+float32(math.Cos(a))*e.R*.6, e.Y+float32(math.Sin(a))*e.R*.6, e.R*.5, e.Damage*.4, e.Owner, 4)
				}
			}
		}
		if e.Left > 0 {
			live = append(live, e)
		}
	}
	w.Effects = append(live, w.Effects[n:]...)
	w.shooter = -1
}

// BuyAbility raises a bought ability's level.
func (w *World) BuyAbility(p *Player, slot int) error {
	if slot <= AbUltimate || slot >= NumAbilities {
		return errors.New("that ability cannot be bought")
	}
	if !w.atArmory(p) {
		return errNotAtArmory
	}
	a := &p.Abil[slot]
	if a.Lv >= Abilities[slot].Max {
		return errMaxed
	}
	if err := w.pay(p, Abilities[slot].Costs[a.Lv]); err != nil {
		return err
	}
	a.Lv++
	return nil
}
