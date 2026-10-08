package game

import (
	"math"
	"math/rand/v2"
)

// Creep is one enemy. Creeps live in World.Creeps, a dense slice; ID is stable for the
// creep's life and is what the wire uses.
type Creep struct {
	X, Y      float32
	HP, MaxHP float32
	Cool      float32 // seconds until the next attack
	Slow      float32 // seconds of slow left
	Burn      float32 // seconds of burning left
	BurnDPS   float32
	ID        uint16
	Kind      CreepKind
	LastHit   int8 // player who last damaged it, -1 none, for the bounty
	Hit       uint8
}

// Structure is a building. Index in World.Structs is its ID; dead slots are reused.
type Structure struct {
	Kind      StructKind
	X, Y      int16 // top-left tile
	W, H      uint8
	HP, MaxHP float32
	Level     uint8
	Owner     int8 // player who built it, -1 for the starting base
	Cool      float32
	Alive     bool
}

// CX and CY are the structure's centre.
func (s *Structure) CX() float32 { return float32(s.X) + float32(s.W)/2 }

// CY is the structure's vertical centre.
func (s *Structure) CY() float32 { return float32(s.Y) + float32(s.H)/2 }

// WeaponState is one weapon in a player's loadout.
type WeaponState struct {
	Owned  bool
	Lv     [NumTracks]uint8
	Ammo   int16
	Reload float32 // seconds of reload left, 0 when ready
	Cool   float32 // seconds until the next shot
}

// AbilityState is one of a player's ability slots.
type AbilityState struct {
	Lv   uint8   // 0 locked
	Cool float32 // seconds until it can be cast again
}

// Player is one survivor. The host moves them: clients give orders, the host walks the path.
type Player struct {
	ID        uint8
	Name      string
	Login     string
	X, Y      float32
	Aim       float32
	HP, MaxHP float32
	Alive     bool
	Respawn   float32
	Gold      int32
	Weapons   [NumWeapons]WeaponState
	Cur       WeaponKind
	Gear      [NumGear]uint8
	Abil      [NumAbilities]AbilityState
	Buff      WeaponKind // whose signature buff runs, valid while BuffLeft > 0
	BuffLeft  float32
	Order     Order
	Kills     uint32
	Damage    float64
	Ready     bool
	Connected bool
	Firing    bool
	Moving    bool
	Hurt      float32

	walk walker
}

// Speed is the player's move speed in tiles per second.
func (p *Player) Speed() float32 { return 6 * (1 + .08*float32(p.Gear[GearBoots])) }

// Tracer is a visible shot for one frame.
type Tracer struct {
	X0, Y0, X1, Y1 float32
	Kind           uint8 // 0..NumWeapons-1 player weapons, 16+ turret kinds, 32 spit
}

// TracerSpit marks a spitter's shot.
const TracerSpit = 32

// TracerTurret is added to a turret StructKind.
const TracerTurret = 16

// Blast is an explosion or pulse for one frame.
type Blast struct {
	X, Y, R float32
	Kind    uint8 // 0 rocket/cannon, 1 frost, 2 tesla
}

// EffectKind is a lasting effect on the ground.
type EffectKind uint8

const (
	EffGrenade   EffectKind = iota + 1 // in flight from X0, Y0 to X, Y
	EffNapalm                          // a burning pool
	EffAirstrike                       // a target marked, the strike lands when Left runs out
)

// Effect is something that lasts more than a tick: a grenade in the air, a pool of napalm.
type Effect struct {
	Kind         EffectKind
	X0, Y0, X, Y float32
	R            float32
	Left, Total  float32
	Damage       float32 // on landing, or per second for a pool
	Owner        int8
}

// Toast is a message for one player only, such as why a build was refused.
type Toast struct {
	Player uint8
	Level  uint8
	Text   string
}

// Death marks where a creep died, for the corpse decal.
type Death struct {
	X, Y float32
	Kind CreepKind
}

// Note is an announcement shown to everyone.
type Note struct {
	Text  string
	Level uint8 // 0 info, 1 good, 2 bad
}

// Projectile is a rocket in flight.
type Projectile struct {
	X, Y, VX, VY float32
	TTL          float32
	Damage       float32
	Blast        float32
	Owner        int8
}

// Spawn is one creep waiting to enter.
type Spawn struct {
	At   float32
	Kind CreepKind
	X, Y float32
}

// World is the whole simulation state.
type World struct {
	W, H    int
	Terrain []Tile
	Seed    uint64

	Creeps  []Creep
	Structs []Structure
	Players []*Player
	Rockets []Projectile
	Effects []Effect

	// Per tick outputs, cleared at the start of Step.
	Tracers []Tracer
	Blasts  []Blast
	Deaths  []Death
	Notes   []Note
	Toasts  []Toast

	Tick       uint32
	Phase      Phase
	PhaseLeft  float32 // seconds left of a build phase
	Wave       int
	WaveTime   float32
	Queue      []Spawn // pending spawns of this wave, sorted by At
	QueueHead  int
	SpawnPts   [][2]float32
	Core       int // structure index of the generator
	Armory     int
	CoreX      float32
	CoreY      float32
	Best       int // waves survived when the game ended
	TotalKills uint32

	structAt []int16 // per tile, structure index or -1
	flow     flowField
	flowDirt bool
	grid     spatial
	freeIDs  []uint16
	rng      *rand.Rand
	scratch  []int32
	hitBuf   []hitCand
	byID     []int32 // creep id -> index in Creeps, valid for creeps alive at the tick's start
	paths    pathfinder
}

// New builds a world from a seed: terrain, the base with its walls, gates and starting
// turrets, and the spawn points on the map edge.
func New(seed uint64) *World {
	const w, h = 320, 200
	wd := &World{W: w, H: h, Seed: seed, rng: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))}
	wd.Terrain = Generate(seed, w, h)
	wd.structAt = make([]int16, w*h)
	for i := range wd.structAt {
		wd.structAt[i] = -1
	}
	wd.freeIDs = make([]uint16, 0, MaxCreeps)
	for i := MaxCreeps - 1; i >= 0; i-- {
		wd.freeIDs = append(wd.freeIDs, uint16(i))
	}
	wd.Creeps = make([]Creep, 0, 4096)
	wd.byID = make([]int32, MaxCreeps)
	wd.paths.init(w, h)
	wd.grid.init(w, h)
	wd.flow.init(w, h)
	wd.buildBase()
	wd.SpawnPts = spawnPoints(wd.Terrain, w, h)
	wd.Phase = PhaseBuild
	wd.PhaseLeft = 45
	wd.flowDirt = true
	wd.updateFlow()
	// Keep only spawn points with a way in; the road ends always have one.
	pts := wd.SpawnPts[:0]
	for _, p := range wd.SpawnPts {
		if wd.flow.dist[int(p[1])*w+int(p[0])] < unreachable {
			pts = append(pts, p)
		}
	}
	wd.SpawnPts = pts
	return wd
}

// At returns the tile at x, y; outside the map is rock.
func (w *World) At(x, y int) Tile {
	if x < 0 || y < 0 || x >= w.W || y >= w.H {
		return TRock
	}
	return w.Terrain[y*w.W+x]
}

// StructAt returns the structure index covering tile x, y, or -1.
func (w *World) StructAt(x, y int) int {
	if x < 0 || y < 0 || x >= w.W || y >= w.H {
		return -1
	}
	return int(w.structAt[y*w.W+x])
}

// buildBase lays out the generator, the armory, a square of walls with a gate on each side,
// floor inside, and four gun turrets by the gates.
func (w *World) buildBase() {
	cx, cy := w.W/2, w.H/2
	w.CoreX, w.CoreY = float32(cx), float32(cy)
	const r = 11
	for y := cy - r - 2; y <= cy+r+2; y++ {
		for x := cx - r - 2; x <= cx+r+2; x++ {
			if y >= cy-r && y <= cy+r && x >= cx-r && x <= cx+r {
				w.Terrain[y*w.W+x] = TFloor
			} else if w.Terrain[y*w.W+x].Solid() {
				w.Terrain[y*w.W+x] = TGrass
			}
		}
	}
	w.Core = w.place(SCore, cx-1, cy-1, -1)
	w.Armory = w.place(SArmory, cx+3, cy-1, -1)
	for i := -r; i <= r; i++ {
		for _, p := range [][2]int{{cx + i, cy - r}, {cx + i, cy + r}, {cx - r, cy + i}, {cx + r, cy + i}} {
			if w.StructAt(p[0], p[1]) >= 0 {
				continue
			}
			kind := SWall
			if i >= -1 && i <= 1 {
				kind = SGate
			}
			w.place(kind, p[0], p[1], -1)
		}
	}
	for _, p := range [][2]int{{cx - 3, cy - r + 2}, {cx + 3, cy + r - 2}, {cx - r + 2, cy + 3}, {cx + r - 2, cy - 3}} {
		w.place(STurretGun, p[0], p[1], -1)
	}
}

// place puts a structure down without checks and returns its index.
func (w *World) place(k StructKind, x, y int, owner int8) int {
	d := Structs[k]
	s := Structure{Kind: k, X: int16(x), Y: int16(y), W: d.W, H: d.H, HP: d.HP, MaxHP: d.HP, Level: 1, Owner: owner, Alive: true}
	idx := -1
	for i := range w.Structs {
		if !w.Structs[i].Alive {
			idx = i
			break
		}
	}
	if idx < 0 {
		w.Structs = append(w.Structs, s)
		idx = len(w.Structs) - 1
	} else {
		w.Structs[idx] = s
	}
	for ty := y; ty < y+int(d.H); ty++ {
		for tx := x; tx < x+int(d.W); tx++ {
			w.structAt[ty*w.W+tx] = int16(idx)
		}
	}
	w.flowDirt = true
	return idx
}

// remove destroys a structure.
func (w *World) remove(idx int) {
	s := &w.Structs[idx]
	for ty := int(s.Y); ty < int(s.Y)+int(s.H); ty++ {
		for tx := int(s.X); tx < int(s.X)+int(s.W); tx++ {
			w.structAt[ty*w.W+tx] = -1
		}
	}
	s.Alive = false
	w.flowDirt = true
}

// Generate makes the terrain: grass with dirt and sand patches, lakes, forests, ruined
// buildings, and four roads into the middle. Deterministic for a seed.
func Generate(seed uint64, w, h int) []Tile {
	rng := rand.New(rand.NewPCG(seed, 0x5eed))
	t := make([]Tile, w*h)
	n1 := newNoise(rng)
	n2 := newNoise(rng)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			fx, fy := float64(x), float64(y)
			wet := n1.at(fx/38, fy/38)*0.7 + n1.at(fx/11, fy/11)*0.3
			wood := n2.at(fx/24, fy/24)*0.75 + n2.at(fx/6, fy/6)*0.25
			tile := TGrass
			switch {
			case wet > .72:
				tile = TWater
			case wet > .67:
				tile = TSand
			case wood > .70:
				tile = TTree
			case wood < .22:
				tile = TDirt
			}
			t[y*w+x] = tile
		}
	}
	// Ruined houses: hollow rectangles with a doorway, so creeps funnel round them.
	for i := 0; i < 70; i++ {
		bw, bh := 4+rng.IntN(7), 4+rng.IntN(6)
		bx, by := 2+rng.IntN(w-bw-4), 2+rng.IntN(h-bh-4)
		if abs(bx+bw/2-w/2) < 34 && abs(by+bh/2-h/2) < 30 {
			continue
		}
		door := rng.IntN(2*(bw+bh) - 4)
		k := 0
		for y := by; y < by+bh; y++ {
			for x := bx; x < bx+bw; x++ {
				edge := y == by || y == by+bh-1 || x == bx || x == bx+bw-1
				if edge {
					if k != door && k != door+1 {
						t[y*w+x] = TRock
					} else {
						t[y*w+x] = TDirt
					}
					k++
				} else {
					t[y*w+x] = TDirt
				}
			}
		}
	}
	// Roads from each edge to the base, wobbling a little, two tiles wide.
	cx, cy := w/2, h/2
	for _, e := range [][2]int{{0, cy}, {w - 1, cy}, {cx, 0}, {cx, h - 1}} {
		x, y := float64(e[0]), float64(e[1])
		for step := 0; step < w+h; step++ {
			dx, dy := float64(cx)-x, float64(cy)-y
			d := math.Hypot(dx, dy)
			if d < 2 {
				break
			}
			wob := (n1.at(x/20, y/20) - .5) * 1.6
			ang := math.Atan2(dy, dx) + wob
			x += math.Cos(ang)
			y += math.Sin(ang)
			for oy := 0; oy <= 1; oy++ {
				for ox := 0; ox <= 1; ox++ {
					xi, yi := int(x)+ox, int(y)+oy
					if xi >= 0 && yi >= 0 && xi < w && yi < h {
						t[yi*w+xi] = TDirt
					}
				}
			}
		}
	}
	// A solid border, so nothing walks off the edge.
	for x := 0; x < w; x++ {
		t[x], t[(h-1)*w+x] = TRock, TRock
	}
	for y := 0; y < h; y++ {
		t[y*w], t[y*w+w-1] = TRock, TRock
	}
	return t
}

// spawnPoints picks open tiles just inside the border: the four road ends and four corners.
func spawnPoints(t []Tile, w, h int) [][2]float32 {
	want := [][2]int{{2, h / 2}, {w - 3, h / 2}, {w / 2, 2}, {w / 2, h - 3}, {4, 4}, {w - 5, 4}, {4, h - 5}, {w - 5, h - 5}}
	var pts [][2]float32
	for _, p := range want {
		// Walk towards the middle until an open tile.
		x, y := p[0], p[1]
		for i := 0; i < 60 && t[y*w+x].Solid(); i++ {
			x += sign(w/2 - x)
			y += sign(h/2 - y)
		}
		for oy := -1; oy <= 1; oy++ {
			for ox := -1; ox <= 1; ox++ {
				if xi, yi := x+ox, y+oy; xi > 0 && yi > 0 && xi < w-1 && yi < h-1 && t[yi*w+xi].Solid() {
					t[yi*w+xi] = TDirt
				}
			}
		}
		pts = append(pts, [2]float32{float32(x) + .5, float32(y) + .5})
	}
	return pts
}

// noise is a small value-noise generator, enough for terrain.
type noise struct{ perm [512]uint8 }

func newNoise(rng *rand.Rand) *noise {
	n := &noise{}
	p := rng.Perm(256)
	for i := 0; i < 512; i++ {
		n.perm[i] = uint8(p[i&255])
	}
	return n
}

func (n *noise) at(x, y float64) float64 {
	xi, yi := int(math.Floor(x)), int(math.Floor(y))
	xf, yf := x-math.Floor(x), y-math.Floor(y)
	u, v := xf*xf*(3-2*xf), yf*yf*(3-2*yf)
	h := func(i, j int) float64 { return float64(n.perm[(int(n.perm[i&255])+j)&511]) / 255 }
	a, b := h(xi, yi), h(xi+1, yi)
	c, d := h(xi, yi+1), h(xi+1, yi+1)
	return a + (b-a)*u + (c-a)*v + (a-b-c+d)*u*v
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func sign(v int) int {
	switch {
	case v > 0:
		return 1
	case v < 0:
		return -1
	}
	return 0
}
