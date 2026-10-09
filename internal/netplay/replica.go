package netplay

import (
	"fmt"
	"time"

	"taildefense/internal/game"
)

// CrateView is a supply crate on the ground; Open is how far opening it is, 0..1.
type CrateView struct {
	X, Y, Open float32
}

// PlayerView is a player as a client sees them.
type PlayerView struct {
	ID                                         uint8
	Name                                       string
	Connected, Alive, Firing, Ready, Reloading bool
	Hurt, AtArmory, Moving                     bool
	X, Y, Aim                                  float32
	PX, PY                                     float32 // position one frame earlier
	HP, MaxHP                                  uint16
	Order                                      game.OrderKind
	Channel                                    float32 // how far a search or revive is, 0..1
	Revived                                    float32 // while down: how far a revive on them is
	Emote                                      uint8
	EmoteLeft, TauntCool                       float32 // seconds
	Stamina                                    float32 // 0..1
	Medkits                                    uint8
	Heal                                       float32 // seconds of a medkit's healing left
	ReloadMask                                 uint8   // a bit per weapon reloading, in hand or not
	Look                                       uint32  // see game.dealLook
	Sprinting, Winded                          bool
	Cur                                        game.WeaponKind
	Ammo                                       uint16
	ReloadFrac                                 float32 // 1 just started, 0 done
	Respawn                                    uint8
	Gold, Kills, Damage                        uint64
	Owned                                      [game.NumWeapons]bool
	Lv                                         [game.NumWeapons][game.NumTracks]uint8
	Gear                                       [game.NumGear]uint8
	Buff                                       uint8   // 0 none, else the weapon kind + 1
	BuffLeft                                   float32 // seconds
	Abil                                       [game.NumAbilities]AbilityView
}

// AbilityView is one ability slot.
type AbilityView struct {
	Lv   uint8
	Cool float32 // seconds left
}

// Effect is a lasting effect, as of the last frame.
type Effect struct {
	Kind            game.EffectKind
	X0, Y0, X, Y, R float32
	Left, Total     float32 // seconds
}

// StructView is a structure as a client sees it.
type StructView struct {
	Alive     bool
	Kind      game.StructKind
	X, Y      int
	W, H      int
	HP, MaxHP uint16
	Level     uint8
	Owner     int8
}

// Tracer, Blast and Death are frame events in tiles.
type Tracer struct {
	X0, Y0, X1, Y1 float32
	Kind           uint8
}

// Blast is an explosion or pulse.
type Blast struct {
	X, Y, R float32
	Kind    uint8
}

// Death is where a creep died.
type Death struct {
	X, Y float32
	Kind game.CreepKind
}

// Replica is the client's copy of the world, rebuilt from frames. It is owned by the game
// loop: the network goroutine only hands it payloads.
type Replica struct {
	W, H    int
	Terrain []game.Tile
	Seed    uint64
	You     uint8

	Tick       uint32
	Phase      game.Phase
	Wave       int
	PhaseLeft  float32
	Pending    int // creeps of this wave still to spawn
	Kills      uint64
	Best       int
	Weather    game.WeatherKind
	WeatherAmt float32
	PausedBy   int // the player who paused the game, or -1
	Players    []PlayerView
	Searched   []bool  // per loot site, from the welcome's list
	Guards     []uint8 // per loot site, its living guards
	Crates     []CrateView

	Alive  bitset
	CX, CY [game.MaxCreeps]float32 // current position
	PX, PY [game.MaxCreeps]float32 // position the frame before, for interpolation
	Kind   [game.MaxCreeps]uint8
	HP     [game.MaxCreeps]uint8
	Flags  [game.MaxCreeps]uint8
	Target [game.MaxCreeps]uint8 // the chased player's id, 128+ an attack's angle, 255 none
	Flash  [game.MaxCreeps]uint8 // frames since the creep was last hurt, saturating
	qx, qy [game.MaxCreeps]uint16
	Count  int

	Structs  []StructView
	structAt []int16

	// Events since the renderer last drained them.
	Tracers []Tracer
	Blasts  []Blast
	Deaths  []Death
	Notes   []game.Note
	Pings   []game.Ping
	// Effects is the whole current list, replaced by every frame.
	Effects []Effect

	FrameAt time.Time
	Synced  bool // a keyframe has been applied
	Bytes   int  // payload bytes of the last frame, for the HUD
}

// NewReplica is an empty replica sized from a welcome.
func NewReplica(w, h int, terrain []game.Tile, you uint8, seed uint64) *Replica {
	r := &Replica{W: w, H: h, Terrain: terrain, You: you, Seed: seed}
	r.structAt = make([]int16, w*h)
	for i := range r.structAt {
		r.structAt[i] = -1
	}
	return r
}

// At implements game.Blocker.
func (r *Replica) At(x, y int) game.Tile {
	if x < 0 || y < 0 || x >= r.W || y >= r.H {
		return game.TRock
	}
	return r.Terrain[y*r.W+x]
}

// StructKindAt implements game.Blocker.
func (r *Replica) StructKindAt(x, y int) game.StructKind {
	if si := r.StructIndexAt(x, y); si >= 0 {
		return r.Structs[si].Kind
	}
	return game.SNone
}

// StructIndexAt is the structure on a tile, or -1.
func (r *Replica) StructIndexAt(x, y int) int {
	if x < 0 || y < 0 || x >= r.W || y >= r.H {
		return -1
	}
	return int(r.structAt[y*r.W+x])
}

// Me is this client's player, nil before the first frame.
func (r *Replica) Me() *PlayerView {
	for i := range r.Players {
		if r.Players[i].ID == r.You {
			return &r.Players[i]
		}
	}
	return nil
}

// Apply decodes one frame payload into the replica.
func (r *Replica) Apply(p []byte) error {
	d := &dec{b: p}
	flags := d.u8()
	key := flags&frameKey != 0
	if !key && !r.Synced {
		return nil // deltas before the first keyframe have nothing to apply to
	}
	r.header(d)
	r.Bytes = len(p)

	for id := range r.Flash {
		if r.Flash[id] < 255 {
			r.Flash[id]++
		}
	}
	if key {
		r.Alive = bitset{}
		n := int(d.uv())
		id := 0
		for i := 0; i < n && d.err == nil; i++ {
			id += int(d.uv())
			r.creepRec(d, id)
		}
	} else {
		n := int(d.uv())
		id := 0
		for i := 0; i < n && d.err == nil; i++ {
			id += int(d.uv())
			if id < game.MaxCreeps {
				r.Alive.clear(uint16(id))
			}
		}
		r.Alive.each(func(id uint16) {
			dx, dy := d.i8(), d.i8()
			r.PX[id], r.PY[id] = r.CX[id], r.CY[id]
			r.qx[id] = uint16(int(r.qx[id]) + int(dx))
			r.qy[id] = uint16(int(r.qy[id]) + int(dy))
			r.CX[id], r.CY[id] = unq(r.qx[id]), unq(r.qy[id])
		})
		n = int(d.uv())
		id = 0
		for i := 0; i < n && d.err == nil; i++ {
			id += int(d.uv())
			r.creepRec(d, id)
		}
		n = int(d.uv())
		id = 0
		for i := 0; i < n && d.err == nil; i++ {
			id += int(d.uv())
			h, f, tg := d.u8(), d.u8(), d.u8()
			if id < game.MaxCreeps {
				if h < r.HP[id] {
					r.Flash[id] = 0
				}
				r.HP[id], r.Flags[id], r.Target[id] = h, f, tg
			}
		}
	}
	n := 0
	r.Alive.each(func(uint16) { n++ })
	r.Count = n

	// Structures.
	if key {
		for i := range r.Structs {
			r.Structs[i].Alive = false
		}
	}
	ns := int(d.uv())
	for i := 0; i < ns && d.err == nil; i++ {
		idx := int(d.uv())
		if idx > 4096 {
			return fmt.Errorf("structure index %d out of range", idx)
		}
		for len(r.Structs) <= idx {
			r.Structs = append(r.Structs, StructView{})
		}
		var s StructView
		s.Alive = d.u8() == 1
		s.Kind = game.StructKind(d.u8())
		s.X, s.Y = int(d.u16()), int(d.u16())
		s.W, s.H = int(d.u8()), int(d.u8())
		s.HP, s.MaxHP = d.u16(), d.u16()
		s.Level = d.u8()
		s.Owner = d.i8()
		r.Structs[idx] = s
	}
	if !key {
		nh := int(d.uv())
		for i := 0; i < nh && d.err == nil; i++ {
			idx := int(d.uv())
			hp := d.u16()
			if idx < len(r.Structs) {
				r.Structs[idx].HP = hp
			}
		}
	}
	if ns > 0 || key {
		r.rebuildStructAt()
	}

	// Events.
	nt := int(d.uv())
	for i := 0; i < nt && d.err == nil; i++ {
		t := Tracer{unq(d.u16()), unq(d.u16()), unq(d.u16()), unq(d.u16()), d.u8()}
		if len(r.Tracers) < 4096 {
			r.Tracers = append(r.Tracers, t)
		}
	}
	nb := int(d.uv())
	for i := 0; i < nb && d.err == nil; i++ {
		b := Blast{unq(d.u16()), unq(d.u16()), float32(d.u8()) / 8, d.u8()}
		if len(r.Blasts) < 1024 {
			r.Blasts = append(r.Blasts, b)
		}
	}
	nd := int(d.uv())
	for i := 0; i < nd && d.err == nil; i++ {
		dt := Death{unq(d.u16()), unq(d.u16()), game.CreepKind(d.u8())}
		if len(r.Deaths) < 4096 {
			r.Deaths = append(r.Deaths, dt)
		}
	}
	ne := int(d.uv())
	r.Effects = r.Effects[:0]
	for i := 0; i < ne && d.err == nil; i++ {
		e := Effect{Kind: game.EffectKind(d.u8()), X0: unq(d.u16()), Y0: unq(d.u16()), X: unq(d.u16()), Y: unq(d.u16()),
			R: float32(d.u8()) / 8, Left: float32(d.u8()) / 10, Total: float32(d.u8()) / 10}
		if len(r.Effects) < 1024 {
			r.Effects = append(r.Effects, e)
		}
	}
	nn := int(d.uv())
	for i := 0; i < nn && d.err == nil; i++ {
		lvl := d.u8()
		r.Notes = append(r.Notes, game.Note{Level: lvl, Text: d.str()})
	}
	ng := int(d.uv())
	for i := 0; i < ng && d.err == nil; i++ {
		g := game.Ping{Player: d.u8(), X: unq(d.u16()), Y: unq(d.u16()), Kind: game.PingKind(d.u8())}
		if len(r.Pings) < 64 {
			r.Pings = append(r.Pings, g)
		}
	}
	if d.err != nil {
		return fmt.Errorf("frame: %w", d.err)
	}
	if key {
		r.Synced = true
	}
	r.FrameAt = time.Now()
	return nil
}

func (r *Replica) creepRec(d *dec, id int) {
	k, x, y, h, f, tg := d.u8(), d.u16(), d.u16(), d.u8(), d.u8(), d.u8()
	if id >= game.MaxCreeps || d.err != nil {
		return
	}
	r.Alive.set(uint16(id))
	r.Kind[id], r.HP[id], r.Flags[id], r.Target[id] = k, h, f, tg
	r.qx[id], r.qy[id] = x, y
	r.CX[id], r.CY[id] = unq(x), unq(y)
	r.PX[id], r.PY[id] = r.CX[id], r.CY[id]
	r.Flash[id] = 255
}

func (r *Replica) header(d *dec) {
	r.Tick = d.u32()
	r.Phase = game.Phase(d.u8())
	r.Wave = int(d.u16())
	r.PhaseLeft = float32(d.u16()) / 10
	r.Pending = int(d.uv())
	r.Kills = d.uv()
	r.Best = int(d.u16())
	r.Weather = game.WeatherKind(d.u8())
	r.WeatherAmt = float32(d.u8()) / 255
	r.PausedBy = int(d.u8()) - 1
	ns := int(d.uv())
	if ns > 4096 {
		d.err = fmt.Errorf("%d loot sites", ns)
		return
	}
	if len(r.Searched) != ns {
		r.Searched = make([]bool, ns)
		r.Guards = make([]uint8, ns)
	}
	for i := 0; i < ns; i++ {
		m := d.u8()
		r.Searched[i], r.Guards[i] = m&128 != 0, m&127
	}
	nc := int(d.uv())
	if nc > 64 {
		d.err = fmt.Errorf("%d supply crates", nc)
		return
	}
	r.Crates = r.Crates[:0]
	for i := 0; i < nc; i++ {
		r.Crates = append(r.Crates, CrateView{X: unq(d.u16()), Y: unq(d.u16()), Open: float32(d.u8()) / 255})
	}
	n := int(d.u8())
	old := r.Players
	r.Players = make([]PlayerView, 0, n)
	for i := 0; i < n && d.err == nil; i++ {
		var p PlayerView
		p.ID = d.u8()
		p.Name = d.str()
		f := d.u8()
		p.Connected, p.Alive, p.Firing = f&pConnected != 0, f&pAlive != 0, f&pFiring != 0
		p.Ready, p.Reloading, p.Hurt, p.AtArmory = f&pReady != 0, f&pReloading != 0, f&pHurt != 0, f&pAtArmory != 0
		p.Moving = f&pMoving != 0
		p.X, p.Y = unq(d.u16()), unq(d.u16())
		p.PX, p.PY = p.X, p.Y
		for _, o := range old {
			if o.ID == p.ID {
				p.PX, p.PY = o.X, o.Y
			}
		}
		p.Aim = unqAngle(d.u16())
		p.HP, p.MaxHP = d.u16(), d.u16()
		p.Order = game.OrderKind(d.u8())
		p.Channel = float32(d.u8()) / 255
		p.Revived = float32(d.u8()) / 255
		p.Emote = d.u8()
		p.EmoteLeft = float32(d.u8()) / 10
		p.TauntCool = float32(d.u16()) / 10
		p.Stamina = float32(d.u8()) / 255
		sp := d.u8()
		p.Sprinting, p.Winded = sp&1 != 0, sp&2 != 0
		p.Look = d.u32()
		p.Cur = game.WeaponKind(d.u8())
		p.Ammo = d.u16()
		p.ReloadFrac = float32(d.u8()) / 255
		p.Respawn = d.u8()
		p.Gold, p.Kills, p.Damage = d.uv(), d.uv(), d.uv()
		owned := d.u8()
		for k := 0; k < int(game.NumWeapons); k++ {
			if owned&(1<<k) != 0 {
				p.Owned[k] = true
				for t := range p.Lv[k] {
					p.Lv[k][t] = d.u8()
				}
			}
		}
		for g := range p.Gear {
			p.Gear[g] = d.u8()
		}
		p.Buff = d.u8()
		p.BuffLeft = float32(d.u8()) / 10
		for a := range p.Abil {
			p.Abil[a].Lv = d.u8()
			p.Abil[a].Cool = float32(d.u16()) / 10
		}
		p.Medkits = d.u8()
		p.Heal = float32(d.u8()) / 10
		p.ReloadMask = d.u8()
		r.Players = append(r.Players, p)
	}
}

func (r *Replica) rebuildStructAt() {
	for i := range r.structAt {
		r.structAt[i] = -1
	}
	for i, s := range r.Structs {
		if !s.Alive {
			continue
		}
		for y := s.Y; y < s.Y+s.H; y++ {
			for x := s.X; x < s.X+s.W; x++ {
				if x >= 0 && y >= 0 && x < r.W && y < r.H {
					r.structAt[y*r.W+x] = int16(i)
				}
			}
		}
	}
}

// Drain hands the accumulated events to the renderer and forgets them. The slices are only
// valid until the next Apply; the game loop consumes them before it applies another frame.
func (r *Replica) Drain() (t []Tracer, b []Blast, d []Death, n []game.Note, g []game.Ping) {
	t, b, d, n, g = r.Tracers, r.Blasts, r.Deaths, r.Notes, r.Pings
	r.Tracers, r.Blasts, r.Deaths, r.Notes, r.Pings = r.Tracers[:0], r.Blasts[:0], r.Deaths[:0], nil, nil
	return
}

// EachCreep calls fn for every live creep, in ascending id order.
func (r *Replica) EachCreep(fn func(id uint16)) { r.Alive.each(fn) }
