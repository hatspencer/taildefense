package game

import (
	"errors"
	"fmt"
	"math"
)

// Aggro: what a creep goes for when it is not simply following the field to the generator.
//
// A survivor close enough is chased, as ever. Beyond that a creep can be pulled: shooting
// one may provoke it into hunting the shooter, and a taunt makes everything around hunt the
// taunter for a while. Now and then a creep of the waves also takes against something on
// its own: a turret or wall nearby, or a survivor further off than it would normally notice.
// Loot guards sleep at their site until woken, and give up and go home when led too far.

const (
	tauntCool   = 12
	tauntRadius = 12
	tauntTime   = 5

	reviveReach = 1.6
	reviveTime  = 2.5
	reviveHP    = .4

	huntLose   = 30 // a hunt ends when the hunted gets this far away
	provokeMax = 16 // a shot provokes only a creep this close to the shooter
	siegeLook  = 6  // how far a creep looks for a structure to go for
	guardLeash = 18 // a guard this far from home gives up and goes back
)

// TauntInfo is the taunt's numbers, for the client.
func TauntInfo() (cool, radius, time float32) { return tauntCool, tauntRadius, tauntTime }

// ReviveInfo is reviving's numbers, for the client.
func ReviveInfo() (reach, time, hp float32) { return reviveReach, reviveTime, reviveHP }

// siegeChance and huntChance are, per kind, how likely a creep of the waves is, each time it
// thinks (every two seconds or so), to go for a structure or a survivor on its own.
var (
	siegeChance = [NumCreepKinds]float32{CWalker: .08, CRunner: .04, CSwarmer: .03, CBrute: .3, CSpitter: .2, CBoss: .25}
	huntChance  = [NumCreepKinds]float32{CWalker: .05, CRunner: .12, CSwarmer: .06, CBrute: .03, CSpitter: .05, CBoss: .05}
)

// Taunt pulls every creep within reach onto the player, sleeping guards too.
func (w *World) Taunt(p *Player) error {
	if !p.Alive {
		return errors.New("you are down")
	}
	if w.Phase == PhaseOver {
		return errOver
	}
	if p.TauntCool > 0 {
		return fmt.Errorf("taunt is ready in %.0fs", math.Ceil(float64(p.TauntCool)))
	}
	p.TauntCool = tauntCool
	p.Emote, p.EmoteLeft = 1, 1.6
	n := 0
	w.grid.each(p.X, p.Y, tauntRadius, func(i int32) bool {
		c := &w.Creeps[i]
		dx, dy := c.X-p.X, c.Y-p.Y
		if c.HP <= 0 || dx*dx+dy*dy > tauntRadius*tauntRadius {
			return true
		}
		c.Asleep, c.Returning = false, false
		c.Hunt, c.HuntLeft = int8(p.ID), tauntTime
		c.Siege = -1
		n++
		return true
	})
	w.Blasts = append(w.Blasts, Blast{p.X, p.Y, tauntRadius, 7})
	if n == 0 {
		w.toast(p, 0, "nothing heard you")
	}
	return nil
}

// OrderRevive sends the player to revive a downed teammate where they fell.
func (w *World) OrderRevive(p *Player, mate int) error {
	if !p.Alive {
		return errors.New("you are down")
	}
	if mate < 0 || mate >= len(w.Players) || w.Players[mate] == p {
		return errors.New("nobody to revive there")
	}
	m := w.Players[mate]
	if m.Alive || !m.Connected {
		return fmt.Errorf("%s is not down", m.Name)
	}
	w.order(p, Order{Kind: OrderRevive, Mate: mate, X: m.X, Y: m.Y})
	return nil
}

// actRevive is one tick of a revive order; it reports whether the order is still going.
func (w *World) actRevive(p *Player, o *Order) bool {
	m := w.Players[o.Mate]
	if m.Alive || !m.Connected {
		p.Search = 0
		return false
	}
	dx, dy := m.X-p.X, m.Y-p.Y
	if dx*dx+dy*dy > reviveReach*reviveReach {
		if !w.step(p) {
			w.toast(p, 2, "cannot get to %s", m.Name)
			return false
		}
		p.Moving = true
		return true
	}
	// Like searching: all a survivor does, and a hit starts it over.
	if p.Hurt > 0 {
		p.Search = 0
		return true
	}
	p.Search += Dt
	m.Revived = max(m.Revived, min(p.Search/reviveTime, 1))
	if p.Search < reviveTime {
		return true
	}
	p.Search = 0
	m.Alive = true
	m.HP = m.MaxHP * reviveHP
	m.Respawn, m.Revived = 0, 0
	m.Order = Order{}
	m.walk.reset()
	w.Blasts = append(w.Blasts, Blast{m.X, m.Y, 1, 9})
	w.note(1, "%s got %s back on their feet", p.Name, m.Name)
	return false
}

// provoke is a creep being hit: guards always wake and turn on the shooter, a creep of the
// waves only sometimes.
func (w *World) provoke(c *Creep) {
	c.Asleep = false
	if w.shooter < 0 || int(w.shooter) >= len(w.Players) {
		return
	}
	p := w.Players[w.shooter]
	if dx, dy := c.X-p.X, c.Y-p.Y; dx*dx+dy*dy > provokeMax*provokeMax {
		return
	}
	if c.Home > 0 {
		c.Hunt, c.HuntLeft, c.Returning = w.shooter, 6, false
		return
	}
	if c.Hunt < 0 && w.rng.Float32() < .12 {
		c.Hunt, c.HuntLeft, c.Siege = w.shooter, 4, -1
	}
}

// think is a creep of the waves considering, every couple of seconds, whether to go for
// something other than the generator.
func (w *World) think(c *Creep, d *CreepDef) {
	if c.SiegeLeft > 0 {
		c.SiegeLeft -= Dt
		if c.SiegeLeft <= 0 {
			c.Siege = -1
		}
	}
	c.think -= Dt
	if c.think > 0 {
		return
	}
	c.think = 1.5 + w.rng.Float32()*2
	if c.Hunt >= 0 || c.Siege >= 0 {
		return
	}
	r := w.rng.Float32()
	switch {
	case r < siegeChance[c.Kind]:
		if si := w.nearbyStruct(c.X, c.Y); si >= 0 {
			c.Siege, c.SiegeLeft = int16(si), 10
		}
	case r < siegeChance[c.Kind]+huntChance[c.Kind]:
		far := 2 * d.Aggro * w.aggroMul()
		if p := w.nearestPlayer(c.X, c.Y, far); p != nil {
			c.Hunt, c.HuntLeft = int8(p.ID), 5
		}
	}
}

// nearbyStruct is the closest turret, wall or gate within siegeLook of x, y, or -1.
func (w *World) nearbyStruct(x, y float32) int {
	best, bi := float32(siegeLook*siegeLook), -1
	x0, y0 := int(x)-siegeLook, int(y)-siegeLook
	for ty := y0; ty <= y0+2*siegeLook; ty++ {
		for tx := x0; tx <= x0+2*siegeLook; tx++ {
			si := w.StructAt(tx, ty)
			if si < 0 {
				continue
			}
			s := &w.Structs[si]
			if !s.Alive || s.Kind == SArmory || s.Kind == SCore {
				continue
			}
			dx, dy := float32(tx)+.5-x, float32(ty)+.5-y
			if dd := dx*dx + dy*dy; dd < best {
				best, bi = dd, si
			}
		}
	}
	return bi
}

func (w *World) nearestPlayer(x, y, r float32) *Player {
	var tp *Player
	best := r * r
	for _, p := range w.Players {
		if !p.Alive || !p.Connected {
			continue
		}
		dx, dy := p.X-x, p.Y-y
		if dd := dx*dx + dy*dy; dd < best {
			best, tp = dd, p
		}
	}
	return tp
}

// creepTarget is the survivor a creep goes for this tick, or nil.
func (w *World) creepTarget(c *Creep, d *CreepDef) *Player {
	if c.Home > 0 {
		if dx, dy := c.X-c.HX, c.Y-c.HY; dx*dx+dy*dy > guardLeash*guardLeash {
			c.Returning, c.Hunt = true, -1
		}
		if c.Returning {
			return nil
		}
	}
	if c.Hunt >= 0 {
		c.HuntLeft -= Dt
		p := w.Players[c.Hunt]
		dx, dy := p.X-c.X, p.Y-c.Y
		if c.HuntLeft > 0 && p.Alive && p.Connected && dx*dx+dy*dy < huntLose*huntLose {
			return p
		}
		c.Hunt = -1
	}
	p := w.nearestPlayer(c.X, c.Y, d.Aggro*w.aggroMul())
	if p != nil && c.Home > 0 {
		// A guard that has seen someone keeps after them for a while.
		c.Hunt, c.HuntLeft = int8(p.ID), 4
	}
	return p
}

// wakes reports whether a sleeping guard notices a survivor.
func (w *World) wakes(c *Creep, d *CreepDef) bool {
	return w.nearestPlayer(c.X, c.Y, d.Aggro*w.aggroMul()) != nil
}

// wakeSite wakes every sleeping guard of c's site around it.
func (w *World) wakeSite(c *Creep) {
	home := c.Home
	x, y := c.X, c.Y
	w.grid.each(x, y, 12, func(i int32) bool {
		o := &w.Creeps[i]
		if o.Home == home && o.Asleep {
			o.Asleep = false
		}
		return true
	})
	c.Asleep = false
	w.Blasts = append(w.Blasts, Blast{x, y, 1.5, 10})
}

// goHome walks a guard back to its post and puts it to sleep there, healed. A guard that
// cannot find its way back settles where it is.
func (w *World) goHome(c *Creep, d *CreepDef, speed float32) {
	dx, dy := c.HX-c.X, c.HY-c.Y
	dd := dx*dx + dy*dy
	if dd < 1 {
		c.Asleep, c.Returning = true, false
		c.HP = c.MaxHP
		return
	}
	c.think -= Dt
	if c.think <= 0 {
		dist := sqrt32(dd)
		if c.SiegeLeft > 0 && dist > c.SiegeLeft-.5 {
			c.HX, c.HY = c.X, c.Y
			c.Asleep, c.Returning = true, false
			return
		}
		c.think, c.SiegeLeft = 2, dist // a guard never sieges, so the field keeps the last distance
	}
	dl := sqrt32(dd)
	w.moveCreep(c, d, c.X+dx/dl*speed*Dt, c.Y+dy/dl*speed*Dt)
}

// guardSize is how many guards each guard level puts on a site, before difficulty.
var guardSize = [5]int{0, 3, 5, 7, 12}

// spawnGuards puts a site's guards down around it, scaled to the current wave.
func (w *World) spawnGuards(si int) {
	s := &w.Sites[si]
	lv := int(s.Guard)
	if lv == 0 {
		return
	}
	df := w.diff()
	n := int(math.Round(float64(float32(guardSize[lv]+w.Wave/5) * df.Guard)))
	hp := df.Guard * (1 + .15*float32(lv))
	for j := 0; j < max(n, 1); j++ {
		k := CWalker
		r := w.rng.IntN(10)
		switch {
		case lv == 4 && j == 0:
			k = CBoss // the outpost's warlord, out of reach early on
		case lv == 4 && j <= 2:
			k = CBrute
		case lv == 3 && j == 0:
			k = CBrute
		case lv == 3 && j == 1 && w.Wave >= 12:
			k = CBrute
		case lv >= 2 && r < 2:
			k = CSpitter
		case (lv >= 2 || w.Wave >= 3) && r < 5:
			k = CRunner
		}
		for try := 0; try < 10; try++ {
			var x, y float32
			if lv == 4 && j == 0 {
				x, y = s.SX, s.SY
			} else if s.Kind.Walled() {
				x = float32(s.X) + 1 + w.rng.Float32()*float32(max(int(s.W)-2, 1))
				y = float32(s.Y) + 1 + w.rng.Float32()*float32(max(int(s.H)-2, 1))
			} else {
				a := w.rng.Float64() * 2 * math.Pi
				d := 1 + w.rng.Float64()*2
				x, y = s.SX+float32(math.Cos(a)*d), s.SY+float32(math.Sin(a)*d)
			}
			if ok, _ := w.creepFree(x, y); !ok {
				continue
			}
			if w.SpawnCreep(k, x, y) {
				c := &w.Creeps[len(w.Creeps)-1]
				c.HP *= hp
				c.MaxHP = c.HP
				c.Home, c.HX, c.HY, c.Asleep = int16(si+1), x, y, true
			}
			break
		}
	}
}

// countGuards refreshes each site's count of living guards.
func (w *World) countGuards() {
	for i := range w.Sites {
		w.Sites[i].Guards = 0
	}
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if c.Home > 0 && c.HP > 0 {
			if s := &w.Sites[c.Home-1]; s.Guards < 127 {
				s.Guards++
			}
		}
	}
}

// waveCreeps is how many creeps of the waves are alive; guards do not hold a wave open.
func (w *World) waveCreeps() int {
	n := 0
	for i := range w.Creeps {
		if w.Creeps[i].Home == 0 {
			n++
		}
	}
	return n
}
