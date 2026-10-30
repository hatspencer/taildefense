package web

import (
	"strconv"

	"taildefense/internal/game"
	"taildefense/internal/netplay"
)

// The welcome carries the game's tables, so the client shows the host's own numbers and
// prices instead of a copy that drifts. See web/PROTOCOL.md.

type creepDef struct {
	Name   string  `json:"name"`
	HP     float32 `json:"hp"`
	Speed  float32 `json:"speed"`
	Radius float32 `json:"radius"`
	Size   uint8   `json:"size"`
	Ranged bool    `json:"ranged"`
	Bounty int32   `json:"bounty"`
	Rate   float32 `json:"rate"`
	Windup float32 `json:"windup"`
}

type ultDef struct {
	Name   string  `json:"name"`
	Desc   string  `json:"desc"`
	Time   float32 `json:"time"`
	Range  float32 `json:"range"`
	Radius float32 `json:"radius"`
	Target string  `json:"target"`
}

type weaponDef struct {
	Name    string     `json:"name"`
	Short   string     `json:"short"`
	Price   int32      `json:"price"`
	Range   float32    `json:"range"`
	Fire    string     `json:"fire"`
	Special string     `json:"special"`
	Costs   [][]int32  `json:"costs"`
	Values  [][]string `json:"values"`
	Ult     ultDef     `json:"ult"`
	Legend  bool       `json:"legend,omitempty"` // a legendary blade: found, never sold
	Art     *artDef    `json:"art,omitempty"`    // a legendary's weapon art, on F
	Evolve  []evoDef   `json:"evolve,omitempty"` // a legendary's two evolutions
	EvoCost int32      `json:"evoCost,omitempty"`
}

// artDef is a legendary's weapon art.
type artDef struct {
	Name  string  `json:"name"`
	Desc  string  `json:"desc"`
	Range float32 `json:"range"`
	Cool  float32 `json:"cool"`
}

type gearDef struct {
	Name  string  `json:"name"`
	Info  string  `json:"info"`
	Costs []int32 `json:"costs"`
}

type abilityDef struct {
	Name   string    `json:"name"`
	Key    string    `json:"key"`
	Desc   string    `json:"desc"`
	Target string    `json:"target"`
	Range  float32   `json:"range"`
	Radius []float32 `json:"radius"`
	Cool   []float32 `json:"cool"`
	Costs  []int32   `json:"costs"`
	Always bool      `json:"always"`
}

type structDef struct {
	Name       string     `json:"name"`
	Price      int32      `json:"price"`
	HP         float32    `json:"hp"`
	W          uint8      `json:"w"`
	H          uint8      `json:"h"`
	Range      float32    `json:"range"`
	Ranges     []float32  `json:"ranges,omitempty"` // a turret's reach at each range track level
	Turret     bool       `json:"turret"`
	Floor      bool       `json:"floor,omitempty"` // a trap: laid flat, it stops nobody
	Key        string     `json:"key"`
	Desc       string     `json:"desc"`
	Upgrade    []int32    `json:"upgrade"`
	Upgradable bool       `json:"upgradable"`
	Special    string     `json:"special,omitempty"`
	Values     [][]string `json:"values,omitempty"` // a turret's [track][level] what the track gives
	Tier       uint8      `json:"tier,omitempty"`   // the generator's tier it needs, past the first
	Evolve     []evoDef   `json:"evolve,omitempty"` // a turret's two evolutions
}

// evoDef is one branch a turret evolves into; Range multiplies its reach (1 for none).
type evoDef struct {
	Name  string  `json:"name"`
	Desc  string  `json:"desc"`
	Range float32 `json:"range"`
}

// tiersDef is the generator's tiers: the gold a pay-in puts in, the top tier, what each
// unlock needs, and the Overload's reach.
type tiersDef struct {
	Step          int32   `json:"step"`
	Max           uint8   `json:"max"`
	Pylon         uint8   `json:"pylon"`
	Evolve        uint8   `json:"evolve"`
	EvolveAt      int     `json:"evolveAt"`
	Overload      uint8   `json:"overload"`
	OverloadReach float32 `json:"overloadReach"`
}

type siteKindDef struct {
	Name   string  `json:"name"`
	Search float32 `json:"search"`
}

type siteDef struct {
	Kind  uint8   `json:"kind"`
	X     int16   `json:"x"`
	Y     int16   `json:"y"`
	W     uint8   `json:"w"`
	H     uint8   `json:"h"`
	SX    float32 `json:"sx"`
	SY    float32 `json:"sy"`
	Tier  uint8   `json:"tier"`
	Guard uint8   `json:"guard"`
	Yaw   float32 `json:"yaw"`  // a wreck's heading, radians from +x towards +y
	Ruin  uint8   `json:"ruin"` // a house's shape (game.RuinKind)
}

type difficultyRef struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type weatherDef struct {
	Name string `json:"name"`
	Info string `json:"info"`
}

type tauntDef struct {
	Cool   float32 `json:"cool"`
	Radius float32 `json:"radius"`
	Time   float32 `json:"time"`
}

type reviveDef struct {
	Reach float32 `json:"reach"`
	Time  float32 `json:"time"`
	HP    float32 `json:"hp"`
}

type medkitDef struct {
	Heal float32 `json:"heal"`
	Time float32 `json:"time"`
	Max  uint8   `json:"max"`
	Cost int32   `json:"cost"`
}

type point struct {
	X float32 `json:"x"`
	Y float32 `json:"y"`
}

// evacDef is the helipad and the evac Huey's timing, in seconds.
type evacDef struct {
	Pad     point   `json:"pad"`
	Half    float32 `json:"half"`
	Reach   float32 `json:"reach"`
	Board   float32 `json:"board"`
	Inbound float32 `json:"inbound"`
	Flight  float32 `json:"flight"`
	Settle  float32 `json:"settle"`
	Wait    float32 `json:"wait"`
	Last    float32 `json:"last"`
	Depart  float32 `json:"depart"`
	Climb   float32 `json:"climb"`
}

type welcomeMsg struct {
	T               string        `json:"t"`
	Proto           int           `json:"proto"`
	Version         string        `json:"version"`
	You             uint8         `json:"you"`
	W               int           `json:"w"`
	H               int           `json:"h"`
	Seed            string        `json:"seed"`
	Host            string        `json:"host"`
	Hosting         bool          `json:"hosting"`
	Hint            string        `json:"hint"`
	TickRate        int           `json:"tickRate"`
	Core            point         `json:"core"`
	BuildRadius     float32       `json:"buildRadius"`
	ShopRadius      float32       `json:"shopRadius"`
	MaxLevel        int           `json:"maxLevel"`
	MaxStructLevel  int           `json:"maxStructLevel"`
	RepairCostPerHP float32       `json:"repairCostPerHP"`
	SellFraction    float32       `json:"sellFraction"`
	RepairShare     float32       `json:"repairShare"`
	Tracks          []string      `json:"tracks"`
	TurretTracks    []string      `json:"turretTracks"`
	Creeps          []creepDef    `json:"creeps"`
	Weapons         []weaponDef   `json:"weapons"`
	Gear            []gearDef     `json:"gear"`
	Abilities       []abilityDef  `json:"abilities"`
	Structs         []structDef   `json:"structs"`
	Buildable       []int         `json:"buildable"`
	SiteKinds       []siteKindDef `json:"siteKinds"`
	Sites           []siteDef     `json:"sites"`
	Difficulty      difficultyRef `json:"difficulty"`
	FogOfWar        bool          `json:"fogOfWar"`
	Mode            string        `json:"mode"`           // standard, or blades: no guns
	StartBlades     []int         `json:"startBlades"`    // in a blades game, the weapons a survivor picks from
	LastWave        int           `json:"lastWave"`       // the wave whose end calls the evac; 0 endless
	Evac            *evacDef      `json:"evac,omitempty"` // absent in an endless game
	Dark            float32       `json:"dark,omitempty"` // survivors' sight at night; 0 for none
	Cone            float32       `json:"cone,omitempty"` // brutal: the flashlight's reach; 0 for none
	Seen            []byte        `json:"seen,omitempty"` // at night, the ground found so far: a bit per tile, low bit first
	Difficulties    []string      `json:"difficulties"`
	Weathers        []weatherDef  `json:"weathers"`
	Taunt           tauntDef      `json:"taunt"`
	Revive          reviveDef     `json:"revive"`
	Medkit          medkitDef     `json:"medkit"`
	Goggles         int32         `json:"goggles"`  // night vision goggles' price
	Volume          int           `json:"volume"`   // this machine's VOLUME setting, 0 (off) to 100
	Music           int           `json:"music"`    // this machine's MUSIC setting, 0 (off) to 100 of the volume
	Patience        []float32     `json:"patience"` // per difficulty: how far past the straight way in a creep walks a maze before it frenzies
	Gate            gateDef       `json:"gate"`
	Affixes         []string      `json:"affixes"` // a wave's affixes, bit by bit
	Tiers           tiersDef      `json:"tiers"`
}

// gateDef is working a gate: seconds at it, seconds before it swings again, how near to stand.
type gateDef struct {
	Time  float32 `json:"time"`
	Cool  float32 `json:"cool"`
	Reach float32 `json:"reach"`
}

var fireNames = map[game.Fire]string{game.FireHitscan: "hitscan", game.FireRocket: "rocket", game.FireMelee: "melee"}

// welcome builds the welcome for a session. host is the host machine's name.
func welcome(wel netplay.Welcome, core point, host, hint string, hosting bool) welcomeMsg {
	m := welcomeMsg{
		T: "welcome", Proto: netplay.Proto, Version: wel.Version, You: wel.You, W: wel.W, H: wel.H,
		Seed: strconv.FormatUint(wel.Seed, 10), Host: host, Hosting: hosting, Hint: hint,
		TickRate: game.TickRate, Core: core, BuildRadius: game.BuildRadius, ShopRadius: game.ShopRadius,
		MaxLevel: game.MaxLevel, MaxStructLevel: game.MaxStructLevel, RepairCostPerHP: game.RepairCostPerHP,
		SellFraction: game.SellFraction, RepairShare: game.RepairShare,
		Tracks:       game.TrackNames[:],
		TurretTracks: game.TurretTrackNames[:],
	}
	for _, c := range game.Creeps {
		m.Creeps = append(m.Creeps, creepDef{c.Name, c.HP, c.Speed, c.Radius, c.Size, c.Ranged, c.Bounty, c.Rate, c.Windup})
	}
	for k, d := range game.Weapons {
		wk := game.WeaponKind(k)
		wd := weaponDef{Name: d.Name, Short: d.Short, Price: d.Price, Range: d.Range, Fire: fireNames[d.Fire], Special: d.Special}
		for t := game.Track(0); t < game.NumTracks; t++ {
			var costs []int32
			var values []string
			for l := uint8(0); l <= game.MaxLevel; l++ {
				if l < game.MaxLevel {
					costs = append(costs, game.UpgradeCost(wk, l))
				}
				values = append(values, game.TrackValue(wk, t, l))
			}
			wd.Costs = append(wd.Costs, costs)
			wd.Values = append(wd.Values, values)
		}
		u := game.Ultimates[k]
		target := "self"
		if u.Range > 0 {
			target = "point"
		}
		wd.Ult = ultDef{u.Name, u.Desc, u.Time, u.Range, u.Radius, target}
		if wk.Evolves() {
			a := game.Arts[k]
			wd.Legend, wd.Art, wd.EvoCost = d.Legend, &artDef{a.Name, a.Desc, a.Range, a.Cool}, game.LegendEvoCost
			for _, e := range game.LegendEvos[k] {
				wd.Evolve = append(wd.Evolve, evoDef{Name: e.Name, Desc: e.Desc, Range: 1})
			}
		}
		m.Weapons = append(m.Weapons, wd)
	}
	for g := game.Gear(0); g < game.NumGear; g++ {
		gd := gearDef{Name: game.GearNames[g], Info: game.GearInfo[g]}
		for l := uint8(0); l < game.MaxLevel; l++ {
			gd.Costs = append(gd.Costs, game.GearCost(g, l))
		}
		m.Gear = append(m.Gear, gd)
	}
	for _, a := range game.Abilities {
		m.Abilities = append(m.Abilities, abilityDef{Name: a.Name, Key: a.Key, Desc: a.Desc, Target: "point",
			Range: a.Range, Radius: a.Radius[:a.Max], Cool: a.Cool[:a.Max], Costs: a.Costs[:a.Max], Always: a.Always})
	}
	for k, d := range game.Structs {
		sk := game.StructKind(k)
		sd := structDef{Name: d.Name, Price: d.Price, HP: d.HP, W: d.W, H: d.H, Range: d.Range, Turret: d.Turret, Floor: d.Floor, Desc: d.Desc, Special: d.Special}
		if d.Key != 0 {
			sd.Key = string(d.Key)
		}
		sd.Upgradable = game.Upgradable(sk)
		sd.Tier = d.Tier
		for _, e := range game.Evolutions[sk] {
			if e.Name != "" {
				sd.Evolve = append(sd.Evolve, evoDef{Name: e.Name, Desc: e.Desc, Range: max(e.Range, 1)})
			}
		}
		if d.Turret {
			// A turret: what a track costs and gives at each level, the same for every track.
			for l := uint8(0); l <= game.MaxLevel; l++ {
				var lv [game.NumTracks]uint8
				lv[game.TrackRange] = l
				sd.Ranges = append(sd.Ranges, game.TurretStats(sk, lv).Range)
				if l < game.MaxLevel {
					sd.Upgrade = append(sd.Upgrade, game.TurretUpgradeCost(sk, l))
				}
			}
			for t := game.Track(0); t < game.NumTracks; t++ {
				var values []string
				for l := uint8(0); l <= game.MaxLevel; l++ {
					values = append(values, game.TurretTrackValue(sk, t, l))
				}
				sd.Values = append(sd.Values, values)
			}
		} else {
			for l := uint8(0); l < game.MaxStructLevel; l++ {
				if sd.Upgradable && l > 0 {
					sd.Upgrade = append(sd.Upgrade, game.StructUpgradeCost(sk, l))
				} else {
					sd.Upgrade = append(sd.Upgrade, 0)
				}
			}
		}
		m.Structs = append(m.Structs, sd)
	}
	for _, k := range game.Buildable {
		m.Buildable = append(m.Buildable, int(k))
	}
	for _, d := range game.SiteDefs {
		m.SiteKinds = append(m.SiteKinds, siteKindDef{d.Name, d.Search})
	}
	m.Sites = []siteDef{}
	for _, s := range wel.Sites {
		m.Sites = append(m.Sites, siteDef{uint8(s.Kind), s.X, s.Y, s.W, s.H, s.SX, s.SY, s.Tier, s.Guard, s.Yaw, uint8(s.Ruin)})
	}
	m.Difficulty = difficultyRef{int(wel.Diff), wel.Diff.String()}
	m.FogOfWar = wel.Fog
	m.Mode = wel.Mode.String()
	for _, k := range game.StartBlades {
		m.StartBlades = append(m.StartBlades, int(k))
	}
	m.LastWave = wel.LastWave
	if wel.LastWave > 0 {
		inbound, flight, settle, wait, last, depart, climb, reach, board, half := game.EvacInfo()
		m.Evac = &evacDef{Pad: point{wel.PadX, wel.PadY}, Half: half, Reach: reach, Board: board,
			Inbound: inbound, Flight: flight, Settle: settle, Wait: wait, Last: last, Depart: depart, Climb: climb}
	}
	if wel.Diff < game.NumDifficulties {
		m.Dark = game.Difficulties[wel.Diff].Dark
		m.Cone = game.Difficulties[wel.Diff].Cone
	}
	for _, d := range game.Difficulties {
		m.Difficulties = append(m.Difficulties, d.Name)
		m.Patience = append(m.Patience, d.Patience)
	}
	gt, gc, gr := game.GateInfo()
	m.Gate = gateDef{gt, gc, gr}
	m.Affixes = game.AffixNames[:]
	m.Tiers = tiersDef{Step: game.TierStep, Max: game.MaxTier, Pylon: game.PylonTier, Evolve: game.EvolveTier, EvolveAt: game.EvolveAt,
		Overload: game.OverloadTier, OverloadReach: game.OverloadReach}
	for _, d := range game.Weathers {
		m.Weathers = append(m.Weathers, weatherDef{d.Name, d.Info})
	}
	cool, radius, t := game.TauntInfo()
	m.Taunt = tauntDef{cool, radius, t}
	reach, rt, hp := game.ReviveInfo()
	m.Revive = reviveDef{reach, rt, hp}
	mh, mt, mm, mc := game.MedkitInfo()
	m.Medkit = medkitDef{mh, mt, mm, mc}
	m.Goggles = game.GogglesCost()
	return m
}

// difficultyMsg tells a page the host changed the difficulty, with the night it brings.
func difficultyMsg(d game.Difficulty) map[string]any {
	m := map[string]any{"t": "difficulty", "difficulty": difficultyRef{int(d), d.String()}, "dark": float32(0), "cone": float32(0)}
	if d < game.NumDifficulties {
		m["dark"] = game.Difficulties[d].Dark
		m["cone"] = game.Difficulties[d].Cone
	}
	return m
}
