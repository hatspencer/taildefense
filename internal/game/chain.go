package game

// The chain: the dead call to each other. A creep that goes for a survivor, whether it saw
// them, was woken, was shot at or heard the shooting, lets out a howl a moment later, and
// everything round it that is not after that survivor already wakes and comes too, and howls
// in its turn. One shot at a sleeping guard can bring a whole stretch of the wastes down on
// the shooter, a ripple at a time.

const (
	shoutRange = 7   // tiles a howl carries
	shoutLo    = .2  // seconds from going for someone to howling
	shoutHi    = .45 // at the latest
	shoutHunt  = 8   // seconds a creep that heard the howl keeps after the survivor
)

// rally is a tick of creep c going for survivor tp, or for nobody when tp is nil: the first
// tick of a chase sets it howling a moment later, and the howl goes out when that comes.
func (w *World) rally(c *Creep, tp *Player) {
	if tp == nil {
		c.shouted, c.alarm = false, 0
		return
	}
	if !c.shouted {
		c.shouted, c.alarm = true, shoutLo+w.rng.Float32()*(shoutHi-shoutLo)
		return
	}
	if c.alarm <= 0 {
		return
	}
	if c.alarm -= Dt; c.alarm <= 0 {
		w.shout(c, tp)
	}
}

// shout is c's howl: everything round it wakes and goes for p.
func (w *World) shout(c *Creep, p *Player) {
	id, n := c.ID, 0
	x, y := c.X, c.Y
	w.grid.each(x, y, shoutRange, func(i int32) bool {
		o := &w.Creeps[i]
		dx, dy := o.X-x, o.Y-y
		if o.ID == id || o.HP <= 0 || o.Hunt == int8(p.ID) || dx*dx+dy*dy > shoutRange*shoutRange {
			return true
		}
		o.Asleep, o.Returning = false, false
		o.Hunt, o.HuntLeft, o.Siege = int8(p.ID), shoutHunt, -1
		n++
		return true
	})
	if n > 0 {
		w.Blasts = append(w.Blasts, Blast{x, y, 1.5, 10})
	}
}
