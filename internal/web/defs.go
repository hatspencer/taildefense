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
}

type sigDef struct {
	Name   string  `json:"name"`
	Desc   string  `json:"desc"`
	Cool   float32 `json:"cool"`
	Range  float32 `json:"range"`
	Radius float32 `json:"radius"`
	Cone   float32 `json:"cone,omitempty"`
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
	Sig     sigDef     `json:"sig"`
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
	Name    string    `json:"name"`
	Price   int32     `json:"price"`
	HP      float32   `json:"hp"`
	W       uint8     `json:"w"`
	H       uint8     `json:"h"`
	Range   float32   `json:"range"`
	Ranges  []float32 `json:"ranges,omitempty"`
	Turret  bool      `json:"turret"`
	Key     string    `json:"key"`
	Desc    string    `json:"desc"`
	Upgrade []int32   `json:"upgrade"`
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
	Yaw   float32 `json:"yaw"` // a wreck's heading, radians from +x towards +y
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
	Tracks          []string      `json:"tracks"`
	Creeps          []creepDef    `json:"creeps"`
	Weapons         []weaponDef   `json:"weapons"`
	Gear            []gearDef     `json:"gear"`
	Abilities       []abilityDef  `json:"abilities"`
	Structs         []structDef   `json:"structs"`
	Buildable       []int         `json:"buildable"`
	SiteKinds       []siteKindDef `json:"siteKinds"`
	Sites           []siteDef     `json:"sites"`
	Difficulty      difficultyRef `json:"difficulty"`
	Difficulties    []string      `json:"difficulties"`
	Weathers        []weatherDef  `json:"weathers"`
	Taunt           tauntDef      `json:"taunt"`
	Revive          reviveDef     `json:"revive"`
	Medkit          medkitDef     `json:"medkit"`
}

var fireNames = map[game.Fire]string{game.FireHitscan: "hitscan", game.FireCone: "cone", game.FireRocket: "rocket"}

// welcome builds the welcome for a session. host is the host machine's name.
func welcome(wel netplay.Welcome, core point, host, hint string, hosting bool) welcomeMsg {
	m := welcomeMsg{
		T: "welcome", Proto: netplay.Proto, Version: wel.Version, You: wel.You, W: wel.W, H: wel.H,
		Seed: strconv.FormatUint(wel.Seed, 10), Host: host, Hosting: hosting, Hint: hint,
		TickRate: game.TickRate, Core: core, BuildRadius: game.BuildRadius, ShopRadius: game.ShopRadius,
		MaxLevel: game.MaxLevel, MaxStructLevel: game.MaxStructLevel, RepairCostPerHP: game.RepairCostPerHP,
		SellFraction: game.SellFraction,
		Tracks:       game.TrackNames[:],
	}
	for _, c := range game.Creeps {
		m.Creeps = append(m.Creeps, creepDef{c.Name, c.HP, c.Speed, c.Radius, c.Size, c.Ranged, c.Bounty})
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
		s := game.Signatures[k]
		target := "point"
		if s.Self {
			target = "self"
		}
		wd.Sig = sigDef{s.Name, s.Desc, s.Cool, s.Range, s.Radius, s.Cone, target}
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
			Range: a.Range, Radius: a.Radius[:], Cool: a.Cool[:], Costs: a.Costs[:], Always: a.Always})
	}
	for k, d := range game.Structs {
		sd := structDef{Name: d.Name, Price: d.Price, HP: d.HP, W: d.W, H: d.H, Range: d.Range, Turret: d.Turret, Desc: d.Desc}
		if d.Key != 0 {
			sd.Key = string(d.Key)
		}
		for l := uint8(0); l < game.MaxStructLevel; l++ {
			if d.Turret {
				_, r, _ := game.TurretStats(game.StructKind(k), l+1)
				sd.Ranges = append(sd.Ranges, r)
			}
			if d.Turret && l > 0 {
				sd.Upgrade = append(sd.Upgrade, game.StructUpgradeCost(game.StructKind(k), l))
			} else {
				sd.Upgrade = append(sd.Upgrade, 0)
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
		m.Sites = append(m.Sites, siteDef{uint8(s.Kind), s.X, s.Y, s.W, s.H, s.SX, s.SY, s.Tier, s.Guard, s.Yaw})
	}
	m.Difficulty = difficultyRef{int(wel.Diff), wel.Diff.String()}
	for _, d := range game.Difficulties {
		m.Difficulties = append(m.Difficulties, d.Name)
	}
	for _, d := range game.Weathers {
		m.Weathers = append(m.Weathers, weatherDef{d.Name, d.Info})
	}
	cool, radius, t := game.TauntInfo()
	m.Taunt = tauntDef{cool, radius, t}
	reach, rt, hp := game.ReviveInfo()
	m.Revive = reviveDef{reach, rt, hp}
	mh, mt, mm, mc := game.MedkitInfo()
	m.Medkit = medkitDef{mh, mt, mm, mc}
	return m
}
