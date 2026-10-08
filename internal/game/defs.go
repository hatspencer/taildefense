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

// BlocksShots reports whether bullets stop at the tile.
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
	Ranged   bool
	Unlocked string
}

// Creeps is indexed by CreepKind.
var Creeps = [NumCreepKinds]CreepDef{
	CWalker:  {Name: "walker", HP: 40, Speed: 1.7, Damage: 6, Rate: 1, Radius: .45, Reach: .5, Bounty: 3, Cost: 1, Size: 1, MinWave: 1, Aggro: 7},
	CRunner:  {Name: "runner", HP: 24, Speed: 3.6, Damage: 4, Rate: 1.6, Radius: .4, Reach: .5, Bounty: 3, Cost: 1.2, Size: 1, MinWave: 2, Aggro: 10},
	CSwarmer: {Name: "swarmer", HP: 9, Speed: 2.7, Damage: 2, Rate: 2, Radius: .3, Reach: .4, Bounty: 1, Cost: .35, Size: 1, MinWave: 3, Aggro: 6},
	CBrute:   {Name: "brute", HP: 280, Speed: 1.15, Damage: 26, Rate: .7, Radius: .9, Reach: .6, Armor: 4, Bounty: 15, Cost: 6, Size: 2, MinWave: 4, Aggro: 5},
	CSpitter: {Name: "spitter", HP: 55, Speed: 1.5, Damage: 9, Rate: .5, Radius: .45, Reach: 6, Bounty: 6, Cost: 2.5, Size: 1, MinWave: 6, Aggro: 9, Ranged: true},
	CBoss:    {Name: "abomination", HP: 3200, Speed: .95, Damage: 70, Rate: .6, Radius: 1.4, Reach: .8, Armor: 9, Bounty: 300, Cost: 60, Size: 3, MinWave: 10, Aggro: 8},
}

// HPScale is how much tougher creeps are on wave w.
func HPScale(w int) float32 {
	f := float32(w - 1)
	return 1 + .14*f + .009*f*f
}

// WeaponKind identifies a weapon. The pistol is owned from the start.
type WeaponKind uint8

const (
	WPistol WeaponKind = iota
	WShotgun
	WSMG
	WRifle
	WFlamer
	WMinigun
	WLauncher
	NumWeapons
)

// Track is one of a weapon's upgrade paths.
type Track uint8

const (
	TrackDamage Track = iota
	TrackRate
	TrackHandling // magazine and reload
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
	FireCone
	FireRocket
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
}

// Weapons is indexed by WeaponKind.
var Weapons = [NumWeapons]WeaponDef{
	WPistol:   {Name: "Pistol", Short: "PST", Price: 0, Damage: 14, Rate: 3, Range: 14, Mag: 12, Reload: 1.1, Pellets: 1, Spread: .03, Special: "+1 pierce"},
	WShotgun:  {Name: "Shotgun", Short: "SHG", Price: 250, Damage: 9, Rate: 1.3, Range: 9, Mag: 6, Reload: 1.8, Pellets: 7, Spread: .32, Special: "+2 pellets"},
	WSMG:      {Name: "SMG", Short: "SMG", Price: 400, Damage: 8, Rate: 11, Range: 12, Mag: 40, Reload: 1.6, Pellets: 1, Spread: .09, Special: "+1 pierce"},
	WRifle:    {Name: "Rifle", Short: "RFL", Price: 650, Damage: 60, Rate: 1.4, Range: 28, Mag: 5, Reload: 2, Pellets: 1, Spread: .01, Pierce: 3, Special: "+2 pierce"},
	WFlamer:   {Name: "Flamethrower", Short: "FLM", Price: 900, Damage: 6, Rate: 12, Range: 6.5, Mag: 80, Reload: 2.5, Pellets: 1, Spread: .38, Fire: FireCone, Burn: 6, Special: "+range, +burn"},
	WMinigun:  {Name: "Minigun", Short: "MNG", Price: 1400, Damage: 9, Rate: 22, Range: 16, Mag: 150, Reload: 3.5, Pellets: 1, Spread: .12, Special: "+1 pierce, +burn"},
	WLauncher: {Name: "Rocket launcher", Short: "RKT", Price: 2000, Damage: 140, Rate: .8, Range: 24, Mag: 4, Reload: 2.6, Pellets: 1, Spread: .02, Fire: FireRocket, Blast: 3, Special: "+blast radius"},
}

// UpgradeCost is the price of raising a weapon's track from level to level+1.
func UpgradeCost(w WeaponKind, level uint8) int32 {
	base := 60 + float64(Weapons[w].Price)*.25
	return int32(math.Round(base * math.Pow(1.55, float64(level))))
}

// Stats is a weapon's effective numbers after upgrades.
type Stats struct {
	Damage, Rate, Range, Reload, Spread, Burn, Blast float32
	Mag                                              int16
	Pellets, Pierce                                  int
}

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
	}
	sp := int(lv[TrackSpecial])
	switch w {
	case WPistol, WSMG:
		s.Pierce += sp
	case WShotgun:
		s.Pellets += 2 * sp
	case WRifle:
		s.Pierce += 2 * sp
	case WFlamer:
		s.Range *= 1 + .15*float32(sp)
		s.Burn *= 1 + .4*float32(sp)
	case WMinigun:
		s.Pierce += sp / 2
		s.Burn += 2 * float32(sp)
	case WLauncher:
		s.Blast += .6 * float32(sp)
	}
	return s
}

// Gear is a player-wide upgrade bought at the armory.
type Gear uint8

const (
	GearArmor  Gear = iota // max HP
	GearBoots              // move speed
	GearMedkit             // regeneration
	NumGear
)

// GearNames label the gear rows.
var GearNames = [NumGear]string{"Armor", "Boots", "Medkit"}

// GearInfo describes one level of each gear row.
var GearInfo = [NumGear]string{"+25 max HP", "+8% speed", "+1.5 HP/s regen"}

// GearCost is the price of raising gear from level to level+1.
func GearCost(g Gear, level uint8) int32 {
	base := [NumGear]float64{90, 110, 130}[g]
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
	NumStructKinds
)

// StructDef is a building's stats at level 1.
type StructDef struct {
	Name   string
	Price  int32
	HP     float32
	W, H   uint8
	Range  float32
	Damage float32
	Rate   float32 // shots per second
	Blast  float32
	Chains int
	Slow   float32 // seconds of slow per pulse
	Turret bool
	Key    byte // build card hotkey
	Desc   string
}

// Structs is indexed by StructKind.
var Structs = [NumStructKinds]StructDef{
	SCore:         {Name: "Generator", HP: 2500, W: 3, H: 3, Desc: "Powers the base. When it falls, the game is over."},
	SArmory:       {Name: "Armory", HP: 1200, W: 2, H: 2, Desc: "Buy and upgrade weapons, gear and abilities here. Creeps ignore it."},
	SWall:         {Name: "Wall", Price: 20, HP: 320, W: 1, H: 1, Key: 'W', Desc: "Blocks creeps; they path round it or break through."},
	SGate:         {Name: "Gate", Price: 45, HP: 320, W: 1, H: 1, Key: 'G', Desc: "A wall survivors can walk through."},
	STurretGun:    {Name: "Gun turret", Price: 120, HP: 220, W: 1, H: 1, Range: 9, Damage: 11, Rate: 4, Turret: true, Key: 'T', Desc: "Fast single shots; pierces from level 3."},
	STurretCannon: {Name: "Cannon", Price: 240, HP: 280, W: 1, H: 1, Range: 11, Damage: 60, Rate: .7, Blast: 2.2, Turret: true, Key: 'C', Desc: "Slow shells that burst on a crowd."},
	STurretFrost:  {Name: "Frost tower", Price: 180, HP: 220, W: 1, H: 1, Range: 6, Damage: 3, Rate: 1, Slow: 1.6, Turret: true, Key: 'F', Desc: "Pulses cold, slowing everything around it."},
	STurretTesla:  {Name: "Tesla coil", Price: 320, HP: 220, W: 1, H: 1, Range: 8, Damage: 32, Rate: 1.2, Chains: 4, Turret: true, Key: 'L', Desc: "Lightning that jumps from creep to creep."},
}

// Buildable lists what the build menu offers, in menu order.
var Buildable = []StructKind{SWall, SGate, STurretGun, STurretCannon, STurretFrost, STurretTesla}

// MaxStructLevel is the highest turret level.
const MaxStructLevel = 5

// StructUpgradeCost is the price of raising a turret from level to level+1.
func StructUpgradeCost(k StructKind, level uint8) int32 {
	return int32(float32(Structs[k].Price) * .8 * float32(level))
}

// TurretStats applies a level to a turret's base numbers.
func TurretStats(k StructKind, level uint8) (dmg, rng, rate float32) {
	d := Structs[k]
	l := float32(level - 1)
	return d.Damage * (1 + .4*l), d.Range * (1 + .08*l), d.Rate * (1 + .1*l)
}

// RepairCostPerHP is gold per hit point repaired.
const RepairCostPerHP = .1

// BuildRadius is how far from the generator's centre building is allowed.
const BuildRadius = 24

// ShopRadius is how close to the armory a player must stand to buy.
const ShopRadius = 4.5

// Phase is where the session is in its wave cycle.
type Phase uint8

const (
	PhaseBuild Phase = iota // between waves: shop, build, repair
	PhaseWave
	PhaseOver
)

// String names a phase for the HUD.
func (p Phase) String() string {
	switch p {
	case PhaseBuild:
		return "build"
	case PhaseWave:
		return "wave"
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
		return fmt.Sprintf("%d rounds, %.1fs reload", st.Mag, st.Reload)
	}
	switch w {
	case WShotgun:
		return fmt.Sprintf("%d pellets", st.Pellets)
	case WFlamer:
		return fmt.Sprintf("%.1f range, %.0f burn/s", st.Range, st.Burn)
	case WMinigun:
		return fmt.Sprintf("%d pierce, %.0f burn/s", st.Pierce, st.Burn)
	case WLauncher:
		return fmt.Sprintf("%.1f blast", st.Blast)
	}
	return fmt.Sprintf("%d pierce", st.Pierce)
}
