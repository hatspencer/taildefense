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
	return weaponDPSFor(r, k, aff, d, ult, 20)
}

// weaponDPSFor is weaponDPS over the first secs seconds of firing, from cold: a minigun that
// has to spin up, a magazine that may not run dry.
func weaponDPSFor(r rig, k CreepKind, aff Affix, d float32, ult bool, secs int) float32 {
	a := newArena(1)
	a.arm(r)
	if ult {
		a.p.Buff, a.p.BuffLeft = r.weapon, 1e9
	}
	a.w.SpawnCreep(k, a.ox+d, a.oy)
	c := &a.w.Creeps[0]
	c.HP, c.MaxHP, c.Aff = 1e6, 1e6, aff
	for range secs * TickRate {
		a.tick(false)
		a.w.Creeps[0].X, a.w.Creeps[0].Y = a.ox+d, a.oy // a shove is not a retreat
	}
	return (1e6 - a.w.Creeps[0].HP) / float32(secs)
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
	secs, reached, _ = clearHurt(r, m, d, wave, walk, aff, ult)
	return secs, reached
}

// clearHurt is clearMix with the health the survivor lost to their own fire: the bench's creeps
// never strike, so that is all of it.
func clearHurt(r rig, m mix, d float32, wave int, walk bool, aff Affix, ult bool) (secs float32, reached int, self float32) {
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
			return float32(i+1) / TickRate, len(at), a.p.MaxHP - a.p.HP
		}
	}
	return limit, len(at), a.p.MaxHP - a.p.HP
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
		"an armoured brute (armour 7) and the abomination (9) mid; cold = dps on a walker mid over the first 2 s, from cold; uptime is firing over firing and reloading; hit%% is dps over every pellet landing\n", benchClose, benchMid, benchFar)
	fmt.Fprintf(&b, "%-8s %6s %4s | %6s %6s %6s | %7s %6s | %5s | %8s | %5s | %5s %5s %5s\n", "rig", "gold", "by", "close", "mid", "far", "brute+A", "boss", "cold", "dps/100g", "up%", "hit%c", "m", "f")
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
			cold := weaponDPSFor(r, CWalker, 0, benchMid, false, 2)
			if k == WCrowbar {
				cold = weaponDPSFor(r, CWalker, 0, benchClose, false, 2)
			}
			g := r.cost()
			best := max(d[0], d[1], d[2])
			per := best / float32(max(g, 100)) * 100
			id := ideal(k, st)
			fmt.Fprintf(&b, "%-8s %6d %4d | %6.0f %6.0f %6.0f | %7.0f %6.0f | %5.0f | %8.1f | %5.0f | %5.0f %5.0f %5.0f\n", r.name, g, affordAt(by, g),
				d[0], d[1], d[2], bra, bo, cold, per, 100*uptime(k, st), 100*d[0]/id, 100*d[1]/id, 100*d[2]/id)
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
			"charge = the army walking in from 16, self = the health you lost to your own fire on it, hasty = a fifth faster, n = how many reached you; goliath = seconds to kill one, from its dps; ult = the charge and the goliath with its ultimate running throughout\n", wave)
		fmt.Fprintf(&b, "%-8s %5s | %6s %6s %6s %6s %7s | %6s %3s %4s %6s %3s | %6s %3s %7s\n", "rig", "range", "pack", "packA", "army", "heavy", "goliath", "charge", "n", "self", "hasty", "n", "ult", "n", "goliath")
		for _, r := range maxed() {
			rr := role[r.weapon]
			p, _ := clearMix(r, mixPack, rr, wave, false, 0, false)
			pa, _ := clearMix(r, mixPack, rr, wave, false, AffixArmoured, false)
			ar, _ := clearMix(r, mixArmy, rr, wave, false, 0, false)
			hv, _ := clearMix(r, mixHeavy, rr, wave, false, 0, false)
			bg := ttk(CGoliath, wave, weaponDPS(r, CGoliath, 0, rr, false))
			ch, n, self := clearHurt(r, mixArmy, 16, wave, true, 0, false)
			hc, hn := clearMix(r, mixArmy, 16, wave, true, AffixHasty, false)
			ul, un, ub := float32(0), 0, float32(0)
			if Ultimates[r.weapon].Time > 0 && r.weapon != WPistol {
				ul, un = clearMix(r, mixArmy, 16, wave, true, 0, true)
				ub = ttk(CGoliath, wave, weaponDPS(r, CGoliath, 0, rr, true))
			}
			fmt.Fprintf(&b, "%-8s %5.1f | %6.1f %6.1f %6.1f %6.1f %7.1f | %6.1f %3d %4.0f %6.1f %3d | %6.1f %3d %7.1f\n", r.name, rr, p, pa, ar, hv, bg, ch, n, self, hc, hn, ul, un, ub)
		}
	}

	fmt.Fprintf(&b, "\ngrenade by level: blast damage on wave 10, and the share of a walker's, a brute's and an abomination's health it takes on waves 10, 20, 30\n")
	for l := 1; l <= len(Abilities[AbGrenade].Radius); l++ {
		fmt.Fprintf(&b, "lv %d: %4d dmg r %.1f |", l, grenadeBase+grenadeStep*l, Abilities[AbGrenade].Radius[l-1])
		for _, wave := range []int{10, 20, 30} {
			dmg := float32(grenadeBase+grenadeStep*l) * lateScale(wave)
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

// The identities the weapon balance is built round, measured on the bench. Each weapon is held
// to its role and every one, fully bought, to a band of the others by late waves.

func TestShotgunIsBrutalCloseAndWeakFar(t *testing.T) {
	for _, l := range []uint8{0, MaxLevel} {
		sg, rf := weaponRig(WShotgun, l), weaponRig(WRifle, l)
		sc, rc := weaponDPS(sg, CWalker, 0, benchClose, false), weaponDPS(rf, CWalker, 0, benchClose, false)
		sm, rm := weaponDPS(sg, CWalker, 0, benchMid, false), weaponDPS(rf, CWalker, 0, benchMid, false)
		if sc < 1.1*rc || l == MaxLevel && sc < 2*rc {
			t.Errorf("level %d: the shotgun up close does %.0f a second, the rifle %.0f; it should be far ahead", l, sc, rc)
		}
		if sm > .5*rm {
			t.Errorf("level %d: the shotgun at %g tiles does %.0f a second, the rifle %.0f; it should fall off", l, benchMid, sm, rm)
		}
		if f := weaponDPS(sg, CWalker, 0, benchFar, false); f > 0 {
			t.Errorf("level %d: the shotgun reaches %g tiles", l, benchFar)
		}
	}
	// Its own boss killer, up close.
	sg := weaponDPS(weaponRig(WShotgun, MaxLevel), CGoliath, 0, benchClose, false)
	for _, r := range maxed() {
		if r.weapon == WShotgun {
			continue
		}
		if d := weaponDPS(r, CGoliath, 0, benchClose, false); d >= sg {
			t.Errorf("%s up close on a goliath does %.0f a second, the shotgun %.0f", r.name, d, sg)
		}
	}
}

func TestRifleIsPreciseAndOwnsRange(t *testing.T) {
	rf := weaponRig(WRifle, MaxLevel)
	far := weaponDPS(rf, CWalker, 0, benchFar, false)
	if id := ideal(WRifle, WeaponStats(WRifle, rf.lv)); far < .95*id {
		t.Errorf("the rifle lands %.0f%% of its fire at %g tiles; it should miss nothing", 100*far/id, benchFar)
	}
	big := weaponDPS(rf, CGoliath, 0, benchFar, false)
	for _, r := range maxed() {
		if r.weapon == WRifle {
			continue
		}
		if d := weaponDPS(r, CWalker, 0, benchFar, false); d >= far {
			t.Errorf("%s does %.0f a second at %g tiles, the rifle %.0f", r.name, d, benchFar, far)
		}
		if d := weaponDPS(r, CGoliath, 0, benchFar, false); d >= big {
			t.Errorf("%s does %.0f a second to a goliath at %g tiles, the rifle %.0f", r.name, d, benchFar, big)
		}
	}
}

func TestMinigunOutlastsTheSMGButSpinsUp(t *testing.T) {
	mg, smg := weaponRig(WMinigun, MaxLevel), weaponRig(WSMG, MaxLevel)
	ms, ss := weaponDPS(mg, CWalker, 0, benchClose, false), weaponDPS(smg, CWalker, 0, benchClose, false)
	if ms < 1.3*ss {
		t.Errorf("sustained, the minigun does %.0f a second up close, the SMG %.0f; the minigun should lead", ms, ss)
	}
	mc, sc := weaponDPSFor(mg, CWalker, 0, benchMid, false, 2), weaponDPSFor(smg, CWalker, 0, benchMid, false, 2)
	if mc >= sc {
		t.Errorf("from cold, the minigun does %.0f a second over 2 s, the SMG %.0f; the SMG should be quicker off the mark", mc, sc)
	}
	if ul := weaponDPSFor(mg, CWalker, 0, benchMid, true, 2); ul <= mc {
		t.Errorf("overdrive from cold does %.0f a second, no more than without (%.0f): it should spin up at once", ul, mc)
	}
}

func TestRocketSplashesAndBurnsItsShooter(t *testing.T) {
	const wave = 25
	rk := weaponRig(WLauncher, MaxLevel)
	pack, _ := clearMix(rk, mixPack, role[WLauncher], wave, false, 0, false)
	for _, r := range maxed() {
		if r.weapon == WLauncher || r.weapon == WCrowbar {
			continue
		}
		if s, _ := clearMix(r, mixPack, role[r.weapon], wave, false, 0, false); s <= pack {
			t.Errorf("wave %d: %s clears the pack in %.1f s, the rocket in %.1f; nothing should clear a crowd faster", wave, r.name, s, pack)
		}
	}
	if rd, fd := weaponDPS(rk, CGoliath, 0, benchFar, false), weaponDPS(weaponRig(WRifle, MaxLevel), CGoliath, 0, benchFar, false); rd >= fd {
		t.Errorf("the rocket does %.0f a second to one goliath, the rifle %.0f; the rocket is for crowds", rd, fd)
	}
	for _, r := range maxed() {
		_, _, self := clearHurt(r, mixArmy, 16, wave, true, 0, false)
		if r.weapon == WLauncher && self < rocketSelf {
			t.Errorf("rockets at a charge in your face cost you %.0f health; they should hurt", self)
		}
		if r.weapon != WLauncher && self > 0 {
			t.Errorf("%s hurt its own shooter for %.0f", r.name, self)
		}
	}
}

func TestPistolScalesWithItsUpgrades(t *testing.T) {
	base := weaponDPS(weaponRig(WPistol, 0), CWalker, 0, benchMid, false)
	one := weaponDPS(weaponRig(WPistol, MaxLevel), CWalker, 0, benchMid, false)
	two := weaponDPS(maxed()[WPistol], CWalker, 0, benchMid, false)
	if one < 4*base {
		t.Errorf("a fully bought pistol does %.0f a second, a new one %.0f; the upgrades should carry it", one, base)
	}
	if two < 1.8*one {
		t.Errorf("a pair of pistols does %.0f a second, one %.0f", two, one)
	}
	if two < weaponDPS(weaponRig(WSMG, 3), CWalker, 0, benchMid, false) {
		t.Errorf("a fully bought pair of pistols, %.0f a second, is outshot by a half-bought SMG", two)
	}
}

func TestCrowbarIsAPanicOption(t *testing.T) {
	bar := weaponDPS(weaponRig(WCrowbar, MaxLevel), CWalker, 0, benchClose, false)
	if pst := weaponDPS(weaponRig(WPistol, MaxLevel), CWalker, 0, benchClose, false); bar < 1.3*pst {
		t.Errorf("a fully bought crowbar does %.0f a second in reach, a pistol %.0f; a swing should beat a sidearm up close", bar, pst)
	}
	if s, _ := clearMix(weaponRig(WCrowbar, MaxLevel), mixArmy, 16, 25, true, 0, false); s > 30 {
		t.Errorf("wave 25: a fully bought crowbar takes %.1f s to beat back a charge", s)
	}
}

// Fully bought, at wave 25, at the range each is for: the time to clear the army and the heavy
// mix, and to beat back the charge, within band times the best of them.
func TestMaxedWeaponsStayInBandLate(t *testing.T) {
	const wave, band = 25, 2.5
	type res struct {
		name               string
		army, heavy, charg float32
	}
	var rs []res
	for _, r := range maxed() {
		x := res{name: r.name, army: -1, heavy: -1}
		if r.weapon != WCrowbar { // it has to be come at: the charge is its test
			x.army, _ = clearMix(r, mixArmy, role[r.weapon], wave, false, 0, false)
			x.heavy, _ = clearMix(r, mixHeavy, role[r.weapon], wave, false, 0, false)
		}
		x.charg, _ = clearMix(r, mixArmy, 16, wave, true, 0, false)
		rs = append(rs, x)
	}
	check := func(what string, get func(res) float32, band float32) {
		best := float32(math.Inf(1))
		for _, x := range rs {
			if v := get(x); v >= 0 {
				best = min(best, v)
			}
		}
		for _, x := range rs {
			if v := get(x); v >= 0 && v > band*best {
				t.Errorf("wave %d %s: %s takes %.1f s, over %.1f times the best's %.1f", wave, what, x.name, v, band, best)
			}
		}
	}
	check("army", func(x res) float32 { return x.army }, band)
	check("heavy", func(x res) float32 { return x.heavy }, band)
	check("charge", func(x res) float32 { return x.charg }, band+.5) // the crowbar has to let them in
}

// The grenade, fully bought, does to a wave 30 crowd what it does to a wave 10 one.
func TestGrenadeKeepsUpLate(t *testing.T) {
	dmg := func(wave int) float32 { return float32(grenadeBase+grenadeStep*5) * lateScale(wave) }
	at := func(wave int) float32 { return dmg(wave) / (Creeps[CWalker].HP * HPScale(wave)) }
	if at(30) < .99*at(10) {
		t.Errorf("a full grenade is %.1f walkers on wave 10 and %.1f on wave 30", at(10), at(30))
	}
	if lateScale(5) != 1 {
		t.Errorf("the grenade grows before wave %d", lateFrom)
	}
}
