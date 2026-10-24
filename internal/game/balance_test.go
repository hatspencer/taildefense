package game

import (
	"flag"
	"fmt"
	"math"
	"strings"
	"testing"
)

// The balance bench: every weapon and turret fired at the same creeps on open ground, so
// their numbers can be set side by side rather than guessed. The tests at the bottom hold the
// identities the balance is built round; `-args -balance` prints the whole table:
//
//	./build.sh go test ./internal/game -run TestBalanceTable -v -args -balance
var balanceTable = flag.Bool("balance", false, "print the weapon and turret balance table")

// arena is a world cleared to grass with nothing standing on it, a survivor at its middle.
type arena struct {
	w      *World
	p      *Player
	ox, oy float32
	turret *Structure
}

func newArena(wave int) *arena {
	w := NewGame(7, DiffNormal)
	for i := range w.Terrain {
		w.Terrain[i] = TGrass
	}
	for i := range w.Structs {
		w.Structs[i].Alive = false
	}
	w.Sites = nil
	w.Wave = wave
	w.Phase = PhaseWave
	w.Weather, w.WeatherAmt = 0, 0
	w.lit = nil
	w.Creeps = w.Creeps[:0]
	w.freeIDs = w.freeIDs[:0]
	for i := MaxCreeps - 1; i >= 0; i-- {
		w.freeIDs = append(w.freeIDs, uint16(i))
	}
	p, _ := w.Join("bench", "bench@example")
	a := &arena{w: w, p: p, ox: float32(w.W / 2), oy: float32(w.H / 2)}
	p.X, p.Y = a.ox, a.oy
	p.HP, p.MaxHP = 1e9, 1e9
	return a
}

// rig is what the arena fires: a weapon at its track levels, or a turret at its levels and
// evolution.
type rig struct {
	name   string
	weapon WeaponKind
	turret StructKind // SNone for a weapon
	lv     [NumTracks]uint8
	evo    uint8
	dual   bool
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

func (a *arena) arm(r rig) {
	if r.turret == SNone {
		ws := &a.p.Weapons[r.weapon]
		ws.Owned, ws.Lv, ws.Dual = true, r.lv, r.dual
		ws.Ammo, ws.Reload, ws.Cool = ws.Stats(r.weapon).Mag, 0, 0
		a.p.Cur = r.weapon
		return
	}
	si := a.w.place(r.turret, int(a.ox), int(a.oy), int8(a.p.ID))
	s := &a.w.Structs[si]
	s.Lv, s.Evo = r.lv, r.evo
	a.turret = s
}

// tick is one step of the bench: the survivor fires as the game fires (orders.go), the
// turrets and rockets go, and the creeps burn, count their stuns down and, when walk, come on
// at the survivor at their pace, slowed, stunned or frozen as the game would have them.
func (a *arena) tick(walk bool) {
	w, p := a.w, a.p
	w.Tick++
	w.grid.build(w.Creeps)
	if a.turret == nil {
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
			sp *= .45
		}
		if !walk {
			continue
		}
		dx, dy := a.ox-c.X, a.oy-c.Y
		d := sqrt32(dx*dx + dy*dy)
		if stop := Creeps[c.Kind].Radius + .7; d > stop {
			m := min(sp*Dt, d-stop)
			c.X += dx / d * m
			c.Y += dy / d * m
		}
	}
	w.reap()
}

// dummyDPS is what r takes off one creep of kind k, armoured or not, d tiles off, a second
// over 20 s of firing, reloads and all: the sustained single-target number.
func dummyDPS(r rig, k CreepKind, armoured bool, d float32, wave int) float32 {
	a := newArena(wave)
	a.arm(r)
	a.w.SpawnCreep(k, a.ox+d, a.oy)
	c := &a.w.Creeps[0]
	c.HP, c.MaxHP = 1e6, 1e6
	if armoured {
		c.Aff = AffixArmoured
	}
	const secs = 20
	for range secs * TickRate {
		a.tick(false)
	}
	return (1e6 - a.w.Creeps[0].HP) / secs
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
func clearTime(r rig, m mix, d float32, wave int, walk, armoured bool) (secs float32, reached int) {
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

func lv(d, r, h, s uint8) [NumTracks]uint8 { return [NumTracks]uint8{d, r, h, s} }

func benchRigs() []rig {
	var rs []rig
	for k := WeaponKind(0); k < NumWeapons; k++ {
		n := Weapons[k].Short
		rs = append(rs, rig{name: n + " 0", weapon: k}, rig{name: n + " 2", weapon: k, lv: lv(2, 2, 2, 2)}, rig{name: n + " 5", weapon: k, lv: lv(5, 5, 5, 5)})
	}
	rs = append(rs, rig{name: "PSTx2 5", weapon: WPistol, lv: lv(5, 5, 5, 5), dual: true})
	for _, k := range []StructKind{STurretGun, STurretCannon, STurretFrost, STurretTesla, STurretSniper, STurretMissile} {
		n := strings.Fields(Structs[k].Name)[0]
		rs = append(rs, rig{name: n + " 0", turret: k}, rig{name: n + " 3", turret: k, lv: lv(3, 3, 3, 3)}, rig{name: n + " 5", turret: k, lv: lv(5, 5, 5, 5)})
		for e := uint8(1); e <= 2; e++ {
			rs = append(rs, rig{name: Evolutions[k][e-1].Name, turret: k, lv: lv(3, 3, 3, 3), evo: e})
		}
	}
	return rs
}

func TestBalanceTable(t *testing.T) {
	if !*balanceTable {
		t.Skip("-args -balance prints the table")
	}
	var b strings.Builder
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
	for _, wave := range []int{10, 20, 30} {
		fmt.Fprintf(&b, "\nwave %d: seconds to kill (60 = not done); pack = 10 walkers 4 runners 16 swarmers; heavy = 3 brutes 6 walkers; charge = the pack walking in from 16, n reached you\n", wave)
		fmt.Fprintf(&b, "%-16s | %7s %7s %7s | %7s %7s | %7s %8s\n", "rig", "pack@6", "pack@14", "packA@8", "heavy@8", "boss@8", "charge", "reached")
		for _, r := range benchRigs() {
			p6, _ := clearTime(r, mixPack, 6, wave, false, false)
			p14, _ := clearTime(r, mixPack, 14, wave, false, false)
			pa, _ := clearTime(r, mixPack, 8, wave, false, true)
			hv, _ := clearTime(r, mixHeavy, 8, wave, false, false)
			bo, _ := clearTime(r, mixBoss, 8, wave, false, false)
			ch, n := clearTime(r, mixPack, 16, wave, true, false)
			fmt.Fprintf(&b, "%-16s | %7.1f %7.1f %7.1f | %7.1f %7.1f | %7.1f %8d\n", r.name, p6, p14, pa, hv, bo, ch, n)
		}
	}
	fmt.Fprintf(&b, "\nsolo gold by wave (bounties at full kills + the wave bonus), normal\n")
	w := New(3)
	var total float32
	for wave := 1; wave <= 30; wave++ {
		var g float32
		for _, s := range w.plan(wave, 1) {
			g += float32(Creeps[s.Kind].Bounty) * (1 + .04*float32(wave))
		}
		g += float32(40 + 15*wave)
		total += g
		if wave%5 == 0 {
			fmt.Fprintf(&b, "wave %2d: %6.0f this wave, %7.0f so far\n", wave, g, total)
		}
	}
	t.Log(b.String())
}
