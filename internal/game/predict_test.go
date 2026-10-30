package game

import (
	"bytes"
	"encoding/json"
	"math"
	"math/rand/v2"
	"os"
	"testing"
)

// The page predicts its own survivor's WASD walk with a port of the host's movement
// (web/src/predict.ts). This test walks survivors with the host's own code over a small map
// with every kind of obstacle and writes what it got to web/test/predict-fixture.json, which
// `npm run check` replays through the port (web/test/predict.mts). A change to how survivors
// walk fails here first; ./build.sh golden rewrites the fixture, and the port must follow.

const predictFixture = "../../web/test/predict-fixture.json"

type predictCase struct {
	X        float32 `json:"x"`
	Y        float32 `json:"y"`
	Turns    uint8   `json:"turns"`
	Ticks    int     `json:"ticks"`
	Repeat   int     `json:"repeat"` // the steer is sent again every so many ticks, 0 never
	Boots    uint8   `json:"boots"`
	Sprint   bool    `json:"sprint"`
	Winded   bool    `json:"winded"`
	Stamina  float32 `json:"stamina"`
	Slow     float32 `json:"slow"`
	Buff     uint8   `json:"buff"` // as the page has it: the weapon kind + 1, 0 none
	BuffLeft float32 `json:"buffLeft"`
	Cur      uint8   `json:"cur"`
	Weather  uint8   `json:"weather"`
	Amt      float32 `json:"amt"`
	// Per tick after the step: x, y, stamina, winded (1 or 0).
	Out [][4]float32 `json:"out"`
}

type predictSite struct {
	Kind     uint8   `json:"kind"`
	SX       float32 `json:"sx"`
	SY       float32 `json:"sy"`
	Yaw      float32 `json:"yaw"`
	Searched bool    `json:"searched"`
}

type predictFix struct {
	TickRate int           `json:"tickRate"`
	W        int           `json:"w"`
	H        int           `json:"h"`
	Tiles    []int         `json:"tiles"`
	Structs  []int         `json:"structs"` // the structure kind per tile, -1 none
	Gate     int           `json:"gate"`
	Sites    []predictSite `json:"sites"`
	Cases    []predictCase `json:"cases"`
}

// predictWorld is a 48 x 32 map: scattered water, trees and rocks, a wall with a gate in it,
// two wrecks, the plane's tail end, and fuel pumps, one blown up.
func predictWorld() *World {
	const w, h = 48, 32
	wd := &World{W: w, H: h, Terrain: make([]Tile, w*h), structAt: make([]int16, w*h)}
	rng := rand.New(rand.NewPCG(7, 11))
	for i := range wd.Terrain {
		switch r := rng.IntN(100); {
		case r < 3:
			wd.Terrain[i] = TWater
		case r < 6:
			wd.Terrain[i] = TTree
		case r < 8:
			wd.Terrain[i] = TRock
		case r < 20:
			wd.Terrain[i] = TDirt
		}
		wd.structAt[i] = -1
	}
	for y := 4; y < 20; y++ {
		k := SWall
		if y == 11 || y == 12 {
			k = SGate
		}
		wd.structAt[y*w+14] = int16(len(wd.Structs))
		wd.Structs = append(wd.Structs, Structure{Kind: k, X: 14, Y: int16(y), W: 1, H: 1, Alive: true})
	}
	wd.Sites = []Site{
		{Kind: SiteCar, SX: 22.4, SY: 9.7, Yaw: .5},
		{Kind: SiteBus, SX: 30.2, SY: 20.5, Yaw: 1.9},
		{Kind: SitePump, SX: 8.5, SY: 25.5},
		{Kind: SitePump, SX: 10.5, SY: 25.5, Searched: true},
		{Kind: SiteTank, SX: 26.5, SY: 26.5},
		{Kind: SitePlane, SX: 52, SY: 30, Yaw: 3.3},
	}
	return wd
}

func predictCases(w *World) []predictCase {
	rng := rand.New(rand.NewPCG(3, 5))
	var cs []predictCase
	for len(cs) < 80 {
		c := predictCase{
			X: float32(1+rng.IntN(46)) + float32(rng.IntN(8))/8, Y: float32(1+rng.IntN(30)) + float32(rng.IntN(8))/8,
			Turns: uint8(rng.IntN(256)), Ticks: 10 + rng.IntN(50), Boots: uint8(rng.IntN(4)),
			Sprint: rng.IntN(2) == 0, Stamina: float32(rng.IntN(256)) / 255, Cur: uint8(rng.IntN(3)),
		}
		if !CanStand(w, c.X, c.Y) {
			continue
		}
		if rng.IntN(3) > 0 {
			c.Repeat = 2 + rng.IntN(3)
		}
		c.Winded = c.Stamina < windedUntil && rng.IntN(2) == 0
		if rng.IntN(3) == 0 {
			c.Slow = float32(rng.IntN(150)) / 100
		}
		switch rng.IntN(5) {
		case 0:
			c.Buff, c.BuffLeft = uint8(WPistol)+1, float32(rng.IntN(30))/10
		case 1:
			c.Buff, c.BuffLeft, c.Cur = uint8(WSMG)+1, float32(rng.IntN(30))/10, uint8(WSMG)
		}
		if rng.IntN(3) == 0 {
			c.Weather, c.Amt = uint8([]WeatherKind{WSnow, WHeavySnow, WRain}[rng.IntN(3)]), float32(rng.IntN(256))/255
		}
		cs = append(cs, c)
	}
	return cs
}

// walk runs case c through the host's tick for one survivor: the buff and the slow count
// down, the order acts, stamina follows, as World.Step has them.
func (c *predictCase) walk(w *World) {
	w.Weather, w.WeatherAmt = WeatherKind(c.Weather), c.Amt
	p := &Player{Alive: true, X: c.X, Y: c.Y, Stamina: c.Stamina, Winded: c.Winded, Sprint: c.Sprint, slowLeft: c.Slow, Cur: WeaponKind(c.Cur)}
	p.Gear[GearBoots] = c.Boots
	if c.Buff > 0 {
		p.Buff, p.BuffLeft = WeaponKind(c.Buff-1), c.BuffLeft
	}
	ang := float32(c.Turns) * (2 * math.Pi / 256)
	w.Steer(p, ang, true)
	c.Out = nil
	for t := range c.Ticks {
		if c.Repeat > 0 && t > 0 && t%c.Repeat == 0 {
			w.Steer(p, ang, true)
		}
		if p.BuffLeft > 0 {
			p.BuffLeft = max(p.BuffLeft-Dt, 0)
		}
		p.tickSlow()
		w.act(p, Stats{})
		p.stepStamina()
		wd := float32(0)
		if p.Winded {
			wd = 1
		}
		c.Out = append(c.Out, [4]float32{p.X, p.Y, p.Stamina, wd})
	}
}

func TestGoldenPredict(t *testing.T) {
	w := predictWorld()
	fx := predictFix{TickRate: TickRate, W: w.W, H: w.H, Gate: int(SGate)}
	for i, tl := range w.Terrain {
		fx.Tiles = append(fx.Tiles, int(tl))
		k := -1
		if si := w.structAt[i]; si >= 0 {
			k = int(w.Structs[si].Kind)
		}
		fx.Structs = append(fx.Structs, k)
	}
	for _, s := range w.Sites {
		fx.Sites = append(fx.Sites, predictSite{uint8(s.Kind), s.SX, s.SY, s.Yaw, s.Searched})
	}
	fx.Cases = predictCases(w)
	for i := range fx.Cases {
		fx.Cases[i].walk(w)
	}
	got, err := json.Marshal(fx)
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	if os.Getenv("TD_GOLDEN") == "update" {
		if err := os.WriteFile(predictFixture, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(predictFixture)
	if err != nil {
		t.Fatalf("%v (./build.sh golden writes it)", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("survivors walk differently from %s: if that is meant, ./build.sh golden rewrites it, and web/src/predict.ts must follow", predictFixture)
	}
}
