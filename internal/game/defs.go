// Package game is the authoritative simulation: the map, the base, creeps, players, their
// weapons and turrets, waves and money. It runs only on the host. Nothing here knows about
// the network or the terminal; netplay encodes its state and play draws it.
//
// The hot loop is written for thousands of creeps: creeps live in one dense slice, a spatial
// hash is rebuilt each tick with a counting sort, the path to the core is one flow field shared
// by every creep, and no step allocates.
package game

import (
	"fmt"
	"math"
)

// TickRate is how many simulation steps run per second. Snapshots go out at the same rate.
const TickRate = 20

// Dt is one tick in seconds.
const Dt = float32(1) / TickRate

// MaxCreeps bounds the creep id space; ids are uint16 on the wire.
const MaxCreeps = 16384

// MaxPlayers bounds a session.
const MaxPlayers = 8

// Tile is one cell of terrain.
type Tile uint8

const (
	TGrass Tile = iota
	TDirt       // roads, which creeps tend to arrive along
	TFloor      // concrete inside the base
	TSand
	TWater // solid from here on: nothing walks or builds here
	TTree
	TRock // buildings and boulders; also stops bullets
)

// Solid reports whether nothing can stand on the tile.
func (t Tile) Solid() bool { return t >= TWater }

// BlocksShots reports whether bullets can stop at the tile; World.blocksShot lets them over
// a lone rock.
func (t Tile) BlocksShots() bool { return t == TTree || t == TRock }

// CreepKind identifies a creep type.
type CreepKind uint8

const (
	CWalker CreepKind = iota
	CRunner
	CSwarmer
	CBrute
	CSpitter
	CBoss
	CHurler  // throws bone from far off; a hit slows
	CMother  // the broodmother: the other boss, lobs bile and spills swarmers
	CHound   // a dead dog: in packs, faster than a survivor, leaps to bite
	CMauler  // a brute that charges, slams to stun and throws whoever it catches
	CGoliath // the third boss: charges, slams to stun longest and throws whoever it catches furthest
	NumCreepKinds
)

// CreepDef is a creep type's base stats, before the wave's scaling.
type CreepDef struct {
	Name     string
	HP       float32
	Speed    float32 // tiles per second
	Damage   float32 // per hit
	Rate     float32 // hits per second
	Radius   float32
	Reach    float32 // attack distance beyond the radius; spitters attack from range
	Armor    float32 // flat damage reduction per hit
	Bounty   int32
	Cost     float32 // wave budget units
	Size     uint8   // drawn as Size x Size pixels
	MinWave  int
	Aggro    float32 // distance at which a player is chased instead of the core
	Windup   float32 // seconds a blow is telegraphed before it lands
	Ranged   bool
	Sprint   float32 // chance one of this kind is a sprinter, faster than a survivor in a chase
	Unlocked string
}

// Creeps is indexed by CreepKind.
var Creeps = [NumCreepKinds]CreepDef{
	CWalker:  {Name: "walker", HP: 40, Speed: 1.7, Damage: 7.5, Rate: 1, Radius: .45, Reach: .5, Bounty: 3, Cost: 1, Size: 1, MinWave: 1, Aggro: 7, Windup: .4, Sprint: .12},
	CRunner:  {Name: "runner", HP: 24, Speed: 3.6, Damage: 5, Rate: 1.6, Radius: .4, Reach: .5, Bounty: 3, Cost: 1.2, Size: 1, MinWave: 2, Aggro: 10, Windup: .28, Sprint: .35},
	CSwarmer: {Name: "swarmer", HP: 9, Speed: 2.7, Damage: 2.5, Rate: 2, Radius: .3, Reach: .4, Bounty: 1, Cost: .35, Size: 1, MinWave: 3, Aggro: 6, Windup: .18, Sprint: .2},
	CBrute:   {Name: "brute", HP: 280, Speed: 1.5, Damage: 32.5, Rate: .7, Radius: .9, Reach: .6, Armor: 4, Bounty: 15, Cost: 6, Size: 2, MinWave: 4, Aggro: 5, Windup: .65},
	CSpitter: {Name: "spitter", HP: 55, Speed: 1.5, Damage: 11.2, Rate: .5, Radius: .45, Reach: 6, Bounty: 6, Cost: 2.5, Size: 1, MinWave: 6, Aggro: 9, Windup: .5, Ranged: true},
	CBoss:    {Name: "abomination", HP: 3200, Speed: .95, Damage: 87.5, Rate: .6, Radius: 1.4, Reach: .8, Armor: 9, Bounty: 300, Cost: 60, Size: 3, MinWave: 10, Aggro: 8, Windup: .7},
	CHurler:  {Name: "hurler", HP: 45, Speed: 1.4, Damage: 9, Rate: .4, Radius: .45, Reach: 13, Bounty: 8, Cost: 3, Size: 1, MinWave: 8, Aggro: 15, Windup: .8, Ranged: true},
	CMother:  {Name: "broodmother", HP: 2600, Speed: 1.05, Damage: 60, Rate: .7, Radius: 1.3, Reach: .8, Armor: 6, Bounty: 300, Cost: 60, Size: 3, MinWave: 10, Aggro: 12, Windup: .6},
	CHound:   {Name: "hound", HP: 20, Speed: 5, Damage: 4.5, Rate: 2, Radius: .38, Reach: 1.1, Bounty: 2, Cost: .8, Size: 1, MinWave: 5, Aggro: 13, Windup: .22, Sprint: .5},
	CMauler:  {Name: "mauler", HP: 420, Speed: 2.6, Damage: 38, Rate: .8, Radius: 1, Reach: .7, Armor: 5, Bounty: 30, Cost: 10, Size: 2, MinWave: 12, Aggro: 7, Windup: .5, Sprint: 1},
	CGoliath: {Name: "goliath", HP: 3600, Speed: 1.7, Damage: 95, Rate: .7, Radius: 1.5, Reach: .9, Armor: 9, Bounty: 300, Cost: 60, Size: 3, MinWave: 10, Aggro: 10, Windup: .6, Sprint: 1},
}

// HPScale is how much tougher creeps are on wave w.
func HPScale(w int) float32 {
	f := float32(w - 1)
	return 1 + .14*f + .009*f*f
}

// WeaponKind identifies a weapon. The pistol is owned from the start, or the crowbar on brutal.
type WeaponKind uint8

const (
	WPistol WeaponKind = iota
	WShotgun
	WSMG
	WRifle
	WMinigun
	WLauncher
	WCrowbar // brutal's starting weapon, and only there: never sold or found
	WKatana  // legendary (legend.go): found at the remote sites, never sold; a second one is a pair
	WGreat   // legendary: the greatsword, found the same way
	NumWeapons
)

// Track is one of a weapon's upgrade paths.
type Track uint8

const (
	TrackDamage Track = iota
	TrackRate
	TrackHandling // magazine and reload; a blade's reach
	TrackSpecial  // per weapon: pierce, pellets, burn, blast radius
	NumTracks
)

// MaxLevel is the highest upgrade level of every track.
const MaxLevel = 5

// TrackNames are short labels for the HUD and armory.
var TrackNames = [NumTracks]string{"damage", "fire rate", "handling", "special"}

// Fire is how a weapon resolves a shot.
type Fire uint8

const (
	FireHitscan Fire = iota
	FireRocket
	FireMelee // a swing at whatever is in front, in arm's reach; no ammo
)

// WeaponDef is a weapon's base stats.
type WeaponDef struct {
	Name    string
	Short   string
	Price   int32
	Damage  float32
	Rate    float32 // shots per second
	Range   float32
	Mag     int16
	Reload  float32
	Pellets int
	Spread  float32 // radians either side
	Pierce  int     // extra creeps a bullet passes through
	Fire    Fire
	Blast   float32 // rocket blast radius
	Burn    float32 // burn damage per second applied on hit
	Special string  // what the special track does
	Legend  bool    // a legendary blade (legend.go): only ever found, with a weapon art on F and two evolutions
	Hits    int     // melee: creeps one swing goes through, meleeHits when 0
}

// Weapons is indexed by WeaponKind.
var Weapons = [NumWeapons]WeaponDef{
	WPistol:   {Name: "Pistol", Short: "PST", Price: 0, Damage: 15, Rate: 3, Range: 14, Mag: 12, Reload: 1.1, Pellets: 1, Spread: .03, Special: "+1 pierce"},
	WShotgun:  {Name: "Shotgun", Short: "SHG", Price: 250, Damage: 13, Rate: 1.3, Range: 10, Mag: 6, Reload: 1.8, Pellets: 7, Spread: .3, Pierce: 1, Special: "+2 pellets, +knockback"},
	WSMG:      {Name: "SMG", Short: "SMG", Price: 400, Damage: 11, Rate: 12, Range: 12, Mag: 50, Reload: 1.6, Pellets: 1, Spread: .09, Special: "+1 pierce"},
	WRifle:    {Name: "Rifle", Short: "RFL", Price: 650, Damage: 80, Rate: 1.5, Range: 28, Mag: 5, Reload: 2, Pellets: 1, Spread: .01, Pierce: 3, Special: "+2 pierce"},
	WMinigun:  {Name: "Minigun", Short: "MNG", Price: 1400, Damage: 9, Rate: 22, Range: 16, Mag: 150, Reload: 3.5, Pellets: 1, Spread: .12, Special: "+1 pierce, +burn"},
	WLauncher: {Name: "Rocket launcher", Short: "RKT", Price: 2000, Damage: 120, Rate: .8, Range: 24, Mag: 4, Reload: 2.6, Pellets: 1, Spread: .02, Fire: FireRocket, Blast: 3, Special: "+blast radius"},
	WCrowbar:  {Name: "Crowbar", Short: "BAR", Price: 0, Damage: 42, Rate: 2, Range: 1.9, Mag: 1, Reload: 0, Pellets: 1, Spread: .8, Fire: FireMelee, Special: "+wider swing"},
	// The legendaries carry a price only to scale their upgrades; nobody sells them.
	WKatana: {Name: "Katana", Short: "KTN", Price: 1800, Damage: 34, Rate: 2.6, Range: 2.2, Mag: 1, Pellets: 1, Spread: .75, Fire: FireMelee, Legend: true, Hits: 5, Special: "+bleed"},
	WGreat:  {Name: "Greatsword", Short: "GSW", Price: 1800, Damage: 100, Rate: .85, Range: 2.8, Mag: 1, Pellets: 1, Spread: 1.15, Fire: FireMelee, Legend: true, Hits: 8, Special: "+wider, +stagger"},
}

// Legendary reports whether k is one of the legendary blades.
func (k WeaponKind) Legendary() bool { return k < NumWeapons && Weapons[k].Legend }

// Evolves reports whether k has a weapon art on F and two evolutions (legend.go): the
// legendaries and the crowbar.
func (k WeaponKind) Evolves() bool { return k < NumWeapons && LegendEvos[k][0].Name != "" }

// Sold reports whether the armory sells k: never the crowbar or a legendary.
func (k WeaponKind) Sold() bool { return k < NumWeapons && k != WCrowbar && !Weapons[k].Legend }

// DualBit marks, in a frame's word of owned weapons, a survivor with a second pistol,
// DualKatanaBit one with a second katana, and PickBit one of a blades game yet to pick a blade.
const (
	DualBit       = 1 << 15
	DualKatanaBit = 1 << 14
	PickBit       = 1 << 13
)

// Dual is the stats of a pair of pistols: each as the survivor upgraded it, both firing, so
// twice the rounds a second and twice the magazine.
func (s Stats) Dual() Stats {
	s.Rate *= 2
	s.Mag *= 2
	return s
}

// Stats is the numbers of weapon k as ws holds it: its upgrades, and a second pistol.
func (ws *WeaponState) Stats(k WeaponKind) Stats {
	s := WeaponStats(k, ws.Lv)
	if ws.Dual && k == WPistol {
		s = s.Dual()
	}
	if ws.Dual && k == WKatana {
		s.Rate *= dualKatana
	}
	return s
}

// UpgradeCost is the price of raising a weapon's track from level to level+1.
func UpgradeCost(w WeaponKind, level uint8) int32 {
	base := 60 + float64(Weapons[w].Price)*.25
	return int32(math.Round(base * math.Pow(1.55, float64(level))))
}

// Stats is a weapon's effective numbers after upgrades.
type Stats struct {
	Damage, Rate, Range, Reload, Spread, Burn, Blast float32
	Stun                                             float32 // times a hit's stun
	Shove                                            float32 // how far each pellet pushes, before the creep's size
	Bleed                                            float32 // a katana: the blood loss each cut builds (legend.go)
	Mag                                              int16
	Pellets, Pierce                                  int
	Hits                                             int // melee: creeps one swing goes through
}

// pistolDamageLevel is what each level of the pistol's damage track adds to it, more than the
// others' .22: the free gun is the one a survivor upgrades first and longest, and a pair of
// them fully bought keeps up late.
const pistolDamageLevel = .3

// meleeReachLevel is the share of a blade's base reach each level of handling adds.
const meleeReachLevel = .08

// WeaponStats applies upgrade levels to a weapon's base stats.
func WeaponStats(w WeaponKind, lv [NumTracks]uint8) Stats {
	d := Weapons[w]
	s := Stats{
		Damage:  d.Damage * (1 + .22*float32(lv[TrackDamage])),
		Rate:    d.Rate * (1 + .13*float32(lv[TrackRate])),
		Range:   d.Range,
		Reload:  d.Reload * (1 - .11*float32(lv[TrackHandling])),
		Mag:     int16(float32(d.Mag) * (1 + .25*float32(lv[TrackHandling]))),
		Spread:  d.Spread,
		Pellets: d.Pellets,
		Pierce:  d.Pierce,
		Burn:    d.Burn,
		Blast:   d.Blast,
		Stun:    1,
		Hits:    d.Hits,
	}
	if s.Hits == 0 {
		s.Hits = meleeHits
	}
	// A blade has no magazine to handle: its handling is reach, the swing a little longer a level.
	if d.Fire == FireMelee {
		s.Range = d.Range * (1 + meleeReachLevel*float32(lv[TrackHandling]))
		s.Mag, s.Reload = d.Mag, 0
	}
	sp := int(lv[TrackSpecial])
	switch w {
	case WPistol:
		s.Damage = d.Damage * (1 + pistolDamageLevel*float32(lv[TrackDamage]))
		s.Pierce += sp
	case WSMG:
		s.Pierce += sp
	case WShotgun:
		s.Pellets += 2 * sp
		s.Stun = slugMul + slugMulLevel*float32(sp)
		s.Shove = shotShove + shotShoveLevel*float32(sp)
	case WRifle:
		s.Pierce += 2 * sp
	case WMinigun:
		s.Pierce += sp
		s.Burn += 2 * float32(sp)
	case WLauncher:
		s.Blast += .6 * float32(sp)
	case WCrowbar:
		s.Spread += .15 * float32(sp)
	case WKatana:
		s.Bleed = katanaBleed + katanaBleedLevel*float32(sp)
	case WGreat:
		s.Spread += .1 * float32(sp)
		s.Stun = greatStagger + greatStaggerLevel*float32(sp)
		s.Shove = greatShove
	}
	return s
}

// Gear is a player-wide upgrade bought at the armory.
type Gear uint8

const (
	GearArmor     Gear = iota // max HP
	GearBoots                 // move speed
	GearVitamins              // regeneration
	GearScavenger             // luck when searching loot sites
	NumGear
)

// GearNames label the gear rows.
var GearNames = [NumGear]string{"Armor", "Boots", "Vitamins", "Scavenger"}

// GearInfo describes one level of each gear row.
var GearInfo = [NumGear]string{"+25 max HP", "+8% speed", "+1.5 HP/s regen", "+luck when searching"}

// GearCost is the price of raising gear from level to level+1.
func GearCost(g Gear, level uint8) int32 {
	base := [NumGear]float64{90, 110, 130, 100}[g]
	return int32(math.Round(base * math.Pow(1.7, float64(level))))
}

// StructKind is a building in the base.
type StructKind uint8

const (
	SNone StructKind = iota
	SCore
	SArmory
	SWall
	SGate // players walk through, creeps break it down
	STurretGun
	STurretCannon
	STurretFrost
	STurretTesla
	STurretSniper
	STurretMissile
	STrapSpikes // traps: laid flat, walked over by creeps and survivors alike (traps.go)
	STrapTar
	STrapVent
	STrapMine
	SPylon // the amplifier pylon: turrets in reach fire faster (evolve.go)
	NumStructKinds
)

// StructDef is a building's stats at level 1.
type StructDef struct {
	Name    string
	Price   int32
	HP      float32
	W, H    uint8
	Range   float32
	Damage  float32
	Rate    float32 // shots per second
	Blast   float32
	Chains  int     // jumps past the first creep before any upgrade
	Slow    float32 // seconds of slow per pulse
	Pierce  int     // extra creeps a shot passes through
	Salvo   int     // missiles a battery fires at once
	Turret  bool
	Floor   bool  // a trap, laid flat on the ground: it stops nobody
	Tier    uint8 // the generator's tier it needs, past the first
	Key     byte  // build card hotkey
	Desc    string
	Special string // what the special track does
}

// Structs is indexed by StructKind.
var Structs = [NumStructKinds]StructDef{
	SCore:          {Name: "Generator", HP: 3200, W: 5, H: 5, Desc: "Powers the base. When it falls, the game is over."},
	SArmory:        {Name: "Armory", HP: 1200, W: 3, H: 3, Desc: "Buy and upgrade weapons, gear and abilities here. Creeps ignore it."},
	SWall:          {Name: "Wall", Price: 20, HP: 320, W: 1, H: 1, Key: '1', Desc: "Blocks creeps: they walk round a maze of them however long, and break in only where the base is sealed."},
	SGate:          {Name: "Gate", Price: 45, HP: 320, W: 1, H: 1, Key: '2', Desc: "Survivors walk through it. Shut, it is a wall to the dead; open (E), they walk through rather than break in."},
	STurretGun:     {Name: "Gun turret", Price: 120, HP: 220, W: 1, H: 1, Range: 9, Damage: 11, Rate: 4, Turret: true, Key: '3', Desc: "Fast single shots at the nearest creep.", Special: "+1 pierce"},
	STurretCannon:  {Name: "Cannon", Price: 240, HP: 280, W: 1, H: 1, Range: 11, Damage: 60, Rate: .6, Blast: 2.2, Turret: true, Key: '4', Desc: "Slow, heavy shells that burst on a crowd.", Special: "+blast radius"},
	STurretFrost:   {Name: "Frost tower", Price: 180, HP: 220, W: 1, H: 1, Range: 6, Damage: 3, Rate: 1, Slow: 1.6, Turret: true, Key: '5', Desc: "Pulses cold, slowing everything around it.", Special: "+deeper slow"},
	STurretTesla:   {Name: "Tesla coil", Price: 280, HP: 220, W: 1, H: 1, Range: 8, Damage: 36, Rate: 1.2, Chains: 2, Turret: true, Key: '6', Desc: "Lightning that jumps from creep to creep.", Special: "+2 jumps, further"},
	STurretSniper:  {Name: "Sniper tower", Price: 380, HP: 200, W: 1, H: 1, Range: 22, Damage: 150, Rate: .35, Pierce: 1, Turret: true, Key: '7', Desc: "A slow, heavy round from far off at the toughest creep it can see, tearing out a share of its health: the boss killer.", Special: "+1 pierce"},
	STurretMissile: {Name: "Missile battery", Price: 420, HP: 260, W: 1, H: 1, Range: 14, Damage: 45, Rate: .5, Blast: 2, Salvo: 3, Turret: true, Key: '8', Desc: "A salvo of rockets with a wide blast, each at a different creep, coming down only near it.", Special: "+1 missile"},
	STrapSpikes:    {Name: "Spike strip", Price: 60, HP: 300, W: 1, H: 1, Damage: 22, Floor: true, Key: '9', Desc: "Cuts every creep that walks over it, wearing down as it does. Lay it in a maze's lanes."},
	STrapTar:       {Name: "Tar pit", Price: 50, HP: 300, W: 1, H: 1, Slow: .6, Floor: true, Key: '0', Desc: "Slows every creep that wades through it, so they spend longer under the guns."},
	STrapVent:      {Name: "Flame vent", Price: 150, HP: 300, W: 1, H: 1, Range: 1.7, Damage: 40, Rate: .35, Floor: true, Key: '-', Desc: "Bursts into flame when a creep steps on it, setting everything round it alight."},
	STrapMine:      {Name: "Mine", Price: 40, HP: 100, W: 1, H: 1, Range: 3, Damage: 260, Floor: true, Key: '=', Desc: "Blows up under the first creep to step on it, harder every wave. Rebuild all (H) lays it again."},
	SPylon:         {Name: "Pylon", Price: 200, HP: 260, W: 1, H: 1, Range: 3, Tier: PylonTier, Key: '[', Desc: "An amplifier: every turret within 3 tiles fires 15% faster; two in reach of one turret don't add up. Needs the generator at tier II."},
}

// Buildable lists what the build menu offers, in menu order.
var Buildable = []StructKind{SWall, SGate, STurretGun, STurretCannon, STurretFrost, STurretTesla, STurretSniper, STurretMissile, STrapSpikes, STrapTar, STrapVent, STrapMine, SPylon}

// MaxStructLevel is the highest level a wall or a gate goes to. A turret has a level per
// track instead, each up to MaxLevel, as a weapon does.
const MaxStructLevel = 5

// TrackRange is a turret's third track, where a weapon has handling.
const TrackRange = TrackHandling

// TurretTrackNames label a turret's tracks.
var TurretTrackNames = [NumTracks]string{"damage", "fire rate", "range", "special"}

// Upgradable reports whether a structure of kind k can be raised a level: the turrets, walls
// and gates, which only get tougher, and the spike strip and the flame vent, which get
// tougher and hit harder.
func Upgradable(k StructKind) bool {
	return Structs[k].Turret || k == SWall || k == SGate || k == STrapSpikes || k == STrapVent
}

// StructGrowth is the share of its base HP a structure gains with each level, or for a
// turret with each upgrade on any track.
func StructGrowth(k StructKind) float32 {
	if Structs[k].Turret {
		return .06
	}
	return .6
}

// StructUpgradeCost is the price of raising a wall, a gate or a trap from level to level+1.
func StructUpgradeCost(k StructKind, level uint8) int32 {
	return int32(float32(Structs[k].Price) * .8 * float32(level))
}

// TurretUpgradeCost is the price of raising a turret's track from level to level+1.
func TurretUpgradeCost(k StructKind, level uint8) int32 {
	return int32(math.Round(float64(Structs[k].Price) * .3 * math.Pow(1.5, float64(level))))
}

// TurretStat is a turret's effective numbers after upgrades.
type TurretStat struct {
	Damage, Range, Rate float32
	Blast, Slow, Hop    float32
	Pierce, Chains      int
	Salvo               int
	Chill               float32 // a frost tower: the share of its pace a slowed creep loses
	Share               float32 // a sniper: the share of its mark's full health a round adds
	Scatter             float32 // a missile battery: how far off its mark a missile may land
}

// Turrets' numbers past StructDef's.
const (
	frostChill     = .45 // the share of its pace a frost tower's cold takes at level 0
	frostChillStep = .06 // and what each level of its special adds
	maxChill       = .85
	sniperShare    = .016 // of its mark's full health a sniper round adds, at level 0
	missileScatter = 1.6  // tiles round its mark a missile may come down
)

// TurretStats applies a turret's track levels to its base numbers.
func TurretStats(k StructKind, lv [NumTracks]uint8) TurretStat {
	d := Structs[k]
	sp := lv[TrackSpecial]
	s := TurretStat{
		Damage: d.Damage * (1 + .3*float32(lv[TrackDamage])),
		Rate:   d.Rate * (1 + .15*float32(lv[TrackRate])),
		Range:  d.Range * (1 + .08*float32(lv[TrackRange])),
		Blast:  d.Blast, Slow: d.Slow, Hop: 3.5,
		Pierce: d.Pierce, Chains: d.Chains, Salvo: d.Salvo,
	}
	switch k {
	case STurretSniper:
		s.Share = sniperShare * (1 + .3*float32(lv[TrackDamage]))
		fallthrough
	case STurretGun:
		s.Pierce += int(sp)
	case STurretCannon:
		s.Blast += .3 * float32(sp)
	case STurretFrost:
		s.Chill = frostChill + frostChillStep*float32(sp)
	case STurretTesla:
		s.Chains += 2 * int(sp)
		s.Hop += .5 * float32(sp)
	case STurretMissile:
		s.Salvo += int(sp)
		s.Scatter = missileScatter
	}
	return s
}

// TurretTrackValue is what a turret's track gives at a level, for its card: "15 dmg", "4.6/s".
func TurretTrackValue(k StructKind, t Track, level uint8) string {
	var lv [NumTracks]uint8
	lv[t] = level
	st := TurretStats(k, lv)
	switch t {
	case TrackDamage:
		return fmt.Sprintf("%.0f dmg", st.Damage)
	case TrackRate:
		if st.Rate < 1 {
			return fmt.Sprintf("every %.1fs", 1/st.Rate)
		}
		return fmt.Sprintf("%.1f/s", st.Rate)
	case TrackRange:
		return fmt.Sprintf("%.1f range", st.Range)
	}
	switch k {
	case STurretCannon:
		return fmt.Sprintf("%.1f blast", st.Blast)
	case STurretFrost:
		return fmt.Sprintf("%.0f%% slow", st.Chill*100)
	case STurretTesla:
		return fmt.Sprintf("%d creeps, %.1f jump", st.Chains+1, st.Hop)
	case STurretMissile:
		return fmt.Sprintf("%d missiles", st.Salvo)
	}
	return fmt.Sprintf("%d pierce", st.Pierce)
}

// RepairCostPerHP is gold per hit point repaired, at most.
const RepairCostPerHP = .1

// RepairShare caps a repair from nothing at this share of what went into the structure, so
// mending is always cheaper than selling and building again: a wall's hit points are cheap
// to buy new, and at the flat rate a badly hurt one was better sold and put back.
const RepairShare = .5

// RepairRate is the gold per hit point repairing s costs. The generator and the armory,
// never bought, pay the flat rate.
func RepairRate(s *Structure) float32 {
	spent := Spent(s)
	if spent == 0 {
		return RepairCostPerHP
	}
	return min(RepairCostPerHP, RepairShare*float32(spent)/s.MaxHP)
}

// BuildRadius is how far from the generator's centre building is allowed.
const BuildRadius = 40

// ShopRadius is how close to the armory a player must stand to buy.
const ShopRadius = 5

// Phase is where the session is in its wave cycle.
type Phase uint8

const (
	PhaseBuild Phase = iota // between waves: shop, build, repair
	PhaseWave
	PhaseOver
	PhaseEvac // the last wave is cleared: the evac Huey is coming, landed or leaving (evac.go)
)

// String names a phase for the HUD.
func (p Phase) String() string {
	switch p {
	case PhaseBuild:
		return "build"
	case PhaseWave:
		return "wave"
	case PhaseEvac:
		return "evac"
	}
	return "over"
}

// TrackValue is what a weapon's track gives at a level, for the armory: "17 dmg", "3.4/s".
func TrackValue(w WeaponKind, t Track, level uint8) string {
	var lv [NumTracks]uint8
	lv[t] = level
	st := WeaponStats(w, lv)
	switch t {
	case TrackDamage:
		return fmt.Sprintf("%.0f dmg", st.Damage)
	case TrackRate:
		return fmt.Sprintf("%.1f/s", st.Rate)
	case TrackHandling:
		if Weapons[w].Fire == FireMelee {
			return fmt.Sprintf("%.1f m reach", st.Range)
		}
		return fmt.Sprintf("%d rounds, %.1fs reload", st.Mag, st.Reload)
	}
	switch w {
	case WShotgun:
		return fmt.Sprintf("%d pellets, %d pierce", st.Pellets, st.Pierce)
	case WMinigun:
		return fmt.Sprintf("%d pierce, %.0f burn/s", st.Pierce, st.Burn)
	case WLauncher:
		return fmt.Sprintf("%.1f blast", st.Blast)
	case WCrowbar:
		return fmt.Sprintf("%.0f° swing", st.Spread*2*180/math.Pi)
	case WKatana:
		return fmt.Sprintf("%.0f bleed a cut", st.Bleed)
	case WGreat:
		return fmt.Sprintf("%.0f° swing, %.1f× stagger", st.Spread*2*180/math.Pi, st.Stun)
	}
	return fmt.Sprintf("%d pierce", st.Pierce)
}
