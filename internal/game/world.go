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

	// Aggro: a creep hunts a survivor it was pulled, taunted or provoked by, or goes for a
	// structure that caught its eye, instead of following the field to the generator.
	Hunt      int8    // player hunted, -1 none
	HuntLeft  float32 // seconds the hunt lasts
	Siege     int16   // structure gone for, -1 none
	SiegeLeft float32
	Chase     int8    // player chased this tick, for the wire; -1 none
	think     float32 // seconds until it next considers something else to attack

	// Guards of a loot site sleep at home until woken, and go back when led too far.
	Home      int16 // site index + 1, 0 for a creep of the waves
	HX, HY    float32
	Asleep    bool
	Returning bool
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
	Search    float32 // seconds into searching a loot site or reviving a teammate
	Revived   float32 // while down: how far the best revive on them is, 0..1
	Emote     uint8   // 0 none, 1 taunting
	EmoteLeft float32
	TauntCool float32
	Sprint    bool    // sprint held
	Winded    bool    // stamina ran out; no sprinting until it is back to windedUntil
	Stamina   float32 // 0..1
	noise     float32 // seconds until firing makes noise again
	Dry       uint8   // searches in a row that found little, which makes the next luckier
	lastAct   uint32  // the tick of the player's last command
	Look      uint32  // what the survivor looks like, dealt on joining; see Look

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
	Level uint8 // 0 info, 1 good, 2 bad, NoteChat a player talking
}

// NoteChat is the level of a player's chat line, "name: text".
const NoteChat uint8 = 3

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
	Diff    Difficulty

	Creeps  []Creep
	Structs []Structure
	Players []*Player
	Rockets []Projectile
	Effects []Effect
	Sites   []Site

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
	Paused     int8 // the player who paused the game, or -1 while it runs
	sentNotes  int  // how many of Notes and Toasts the last tick already carried
	sentToasts int
	stall      float32 // seconds since a creep of the wave last died, once all are out
	overtime   float32 // seconds of overtime, counted once the wave is all out and at the base
	waveLeft   int     // creeps of the wave alive at the last count
	SpawnPts   [][2]float32
	Core       int // structure index of the generator
	Armory     int
	CoreX      float32
	CoreY      float32
	Best       int // waves survived when the game ended
	TotalKills uint32
	Weather    WeatherKind
	WeatherAmt float32 // 0..1, how strongly it holds

	weatherNext WeatherKind
	lightning   float32
	shooter     int8 // the player whose shot is being resolved, -1 for turrets and the sky

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

// New builds a world from a seed at the default difficulty.
func New(seed uint64) *World { return NewGame(seed, DefaultDifficulty) }

// NewGame builds a world from a seed: terrain, the base with its walls, gates and starting
// turrets, the spawn points on the map edge, and the loot sites with their guards.
func NewGame(seed uint64, diff Difficulty) *World {
	const w, h = 320, 200
	if diff >= NumDifficulties {
		diff = DefaultDifficulty
	}
	wd := &World{W: w, H: h, Seed: seed, Diff: diff, shooter: -1, Paused: -1, rng: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))}
	var ruins []ruin
	wd.Terrain, ruins = generate(seed, w, h)
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
	wd.PhaseLeft = wd.diff().First
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
	wd.Sites = wd.placeSites(ruins)
	for i := range wd.Sites {
		wd.spawnGuards(i)
	}
	wd.countGuards()
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

// baseRadius is the half-width of the starting walls' square.
const baseRadius = 14

// buildBase lays out the generator, the armory, a square of walls with a gate on each side,
// floor inside, and four gun turrets by the gates.
func (w *World) buildBase() {
	cx, cy := w.W/2, w.H/2
	w.CoreX, w.CoreY = float32(cx), float32(cy)
	const r = baseRadius
	for y := cy - r - 2; y <= cy+r+2; y++ {
		for x := cx - r - 2; x <= cx+r+2; x++ {
			if y >= cy-r && y <= cy+r && x >= cx-r && x <= cx+r {
				w.Terrain[y*w.W+x] = TFloor
			} else if w.Terrain[y*w.W+x].Solid() {
				w.Terrain[y*w.W+x] = TGrass
			}
		}
	}
	w.Core = w.place(SCore, cx-2, cy-2, -1)
	w.Armory = w.place(SArmory, cx+4, cy-1, -1)
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
	t, _ := generate(seed, w, h)
	return t
}

// ruin is a walled place the generator built: a ruined house or an overrun outpost. For an
// outpost, cx, cy is the middle of its keep.
type ruin struct {
	x, y, w, h int
	outpost    bool
	cx, cy     int
}

// generate is Generate, also returning the ruins it built.
func generate(seed uint64, w, h int) ([]Tile, []ruin) {
	var houses []ruin
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
		houses = append(houses, ruin{x: bx, y: by, w: bw, h: bh})
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
	houses = outposts(t, w, h, rng, houses)
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
	return t, houses
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

// outposts builds the overrun outposts, big walled compounds well out from the base: an outer
// wall with a gate on each side, a few walls breaking up the yard, and a keep in the middle
// with a door. Houses they land on are torn down.
func outposts(t []Tile, w, h int, rng *rand.Rand, houses []ruin) []ruin {
	var forts []ruin
	set := func(x, y int, k Tile) {
		if x > 0 && y > 0 && x < w-1 && y < h-1 {
			t[y*w+x] = k
		}
	}
	for try := 0; try < 400 && len(forts) < 3; try++ {
		fw, fh := 20+rng.IntN(7), 16+rng.IntN(5)
		fx, fy := 3+rng.IntN(w-fw-6), 3+rng.IntN(h-fh-6)
		cx, cy := fx+fw/2, fy+fh/2
		if math.Hypot(float64(cx-w/2), float64(cy-h/2)) < 80 {
			continue
		}
		clash := false
		for _, f := range forts {
			if fx < f.x+f.w+16 && f.x < fx+fw+16 && fy < f.y+f.h+16 && f.y < fy+fh+16 {
				clash = true
			}
		}
		if clash {
			continue
		}
		// Clear the ground, a margin round it too, and the houses on it.
		for y := fy - 2; y < fy+fh+2; y++ {
			for x := fx - 2; x < fx+fw+2; x++ {
				set(x, y, TDirt)
			}
		}
		kept := houses[:0]
		for _, r := range houses {
			if r.x < fx+fw+2 && fx-2 < r.x+r.w && r.y < fy+fh+2 && fy-2 < r.y+r.h {
				continue
			}
			kept = append(kept, r)
		}
		houses = kept
		// The outer wall, with a three-wide gate in the middle of each side.
		for x := fx; x < fx+fw; x++ {
			if abs(x-cx) > 1 {
				set(x, fy, TRock)
				set(x, fy+fh-1, TRock)
			}
		}
		for y := fy; y < fy+fh; y++ {
			if abs(y-cy) > 1 {
				set(fx, y, TRock)
				set(fx+fw-1, y, TRock)
			}
		}
		// The keep: 8 by 6 round the middle, its door facing a random side.
		kx, ky, kw, kh := cx-4, cy-3, 8, 6
		door := rng.IntN(4)
		for x := kx; x < kx+kw; x++ {
			for _, y := range []int{ky, ky + kh - 1} {
				if !((door == 0 && y == ky || door == 1 && y == ky+kh-1) && abs(x-cx) <= 1) {
					set(x, y, TRock)
				}
			}
		}
		for y := ky; y < ky+kh; y++ {
			for _, x := range []int{kx, kx + kw - 1} {
				if !((door == 2 && x == kx || door == 3 && x == kx+kw-1) && abs(y-cy) <= 1) {
					set(x, y, TRock)
				}
			}
		}
		// Broken walls across the yard, cover for the guards and for whoever comes in.
		for i := 0; i < 4; i++ {
			x, y := fx+2+rng.IntN(fw-4), fy+2+rng.IntN(fh-4)
			if x >= kx-2 && x < kx+kw+2 && y >= ky-2 && y < ky+kh+2 {
				continue
			}
			n := 3 + rng.IntN(3)
			for k := 0; k < n; k++ {
				if i%2 == 0 {
					set(x+k, y, TRock)
				} else {
					set(x, y+k, TRock)
				}
			}
		}
		forts = append(forts, ruin{x: fx, y: fy, w: fw, h: fh, outpost: true, cx: cx, cy: cy})
	}
	return append(forts, houses...)
}
