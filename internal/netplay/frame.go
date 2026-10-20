package netplay

import (
	"math"
	"math/bits"

	"taildefense/internal/game"
)

const words = game.MaxCreeps / 64

type bitset [words]uint64

func (b *bitset) set(i uint16)      { b[i>>6] |= 1 << (i & 63) }
func (b *bitset) clear(i uint16)    { b[i>>6] &^= 1 << (i & 63) }
func (b *bitset) has(i uint16) bool { return b[i>>6]&(1<<(i&63)) != 0 }

// each calls fn for every set bit, ascending.
func (b *bitset) each(fn func(i uint16)) {
	for wi, w := range b {
		for w != 0 {
			t := bits.TrailingZeros64(w)
			fn(uint16(wi<<6 | t))
			w &= w - 1
		}
	}
}

// Creep flags on the wire.
const (
	flagBurning = 1 << 0
	flagSlowed  = 1 << 1
	flagGuard   = 1 << 2
	flagHunting = 1 << 3
	flagSiege   = 1 << 4
	flagAsleep  = 1 << 5
	flagWindup  = 1 << 6
	flagStrike  = 1 << 7
)

// More creep flags, in a second byte.
const (
	fxFrenzy = 1 << 0 // lost its patience with the maze: faster, tearing through walls
	// Its wave's affixes it carries, game.Affix shifted up past fxFrenzy.
	fxAffixShift = 1
)

// Player flags on the wire.
const (
	pConnected = 1 << iota
	pAlive
	pFiring
	pReady
	pReloading
	pHurt
	pAtArmory
	pMoving
)

const frameKey = 1

// Encoder holds what every client has been sent, so each tick only the difference goes out.
// All clients share one encoder: a client that misses a frame is resynchronised with a
// keyframe built from the same sent state, after which the shared deltas apply again.
type Encoder struct {
	alive    bitset
	x, y     [game.MaxCreeps]uint16
	hp, fl   [game.MaxCreeps]uint8
	fx       [game.MaxCreeps]uint8 // more flags (fxFrenzy)
	tg       [game.MaxCreeps]uint8 // the chased player's id, 255 none
	kind     [game.MaxCreeps]uint8
	curAlive bitset
	cur      [game.MaxCreeps]int32 // creep id -> index in World.Creeps this tick

	structs []structRec

	removed, added, changed []uint16

	tick  uint32
	delta enc
	key   enc
	keyOK bool
}

type structRec struct {
	alive, ghost        bool
	kind                game.StructKind
	x, y                uint16
	w, h                uint8
	hp, max             uint16
	level               uint8
	lv                  [game.NumTracks]uint8
	owner               int8
	open                bool
	hpDirty, shapeDirty bool
}

func structOf(s *game.Structure) structRec {
	return structRec{alive: s.Alive, ghost: s.Ghost, kind: s.Kind, x: uint16(s.X), y: uint16(s.Y), w: s.W, h: s.H,
		hp: uint16(max(math.Ceil(float64(s.HP)), 0)), max: uint16(s.MaxHP), level: s.Level, lv: s.Lv, owner: s.Owner, open: s.Open}
}

func hp8(hp, maxHP float32) uint8 {
	if maxHP <= 0 {
		return 0
	}
	return uint8(min(max(math.Ceil(float64(hp/maxHP*255)), 1), 255))
}

func creepFlags(c *game.Creep) uint8 {
	var f uint8
	if c.Burn > 0 {
		f |= flagBurning
	}
	if c.Slow > 0 {
		f |= flagSlowed
	}
	if c.Home > 0 {
		f |= flagGuard
	}
	if c.Chase >= 0 {
		f |= flagHunting
	}
	if c.Siege >= 0 && c.Chase < 0 {
		f |= flagSiege
	}
	if c.Asleep {
		f |= flagAsleep
	}
	switch c.Swing {
	case game.SwingWindup:
		f |= flagWindup
	case game.SwingStrike:
		f |= flagStrike
	}
	return f
}

func creepFx(c *game.Creep) uint8 {
	var f uint8
	if c.Frenzy {
		f |= fxFrenzy
	}
	return f | uint8(c.Aff)<<fxAffixShift
}

// creepTarget is the chased player's id; else, for a creep attacking a structure, 128 + the
// angle to it in 127ths of a turn; else 255.
func creepTarget(c *game.Creep) uint8 {
	if c.Chase >= 0 {
		return uint8(c.Chase)
	}
	if c.Swing != game.SwingNone {
		return 128 + uint8(int(math.Round(float64(c.Face)/(2*math.Pi)*127)+127)%127)
	}
	return 255
}

// Delta encodes this tick against the last and moves the sent state forward. Call it once per
// tick, then Key as often as clients need resynchronising.
func (e *Encoder) Delta(w *game.World, atArmory func(*game.Player) bool) []byte {
	e.tick = w.Tick
	e.keyOK = false
	b := &e.delta
	b.b = b.b[:0]
	b.u8(0)
	e.header(b, w, atArmory)

	// Creeps: current alive set and index by id.
	e.curAlive = bitset{}
	for i := range w.Creeps {
		id := w.Creeps[i].ID
		e.curAlive.set(id)
		e.cur[id] = int32(i)
	}
	// Removed: alive before, not now.
	removed, added := e.removed[:0], e.added[:0]
	for wi := range e.alive {
		gone := e.alive[wi] &^ e.curAlive[wi]
		for gone != 0 {
			t := bits.TrailingZeros64(gone)
			removed = append(removed, uint16(wi<<6|t))
			gone &= gone - 1
		}
		fresh := e.curAlive[wi] &^ e.alive[wi]
		for fresh != 0 {
			t := bits.TrailingZeros64(fresh)
			added = append(added, uint16(wi<<6|t))
			fresh &= fresh - 1
		}
	}
	b.uv(uint64(len(removed)))
	prev := 0
	for _, id := range removed {
		b.uv(uint64(int(id) - prev))
		prev = int(id)
		e.alive.clear(id)
	}
	// Moves, for every creep alive in both, in id order. The client walks the same set.
	changed := e.changed[:0]
	e.alive.each(func(id uint16) {
		c := &w.Creeps[e.cur[id]]
		dx := clampDelta(int(qpos(c.X)) - int(e.x[id]))
		dy := clampDelta(int(qpos(c.Y)) - int(e.y[id]))
		b.i8(int8(dx))
		b.i8(int8(dy))
		e.x[id] = uint16(int(e.x[id]) + dx)
		e.y[id] = uint16(int(e.y[id]) + dy)
		h, f, fx, tg := hp8(c.HP, c.MaxHP), creepFlags(c), creepFx(c), creepTarget(c)
		if h != e.hp[id] || f != e.fl[id] || fx != e.fx[id] || tg != e.tg[id] {
			e.hp[id], e.fl[id], e.fx[id], e.tg[id] = h, f, fx, tg
			changed = append(changed, id)
		}
	})
	b.uv(uint64(len(added)))
	prev = 0
	for _, id := range added {
		c := &w.Creeps[e.cur[id]]
		e.alive.set(id)
		e.x[id], e.y[id] = qpos(c.X), qpos(c.Y)
		e.hp[id], e.fl[id], e.fx[id], e.kind[id], e.tg[id] = hp8(c.HP, c.MaxHP), creepFlags(c), creepFx(c), uint8(c.Kind), creepTarget(c)
		b.uv(uint64(int(id) - prev))
		prev = int(id)
		e.creepRec(b, id)
	}
	b.uv(uint64(len(changed)))
	prev = 0
	for _, id := range changed {
		b.uv(uint64(int(id) - prev))
		prev = int(id)
		b.u8(e.hp[id])
		b.u8(e.fl[id])
		b.u8(e.fx[id])
		b.u8(e.tg[id])
	}
	e.removed, e.added, e.changed = removed, added, changed

	// Structures: full records for new or reshaped ones, hit points for the rest.
	for len(e.structs) < len(w.Structs) {
		e.structs = append(e.structs, structRec{})
	}
	nShape, nHP := 0, 0
	for i := range e.structs {
		// One past the world's list (a restart's new map has fewer) is sent once as gone.
		var r structRec
		if i < len(w.Structs) {
			r = structOf(&w.Structs[i])
		}
		o := &e.structs[i]
		o.shapeDirty = r.alive != o.alive || r.ghost != o.ghost || r.kind != o.kind || r.level != o.level || r.lv != o.lv || r.max != o.max || r.x != o.x || r.y != o.y || r.open != o.open
		o.hpDirty = !o.shapeDirty && r.hp != o.hp
		if o.shapeDirty {
			nShape++
		} else if o.hpDirty {
			nHP++
		}
		r.hpDirty, r.shapeDirty = o.hpDirty, o.shapeDirty
		*o = r
	}
	b.uv(uint64(nShape))
	for i := range e.structs {
		if e.structs[i].shapeDirty {
			b.uv(uint64(i))
			structRecord(b, &e.structs[i])
		}
	}
	b.uv(uint64(nHP))
	for i := range e.structs {
		if e.structs[i].hpDirty {
			b.uv(uint64(i))
			b.u16(e.structs[i].hp)
		}
	}
	// Key frames list only what the world has.
	e.structs = e.structs[:len(w.Structs)]
	events(b, w)
	// Ground first seen this tick, at night, in tile order.
	b.uv(uint64(len(w.Found)))
	prev = 0
	for _, i := range w.Found {
		b.uv(uint64(int(i) - prev))
		prev = int(i)
	}
	return b.b
}

// Key encodes the full sent state of the current tick, for a client joining or catching up.
func (e *Encoder) Key(w *game.World, atArmory func(*game.Player) bool) []byte {
	if e.keyOK {
		return e.key.b
	}
	b := &e.key
	b.b = b.b[:0]
	b.u8(frameKey)
	e.header(b, w, atArmory)
	n := 0
	e.alive.each(func(uint16) { n++ })
	b.uv(uint64(n))
	prev := 0
	e.alive.each(func(id uint16) {
		b.uv(uint64(int(id) - prev))
		prev = int(id)
		e.creepRec(b, id)
	})
	b.uv(uint64(len(e.structs)))
	for i := range e.structs {
		b.uv(uint64(i))
		structRecord(b, &e.structs[i])
	}
	events(b, w)
	// All the ground found so far, at night.
	b.uv(uint64(len(w.Seen)))
	for _, v := range w.Seen {
		b.u32(uint32(v))
		b.u32(uint32(v >> 32))
	}
	e.keyOK = true
	return b.b
}

func clampDelta(d int) int { return min(max(d, -127), 127) }

func (e *Encoder) creepRec(b *enc, id uint16) {
	b.u8(e.kind[id])
	b.u16(e.x[id])
	b.u16(e.y[id])
	b.u8(e.hp[id])
	b.u8(e.fl[id])
	b.u8(e.fx[id])
	b.u8(e.tg[id])
}

func structRecord(b *enc, r *structRec) {
	// 0 gone, 1 standing, 2 a ghost to rebuild.
	var alive uint8
	if r.alive {
		alive = 1
	} else if r.ghost {
		alive = 2
	}
	b.u8(alive)
	b.u8(uint8(r.kind))
	b.u16(r.x)
	b.u16(r.y)
	b.u8(r.w)
	b.u8(r.h)
	b.u16(r.hp)
	b.u16(r.max)
	b.u8(r.level)
	b.b = append(b.b, r.lv[:]...)
	b.i8(r.owner)
	var state uint8
	if r.open {
		state |= 1
	}
	b.u8(state)
}

func (e *Encoder) header(b *enc, w *game.World, atArmory func(*game.Player) bool) {
	b.u32(w.Tick)
	b.u8(uint8(w.Phase))
	b.u16(uint16(w.Wave))
	b.u16(uint16(max(w.PhaseLeft, 0) * 10))
	b.uv(uint64(w.CreepsLeft))
	b.uv(uint64(w.TotalKills))
	b.u16(uint16(w.Best))
	b.u8(uint8(w.Weather))
	b.u8(uint8(w.WeatherAmt * 255))
	b.u8(uint8(w.Paused + 1))
	b.u8(uint8(w.Affix))
	b.u8(uint8(w.NextAffix))
	b.u8(w.NextFrom)
	// Per loot site: searched in bit 7, living guards below; small enough to send whole.
	b.uv(uint64(len(w.Sites)))
	for i := range w.Sites {
		m := min(w.Sites[i].Guards, 127)
		if w.Sites[i].Searched {
			m |= 128
		}
		b.u8(m)
	}
	b.uv(uint64(len(w.Crates)))
	for _, c := range w.Crates {
		b.u16(qpos(c.X))
		b.u16(qpos(c.Y))
		b.u8(uint8(min(c.Open/game.CrateOpenTime(), 1) * 255))
	}
	b.uv(uint64(len(w.Guns)))
	for i := range w.Guns {
		g := &w.Guns[i]
		b.u16(g.ID)
		b.u8(uint8(g.Kind))
		b.u16(qpos(g.X))
		b.u16(qpos(g.Y))
		b.b = append(b.b, g.Lv[:]...)
		b.u8(g.By)
	}
	// The evac Huey, once it is called.
	ev := &w.Evac
	b.u8(uint8(ev.Stage))
	if ev.Stage != game.EvacNone {
		b.u16(uint16(min(max(math.Ceil(float64(ev.Left*10)), 0), 65535)))
		b.u16(qpos(ev.X))
		b.u16(qpos(ev.Y))
		b.u8(uint8(min(max(ev.Alt, 0), 1) * 255))
		b.u16(qangle(ev.Heading))
	}
	b.u8(uint8(len(w.Players)))
	for _, p := range w.Players {
		var f uint8
		if p.Connected {
			f |= pConnected
		}
		if p.Alive {
			f |= pAlive
		}
		if p.Firing {
			f |= pFiring
		}
		if p.Ready {
			f |= pReady
		}
		ws := &p.Weapons[p.Cur]
		if ws.Reload > 0 {
			f |= pReloading
		}
		if p.Hurt > 0 {
			f |= pHurt
		}
		if atArmory != nil && atArmory(p) {
			f |= pAtArmory
		}
		if p.Moving {
			f |= pMoving
		}
		b.u8(p.ID)
		b.str(p.Name)
		b.u8(f)
		b.u16(qpos(p.X))
		b.u16(qpos(p.Y))
		b.u16(qangle(p.Aim))
		b.u16(uint16(max(p.HP, 0)))
		b.u16(uint16(p.MaxHP))
		b.u8(uint8(p.Order.Kind))
		var channel uint8
		switch {
		case p.Order.Kind == game.OrderLoot && p.Order.Site < len(w.Sites):
			channel = uint8(min(p.Search/game.SiteDefs[w.Sites[p.Order.Site].Kind].Search, 1) * 255)
		case p.Order.Kind == game.OrderRevive:
			_, t, _ := game.ReviveInfo()
			channel = uint8(min(p.Search/t, 1) * 255)
		case p.Order.Kind == game.OrderPickup:
			channel = uint8(min(p.Search/game.GunPickupTime(), 1) * 255)
		case p.Order.Kind == game.OrderBoard:
			_, _, _, _, _, _, _, _, t, _ := game.EvacInfo()
			channel = uint8(min(p.Search/t, 1) * 255)
		}
		b.u8(channel)
		b.u8(uint8(min(p.Revived, 1) * 255))
		b.u8(p.Emote)
		b.u8(deci(p.EmoteLeft))
		b.u16(uint16(min(math.Ceil(float64(p.TauntCool*10)), 65535)))
		b.u8(uint8(min(max(p.Stamina, 0), 1) * 255))
		sprint := uint8(0)
		if p.Sprinting() && p.Moving {
			sprint |= 1
		}
		if p.Winded {
			sprint |= 2
		}
		if p.Goggles {
			sprint |= 8
		}
		if p.Stunned() {
			sprint |= 4
		}
		if p.Shield > 0 {
			sprint |= 16
		}
		if p.Aboard {
			sprint |= 32
		}
		if p.Held() {
			sprint |= 64
		}
		if p.Airborne() {
			sprint |= 128
		}
		b.u8(sprint)
		b.u32(p.Look)
		b.u8(uint8(p.Cur))
		b.u16(uint16(max(ws.Ammo, 0)))
		st := ws.Stats(p.Cur)
		reload := uint8(0)
		if ws.Reload > 0 && st.Reload > 0 {
			reload = uint8(min(ws.Reload/st.Reload, 1) * 255)
		}
		b.u8(reload)
		b.u8(uint8(max(p.Respawn, 0) + .99))
		b.uv(uint64(max(p.Gold, 0)))
		b.uv(uint64(p.Kills))
		b.uv(uint64(p.Damage))
		var owned uint8
		for k := range p.Weapons {
			if p.Weapons[k].Owned {
				owned |= 1 << k
			}
		}
		if p.Weapons[game.WPistol].Dual {
			owned |= game.DualBit
		}
		b.u8(owned)
		for k := range p.Weapons {
			if p.Weapons[k].Owned {
				for _, l := range p.Weapons[k].Lv {
					b.u8(l)
				}
			}
		}
		for _, g := range p.Gear {
			b.u8(g)
		}
		if p.BuffLeft > 0 {
			b.u8(uint8(p.Buff) + 1)
		} else {
			b.u8(0)
		}
		b.u8(deci(p.BuffLeft))
		b.u8(uint8(min(max(p.Ult, 0), 1) * 255))
		for _, a := range p.Abil {
			b.u8(a.Lv)
			b.u16(uint16(min(math.Ceil(float64(a.Cool*10)), 65535)))
		}
		b.u8(p.Medkits)
		b.u8(deci(p.Heal))
		var reloading uint8
		for k := range p.Weapons {
			if p.Weapons[k].Reload > 0 {
				reloading |= 1 << k
			}
		}
		b.u8(reloading)
		t := &p.Tally
		for _, v := range [...]uint32{t.Downs, t.Revives, t.Built, t.Searched, t.Bosses} {
			b.uv(uint64(v))
		}
		b.uv(uint64(t.Taken))
		b.uv(uint64(t.Turret))
	}
}

// deci is seconds as deciseconds in a byte, rounded up so a running timer never reads 0.
func deci(s float32) uint8 {
	return uint8(min(max(math.Ceil(float64(s*10)), 0), 255))
}

func events(b *enc, w *game.World) {
	b.uv(uint64(len(w.Tracers)))
	for _, t := range w.Tracers {
		b.u16(qpos(t.X0))
		b.u16(qpos(t.Y0))
		b.u16(qpos(t.X1))
		b.u16(qpos(t.Y1))
		b.u8(t.Kind)
	}
	b.uv(uint64(len(w.Blasts)))
	for _, x := range w.Blasts {
		b.u16(qpos(x.X))
		b.u16(qpos(x.Y))
		b.u8(uint8(min(x.R*8, 255)))
		b.u8(x.Kind)
	}
	b.uv(uint64(len(w.Deaths)))
	for _, d := range w.Deaths {
		b.u16(qpos(d.X))
		b.u16(qpos(d.Y))
		b.u8(uint8(d.Kind))
	}
	b.uv(uint64(len(w.Effects)))
	for _, e := range w.Effects {
		b.u8(uint8(e.Kind))
		b.u16(qpos(e.X0))
		b.u16(qpos(e.Y0))
		b.u16(qpos(e.X))
		b.u16(qpos(e.Y))
		b.u8(uint8(min(e.R*8, 255)))
		b.u8(deci(e.Left))
		b.u8(deci(e.Total))
	}
	b.uv(uint64(len(w.Notes)))
	for _, n := range w.Notes {
		b.u8(n.Level)
		b.str(n.Text)
	}
	b.uv(uint64(len(w.Pings)))
	for _, g := range w.Pings {
		b.u8(g.Player)
		b.u16(qpos(g.X))
		b.u16(qpos(g.Y))
		b.u8(uint8(g.Kind))
	}
}
