package web

import (
	"encoding/binary"
	"math"

	"taildefense/internal/game"
	"taildefense/internal/netplay"
)

// Binary message types to the browser.
const (
	viewFrame   = 1
	viewTerrain = 2
)

// viewEncoder writes the browser's frame: the whole replica every tick, laid out as
// web/PROTOCOL.md says. One buffer, reused.
type viewEncoder struct{ b []byte }

func (e *viewEncoder) u8(v uint8)   { e.b = append(e.b, v) }
func (e *viewEncoder) u16(v uint16) { e.b = binary.LittleEndian.AppendUint16(e.b, v) }
func (e *viewEncoder) u32(v uint32) { e.b = binary.LittleEndian.AppendUint32(e.b, v) }

func (e *viewEncoder) pos(v float32) {
	e.u16(uint16(min(max(math.Round(float64(v)*8), 0), 65535)))
}

func clamp32(v uint64) uint32 { return uint32(min(v, math.MaxUint32)) }

func deci16(s float32) uint16 { return uint16(min(max(math.Ceil(float64(s)*10), 0), 65535)) }

func deci8(s float32) uint8 { return uint8(min(max(math.Ceil(float64(s)*10), 0), 255)) }

func turns(a float32) uint16 {
	t := float64(a) / (2 * math.Pi)
	t -= math.Floor(t)
	return uint16(t * 65536)
}

func terrainMsg(t []game.Tile) []byte {
	b := make([]byte, 1+len(t))
	b[0] = viewTerrain
	for i, v := range t {
		b[1+i] = byte(v)
	}
	return b
}

// frame encodes the replica and the events since the last frame.
func (e *viewEncoder) frame(r *netplay.Replica) []byte {
	e.b = e.b[:0]
	e.u8(viewFrame)
	e.u32(r.Tick)
	e.u8(uint8(r.Phase))
	e.u16(uint16(r.Wave))
	e.u16(deci16(r.PhaseLeft))
	e.u32(uint32(r.Pending))
	e.u32(clamp32(r.Kills))
	e.u16(uint16(r.Best))
	e.u8(uint8(r.Weather))
	e.u8(uint8(min(max(r.WeatherAmt, 0), 1) * 255))
	e.u8(uint8(r.PausedBy + 1))

	e.u8(uint8(len(r.Players)))
	for i := range r.Players {
		p := &r.Players[i]
		var f uint8
		for bit, on := range [...]bool{p.Connected, p.Alive, p.Firing, p.Ready, p.Reloading, p.Hurt, p.AtArmory, p.Moving} {
			if on {
				f |= 1 << bit
			}
		}
		e.u8(p.ID)
		e.u8(f)
		e.pos(p.X)
		e.pos(p.Y)
		e.u16(turns(p.Aim))
		e.u16(p.HP)
		e.u16(p.MaxHP)
		e.u8(uint8(p.Cur))
		e.u16(p.Ammo)
		mag := int16(0)
		if p.Cur < game.NumWeapons {
			mag = game.WeaponStats(p.Cur, p.Lv[p.Cur]).Mag
		}
		e.u16(uint16(max(mag, 0)))
		e.u8(uint8(min(max(p.ReloadFrac, 0), 1) * 255))
		e.u8(p.Respawn)
		e.u32(clamp32(p.Gold))
		e.u32(clamp32(p.Kills))
		e.u32(clamp32(p.Damage))
		var owned uint8
		for k, o := range p.Owned {
			if o {
				owned |= 1 << k
			}
		}
		e.u8(owned)
		for k := range p.Lv {
			for _, l := range p.Lv[k] {
				e.u8(l)
			}
		}
		for _, g := range p.Gear {
			e.u8(g)
		}
		e.u8(uint8(p.Order))
		e.u8(uint8(min(max(p.Channel, 0), 1) * 255))
		e.u8(uint8(min(max(p.Revived, 0), 1) * 255))
		e.u8(p.Emote)
		e.u8(deci8(p.EmoteLeft))
		e.u16(deci16(p.TauntCool))
		e.u8(uint8(min(max(p.Stamina, 0), 1) * 255))
		var sp uint8
		if p.Sprinting {
			sp |= 1
		}
		if p.Winded {
			sp |= 2
		}
		e.u8(sp)
		e.u32(p.Look)
		e.u8(p.Buff)
		e.u8(deci8(p.BuffLeft))
		for _, a := range p.Abil {
			e.u8(a.Lv)
			e.u16(deci16(a.Cool))
		}
		name := p.Name
		if len(name) > 255 {
			name = name[:255]
		}
		e.u8(uint8(len(name)))
		e.b = append(e.b, name...)
	}

	e.u16(uint16(len(r.Searched)))
	for i, done := range r.Searched {
		m := r.Guards[i] & 127
		if done {
			m |= 128
		}
		e.u8(m)
	}

	e.u16(uint16(len(r.Structs)))
	for i := range r.Structs {
		s := &r.Structs[i]
		if s.Alive {
			e.u8(1)
		} else {
			e.u8(0)
		}
		e.u8(uint8(s.Kind))
		e.u16(uint16(s.X))
		e.u16(uint16(s.Y))
		e.u8(uint8(s.W))
		e.u8(uint8(s.H))
		e.u16(s.HP)
		e.u16(s.MaxHP)
		e.u8(s.Level)
		e.u8(uint8(s.Owner))
	}

	e.u16(uint16(r.Count))
	r.EachCreep(func(id uint16) {
		e.u16(id)
		e.pos(r.CX[id])
		e.pos(r.CY[id])
		e.u8(r.Kind[id])
		e.u8(r.HP[id])
		e.u8(r.Flags[id])
		e.u8(r.Target[id])
	})

	tr, bl, de, notes := r.Drain()
	tr = tr[:min(len(tr), 65535)]
	e.u16(uint16(len(tr)))
	for _, t := range tr {
		e.pos(t.X0)
		e.pos(t.Y0)
		e.pos(t.X1)
		e.pos(t.Y1)
		e.u8(t.Kind)
	}
	bl = bl[:min(len(bl), 65535)]
	e.u16(uint16(len(bl)))
	for _, x := range bl {
		e.pos(x.X)
		e.pos(x.Y)
		e.u8(uint8(min(x.R*8, 255)))
		e.u8(x.Kind)
	}
	de = de[:min(len(de), 65535)]
	e.u16(uint16(len(de)))
	for _, d := range de {
		e.pos(d.X)
		e.pos(d.Y)
		e.u8(uint8(d.Kind))
	}
	e.u16(uint16(len(r.Effects)))
	for _, x := range r.Effects {
		e.u8(uint8(x.Kind))
		e.pos(x.X0)
		e.pos(x.Y0)
		e.pos(x.X)
		e.pos(x.Y)
		e.u8(uint8(min(x.R*8, 255)))
		e.u8(deci8(x.Left))
		e.u8(deci8(x.Total))
	}
	notes = notes[:min(len(notes), 255)]
	e.u8(uint8(len(notes)))
	for _, n := range notes {
		e.u8(n.Level)
		t := n.Text
		if len(t) > 65535 {
			t = t[:65535]
		}
		e.u16(uint16(len(t)))
		e.b = append(e.b, t...)
	}
	return e.b
}
