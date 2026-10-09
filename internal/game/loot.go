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
	SiteHouse     SiteKind = iota // a ruined house; searched from inside
	SiteCar                       // a car wreck on a track
	SiteCrate                     // a supply crate in the open
	SiteOutpost                   // an overrun outpost: a big walled compound, searched in its keep
	SitePickup                    // a pickup truck, its bed full of tools
	SitePolice                    // a police cruiser, the shotgun rack still locked
	SiteAmbulance                 // an ambulance; its kit patches up the searcher
	SiteBus                       // a school bus: slow to search, two finds, often a nest inside
	SiteArmy                      // an army truck far out, always guarded
	NumSiteKinds
)

// Favor is what kind of find a site leans towards.
type Favor uint8

const (
	FavorNone Favor = iota
	FavorWeapons
	FavorGear
)

// SiteDef is a kind of loot site.
type SiteDef struct {
	Name   string
	Search float32 // seconds a search takes
	Luck   float64 // added to the searcher's luck
	Trap   float32 // chance a search wakes a nest
	Favor  Favor   // the kind of find it leans towards
	Finds  int     // finds a search turns up, 1 when 0
	Heal   bool    // the search patches the searcher up to full health
	Guard  uint8   // the least guard level it is ever placed with
}

// SiteDefs is indexed by SiteKind.
var SiteDefs = [NumSiteKinds]SiteDef{
	SiteHouse:     {Name: "Ruined house", Search: 3, Luck: .5, Trap: .1},
	SiteCar:       {Name: "Car wreck", Search: 2},
	SiteCrate:     {Name: "Supply crate", Search: 1.5, Luck: .25},
	SiteOutpost:   {Name: "Overrun outpost", Search: 6, Luck: 2},
	SitePickup:    {Name: "Pickup truck", Search: 2.5, Luck: .25, Favor: FavorGear},
	SitePolice:    {Name: "Police cruiser", Search: 2.5, Luck: .5, Favor: FavorWeapons},
	SiteAmbulance: {Name: "Ambulance", Search: 3, Luck: .25, Favor: FavorGear, Heal: true},
	SiteBus:       {Name: "School bus", Search: 4, Luck: .25, Trap: .3, Finds: 2},
	SiteArmy:      {Name: "Army truck", Search: 3.5, Luck: 1.25, Favor: FavorWeapons, Guard: 2},
}

// Wreck reports whether a site is a vehicle on a road.
func (k SiteKind) Wreck() bool { return k == SiteCar || k >= SitePickup }

// wreckOdds is how often each kind of wreck turns up on the roads, by tier: plain cars and
// pickups everywhere, the bus nearer town, the police and the army further out.
var wreckOdds = [3][]struct {
	Kind SiteKind
	Odds int
}{
	{{SiteCar, 50}, {SitePickup, 22}, {SiteBus, 16}, {SiteAmbulance, 12}},
	{{SiteCar, 30}, {SitePickup, 20}, {SitePolice, 20}, {SiteAmbulance, 14}, {SiteBus, 10}, {SiteArmy, 6}},
	{{SiteCar, 22}, {SitePickup, 14}, {SitePolice, 20}, {SiteAmbulance, 12}, {SiteBus, 8}, {SiteArmy, 24}},
}

// Walled reports whether a site is a building searched from inside, rather than a thing in
// the open.
func (k SiteKind) Walled() bool { return k == SiteHouse || k == SiteOutpost }

// outpostFinds is how many finds searching an outpost turns up; the first is rare or better,
// the rest good or better.
const outpostFinds = 3

func (d SiteDef) lower() string { return strings.ToLower(d.Name) }

// Site is a place outside the walls that can be searched once for loot. Sites are fixed by
// the map's seed; Searched is the only thing that changes.
type Site struct {
	Kind     SiteKind
	X, Y     int16 // top-left tile of what it covers
	W, H     uint8
	SX, SY   float32 // where a survivor stands to search
	Tier     uint8   // 0 near the base .. 2 far out
	Guard    uint8   // 0 unguarded .. 3 a lair, 4 an outpost's garrison: how many and how tough its guards are
	Guards   uint8   // guards still alive
	Searched bool
	Sprung   uint8   // ambushes already sprung here; the hardest places hide more than their guards
	Yaw      float32 // a wreck's heading, radians from +x towards +y (wreck.go)
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
	w.order(p, Order{Kind: OrderLoot, Site: si, X: s.SX, Y: s.SY})
	return nil
}

// search finishes p's search of a site: maybe a nest wakes, then the find is rolled and
// handed over.
func (w *World) search(p *Player, si int) {
	s := &w.Sites[si]
	s.Searched = true
	d := SiteDefs[s.Kind]
	if w.rng.Float32() < d.Trap {
		w.ambush(si, p)
		w.Blasts = append(w.Blasts, Blast{s.SX, s.SY, 2.5, 6})
		w.note(2, "%s woke a nest in a %s", p.Name, d.lower())
	}
	if s.Kind == SiteOutpost {
		w.searchOutpost(p, s)
		return
	}
	r := Junk
	var got []string
	for i := 0; i < max(d.Finds, 1); i++ {
		ri := w.ceil(s, RollRarity(w.rng.Float64(), w.Luck(p, s)))
		r = max(r, ri)
		got = append(got, w.grant(p, ri, d.Favor))
	}
	what := strings.Join(got, " and ")
	if d.Heal && p.HP < p.MaxHP {
		p.HP = p.MaxHP
		what += ", and patched up with its kit"
	}
	if d.Heal && p.Medkits < medkitMax {
		p.Medkits++
		what += ", and a medkit"
	}
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

// lootCeil is the best a site can give by its guard level: the quiet houses near the base
// hold gold and small upgrades, the strong guns wait behind the lairs and the outposts.
var lootCeil = [5]Rarity{Common, Good, Rare, Jackpot, Jackpot}

// ceilChance is how often a site gives one step better than its ceiling anyway.
const ceilChance = .06

// ceil holds r to what site s can give, now and then letting it through one step higher.
func (w *World) ceil(s *Site, r Rarity) Rarity {
	c := lootCeil[min(int(s.Guard), len(lootCeil)-1)]
	if r > c && w.rng.Float32() < ceilChance {
		c++
	}
	return min(r, c)
}

// searchOutpost hands over an outpost's stash: several finds, all good, the first rare at least.
func (w *World) searchOutpost(p *Player, s *Site) {
	var got []string
	best := Junk
	for i := 0; i < outpostFinds; i++ {
		floor := Good
		if i == 0 {
			floor = Rare
		}
		r := max(RollRarity(w.rng.Float64(), w.Luck(p, s)), floor)
		best = max(best, r)
		got = append(got, w.grant(p, r, FavorNone))
	}
	p.Dry = 0
	w.Blasts = append(w.Blasts, Blast{s.SX, s.SY, 1.5, 5})
	tag := ""
	if rarityNames[best] != "" {
		tag = "  ·  " + rarityNames[best]
	}
	w.note(1, "%s raided an overrun outpost: %s%s", p.Name, strings.Join(got, ", "), tag)
}

// ambush wakes a nest inside a house: walkers, and runners later on, around the searcher.
func (w *World) ambush(si int, p *Player) {
	s := &w.Sites[si]
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
					// The nest belongs to the house like guards do, so it never holds a
					// wave open: it hunts the searcher, then settles back in.
					c := &w.Creeps[len(w.Creeps)-1]
					c.Hunt, c.HuntLeft = int8(p.ID), 8
					c.Home, c.HX, c.HY = int16(si+1), x, y
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
			w.Sites[i].Searched, w.Sites[i].Sprung = false, 0
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

// pick is one of n kinds of find, the favoured one (if any) more often than the others.
func (w *World) pick(n, favored int) int {
	if favored >= 0 && w.rng.IntN(10) < 6 {
		return favored
	}
	return w.rng.IntN(n)
}

// grant gives p a find of rarity r, leaning towards what f favours, and says what it was. Whatever cannot be given (a weapon
// already owned, an upgrade already maxed) becomes gold instead.
func (w *World) grant(p *Player, r Rarity, f Favor) string {
	good, rare := -1, -1
	switch f {
	case FavorWeapons:
		good, rare = 0, 1
	case FavorGear:
		good, rare = 1, 2
	}
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
		switch w.pick(3, good) {
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
		switch w.pick(3, rare) {
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

// tierAt is the tier of a place dx, dy from the generator.
func tierAt(dx, dy float32) uint8 {
	switch d := sqrt32(dx*dx + dy*dy); {
	case d >= tierFar:
		return 2
	case d >= tierMid:
		return 1
	}
	return 0
}

// wreckKind picks what a wreck on the road is, by its tier.
func wreckKind(rng *rand.Rand, tier uint8) SiteKind {
	odds := wreckOdds[tier]
	total := 0
	for _, o := range odds {
		total += o.Odds
	}
	r := rng.IntN(total)
	for _, o := range odds {
		if r < o.Odds {
			return o.Kind
		}
		r -= o.Odds
	}
	return SiteCar
}

// placeSites turns the ruined houses into loot sites and scatters car wrecks and crates,
// keeping only those a survivor can reach. It draws on its own generator, so the terrain
// of a seed is the same with or without them.
func (w *World) placeSites(ruins []ruin) []Site {
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
		tier := tierAt(sx-w.CoreX, sy-w.CoreY)
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
		if k == SiteOutpost {
			g = 4
		}
		g = max(g, SiteDefs[k].Guard)
		sites = append(sites, Site{Kind: k, X: int16(x), Y: int16(y), W: uint8(sw), H: uint8(sh), SX: sx, SY: sy, Tier: tier, Guard: g})
	}
	for _, h := range ruins {
		x, y, hw, hh := h.x, h.y, h.w, h.h
		sx, sy := float32(x)+float32(hw)/2, float32(y)+float32(hh)/2
		if h.outpost {
			sx, sy = float32(h.cx)+.5, float32(h.cy)+.5
			if !inside(int(sx), int(sy), 0) && reach(sx, sy) {
				add(SiteOutpost, x, y, hw, hh, sx, sy)
			}
			continue
		}
		// A later house or a road can cut through an earlier one; keep it only while its
		// middle is still floor a survivor can get to.
		if inside(int(sx), int(sy), 0) || !reach(sx, sy) {
			continue
		}
		add(SiteHouse, x, y, hw, hh, sx, sy)
	}
	want := [NumSiteKinds]int{SiteCar: 30, SiteCrate: 22}
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
		if k == SiteCar {
			k = wreckKind(rng, tierAt(sx-w.CoreX, sy-w.CoreY))
		}
		add(k, x, y, 1, 1, sx, sy)
	}
	return sites
}

// Ambushes: the hardest places hide more than the guards you can see. An outpost springs one
// when someone first gets into its yard and another when they start on its keep; a lair may
// spring one when its search starts. The ambushers come out of hiding round the survivor and
// go straight for them, and belong to the site afterwards, like its guards.

// ambushOnEntry springs an outpost's first ambush on a survivor inside its walls.
func (w *World) ambushOnEntry(p *Player) {
	for si := range w.Sites {
		s := &w.Sites[si]
		if s.Kind != SiteOutpost || s.Sprung > 0 || s.Searched {
			continue
		}
		if p.X > float32(s.X)+1 && p.Y > float32(s.Y)+1 && p.X < float32(s.X)+float32(s.W)-1 && p.Y < float32(s.Y)+float32(s.H)-1 {
			w.springAmbush(si, p)
		}
	}
}

// ambushOnSearch is a search of site si starting.
func (w *World) ambushOnSearch(si int, p *Player) {
	s := &w.Sites[si]
	switch {
	case s.Kind == SiteOutpost && s.Sprung < 2:
		w.springAmbush(si, p)
	case s.Guard == 3 && s.Sprung == 0 && w.rng.Float32() < .6:
		w.springAmbush(si, p)
	}
}

// springAmbush brings ambushers out of hiding round p.
func (w *World) springAmbush(si int, p *Player) {
	s := &w.Sites[si]
	s.Sprung++
	df := w.diff()
	n := int(float32(4+w.Wave/3+int(s.Guard)) * df.Guard)
	hp := df.Guard * (1 + .15*float32(s.Guard))
	got := 0
	for i := 0; i < n; i++ {
		k := CRunner
		switch r := w.rng.IntN(10); {
		case r < 3:
			k = CWalker
		case r < 5 && w.Wave >= 4:
			k = CSpitter
		case r == 5 && s.Kind == SiteOutpost && w.Wave >= 6:
			k = CBrute
		}
		for try := 0; try < 12; try++ {
			a := w.rng.Float64() * 2 * math.Pi
			d := 5 + w.rng.Float64()*3
			x, y := p.X+float32(math.Cos(a)*d), p.Y+float32(math.Sin(a)*d)
			if ok, _ := w.creepFree(x, y); !ok {
				continue
			}
			if w.SpawnCreep(k, x, y) {
				c := &w.Creeps[len(w.Creeps)-1]
				c.HP *= hp
				c.MaxHP = c.HP
				c.Home, c.HX, c.HY = int16(si+1), x, y
				c.Hunt, c.HuntLeft = int8(p.ID), 10
				got++
			}
			break
		}
	}
	if got == 0 {
		return
	}
	w.Blasts = append(w.Blasts, Blast{p.X, p.Y, 6, 6})
	w.note(2, "ambush! %d creeps burst out on %s at the %s", got, p.Name, SiteDefs[s.Kind].lower())
}
