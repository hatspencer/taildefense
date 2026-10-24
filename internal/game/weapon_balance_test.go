package game

import (
	"fmt"
	"math"
	"strings"
	"testing"
)

// The weapon half of the balance bench (balance_test.go): each survivor's weapon at every
// upgrade level, at close, mid and far range, against every kind of creep, with its gold set
// against what a solo game has earned by then. The tests below it hold each weapon to its
// role. `-args -balance` prints the tables:
//
//	./build.sh go test ./internal/game -run TestWeaponTable -v -args -balance

// The bench's ranges, from the survivor to the creep's middle.
const (
	benchClose float32 = 1.5 // inside the crowbar's reach
	benchMid   float32 = 8
	benchFar   float32 = 15
)

var benchRanges = [3]float32{benchClose, benchMid, benchFar}

// benchKinds are the creeps the weapon tables kill one at a time.
var benchKinds = []CreepKind{CWalker, CRunner, CSwarmer, CHound, CSpitter, CBrute, CMauler, CBoss, CMother, CGoliath}

// role is the range each weapon is built to fight at, for the late-wave tables and bands.
var role = [NumWeapons]float32{
	WPistol:   6,
	WShotgun:  3,
	WSMG:      6,
	WRifle:    16,
	WMinigun:  8,
	WLauncher: 11,
	WCrowbar:  1.5,
}

func weaponRig(k WeaponKind, level uint8) rig {
	return rig{name: fmt.Sprintf("%s %d", Weapons[k].Short, level), weapon: k, lv: lv(level, level, level, level)}
}

// maxed is every weapon fully upgraded, the pistol a pair, as a late wave sees them.
func maxed() []rig {
	var rs []rig
	for k := WeaponKind(0); k < NumWeapons; k++ {
		r := weaponRig(k, MaxLevel)
		if k == WPistol {
			r.name, r.dual = "PSTx2 5", true
		}
		rs = append(rs, r)
	}
	return rs
}

// weaponDPS is dummyDPS with the creep's affixes, and the weapon's ultimate running if ult.
func weaponDPS(r rig, k CreepKind, aff Affix, d float32, ult bool) float32 {
	a := newArena(1)
	a.arm(r)
	if ult {
		a.p.Buff, a.p.BuffLeft = r.weapon, 1e9
	}
	a.w.SpawnCreep(k, a.ox+d, a.oy)
	c := &a.w.Creeps[0]
	c.HP, c.MaxHP, c.Aff = 1e6, 1e6, aff
	const secs = 20
	for range secs * TickRate {
		a.tick(false)
		a.w.Creeps[0].X, a.w.Creeps[0].Y = a.ox+d, a.oy // a shove is not a retreat
	}
	return (1e6 - a.w.Creeps[0].HP) / secs
}

// ttk is the seconds r takes to kill one creep of kind k on wave, at dps.
func ttk(k CreepKind, wave int, dps float32) float32 {
	if dps <= 0 {
		return float32(math.Inf(1))
	}
	return Creeps[k].HP * HPScale(wave) / dps
}

// clearMix is clearTime with the creeps' affixes, and r's ultimate running if ult.
func clearMix(r rig, m mix, d float32, wave int, walk bool, aff Affix, ult bool) (secs float32, reached int) {
	a := newArena(wave)
	a.arm(r)
	if ult {
		a.p.Buff, a.p.BuffLeft = r.weapon, 1e9
	}
	rng := a.w.rng
	for gi, k := range m.kinds {
		for range m.n[gi] {
			ang := rng.Float64() * 2 * math.Pi
			rr := float32(math.Sqrt(rng.Float64())) * 2
			if a.w.SpawnCreep(k, a.ox+d+rr*float32(math.Cos(ang)), a.oy+rr*float32(math.Sin(ang))) {
				a.w.Creeps[len(a.w.Creeps)-1].Aff = aff
			}
		}
	}
	const limit = 60
	at := map[uint16]bool{}
	for i := range limit * TickRate {
		a.tick(walk)
		for j := range a.w.Creeps {
			c := &a.w.Creeps[j]
			if dx, dy := c.X-a.ox, c.Y-a.oy; dx*dx+dy*dy <= (Creeps[c.Kind].Radius+.8)*(Creeps[c.Kind].Radius+.8) {
				at[c.ID] = true
			}
		}
		if len(a.w.Creeps) == 0 {
			return float32(i+1) / TickRate, len(at)
		}
	}
	return limit, len(at)
}

// uptime is the rounds st's weapon gets off over a magazine and its reload, against firing
// without ever reloading: the last round starts the reload, the first of the next magazine
// goes as it ends. Melee never reloads.
func uptime(k WeaponKind, st Stats) float32 {
	if Weapons[k].Fire == FireMelee {
		return 1
	}
	return float32(st.Mag) / st.Rate / (float32(st.Mag-1)/st.Rate + st.Reload)
}

// ideal is what st would take off one unarmoured creep a second if every pellet landed:
// burst times uptime, burn and blast centre included.
func ideal(k WeaponKind, st Stats) float32 {
	return (st.Damage*float32(st.Pellets) + st.Burn) * st.Rate * uptime(k, st)
}

// goldBy is what a lone survivor has earned by the end of each wave, from 1 to 30.
func goldBy() [31]float32 {
	var by [31]float32
	w := New(3)
	for wave := 1; wave <= 30; wave++ {
		g := float32(40 + 15*wave)
		for _, s := range w.plan(wave, 1) {
			g += float32(Creeps[s.Kind].Bounty) * (1 + .04*float32(wave))
		}
		by[wave] = by[wave-1] + g
	}
	return by
}

// affordAt is the first wave by whose end a solo game has earned g; 31 for never.
func affordAt(by [31]float32, g int32) int {
	for wave := 1; wave <= 30; wave++ {
		if by[wave] >= float32(g) {
			return wave
		}
	}
	return 31
}

var (
	mixArmy = mix{"army", []CreepKind{CWalker, CRunner, CSwarmer, CHound, CBrute, CMauler}, []int{10, 4, 10, 4, 2, 1}}
)

func TestWeaponTable(t *testing.T) {
	if !*balanceTable {
		t.Skip("-args -balance prints the table")
	}
	by := goldBy()
	var b strings.Builder

	fmt.Fprintf(&b, "\nweapons by level: gold in it, the wave a solo game has earned that by; sustained dps on one walker close (%g) mid (%g) far (%g), "+
		"an armoured brute (armour 7) and the abomination (9) mid; uptime is firing over firing and reloading; hit%% is dps over every pellet landing\n", benchClose, benchMid, benchFar)
	fmt.Fprintf(&b, "%-8s %6s %4s | %6s %6s %6s | %7s %6s | %8s | %5s | %5s %5s %5s\n", "rig", "gold", "by", "close", "mid", "far", "brute+A", "boss", "dps/100g", "up%", "hit%c", "m", "f")
	for k := WeaponKind(0); k < NumWeapons; k++ {
		for l := uint8(0); l <= MaxLevel; l++ {
			r := weaponRig(k, l)
			st := WeaponStats(k, r.lv)
			var d [3]float32
			for i, rr := range benchRanges {
				d[i] = weaponDPS(r, CWalker, 0, rr, false)
			}
			bra := weaponDPS(r, CBrute, AffixArmoured, benchMid, false)
			bo := weaponDPS(r, CBoss, 0, benchMid, false)
			if k == WCrowbar {
				bra = weaponDPS(r, CBrute, AffixArmoured, benchClose, false)
				bo = weaponDPS(r, CBoss, 0, benchClose, false)
			}
			g := r.cost()
			best := max(d[0], d[1], d[2])
			per := best / float32(max(g, 100)) * 100
			id := ideal(k, st)
			fmt.Fprintf(&b, "%-8s %6d %4d | %6.0f %6.0f %6.0f | %7.0f %6.0f | %8.1f | %5.0f | %5.0f %5.0f %5.0f\n", r.name, g, affordAt(by, g),
				d[0], d[1], d[2], bra, bo, per, 100*uptime(k, st), 100*d[0]/id, 100*d[1]/id, 100*d[2]/id)
		}
	}

	const late = 25
	fmt.Fprintf(&b, "\nmaxed, seconds to kill one creep on wave %d (A = armoured); - out of reach\n", late)
	fmt.Fprintf(&b, "%-11s", "rig@range")
	for _, k := range benchKinds {
		fmt.Fprintf(&b, " %7.7s", Creeps[k].Name)
	}
	fmt.Fprintf(&b, " %7s %7s\n", "walkerA", "bruteA")
	for _, r := range maxed() {
		for _, rr := range benchRanges {
			fmt.Fprintf(&b, "%-11s", fmt.Sprintf("%s@%g", r.name, rr))
			cell := func(k CreepKind, aff Affix) {
				s := ttk(k, late, weaponDPS(r, k, aff, rr, false))
				if s > 999 {
					fmt.Fprintf(&b, " %7s", "-")
				} else {
					fmt.Fprintf(&b, " %7.1f", s)
				}
			}
			for _, k := range benchKinds {
				cell(k, 0)
			}
			cell(CWalker, AffixArmoured)
			cell(CBrute, AffixArmoured)
			b.WriteByte('\n')
		}
	}

	for _, wave := range []int{20, 25, 30} {
		fmt.Fprintf(&b, "\nwave %d, maxed, each at its own range: seconds to clear (60 = not done); army = 10 walkers 4 runners 10 swarmers 4 hounds 2 brutes 1 mauler; "+
			"charge = the army walking in from 16, hasty = a fifth faster, n = how many reached you; goliath = seconds to kill one, from its dps; ult = the charge and the goliath with its ultimate running throughout\n", wave)
		fmt.Fprintf(&b, "%-8s %5s | %6s %6s %6s %6s %7s | %6s %3s %6s %3s | %6s %3s %7s\n", "rig", "range", "pack", "packA", "army", "heavy", "goliath", "charge", "n", "hasty", "n", "ult", "n", "goliath")
		for _, r := range maxed() {
			rr := role[r.weapon]
			p, _ := clearMix(r, mixPack, rr, wave, false, 0, false)
			pa, _ := clearMix(r, mixPack, rr, wave, false, AffixArmoured, false)
			ar, _ := clearMix(r, mixArmy, rr, wave, false, 0, false)
			hv, _ := clearMix(r, mixHeavy, rr, wave, false, 0, false)
			bg := ttk(CGoliath, wave, weaponDPS(r, CGoliath, 0, rr, false))
			ch, n := clearMix(r, mixArmy, 16, wave, true, 0, false)
			hc, hn := clearMix(r, mixArmy, 16, wave, true, AffixHasty, false)
			ul, un, ub := float32(0), 0, float32(0)
			if Ultimates[r.weapon].Time > 0 && r.weapon != WPistol {
				ul, un = clearMix(r, mixArmy, 16, wave, true, 0, true)
				ub = ttk(CGoliath, wave, weaponDPS(r, CGoliath, 0, rr, true))
			}
			fmt.Fprintf(&b, "%-8s %5.1f | %6.1f %6.1f %6.1f %6.1f %7.1f | %6.1f %3d %6.1f %3d | %6.1f %3d %7.1f\n", r.name, rr, p, pa, ar, hv, bg, ch, n, hc, hn, ul, un, ub)
		}
	}

	fmt.Fprintf(&b, "\ngrenade by level: blast damage, and the share of a walker's, a brute's and an abomination's health it takes on waves 10, 20, 30\n")
	for l := 1; l <= len(Abilities[AbGrenade].Radius); l++ {
		dmg := float32(grenadeBase + grenadeStep*l)
		fmt.Fprintf(&b, "lv %d: %4.0f dmg r %.1f |", l, dmg, Abilities[AbGrenade].Radius[l-1])
		for _, wave := range []int{10, 20, 30} {
			fmt.Fprintf(&b, " w%d %3.0f%% %3.0f%% %3.0f%%", wave, 100*dmg/(Creeps[CWalker].HP*HPScale(wave)),
				100*(dmg-Creeps[CBrute].Armor)/(Creeps[CBrute].HP*HPScale(wave)), 100*(dmg-Creeps[CBoss].Armor)/(Creeps[CBoss].HP*HPScale(wave)))
		}
		b.WriteByte('\n')
	}

	fmt.Fprintf(&b, "\nsolo gold earned by the end of the wave\n")
	for wave := 5; wave <= 30; wave += 5 {
		fmt.Fprintf(&b, "wave %2d: %7.0f\n", wave, by[wave])
	}
	t.Log(b.String())
}
