package game

import (
	"errors"
	"fmt"
	"math"
)

// Ability slots, cast with Q W E R.
const (
	AbSignature = iota // the equipped weapon's own ability, always there
	AbGrenade
	AbDash
	AbAirstrike
	NumAbilities
)

// MaxAbilityLevel is the highest level of a bought ability.
const MaxAbilityLevel = 3

// AbilityDef is one ability slot. Cool and Costs are per level: Cool[l-1] at level l,
// Costs[l] to go from l to l+1.
type AbilityDef struct {
	Name   string
	Key    byte
	Desc   string
	Range  float32
	Radius [MaxAbilityLevel]float32 // area hit, per level; 0 for none
	Cool   [MaxAbilityLevel]float32
	Costs  [MaxAbilityLevel]int32
	Always bool // owned from the start, not bought
}

// Abilities is indexed by slot.
var Abilities = [NumAbilities]AbilityDef{
	AbSignature: {Name: "Signature", Key: 'Q', Desc: "The equipped weapon's own ability; stronger with its special upgrades.", Always: true},
	AbGrenade:   {Name: "Grenade", Key: 'W', Desc: "Lobbed at a point, bursts after a moment. Bigger and harder each level.", Range: 11, Radius: [3]float32{2.5, 3, 3.5}, Cool: [3]float32{9, 8, 7}, Costs: [3]int32{200, 450, 800}},
	AbDash:      {Name: "Dash", Key: 'E', Desc: "Leap towards a point, out of a crowd. Further and sooner each level.", Range: 5, Cool: [3]float32{10, 8, 6}, Costs: [3]int32{150, 350, 650}},
	AbAirstrike: {Name: "Airstrike", Key: 'D', Desc: "Mark a point anywhere near; two seconds later it is levelled.", Range: 40, Radius: [3]float32{5, 6, 7}, Cool: [3]float32{75, 65, 55}, Costs: [3]int32{600, 1200, 2000}},
}

// SigDef is a weapon's signature ability.
type SigDef struct {
	Name   string
	Desc   string
	Cool   float32
	Range  float32
	Radius float32 // area round the point; for a cone, its reach
	Cone   float32 // half-angle in radians when the area is a cone in front
	Self   bool    // cast on the survivor, no point needed
}

// Signatures is indexed by WeaponKind.
var Signatures = [NumWeapons]SigDef{
	WPistol:   {Name: "Fan the hammer", Desc: "Six quick shots fanned towards a point, no ammo spent.", Cool: 8, Range: 14},
	WShotgun:  {Name: "Concussion", Desc: "A blast that hurts and throws back everything in front, slowing it.", Cool: 10, Range: 7, Radius: 7, Cone: .6},
	WSMG:      {Name: "Bullet hose", Desc: "Twice the fire rate for 4 seconds.", Cool: 14, Self: true},
	WRifle:    {Name: "Piercing shot", Desc: "One shot through everything in a long line, five times the damage.", Cool: 9, Range: 40},
	WFlamer:   {Name: "Napalm", Desc: "A pool of fire at a point that burns for 6 seconds.", Cool: 14, Range: 9, Radius: 3},
	WMinigun:  {Name: "Overdrive", Desc: "60% more fire rate and one more pierce for 5 seconds.", Cool: 16, Self: true},
	WLauncher: {Name: "Barrage", Desc: "Six rockets scattered round a point.", Cool: 15, Range: 24, Radius: 2.5},
}

// AbilityRange is how far a slot reaches for this player right now.
func AbilityRange(p *Player, slot int) float32 {
	switch slot {
	case AbSignature:
		return Signatures[p.Cur].Range
	case AbDash:
		return Abilities[AbDash].Range + 1.5*float32(p.Abil[AbDash].Lv)
	}
	return Abilities[slot].Range
}

// playerStats is the equipped weapon's numbers with any running buff.
func (w *World) playerStats(p *Player) Stats {
	st := WeaponStats(p.Cur, p.Weapons[p.Cur].Lv)
	st.Range *= w.rangeMul()
	if p.BuffLeft > 0 && p.Buff == p.Cur {
		switch p.Buff {
		case WSMG:
			st.Rate *= 2
		case WMinigun:
			st.Rate *= 1.6
			st.Pierce++
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
	if w.Phase == PhaseOver {
		return errOver
	}
	a := &p.Abil[slot]
	if a.Lv == 0 {
		return fmt.Errorf("%s is locked; buy it at the armory", Abilities[slot].Name)
	}
	if a.Cool > 0 {
		return fmt.Errorf("%s is ready in %.0fs", w.abilityName(p, slot), math.Ceil(float64(a.Cool)))
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
	case AbSignature:
		w.signature(p, x, y, ang)
		a.Cool = Signatures[p.Cur].Cool
		return nil
	case AbGrenade:
		const flight = .7
		w.Effects = append(w.Effects, Effect{Kind: EffGrenade, X0: p.X, Y0: p.Y, X: x, Y: y, R: Abilities[AbGrenade].Radius[a.Lv-1],
			Left: flight, Total: flight, Damage: 20 + 70*lv, Owner: owner})
	case AbDash:
		w.dash(p, ang, sqrt32((x-p.X)*(x-p.X)+(y-p.Y)*(y-p.Y)))
	case AbAirstrike:
		const delay = 2
		w.Effects = append(w.Effects, Effect{Kind: EffAirstrike, X0: x, Y0: y, X: x, Y: y, R: Abilities[AbAirstrike].Radius[a.Lv-1],
			Left: delay, Total: delay, Damage: 100 + 250*lv, Owner: owner})
	}
	a.Cool = Abilities[slot].Cool[a.Lv-1]
	p.Aim = ang
	return nil
}

func (w *World) abilityName(p *Player, slot int) string {
	if slot == AbSignature {
		return Signatures[p.Cur].Name
	}
	return Abilities[slot].Name
}

// signature is the equipped weapon's ability. Its punch grows with the weapon's special
// track, so upgrading a weapon also upgrades its Q.
func (w *World) signature(p *Player, x, y, ang float32) {
	st := w.playerStats(p)
	pow := 1 + .2*float32(p.Weapons[p.Cur].Lv[TrackSpecial])
	owner := int8(p.ID)
	kind := uint8(p.Cur)
	p.Aim = ang
	switch p.Cur {
	case WPistol:
		for i := 0; i < 6; i++ {
			a := ang + (float32(i)-2.5)*.07
			w.hitscan(owner, p.X, p.Y, a, st.Range, st.Damage*1.5*pow, st.Pierce+1, 0, kind)
		}
	case WShotgun:
		reach, half := Signatures[WShotgun].Radius, Signatures[WShotgun].Cone
		dmg := st.Damage * 4 * pow
		dx, dy := float32(math.Cos(float64(ang))), float32(math.Sin(float64(ang)))
		cosHalf := float32(math.Cos(float64(half)))
		w.grid.each(p.X, p.Y, reach, func(i int32) bool {
			c := &w.Creeps[i]
			ox, oy := c.X-p.X, c.Y-p.Y
			dd := ox*ox + oy*oy
			if dd > reach*reach || dd < 1e-6 {
				return true
			}
			d := sqrt32(dd)
			if (ox*dx+oy*dy)/d < cosHalf {
				return true
			}
			w.damage(i, dmg, owner)
			c.Slow = 2
			// Thrown back, less the bigger the creep and the further it was.
			push := (3 - d*.3) / (1 + Creeps[c.Kind].Radius)
			if c.Kind != CBoss && push > 0 {
				for s := 0; s < 6; s++ {
					nx, ny := c.X+ox/d*push/6, c.Y+oy/d*push/6
					if ok, _ := w.creepFree(nx, ny); !ok {
						break
					}
					c.X, c.Y = nx, ny
				}
			}
			return true
		})
		w.Blasts = append(w.Blasts, Blast{p.X + dx*2, p.Y + dy*2, reach, 3})
	case WSMG, WMinigun:
		p.Buff = p.Cur
		p.BuffLeft = 4
		if p.Cur == WMinigun {
			p.BuffLeft = 5
		}
	case WRifle:
		w.hitscan(owner, p.X, p.Y, ang, Signatures[WRifle].Range, st.Damage*5*pow, 1000, 0, kind)
	case WFlamer:
		const dur = 6
		w.Effects = append(w.Effects, Effect{Kind: EffNapalm, X0: x, Y0: y, X: x, Y: y, R: Signatures[WFlamer].Radius,
			Left: dur, Total: dur, Damage: (st.Burn*2 + st.Damage) * pow, Owner: owner})
	case WLauncher:
		const speed = 22
		for i := 0; i < 6; i++ {
			a := w.rng.Float32() * 2 * math.Pi
			r := w.rng.Float32() * Signatures[WLauncher].Radius
			tx, ty := x+float32(math.Cos(float64(a)))*r, y+float32(math.Sin(float64(a)))*r
			dx, dy := tx-p.X, ty-p.Y
			d := sqrt32(dx*dx+dy*dy) + 1e-6
			w.Rockets = append(w.Rockets, Projectile{X: p.X, Y: p.Y, VX: dx / d * speed, VY: dy / d * speed,
				TTL: d / speed, Damage: st.Damage * .8 * pow, Blast: st.Blast, Owner: owner})
		}
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
	live := w.Effects[:0]
	for _, e := range w.Effects {
		e.Left -= Dt
		w.shooter = e.Owner
		switch e.Kind {
		case EffNapalm:
			x, y, r, dps, owner := e.X, e.Y, e.R, e.Damage, e.Owner
			w.grid.each(x, y, r, func(i int32) bool {
				c := &w.Creeps[i]
				dx, dy := c.X-x, c.Y-y
				if dx*dx+dy*dy <= r*r {
					w.damage(i, dps*Dt, owner)
					w.ignite(i, dps*.5)
				}
				return true
			})
		case EffGrenade:
			if e.Left <= 0 {
				w.explode(e.X, e.Y, e.R, e.Damage, e.Owner, 0)
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
	w.Effects = live
	w.shooter = -1
}

// BuyAbility raises a bought ability's level.
func (w *World) BuyAbility(p *Player, slot int) error {
	if slot <= AbSignature || slot >= NumAbilities {
		return errors.New("that ability cannot be bought")
	}
	if !w.atArmory(p) {
		return errNotAtArmory
	}
	a := &p.Abil[slot]
	if a.Lv >= MaxAbilityLevel {
		return errMaxed
	}
	if err := w.pay(p, Abilities[slot].Costs[a.Lv]); err != nil {
		return err
	}
	a.Lv++
	return nil
}
