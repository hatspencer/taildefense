package game

import (
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"math"
)

// Check reports the first broken invariant of the world between ticks, or nil. The playtests
// run it after every tick of every game they play; it is too slow for the host's own loop.
func (w *World) Check() error {
	if w.Phase > PhaseEvac {
		return fmt.Errorf("phase %d", w.Phase)
	}
	if !finite(w.PhaseLeft) || !finite(w.WaveTime) {
		return fmt.Errorf("phase left %v, wave time %v", w.PhaseLeft, w.WaveTime)
	}
	if n := len(w.Creeps) + len(w.freeIDs) + len(w.freed); n != MaxCreeps {
		return fmt.Errorf("%d creeps and %d+%d free ids do not make %d", len(w.Creeps), len(w.freeIDs), len(w.freed), MaxCreeps)
	}
	seen := make([]bool, MaxCreeps)
	for _, id := range append(w.freeIDs[:len(w.freeIDs):len(w.freeIDs)], w.freed...) {
		if int(id) >= MaxCreeps || seen[id] {
			return fmt.Errorf("free id %d out of range or twice", id)
		}
		seen[id] = true
	}
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if int(c.ID) >= MaxCreeps || seen[c.ID] {
			return fmt.Errorf("creep id %d out of range, free, or taken twice", c.ID)
		}
		seen[c.ID] = true
		if c.Kind >= NumCreepKinds {
			return fmt.Errorf("creep %d kind %d", c.ID, c.Kind)
		}
		if !w.inside(c.X, c.Y) {
			return fmt.Errorf("creep %d (%s) at %v,%v, off the map", c.ID, Creeps[c.Kind].Name, c.X, c.Y)
		}
		if !finite(c.HP) || !(c.MaxHP > 0) || c.HP > c.MaxHP*1.0001 {
			return fmt.Errorf("creep %d (%s) hp %v of %v", c.ID, Creeps[c.Kind].Name, c.HP, c.MaxHP)
		}
		if int(c.Hunt) >= len(w.Players) || c.Hunt < -1 {
			return fmt.Errorf("creep %d hunts player %d of %d", c.ID, c.Hunt, len(w.Players))
		}
		if int(c.Siege) >= len(w.Structs) || c.Siege < -1 {
			return fmt.Errorf("creep %d sieges structure %d of %d", c.ID, c.Siege, len(w.Structs))
		}
	}

	for i := range w.Structs {
		s := &w.Structs[i]
		if !s.Alive {
			continue
		}
		if s.X < 0 || s.Y < 0 || int(s.X)+int(s.W) > w.W || int(s.Y)+int(s.H) > w.H {
			return fmt.Errorf("structure %d (%s) at %d,%d hangs off the map", i, Structs[s.Kind].Name, s.X, s.Y)
		}
		if !finite(s.HP) || s.HP > s.MaxHP*1.0001 {
			return fmt.Errorf("structure %d (%s) hp %v of %v", i, Structs[s.Kind].Name, s.HP, s.MaxHP)
		}
		for ty := int(s.Y); ty < int(s.Y)+int(s.H); ty++ {
			for tx := int(s.X); tx < int(s.X)+int(s.W); tx++ {
				if got := w.structAt[ty*w.W+tx]; int(got) != i {
					return fmt.Errorf("tile %d,%d of structure %d (%s) maps to %d", tx, ty, i, Structs[s.Kind].Name, got)
				}
			}
		}
	}
	for t, si := range w.structAt {
		if si < 0 {
			continue
		}
		if int(si) >= len(w.Structs) || !w.Structs[si].Alive {
			return fmt.Errorf("tile %d,%d maps to dead structure %d", t%w.W, t/w.W, si)
		}
	}
	if w.Phase != PhaseOver && !w.Structs[w.Core].Alive {
		return fmt.Errorf("the generator is gone in phase %s", w.Phase)
	}

	for _, p := range w.Players {
		if !w.inside(p.X, p.Y) {
			return fmt.Errorf("%s at %v,%v, off the map", p.Name, p.X, p.Y)
		}
		if !finite(p.HP) || p.HP < 0 || p.HP > p.MaxHP*1.0001 {
			return fmt.Errorf("%s hp %v of %v", p.Name, p.HP, p.MaxHP)
		}
		if p.Aboard && (p.Alive || w.Phase != PhaseEvac && w.Phase != PhaseOver) {
			return fmt.Errorf("%s aboard the Huey, alive %v in phase %s", p.Name, p.Alive, w.Phase)
		}
		if p.Alive && p.HP <= 0 {
			return fmt.Errorf("%s alive on %v hp", p.Name, p.HP)
		}
		if p.Gold < 0 {
			return fmt.Errorf("%s has %d gold", p.Name, p.Gold)
		}
		if !finite(p.Stamina) || p.Stamina < 0 || p.Stamina > 1.0001 {
			return fmt.Errorf("%s stamina %v", p.Name, p.Stamina)
		}
		if p.Cur >= NumWeapons || !p.Weapons[p.Cur].Owned {
			return fmt.Errorf("%s holds weapon %d, not theirs", p.Name, p.Cur)
		}
		for k, ws := range p.Weapons {
			if ws.Ammo < 0 || !finite(ws.Reload) || !finite(ws.Cool) {
				return fmt.Errorf("%s weapon %d ammo %d reload %v cool %v", p.Name, k, ws.Ammo, ws.Reload, ws.Cool)
			}
		}
		if p.Alive && !CanStand(w, p.X, p.Y) {
			return fmt.Errorf("%s stands inside something at %.2f,%.2f (tile %v, structure %s)", p.Name, p.X, p.Y,
				w.At(int(p.X), int(p.Y)), Structs[w.StructKindAt(int(p.X), int(p.Y))].Name)
		}
	}

	if len(w.Guns) > gunMax {
		return fmt.Errorf("%d weapons on the ground, more than %d", len(w.Guns), gunMax)
	}
	for _, g := range w.Guns {
		if g.Kind >= NumWeapons || !w.inside(g.X, g.Y) || g.Ammo < 0 {
			return fmt.Errorf("weapon %d on the ground: kind %d at %v,%v ammo %d", g.ID, g.Kind, g.X, g.Y, g.Ammo)
		}
		for _, l := range g.Lv {
			if l > MaxLevel {
				return fmt.Errorf("weapon %d on the ground at level %d", g.ID, l)
			}
		}
	}

	for _, r := range w.Rockets {
		if !finite(r.X) || !finite(r.Y) || !finite(r.VX) || !finite(r.VY) {
			return fmt.Errorf("rocket at %v,%v moving %v,%v", r.X, r.Y, r.VX, r.VY)
		}
	}
	for _, e := range w.Effects {
		if !finite(e.X) || !finite(e.Y) || !finite(e.Left) || !finite(e.R) {
			return fmt.Errorf("effect %d at %v,%v r %v left %v", e.Kind, e.X, e.Y, e.R, e.Left)
		}
	}
	return nil
}

func finite(v float32) bool { return !math.IsNaN(float64(v)) && !math.IsInf(float64(v), 0) }

func (w *World) inside(x, y float32) bool {
	return finite(x) && finite(y) && x >= 0 && y >= 0 && x < float32(w.W) && y < float32(w.H)
}

// Hash sums up the state a game is played on: the phase, every creep, structure and player,
// the effects and the loot sites. Two worlds with the same seed and commands hash the same tick for
// tick; the playtests use it to catch the sim drifting from one build to the next.
func (w *World) Hash() uint64 {
	h := fnv.New64a()
	var b []byte
	u := func(v uint64) { b = binary.LittleEndian.AppendUint64(b, v) }
	f := func(v float32) { b = binary.LittleEndian.AppendUint32(b, math.Float32bits(v)) }
	u(uint64(w.Tick))
	u(uint64(w.Phase))
	u(uint64(w.Wave))
	f(w.PhaseLeft)
	u(uint64(w.TotalKills))
	u(uint64(w.Weather))
	if w.Evac.Stage != EvacNone {
		u(uint64(w.Evac.Stage))
		f(w.Evac.Left)
	}
	for i := range w.Creeps {
		c := &w.Creeps[i]
		u(uint64(c.ID)<<8 | uint64(c.Kind))
		f(c.X)
		f(c.Y)
		f(c.HP)
		u(uint64(uint8(c.Hunt))<<16 | uint64(uint16(c.Siege)))
	}
	for i := range w.Structs {
		s := &w.Structs[i]
		if !s.Alive {
			continue
		}
		u(uint64(i)<<32 | uint64(s.Kind)<<8 | uint64(s.Level))
		u(uint64(s.Lv[0]) | uint64(s.Lv[1])<<8 | uint64(s.Lv[2])<<16 | uint64(s.Lv[3])<<24)
		f(s.HP)
	}
	for _, p := range w.Players {
		f(p.X)
		f(p.Y)
		f(p.HP)
		u(uint64(p.Gold))
		u(uint64(p.Kills))
		u(uint64(p.Order.Kind))
		if p.Aboard {
			u(1)
		}
	}
	for _, e := range w.Effects {
		u(uint64(e.Kind))
		f(e.X)
		f(e.Y)
		f(e.Left)
	}
	for _, g := range w.Guns {
		u(uint64(g.ID)<<8 | uint64(g.Kind))
		f(g.X)
		f(g.Y)
	}
	for _, s := range w.Sites {
		u(uint64(s.Guards)<<1 | uint64(btou(s.Searched)))
	}
	_, _ = h.Write(b)
	return h.Sum64()
}

func btou(b bool) uint8 {
	if b {
		return 1
	}
	return 0
}
