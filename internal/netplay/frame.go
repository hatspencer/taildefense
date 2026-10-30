package netplay

import (
	"bytes"
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
	chMask   [game.MaxCreeps]uint8 // what changed this tick, for the creeps in changed
	curAlive bitset
	cur      [game.MaxCreeps]int32 // creep id -> index in World.Creeps this tick

	structs []structRec

	removed, added, changed []uint16

	players [256]playerSent

	tick       uint32
	delta, key enc
	grp, esc   enc // scratch: one player group, the moves too far for a nibble
	keyOK      bool
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
	evo                 uint8
	hpDirty, shapeDirty bool
}

func structOf(s *game.Structure) structRec {
	return structRec{alive: s.Alive, ghost: s.Ghost, kind: s.Kind, x: uint16(s.X), y: uint16(s.Y), w: s.W, h: s.H,
		hp: uint16(max(math.Ceil(float64(s.HP)), 0)), max: uint16(s.MaxHP), level: s.Level, lv: s.Lv, owner: s.Owner, open: s.Open, evo: s.Evo}
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
	e.header(b, w, atArmory, false)

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
	e.esc.b = e.esc.b[:0]
	k, nib := 0, uint8(0)
	for wi, word := range e.alive {
		for word != 0 {
			id := uint16(wi<<6 | bits.TrailingZeros64(word))
			word &= word - 1
			c := &w.Creeps[e.cur[id]]
			dx := clampDelta(int(qpos(c.X)) - int(e.x[id]))
			dy := clampDelta(int(qpos(c.Y)) - int(e.y[id]))
			nib |= moveNibble(dx, dy, &e.esc) << (k & 1 * 4)
			if k&1 == 1 {
				b.u8(nib)
				nib = 0
			}
			k++
			e.x[id] = uint16(int(e.x[id]) + dx)
			e.y[id] = uint16(int(e.y[id]) + dy)
			var m uint8
			h, f, fx, tg := hp8(c.HP, c.MaxHP), creepFlags(c), creepFx(c), creepTarget(c)
			if h != e.hp[id] {
				m |= chHP
			}
			if f != e.fl[id] {
				m |= chFlags
			}
			if fx != e.fx[id] {
				m |= chFx
			}
			if tg != e.tg[id] {
				m |= chTarget
			}
			if m != 0 {
				e.hp[id], e.fl[id], e.fx[id], e.tg[id] = h, f, fx, tg
				e.chMask[id] = m
				changed = append(changed, id)
			}
		}
	}
	if k&1 == 1 {
		b.u8(nib)
	}
	b.b = append(b.b, e.esc.b...)
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
		// The gap to the last id with the mask of what changed in its low four bits: one
		// byte for a horde losing hit points, ids a few apart.
		m := e.chMask[id]
		b.uv(uint64(int(id)-prev)<<4 | uint64(m))
		prev = int(id)
		if m&chHP != 0 {
			b.u8(e.hp[id])
		}
		if m&chFlags != 0 {
			b.u8(e.fl[id])
		}
		if m&chFx != 0 {
			b.u8(e.fx[id])
		}
		if m&chTarget != 0 {
			b.u8(e.tg[id])
		}
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
		o.shapeDirty = r.alive != o.alive || r.ghost != o.ghost || r.kind != o.kind || r.level != o.level || r.lv != o.lv || r.max != o.max || r.x != o.x || r.y != o.y || r.open != o.open || r.evo != o.evo
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
	e.header(b, w, atArmory, true)
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

// What changed in a creep, in the low bits of its entry in the changed list.
const (
	chHP = 1 << iota
	chFlags
	chFx
	chTarget
)

// A creep's move is a nibble, two creeps a byte: two bits an axis, 0 still, 1 an eighth of a
// tile forward, 2 back, and 3 on either axis for a move further than that, whose dx, dy follow
// as an i8 pair after all the nibbles. A walker covers well under an eighth a tick, so nearly
// every move fits, and a horde standing at a wall is a run of zero bytes that deflate all but
// erases.
const moveEscape = 0xf

func moveNibble(dx, dy int, esc *enc) uint8 {
	// A table, not a switch: whether a walker stepped an eighth this tick is a coin toss to
	// the branch predictor, and with 16k creeps the mispredictions were most of the encode.
	if uint(dx+1) < 3 && uint(dy+1) < 3 {
		return axisCode[dx+1] | axisCode[dy+1]<<2
	}
	esc.i8(int8(dx))
	esc.i8(int8(dy))
	return moveEscape
}

// axisCode is an axis's code by its move + 1, axisMove the move by its code.
var (
	axisCode = [3]uint8{2, 0, 1}
	axisMove = [3]int{0, 1, -1}
)

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
	state := r.evo << 1
	if r.open {
		state |= 1
	}
	b.u8(state)
}

func (e *Encoder) header(b *enc, w *game.World, atArmory func(*game.Player) bool, key bool) {
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
	b.u8(w.Tier)
	b.u16(uint16(w.TierPaid))
	b.u16(uint16(w.TierCost()))
	var ov uint8
	if w.OverloadReady() {
		ov = 1
	}
	b.u8(ov)
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
		b.u8(g.Evo)
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
		e.player(b, w, p, atArmory, key)
	}
	if !key {
		// Who this frame listed is the base for the next; a player gone from the list is
		// sent whole if they come back.
		for id := range e.players {
			e.players[id].listed = false
		}
		for _, p := range w.Players {
			e.players[p.ID].listed = true
		}
	}
}

// A player's record is a few fields that change nearly every tick, sent always, then groups
// of the rest that are sent only when something in them changed since the last frame: a
// survivor standing still in a break costs eight bytes, not a hundred. The groups come in
// order of how often they change, so the usual mask (motion, combat, score) fits a byte.
const (
	pgMotion  = iota // stamina and the sprint bits
	pgCombat         // the weapon in hand, its ammo and reload, the ultimate, a legendary's swings and art
	pgTimers         // emotes, taunts, buffs, healing, ability cooldowns, the respawn
	pgOrder          // the order and how far its channel is, how far a revive on them is
	pgScore          // gold, kills, damage
	pgKit            // most hit points, medkits, ability levels
	pgTally          // the game's statistics
	pgName           // the name
	pgLook           // the look
	pgArsenal        // weapons owned, their levels and evolutions
	pgGear           // gear levels
	numGroups
)

const allGroups = 1<<numGroups - 1

// playerSent is what the last delta frame said of one player, by id.
type playerSent struct {
	listed bool // in the last delta's player list
	group  [numGroups][]byte
}

func (e *Encoder) player(b *enc, w *game.World, p *game.Player, atArmory func(*game.Player) bool, key bool) {
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
	if p.Weapons[p.Cur].Reload > 0 {
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
	b.u8(f)
	b.u16(qpos(p.X))
	b.u16(qpos(p.Y))
	b.u16(qangle(p.Aim))
	b.u16(uint16(max(p.HP, 0)))

	s := &e.players[p.ID]
	if key {
		// A key frame is the sent state: what the last delta said of a listed player (the
		// next delta is a difference from that), the world for anyone it did not list.
		b.uv(allGroups)
		for g := range numGroups {
			if s.listed {
				b.b = append(b.b, s.group[g]...)
			} else {
				e.grp.b = e.grp.b[:0]
				playerGroup(&e.grp, g, w, p)
				b.b = append(b.b, e.grp.b...)
			}
		}
		return
	}
	var mask uint64
	for g := range numGroups {
		e.grp.b = e.grp.b[:0]
		playerGroup(&e.grp, g, w, p)
		if !s.listed || !bytes.Equal(e.grp.b, s.group[g]) {
			s.group[g] = append(s.group[g][:0], e.grp.b...)
			mask |= 1 << g
		}
	}
	b.uv(mask)
	for g := range numGroups {
		if mask&(1<<g) != 0 {
			b.b = append(b.b, s.group[g]...)
		}
	}
}

// playerGroup writes one group of a player's record; replica.playerGroup reads it.
func playerGroup(b *enc, g int, w *game.World, p *game.Player) {
	ws := &p.Weapons[p.Cur]
	switch g {
	case pgMotion:
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
	case pgCombat:
		b.u8(uint8(p.Cur))
		b.u16(uint16(max(ws.Ammo, 0)))
		st := ws.Stats(p.Cur)
		reload := uint8(0)
		if ws.Reload > 0 && st.Reload > 0 {
			reload = uint8(min(ws.Reload/st.Reload, 1) * 255)
		}
		b.u8(reload)
		var reloading uint16
		for k := range p.Weapons {
			if p.Weapons[k].Reload > 0 {
				reloading |= 1 << k
			}
		}
		b.u16(reloading)
		b.u8(uint8(min(max(p.Ult, 0), 1) * 255))
		// A legendary's swings so far, its weapon art (the art in the top two bits, how far
		// through it below) and the seconds until the art is ready.
		b.u8(p.Swings)
		art := p.Art << 6
		if p.Art != game.ArtNone && p.ArtTotal > 0 {
			art |= uint8(min(max(1-p.ArtLeft/p.ArtTotal, 0), 1) * 63)
		}
		b.u8(art)
		b.u16(uint16(min(math.Ceil(float64(p.ArtCool*10)), 65535)))
	case pgTimers:
		b.u8(p.Emote)
		b.u8(deci(p.EmoteLeft))
		b.u16(uint16(min(math.Ceil(float64(p.TauntCool*10)), 65535)))
		if p.BuffLeft > 0 {
			b.u8(uint8(p.Buff) + 1)
		} else {
			b.u8(0)
		}
		b.u8(deci(p.BuffLeft))
		b.u8(deci(p.Heal))
		for _, a := range p.Abil {
			b.u16(uint16(min(math.Ceil(float64(a.Cool*10)), 65535)))
		}
		b.u8(uint8(max(p.Respawn, 0) + .99))
	case pgOrder:
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
	case pgScore:
		b.uv(uint64(max(p.Gold, 0)))
		b.uv(uint64(p.Kills))
		b.uv(uint64(p.Damage))
	case pgKit:
		b.u16(uint16(p.MaxHP))
		b.u8(p.Medkits)
		for _, a := range p.Abil {
			b.u8(a.Lv)
		}
	case pgTally:
		t := &p.Tally
		for _, v := range [...]uint32{t.Downs, t.Revives, t.Built, t.Searched, t.Bosses} {
			b.uv(uint64(v))
		}
		b.uv(uint64(t.Taken))
		b.uv(uint64(t.Turret))
	case pgName:
		b.str(p.Name)
	case pgLook:
		b.u32(p.Look)
	case pgArsenal:
		var owned uint16
		for k := range p.Weapons {
			if p.Weapons[k].Owned {
				owned |= 1 << k
			}
		}
		if p.Weapons[game.WPistol].Dual {
			owned |= game.DualBit
		}
		if p.Weapons[game.WKatana].Dual {
			owned |= game.DualKatanaBit
		}
		if p.Picking {
			owned |= game.PickBit
		}
		b.u16(owned)
		for k := range p.Weapons {
			if p.Weapons[k].Owned {
				b.b = append(b.b, p.Weapons[k].Lv[:]...)
			}
		}
		// The blades' evolutions, two bits each: the katana, the greatsword, the crowbar.
		b.u8(p.Weapons[game.WKatana].Evo | p.Weapons[game.WGreat].Evo<<2 | p.Weapons[game.WCrowbar].Evo<<4)
	case pgGear:
		b.b = append(b.b, p.Gear[:]...)
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
