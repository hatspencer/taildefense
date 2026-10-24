package game

import (
	"flag"
	"fmt"
	"math"
	"strings"
	"testing"
)

// The balance bench: every weapon, turret, evolution and trap fired at the same creeps on open
// ground, so their numbers can be set side by side rather than guessed. The tests in
// balance_bands_test.go hold the identities the balance is built round; `-args -balance`
// prints the whole table, `-balance-only` some of its sections (a comma list of dps, clear,
// kinds, lane, support, traps, trapkinds, pylon, overload, gold):
//
//	./build.sh go test ./internal/game -run TestBalanceTable -v -args -balance
//	./build.sh go test ./internal/game -run TestBalanceTable -v -args -balance -balance-only lane,support
var (
	balanceTable = flag.Bool("balance", false, "print the weapon and turret balance table")
	balanceOnly  = flag.String("balance-only", "", "print only these sections of the balance table")
)

// section reports whether the table prints section name.
func section(name string) bool {
	if *balanceOnly == "" {
		return true
	}
	for _, s := range strings.Split(*balanceOnly, ",") {
		if strings.TrimSpace(s) == name {
			return true
		}
	}
	return false
}

// arena is a world cleared to grass with nothing standing on it, a survivor at its middle.
type arena struct {
	w      *World
	p      *Player
	ox, oy float32
	built  bool // turrets or traps stand: the survivor holds fire

	// The lane: creeps walk +x along y = laneY from laneX0 and leak past laneX1.
	lane           bool
	laneY          float32
	laneX0, laneX1 float32
	leakedHP       float32
	leaked         int
}

func newArena(wave int) *arena {
	w := NewGame(7, DiffNormal)
	for i := range w.Terrain {
		w.Terrain[i] = TGrass
	}
	// Nothing stands, not even the generator: a trap gone off must not be taken for it.
	w.Structs = w.Structs[:0]
	w.Core = -1
	for i := range w.structAt {
		w.structAt[i] = -1
	}
	for i := range w.floorAt {
		w.floorAt[i] = -1
	}
	w.Sites = nil
	w.Wave = wave
	w.Phase = PhaseWave
	w.Weather, w.WeatherAmt = 0, 0
	w.lit = nil
	w.Creeps = w.Creeps[:0]
	w.freeIDs = w.freeIDs[:0]
	w.freed = w.freed[:0]
	for i := MaxCreeps - 1; i >= 0; i-- {
		w.freeIDs = append(w.freeIDs, uint16(i))
	}
	p, _ := w.Join("bench", "bench@example")
	a := &arena{w: w, p: p, ox: float32(w.W / 2), oy: float32(w.H / 2)}
	p.X, p.Y = a.ox, a.oy
	p.HP, p.MaxHP = 1e9, 1e9
	return a
}

// rig is what the arena fires: a weapon at its track levels, or a structure (a turret at its
// levels and evolution, a trap at its level, a pylon).
type rig struct {
	name   string
	weapon WeaponKind
	turret StructKind // SNone for a weapon
	lv     [NumTracks]uint8
	evo    uint8
	dual   bool
	level  uint8 // a trap's level, past the first
}

// cost is the gold that went into r.
func (r rig) cost() int32 {
	var g int32
	if r.turret == SNone {
		g = Weapons[r.weapon].Price
		for t := range NumTracks {
			for l := uint8(0); l < r.lv[t]; l++ {
				g += UpgradeCost(r.weapon, l)
			}
		}
		return g
	}
	g = Structs[r.turret].Price
	if !Structs[r.turret].Turret {
		for l := uint8(1); l <= r.level; l++ {
			g += StructUpgradeCost(r.turret, l)
		}
		return g
	}
	for t := range NumTracks {
		for l := uint8(0); l < r.lv[t]; l++ {
			g += TurretUpgradeCost(r.turret, l)
		}
	}
	if r.evo > 0 {
		g += Structs[r.turret].Price
	}
	return g
}

// arm gives the survivor r's weapon, or builds r's structure at the arena's middle.
func (a *arena) arm(r rig) {
	if r.turret == SNone {
		ws := &a.p.Weapons[r.weapon]
		ws.Owned, ws.Lv, ws.Dual = true, r.lv, r.dual
		ws.Ammo, ws.Reload, ws.Cool = ws.Stats(r.weapon).Mag, 0, 0
		a.p.Cur = r.weapon
		return
	}
	a.build(r, 0, 0)
}

// build puts r's structure down dx, dy tiles from the arena's middle.
func (a *arena) build(r rig, dx, dy int) *Structure {
	si := a.w.place(r.turret, int(a.ox)+dx, int(a.oy)+dy, int8(a.p.ID))
	s := &a.w.Structs[si]
	s.Lv, s.Evo = r.lv, r.evo
	s.Level = 1 + r.level
	a.built = true
	return s
}

// The ways the bench's creeps move.
const (
	still = iota // where they stand
	walk         // at the survivor
	lane         // along the lane, to leak out of its far end
)

// tick is one step of the bench: the survivor fires as the game fires (orders.go), the
// turrets, traps and rockets go, and the creeps burn, count their stuns down and, unless
// still, come on at their pace, slowed, stunned or frozen as the game would have them.
func (a *arena) tick(move int) {
	w, p := a.w, a.p
	w.Tick++
	w.freeIDs = append(w.freeIDs, w.freed...)
	w.freed = w.freed[:0]
	w.grid.build(w.Creeps)
	if !a.built {
		ws := &p.Weapons[p.Cur]
		st := w.playerStats(p)
		if ws.Reload > 0 {
			if ws.Reload -= Dt; ws.Reload <= 0 {
				ws.Reload, ws.Ammo = 0, st.Mag
			}
		}
		ws.Cool -= Dt
		t := w.nearestVisible(p.X, p.Y, st.Range)
		if t >= 0 {
			c := &w.Creeps[t]
			ang := float32(math.Atan2(float64(c.Y-p.Y), float64(c.X-p.X)))
			w.shooter = int8(p.ID)
			for ws.Cool <= 0 && ws.Reload <= 0 && ws.Ammo > 0 {
				w.shoot(p, st, ang)
				ws.Cool += 1 / st.Rate
				if Weapons[p.Cur].Fire == FireMelee || p.ulting(p.Cur) {
					continue
				}
				if ws.Ammo--; ws.Ammo == 0 {
					ws.Reload = st.Reload
				}
			}
			w.shooter = -1
		}
		ws.Cool = max(ws.Cool, 0)
	}
	w.stepTurrets()
	w.stepTraps()
	w.stepRockets()
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if c.HP <= 0 {
			continue
		}
		if c.Mark > 0 {
			c.Mark -= Dt
		}
		if c.Burn > 0 {
			c.Burn -= Dt
			c.HP -= c.BurnDPS * w.burnMul() * Dt
		}
		if c.stunned() {
			continue
		}
		sp := Creeps[c.Kind].Speed
		if c.Aff&AffixHasty != 0 {
			sp *= affixHaste
		}
		if c.Slow > 0 {
			c.Slow -= Dt
			sp *= c.slowed()
		}
		switch move {
		case walk:
			dx, dy := a.ox-c.X, a.oy-c.Y
			d := sqrt32(dx*dx + dy*dy)
			if stop := Creeps[c.Kind].Radius + .7; d > stop {
				m := min(sp*Dt, d-stop)
				c.X += dx / d * m
				c.Y += dy / d * m
			}
		case lane:
			c.X += sp * Dt
		}
	}
	if move == lane {
		for i := 0; i < len(w.Creeps); {
			if c := &w.Creeps[i]; c.HP > 0 && c.X >= a.laneX1 {
				a.leakedHP += c.HP
				a.leaked++
				w.freed = append(w.freed, c.ID)
				w.Creeps[i] = w.Creeps[len(w.Creeps)-1]
				w.Creeps = w.Creeps[:len(w.Creeps)-1]
				continue
			}
			i++
		}
	}
	w.reap()
}

// dummyDPS is what r takes off one creep of kind k, armoured or not, d tiles off, a second
// over 20 s of firing, reloads and all: the sustained single-target number. The dummy keeps
// its kind's hit points at the wave for anything that goes by them, with a million to take.
func dummyDPS(r rig, k CreepKind, armoured bool, d float32, wave int) float32 {
	a := newArena(wave)
	a.arm(r)
	a.w.SpawnCreep(k, a.ox+d, a.oy)
	c := &a.w.Creeps[0]
	c.HP = 1e6
	if armoured {
		c.Aff = AffixArmoured
	}
	const secs = 20
	for range secs * TickRate {
		a.tick(still)
	}
	return (1e6 - a.w.Creeps[0].HP) / secs
}

// ttk is the seconds r takes to kill one creep of kind k with affixes aff, standing 6 tiles
// off at wave, up to limit.
func ttk(r rig, k CreepKind, aff Affix, wave int, limit float32) float32 {
	a := newArena(wave)
	a.arm(r)
	a.w.SpawnCreep(k, a.ox+6, a.oy)
	a.w.Creeps[0].Aff = aff
	for i := range int(limit * TickRate) {
		a.tick(still)
		if len(a.w.Creeps) == 0 {
			return float32(i+1) / TickRate
		}
	}
	return limit
}

// mix is a group of creeps for the bench, spawned in a blob.
type mix struct {
	name  string
	kinds []CreepKind
	n     []int
}

var (
	mixPack  = mix{"pack", []CreepKind{CWalker, CRunner, CSwarmer}, []int{10, 4, 16}}
	mixHeavy = mix{"heavy", []CreepKind{CBrute, CWalker}, []int{3, 6}}
	mixBoss  = mix{"boss", []CreepKind{CBoss}, []int{1}}
)

// clearTime is r against m d tiles off, frozen in place or walking in: the seconds it takes to
// kill them all (capped at limit), and when they walk, how many got to the survivor alive.
func clearTime(r rig, m mix, d float32, wave int, move int, armoured bool) (secs float32, reached int) {
	a := newArena(wave)
	a.arm(r)
	rng := a.w.rng
	for gi, k := range m.kinds {
		for range m.n[gi] {
			ang := rng.Float64() * 2 * math.Pi
			rr := float32(math.Sqrt(rng.Float64())) * 2
			a.w.SpawnCreep(k, a.ox+d+rr*float32(math.Cos(ang)), a.oy+rr*float32(math.Sin(ang)))
			if armoured {
				a.w.Creeps[len(a.w.Creeps)-1].Aff = AffixArmoured
			}
		}
	}
	const limit = 60
	at := map[uint16]bool{}
	for i := range limit * TickRate {
		a.tick(move)
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

// The lane: a road 50 tiles long, laneOff tiles from the middle where the turrets stand,
// that a wave's creeps walk single file at their own pace, a gap apart, and leak out of the
// far end. What a defence takes off them is the measure of it in a wave rather than a blob:
// range is time with them, a slow is more of it, splash is how bunched they come.
const (
	laneHalf = 25
	laneOff  = 3
	laneN    = 60  // creeps in a lane wave
	laneGap  = .35 // seconds between them

	// supportGap packs the lane closer for the support table, so a partner alone leaves
	// something for its support to add to.
	supportGap = .15
)

// piece is a structure of a lane's defence, dx, dy tiles from the middle; on the road is
// dy = laneOff.
type piece struct {
	r      rig
	dx, dy int
}

// laneWave is laneN creeps sampled evenly from wave's plan, bosses left out (they have their
// own table): the wave's mix, at the bench's size.
func laneWave(wave int) []CreepKind {
	w := New(3)
	var all []CreepKind
	for _, s := range w.plan(wave, 1) {
		if !s.Kind.Boss() {
			all = append(all, s.Kind)
		}
	}
	ks := make([]CreepKind, laneN)
	for i := range ks {
		ks[i] = all[i*len(all)/laneN]
	}
	return ks
}

// laneResult is what a defence did to a lane wave.
type laneResult struct {
	share  float32 // of the wave's hit points taken off it
	killed float32 // hit points taken off
	leaked int     // creeps out of the far end alive
	gold   int32
}

// runLane walks kinds down the lane at wave past the defence ps, with affixes aff.
func runLane(ps []piece, kinds []CreepKind, wave int, aff Affix) laneResult {
	return runLaneGap(ps, kinds, wave, aff, laneGap)
}

// runLaneGap is runLane with the creeps gap seconds apart.
func runLaneGap(ps []piece, kinds []CreepKind, wave int, aff Affix, gap float32) laneResult {
	a := newArena(wave)
	a.lane = true
	a.laneY = a.oy + laneOff + .5
	a.laneX0, a.laneX1 = a.ox-laneHalf, a.ox+laneHalf
	var res laneResult
	for _, p := range ps {
		a.build(p.r, p.dx, p.dy)
		res.gold += p.r.cost()
	}
	var total float32
	next, spawned := float32(0), 0
	for i := 0; i < 240*TickRate; i++ {
		t := float32(i) / TickRate
		for spawned < len(kinds) && t >= next {
			// A little to either side of the middle of the road, as a crowd walks.
			y := a.laneY + (a.w.rng.Float32()-.5)*.6
			a.w.SpawnCreep(kinds[spawned], a.laneX0, y)
			c := &a.w.Creeps[len(a.w.Creeps)-1]
			c.Aff = aff
			total += c.HP
			spawned++
			next += gap
		}
		a.tick(lane)
		if spawned == len(kinds) && len(a.w.Creeps) == 0 {
			break
		}
	}
	left := a.leakedHP
	for _, c := range a.w.Creeps {
		left += max(c.HP, 0)
	}
	res.killed = max(total-left, 0)
	res.share = res.killed / total
	res.leaked = a.leaked
	return res
}

func lv(d, r, h, s uint8) [NumTracks]uint8 { return [NumTracks]uint8{d, r, h, s} }

// turretKinds are the turrets, in menu order.
var turretKinds = []StructKind{STurretGun, STurretCannon, STurretFrost, STurretTesla, STurretSniper, STurretMissile}

// shortName is a structure's first word: "Gun", "Cannon".
func shortName(k StructKind) string { return strings.Fields(Structs[k].Name)[0] }

// turretRigs are every turret at 0, 3 and 5 on every track, and each evolution at 3s.
func turretRigs() []rig {
	var rs []rig
	for _, k := range turretKinds {
		n := shortName(k)
		rs = append(rs, rig{name: n + " 0", turret: k}, rig{name: n + " 3", turret: k, lv: lv(3, 3, 3, 3)}, rig{name: n + " 5", turret: k, lv: lv(5, 5, 5, 5)})
		for e := uint8(1); e <= 2; e++ {
			rs = append(rs, evoRig(k, e))
		}
	}
	return rs
}

// evoRig is turret k evolved into branch e at the fewest levels it takes, 3 on every track.
func evoRig(k StructKind, e uint8) rig {
	return rig{name: Evolutions[k][e-1].Name, turret: k, lv: lv(3, 3, 3, 3), evo: e}
}

func benchRigs() []rig {
	var rs []rig
	for k := WeaponKind(0); k < NumWeapons; k++ {
		n := Weapons[k].Short
		rs = append(rs, rig{name: n + " 0", weapon: k}, rig{name: n + " 2", weapon: k, lv: lv(2, 2, 2, 2)}, rig{name: n + " 5", weapon: k, lv: lv(5, 5, 5, 5)})
	}
	rs = append(rs, rig{name: "PSTx2 5", weapon: WPistol, lv: lv(5, 5, 5, 5), dual: true})
	return append(rs, turretRigs()...)
}

// laneOne is a lone structure of r beside the lane.
func laneOne(r rig) []piece { return []piece{{r, 0, 0}} }

// trapRow is n of trap r laid along the road, middle out.
func trapRow(r rig, n int) []piece {
	var ps []piece
	for i := range n {
		ps = append(ps, piece{r, i - n/2, laneOff})
	}
	return ps
}

// supportGain is what support s adds beside partner p in the lane at wave, against what p
// does alone: the hit points s's gold bought, per 100 gold, and p's own per 100 gold.
func supportGain(p rig, s []piece, kinds []CreepKind, wave int) (gain, own float32) {
	alone := runLaneGap(laneOne(p), kinds, wave, 0, supportGap)
	with := runLaneGap(append(laneOne(p), s...), kinds, wave, 0, supportGap)
	var sg int32
	for _, x := range s {
		sg += x.r.cost()
	}
	return (with.killed - alone.killed) / float32(sg) * 100, alone.killed / float32(p.cost()) * 100
}

// The bench's traps.
var (
	rigSpikes = rig{name: "Spikes", turret: STrapSpikes}
	rigTar    = rig{name: "Tar", turret: STrapTar}
	rigVent   = rig{name: "Vent", turret: STrapVent}
	rigMine   = rig{name: "Mine", turret: STrapMine}
	rigPylon  = rig{name: "Pylon", turret: SPylon}
)

// benchKinds are the creeps of the per-kind table.
// laneWaves are the waves the lane tables walk: the last before each swarm, a normal mix.
var laneWaves = []int{4, 9, 19, 29}

var benchKinds = []CreepKind{CWalker, CRunner, CSwarmer, CHound, CSpitter, CHurler, CBrute, CMauler, CBoss, CMother, CGoliath}

func TestBalanceTable(t *testing.T) {
	if !*balanceTable {
		t.Skip("-args -balance prints the table")
	}
	var b strings.Builder
	if section("dps") {
		fmt.Fprintf(&b, "\nsustained dps on one creep, wave 1 (walker unarmoured; brute armour 4; brute armoured 7; boss 9)\n")
		fmt.Fprintf(&b, "%-16s %6s | %7s %7s %7s | %7s %7s %7s | %8s\n", "rig", "gold", "walk@4", "walk@10", "walk@18", "brute", "brute+A", "boss", "dps/100g")
		for _, r := range benchRigs() {
			d4, d10, d18 := dummyDPS(r, CWalker, false, 4, 1), dummyDPS(r, CWalker, false, 10, 1), dummyDPS(r, CWalker, false, 18, 1)
			br, bra, bo := dummyDPS(r, CBrute, false, 6, 1), dummyDPS(r, CBrute, true, 6, 1), dummyDPS(r, CBoss, false, 6, 1)
			g := r.cost()
			per := float32(0)
			if g > 0 {
				per = max(d4, d10) / float32(g) * 100
			}
			fmt.Fprintf(&b, "%-16s %6d | %7.0f %7.0f %7.0f | %7.0f %7.0f %7.0f | %8.1f\n", r.name, g, d4, d10, d18, br, bra, bo, per)
		}
	}
	if section("clear") {
		for _, wave := range []int{10, 20, 30} {
			fmt.Fprintf(&b, "\nwave %d: seconds to kill (60 = not done); pack = 10 walkers 4 runners 16 swarmers; heavy = 3 brutes 6 walkers; charge = the pack walking in from 16, n reached you\n", wave)
			fmt.Fprintf(&b, "%-16s | %7s %7s %7s | %7s %7s | %7s %8s\n", "rig", "pack@6", "pack@14", "packA@8", "heavy@8", "boss@8", "charge", "reached")
			for _, r := range benchRigs() {
				p6, _ := clearTime(r, mixPack, 6, wave, still, false)
				p14, _ := clearTime(r, mixPack, 14, wave, still, false)
				pa, _ := clearTime(r, mixPack, 8, wave, still, true)
				hv, _ := clearTime(r, mixHeavy, 8, wave, still, false)
				bo, _ := clearTime(r, mixBoss, 8, wave, still, false)
				ch, n := clearTime(r, mixPack, 16, wave, walk, false)
				fmt.Fprintf(&b, "%-16s | %7.1f %7.1f %7.1f | %7.1f %7.1f | %7.1f %8d\n", r.name, p6, p14, pa, hv, bo, ch, n)
			}
		}
	}
	if section("kinds") {
		const wave, limit = 20, 180
		fmt.Fprintf(&b, "\nwave %d: seconds for one turret to kill one creep of each kind 6 tiles off (%d = not done); +A armoured\n", wave, limit)
		fmt.Fprintf(&b, "%-16s %6s |", "rig", "gold")
		for _, k := range benchKinds {
			fmt.Fprintf(&b, " %6.6s", Creeps[k].Name)
		}
		fmt.Fprintf(&b, " %6s %6s | %9s\n", "brute+A", "abom+A", "abom·kg")
		for _, r := range turretRigs() {
			fmt.Fprintf(&b, "%-16s %6d |", r.name, r.cost())
			var boss float32
			for _, k := range benchKinds {
				s := ttk(r, k, 0, wave, limit)
				if k == CBoss {
					boss = s
				}
				fmt.Fprintf(&b, " %6.1f", s)
			}
			// The gold-seconds a boss takes: lower is a better boss killer for its gold.
			fmt.Fprintf(&b, " %6.1f %6.1f | %9.0f\n", ttk(r, CBrute, AffixArmoured, wave, limit), ttk(r, CBoss, AffixArmoured, wave, limit), boss*float32(r.cost())/1000)
		}
	}
	if section("lane") {
		for _, wave := range laneWaves {
			kinds := laneWave(wave)
			fmt.Fprintf(&b, "\nwave %d lane: %d creeps of the wave single file down a road %d tiles long, %d tiles from one turret; share of their hp taken off, hp per 100 gold, leaked\n", wave, laneN, 2*laneHalf, laneOff)
			fmt.Fprintf(&b, "%-16s %6s | %6s %8s %6s | %6s %6s (armoured)\n", "rig", "gold", "share", "hp/100g", "leaked", "share", "leaked")
			for _, r := range turretRigs() {
				res := runLane(laneOne(r), kinds, wave, 0)
				ra := runLane(laneOne(r), kinds, wave, AffixArmoured)
				fmt.Fprintf(&b, "%-16s %6d | %5.0f%% %8.0f %6d | %5.0f%% %6d\n", r.name, res.gold, res.share*100, res.killed/float32(res.gold)*100, res.leaked, ra.share*100, ra.leaked)
			}
		}
	}
	if section("support") {
		for _, wave := range laneWaves[1:] {
			kinds := laneWave(wave)
			fmt.Fprintf(&b, "\nwave %d lane, support: hp a slow, a trap or a pylon adds beside a partner, per 100 of its own gold, against the partner's own per 100 gold\n", wave)
			sups := []struct {
				name string
				ps   []piece
			}{
				{"Frost 0", []piece{{rig{turret: STurretFrost}, 1, 0}}},
				{"Frost 3", []piece{{rig{turret: STurretFrost, lv: lv(3, 3, 3, 3)}, 1, 0}}},
				{"Frost 5", []piece{{rig{turret: STurretFrost, lv: lv(5, 5, 5, 5)}, 1, 0}}},
				{"Cryo", []piece{{evoRig(STurretFrost, 1), 1, 0}}},
				{"Blizzard", []piece{{evoRig(STurretFrost, 2), 1, 0}}},
				{"Spotter", []piece{{evoRig(STurretSniper, 1), 1, 0}}},
				{"Tar x5", trapRow(rigTar, 5)},
				{"Pylon", []piece{{rigPylon, 1, 0}}},
			}
			partners := []rig{
				{name: "Gun 3", turret: STurretGun, lv: lv(3, 3, 3, 3)},
				{name: "Cannon 3", turret: STurretCannon, lv: lv(3, 3, 3, 3)},
				{name: "Tesla 3", turret: STurretTesla, lv: lv(3, 3, 3, 3)},
				{name: "Sniper 3", turret: STurretSniper, lv: lv(3, 3, 3, 3)},
				{name: "Missile 3", turret: STurretMissile, lv: lv(3, 3, 3, 3)},
			}
			fmt.Fprintf(&b, "%-10s |", "support")
			for _, p := range partners {
				fmt.Fprintf(&b, " %16s", p.name)
			}
			fmt.Fprintf(&b, "\n")
			for _, s := range sups {
				fmt.Fprintf(&b, "%-10s |", s.name)
				for _, p := range partners {
					gain, own := supportGain(p, s.ps, kinds, wave)
					fmt.Fprintf(&b, " %7.0f vs %5.0f", gain, own)
				}
				fmt.Fprintf(&b, "\n")
			}
		}
	}
	if section("traps") {
		rows := []struct {
			name string
			ps   []piece
		}{
			{"Spikes x5", trapRow(rigSpikes, 5)},
			{"Spikes L3 x5", trapRow(rig{turret: STrapSpikes, level: 2}, 5)},
			{"Vent x2", trapRow(rigVent, 2)},
			{"Vent L3 x2", trapRow(rig{turret: STrapVent, level: 2}, 2)},
			{"Mine x5", trapRow(rigMine, 5)},
			{"Tar x5", trapRow(rigTar, 5)},
			{"Gun 0", laneOne(rig{turret: STurretGun})},
		}
		for _, wave := range laneWaves {
			kinds := laneWave(wave)
			fmt.Fprintf(&b, "\nwave %d lane, traps on the road: share of hp, hp per 100 gold, leaked\n", wave)
			for _, r := range rows {
				res := runLane(r.ps, kinds, wave, 0)
				fmt.Fprintf(&b, "%-16s %6d | %5.0f%% %8.0f %6d\n", r.name, res.gold, res.share*100, res.killed/float32(res.gold)*100, res.leaked)
			}
		}
	}
	if section("trapkinds") {
		const wave = 20
		fmt.Fprintf(&b, "\nwave %d: share of one creep's hp a row of traps takes as it walks over (one at a time)\n%-12s |", wave, "row")
		for _, k := range benchKinds {
			fmt.Fprintf(&b, " %6.6s", Creeps[k].Name)
		}
		fmt.Fprintf(&b, "\n")
		for _, r := range []struct {
			name string
			ps   []piece
		}{{"Spikes x5", trapRow(rigSpikes, 5)}, {"Vent x2", trapRow(rigVent, 2)}, {"Mine x1", trapRow(rigMine, 1)}} {
			fmt.Fprintf(&b, "%-12s |", r.name)
			for _, k := range benchKinds {
				res := runLane(r.ps, []CreepKind{k}, wave, 0)
				fmt.Fprintf(&b, " %5.0f%%", res.share*100)
			}
			fmt.Fprintf(&b, "\n")
		}
	}
	if section("pylon") {
		const wave = 29
		kinds := laneWave(wave)
		four := func(r rig) []piece {
			return []piece{{r, -1, -1}, {r, 1, -1}, {r, -1, 1}, {r, 1, 1}}
		}
		fmt.Fprintf(&b, "\nwave %d lane, a pylon among four turrets: hp it adds per 100 gold, against theirs\n", wave)
		for _, k := range turretKinds {
			r := rig{turret: k, lv: lv(3, 3, 3, 3)}
			alone := runLaneGap(four(r), kinds, wave, 0, supportGap)
			with := runLaneGap(append(four(r), piece{rigPylon, 0, 0}), kinds, wave, 0, supportGap)
			fmt.Fprintf(&b, "%-10s 3 x4 | pylon %6.0f vs %6.0f\n", shortName(k), (with.killed-alone.killed)/float32(rigPylon.cost())*100, alone.killed/float32(alone.gold)*100)
		}
	}
	if section("overload") {
		fmt.Fprintf(&b, "\nthe Overload's damage against each kind's hp (armour off), by wave\n%-6s %6s |", "wave", "damage")
		for _, k := range benchKinds {
			fmt.Fprintf(&b, " %6.6s", Creeps[k].Name)
		}
		fmt.Fprintf(&b, "\n")
		for _, wave := range []int{10, 20, 30} {
			w := New(3)
			w.Wave = wave
			d := w.overloadDamage()
			fmt.Fprintf(&b, "%-6d %6.0f |", wave, d)
			for _, k := range benchKinds {
				hp := Creeps[k].HP * HPScale(wave)
				fmt.Fprintf(&b, " %5.0f%%", min(max(d-Creeps[k].Armor, d*.25)/hp, 1)*100)
			}
			fmt.Fprintf(&b, "\n")
		}
	}
	if section("gold") {
		fmt.Fprintf(&b, "\nsolo gold by wave (bounties at full kills + the wave bonus), normal; and the hp of the wave\n")
		w := New(3)
		var total float32
		for wave := 1; wave <= 30; wave++ {
			var g, hp float32
			for _, s := range w.plan(wave, 1) {
				g += float32(Creeps[s.Kind].Bounty) * (1 + .04*float32(wave))
				hp += Creeps[s.Kind].HP * HPScale(wave)
			}
			g += float32(40 + 15*wave)
			total += g
			if wave%5 == 0 || wave%5 == 4 {
				fmt.Fprintf(&b, "wave %2d: %6.0f this wave, %7.0f so far, %8.0f hp\n", wave, g, total, hp)
			}
		}
	}
	t.Log(b.String())
}
