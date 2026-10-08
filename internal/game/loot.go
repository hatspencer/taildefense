package game

import (
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"strings"
)

// SiteKind is what a loot site is.
type SiteKind uint8

const (
	SiteHouse SiteKind = iota // a ruined house; searched from inside
	SiteCar                   // a car wreck on a track
	SiteCrate                 // a supply crate in the open
	NumSiteKinds
)

// SiteDef is a kind of loot site.
type SiteDef struct {
	Name   string
	Search float32 // seconds a search takes
	Luck   float64 // added to the searcher's luck
	Trap   float32 // chance a search wakes a nest
}

// SiteDefs is indexed by SiteKind.
var SiteDefs = [NumSiteKinds]SiteDef{
	SiteHouse: {Name: "Ruined house", Search: 3, Luck: .5, Trap: .1},
	SiteCar:   {Name: "Car wreck", Search: 2},
	SiteCrate: {Name: "Supply crate", Search: 1.5, Luck: .25},
}

func (d SiteDef) lower() string { return strings.ToLower(d.Name) }

// Site is a place outside the walls that can be searched once for loot. Sites are fixed by
// the map's seed; Searched is the only thing that changes.
type Site struct {
	Kind     SiteKind
	X, Y     int16 // top-left tile of what it covers
	W, H     uint8
	SX, SY   float32 // where a survivor stands to search
	Tier     uint8   // 0 near the base .. 2 far out
	Guard    uint8   // 0 unguarded .. 3 a lair: how many and how tough its guards are
	Guards   uint8   // guards still alive; it cannot be searched until there are none
	Searched bool
}

// lootReach is how close to a site's spot a survivor must be to search it.
const lootReach = 1.2

// Rarity is how good a find is.
type Rarity uint8

const (
	Junk Rarity = iota
	Common
	Good
	Rare
	Jackpot
	NumRarities
)

var rarityNames = [NumRarities]string{"", "", "", "rare", "jackpot"}

// rarityWeight is how often each rarity comes up with no luck at all.
var rarityWeight = [NumRarities]float64{35, 35, 20, 8, 2}

// RollRarity turns a uniform number in [0, 1) into a rarity. Luck moves weight from junk to
// the rarer finds, the rarest gaining the most.
func RollRarity(u, luck float64) Rarity {
	f := 1 + .5*max(luck, 0)
	var wts [NumRarities]float64
	total := 0.
	for i := range wts {
		wts[i] = rarityWeight[i] * math.Pow(f, .4*float64(i))
		total += wts[i]
	}
	x := u * total
	for i, v := range wts {
		if x < v {
			return Rarity(i)
		}
		x -= v
	}
	return Jackpot
}

// Luck is how lucky p would be searching s right now: further out, later waves, searching
// during a wave, the Scavenger gear and a run of poor finds all help.
func (w *World) Luck(p *Player, s *Site) float64 {
	l := .75*float64(s.Tier) + .6*float64(s.Guard) + SiteDefs[s.Kind].Luck + .5*float64(p.Gear[GearScavenger]) + float64(w.Wave)/10 + .5*float64(p.Dry)
	if w.Phase == PhaseWave {
		l++
	}
	return l
}

// OrderLoot sends the player to search a site.
func (w *World) OrderLoot(p *Player, si int) error {
	if si < 0 || si >= len(w.Sites) {
		return errors.New("nothing to search there")
	}
	if w.Phase == PhaseOver {
		return errOver
	}
	s := &w.Sites[si]
	if s.Searched {
		return fmt.Errorf("the %s has been searched already", SiteDefs[s.Kind].lower())
	}
	if err := guarded(s); err != nil {
		return err
	}
	w.order(p, Order{Kind: OrderLoot, Site: si, X: s.SX, Y: s.SY})
	return nil
}

// guarded refuses a search while a site's guards live.
func guarded(s *Site) error {
	switch s.Guards {
	case 0:
		return nil
	case 1:
		return fmt.Errorf("a guard is still watching the %s: deal with it first", SiteDefs[s.Kind].lower())
	}
	return fmt.Errorf("%d guards are still watching the %s: clear them first", s.Guards, SiteDefs[s.Kind].lower())
}

// search finishes p's search of a site: maybe a nest wakes, then the find is rolled and
// handed over.
func (w *World) search(p *Player, si int) {
	s := &w.Sites[si]
	s.Searched = true
	d := SiteDefs[s.Kind]
	if w.rng.Float32() < d.Trap {
		w.ambush(s, p)
		w.Blasts = append(w.Blasts, Blast{s.SX, s.SY, 2.5, 6})
		w.note(2, "%s woke a nest in a %s", p.Name, d.lower())
	}
	r := RollRarity(w.rng.Float64(), w.Luck(p, s))
	what := w.grant(p, r)
	switch {
	case r == Junk:
		p.Dry = min(p.Dry+1, 6)
	case r >= Good:
		p.Dry = 0
	}
	br := float32(.5)
	if r >= Rare {
		br = 1
	}
	w.Blasts = append(w.Blasts, Blast{s.SX, s.SY, br, 5})
	level := uint8(0)
	if r >= Good {
		level = 1
	}
	tag := ""
	if rarityNames[r] != "" {
		tag = "  ·  " + rarityNames[r]
	}
	w.note(level, "%s found %s in a %s%s", p.Name, what, d.lower(), tag)
}

// ambush wakes a nest inside a house: walkers, and runners later on, around the searcher.
func (w *World) ambush(s *Site, p *Player) {
	n := 3 + w.rng.IntN(3) + w.Wave/3
	for i := 0; i < n; i++ {
		k := CWalker
		if w.Wave >= 4 && w.rng.IntN(3) == 0 {
			k = CRunner
		}
		for try := 0; try < 8; try++ {
			x := float32(s.X) + 1 + w.rng.Float32()*float32(max(int(s.W)-2, 1))
			y := float32(s.Y) + 1 + w.rng.Float32()*float32(max(int(s.H)-2, 1))
			if !w.At(int(x), int(y)).Solid() {
				if w.SpawnCreep(k, x, y) {
					c := &w.Creeps[len(w.Creeps)-1]
					c.Hunt, c.HuntLeft = int8(p.ID), 8
				}
				break
			}
		}
	}
}

// restock fills about a third of the searched sites again and returns how many.
func (w *World) restock() int {
	n := 0
	for i := range w.Sites {
		if w.Sites[i].Searched && w.rng.IntN(3) == 0 {
			w.Sites[i].Searched = false
			if w.Sites[i].Guards == 0 {
				w.spawnGuards(i)
			}
			n++
		}
	}
	return n
}

// lootGold is a gold find between lo and hi, more on later waves.
func (w *World) lootGold(lo, hi int) int32 {
	return int32(float32(lo+w.rng.IntN(hi-lo+1)) * (1 + .08*float32(w.Wave)) * w.diff().Gold)
}

// grant gives p a find of rarity r and says what it was. Whatever cannot be given (a weapon
// already owned, an upgrade already maxed) becomes gold instead.
func (w *World) grant(p *Player, r Rarity) string {
	gold := func(g int32) string {
		p.Gold += g
		return fmt.Sprintf("%d gold", g)
	}
	switch r {
	case Junk:
		return gold(w.lootGold(5, 25))
	case Common:
		if w.rng.IntN(2) == 0 {
			if s, ok := w.giveUpgrade(p, p.Cur, 1); ok {
				return s
			}
		}
		return gold(w.lootGold(30, 120))
	case Good:
		switch w.rng.IntN(3) {
		case 0:
			if s, ok := w.giveWeapon(p, w.unowned(p, Weapons[WRifle].Price), 0); ok {
				return s
			}
		case 1:
			if s, ok := w.giveGear(p); ok {
				return s
			}
		}
		return gold(w.lootGold(150, 300))
	case Rare:
		switch w.rng.IntN(3) {
		case 0:
			if s, ok := w.giveAbility(p); ok {
				return s
			}
		case 1:
			if s, ok := w.giveWeapon(p, w.unowned(p, Weapons[WMinigun].Price), 2); ok {
				return s
			}
		case 2:
			if s, ok := w.giveUpgrade(p, p.Cur, 2); ok {
				return s
			}
		}
		return gold(w.lootGold(300, 500))
	}
	// Jackpot.
	if w.rng.IntN(2) == 0 && !p.Weapons[WLauncher].Owned {
		s, _ := w.giveWeapon(p, WLauncher, 0)
		return s
	}
	share := w.lootGold(80, 120)
	for _, o := range w.Players {
		if o != p && o.Connected {
			o.Gold += share
		}
	}
	return gold(w.lootGold(500, 900)) + fmt.Sprintf(" (and %d for everyone else)", share)
}

// unowned picks a weapon p does not own, priced up to most, or NumWeapons when there is none.
func (w *World) unowned(p *Player, most int32) WeaponKind {
	var c []WeaponKind
	for k := WeaponKind(0); k < NumWeapons; k++ {
		if !p.Weapons[k].Owned && Weapons[k].Price <= most {
			c = append(c, k)
		}
	}
	if len(c) == 0 {
		return NumWeapons
	}
	return c[w.rng.IntN(len(c))]
}

// giveWeapon hands over weapon k with levels on one random track, and equips it.
func (w *World) giveWeapon(p *Player, k WeaponKind, levels uint8) (string, bool) {
	if k >= NumWeapons || p.Weapons[k].Owned {
		return "", false
	}
	ws := WeaponState{Owned: true}
	note := ""
	if levels > 0 {
		t := Track(w.rng.IntN(int(NumTracks)))
		ws.Lv[t] = levels
		note = fmt.Sprintf(" with %s %d", TrackNames[t], levels)
	}
	ws.Ammo = WeaponStats(k, ws.Lv).Mag
	p.Weapons[k] = ws
	p.Cur = k
	return article(Weapons[k].Name) + note, true
}

// giveUpgrade raises a random unmaxed track of weapon k by up to n levels.
func (w *World) giveUpgrade(p *Player, k WeaponKind, n uint8) (string, bool) {
	ws := &p.Weapons[k]
	var c []Track
	for t := Track(0); t < NumTracks; t++ {
		if ws.Lv[t] < MaxLevel {
			c = append(c, t)
		}
	}
	if !ws.Owned || len(c) == 0 {
		return "", false
	}
	t := c[w.rng.IntN(len(c))]
	ws.Lv[t] = min(ws.Lv[t]+n, MaxLevel)
	if t == TrackHandling && ws.Reload <= 0 {
		ws.Ammo = WeaponStats(k, ws.Lv).Mag
	}
	return fmt.Sprintf("%s parts (%s → %d)", Weapons[k].Name, TrackNames[t], ws.Lv[t]), true
}

// giveGear raises a random unmaxed piece of gear, Scavenger aside, by one level.
func (w *World) giveGear(p *Player) (string, bool) {
	var c []Gear
	for g := Gear(0); g < GearScavenger; g++ {
		if p.Gear[g] < MaxLevel {
			c = append(c, g)
		}
	}
	if len(c) == 0 {
		return "", false
	}
	g := c[w.rng.IntN(len(c))]
	p.Gear[g]++
	if g == GearArmor {
		p.MaxHP += 25
		p.HP += 25
	}
	return fmt.Sprintf("%s (→ %d)", strings.ToLower(GearNames[g]), p.Gear[g]), true
}

// giveAbility raises a random unmaxed bought ability by one level.
func (w *World) giveAbility(p *Player) (string, bool) {
	var c []int
	for a := AbSignature + 1; a < NumAbilities; a++ {
		if p.Abil[a].Lv < MaxAbilityLevel {
			c = append(c, a)
		}
	}
	if len(c) == 0 {
		return "", false
	}
	a := c[w.rng.IntN(len(c))]
	p.Abil[a].Lv++
	return fmt.Sprintf("a %s manual (→ %d)", strings.ToLower(Abilities[a].Name), p.Abil[a].Lv), true
}

// article puts "a" or "an" before a name.
func article(s string) string {
	if strings.ContainsRune("AEIOUaeiou", rune(s[0])) || strings.HasPrefix(s, "SMG") {
		return "an " + s
	}
	return "a " + s
}

// guardOdds weighs guard levels 0..3 per tier.
var guardOdds = [3][4]int{{45, 40, 15, 0}, {15, 40, 33, 12}, {5, 25, 40, 30}}

// Site tiers by distance from the generator.
const (
	tierMid = 70
	tierFar = 120
)

// placeSites turns the ruined houses into loot sites and scatters car wrecks and crates,
// keeping only those a survivor can reach. It draws on its own generator, so the terrain
// of a seed is the same with or without them.
func (w *World) placeSites(houses [][4]int) []Site {
	rng := rand.New(rand.NewPCG(w.Seed, 0x100f))
	var sites []Site
	reach := func(x, y float32) bool {
		tx, ty := int(x), int(y)
		return CanStand(w, x, y) && w.flow.dist[ty*w.W+tx] < unreachable
	}
	inside := func(x, y, pad int) bool {
		for _, s := range sites {
			if x >= int(s.X)-pad && y >= int(s.Y)-pad && x < int(s.X)+int(s.W)+pad && y < int(s.Y)+int(s.H)+pad {
				return true
			}
		}
		return false
	}
	add := func(k SiteKind, x, y, sw, sh int, sx, sy float32) {
		dx, dy := sx-w.CoreX, sy-w.CoreY
		d := sqrt32(dx*dx + dy*dy)
		tier := uint8(0)
		if d >= tierFar {
			tier = 2
		} else if d >= tierMid {
			tier = 1
		}
		// Further out is guarded harder; a crate in the open less often than a house.
		wt := guardOdds[tier]
		if k == SiteCrate {
			wt[0] += 25
		}
		g, r := uint8(0), rng.IntN(wt[0]+wt[1]+wt[2]+wt[3])
		for g < 3 && r >= wt[g] {
			r -= wt[g]
			g++
		}
		sites = append(sites, Site{Kind: k, X: int16(x), Y: int16(y), W: uint8(sw), H: uint8(sh), SX: sx, SY: sy, Tier: tier, Guard: g})
	}
	for _, h := range houses {
		x, y, hw, hh := h[0], h[1], h[2], h[3]
		sx, sy := float32(x)+float32(hw)/2, float32(y)+float32(hh)/2
		// A later house or a road can cut through an earlier one; keep it only while its
		// middle is still floor a survivor can get to.
		if inside(int(sx), int(sy), 0) || !reach(sx, sy) {
			continue
		}
		add(SiteHouse, x, y, hw, hh, sx, sy)
	}
	want := [NumSiteKinds]int{SiteCar: 22, SiteCrate: 22}
	for try := 0; try < 4000 && (want[SiteCar] > 0 || want[SiteCrate] > 0); try++ {
		x, y := 3+rng.IntN(w.W-6), 3+rng.IntN(w.H-6)
		sx, sy := float32(x)+.5, float32(y)+.5
		if dx, dy := sx-w.CoreX, sy-w.CoreY; dx*dx+dy*dy < 30*30 {
			continue
		}
		k := SiteCrate
		switch w.At(x, y) {
		case TDirt:
			k = SiteCar
		case TGrass, TSand:
		default:
			continue
		}
		if want[k] == 0 || inside(x, y, 4) || !reach(sx, sy) {
			continue
		}
		want[k]--
		add(k, x, y, 1, 1, sx, sy)
	}
	return sites
}
