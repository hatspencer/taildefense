package game

// The burster: a dead runner wired with a charge. Every one is a sprinter, out from wave 7 in
// twos to fives, and it hunts a survivor from further off than most. Reaching one, it stops
// dead and its fuse burns burstFuse seconds, the charge blinking on its chest; then it blows
// up where it stands, whoever is still there or not. The blast hurts every survivor in reach,
// most at its heart, slows them, and stuns those close; it hurts structures too, and leaves the
// ground burning, which burns the creeps that cross it. So a survivor who sees one lit runs,
// and one who keeps their head leads the pack after it through the fire. Shot down before it
// reaches anyone, a burster only falls: the charge needs its fuse. A hit that stuns it holds
// the fuse, as it holds any blow. It walks into a wall the same way, and blows that up instead.

const (
	burstShare   = .08 // of a wave's budget, on top of it, from wave 7 but on the swarm waves
	burstFuse    = .45 // seconds from reaching a survivor to the blast: the time to get clear
	burstReach   = 2.4 // tiles: the blast's reach; Damage (its def's) at the heart, half at the edge
	burstStunR   = 1.2 // within this of the heart a survivor is stunned
	burstStun    = .6  // seconds
	burstStruct  = 90  // to every structure in reach but the armory
	burstFire    = 4   // seconds the ground burns
	burstFireR   = 1.8 // tiles
	burstFireDPS = 22  // a second, to a creep in the fire, more in late waves
)

// fuse is a tick of burster c with survivor tp to go for: once it is in reach it lights its
// fuse and stands while it burns, then blows up. It reports whether that took its tick.
func (w *World) fuse(c *Creep, d *CreepDef, tp *Player) bool {
	if c.Kind != CBurster {
		return false
	}
	if c.swung != SwingWindup {
		if tp == nil {
			return false
		}
		dx, dy := tp.X-c.X, tp.Y-c.Y
		if reach := d.Radius + d.Reach; dx*dx+dy*dy > reach*reach {
			return false
		}
		c.Cool = d.Windup // lit
	}
	// Burning, it goes off whether or not anyone stayed for it.
	tx, ty, by := c.X+cos32(c.Face), c.Y+sin32(c.Face), int8(-1)
	if tp != nil {
		tx, ty, by = tp.X, tp.Y, int8(tp.ID)
	}
	if c.swing(d, tx, ty) {
		w.burst(c, by)
	}
	return true
}

// burst is burster c going up: survivors and structures in reach hurt, the ground left
// burning, the burster gone for nobody's bounty. What the fire kills pays the team, as a trap
// does, the kill counted to by, the survivor it was after (-1 none).
func (w *World) burst(c *Creep, by int8) {
	x, y := c.X, c.Y
	c.HP, c.LastHit = 0, -1
	hurt := Creeps[CBurster].Damage
	for _, p := range w.Players {
		if !p.Alive {
			continue
		}
		dx, dy := p.X-x, p.Y-y
		dd := dx*dx + dy*dy
		if dd >= burstReach*burstReach {
			continue
		}
		dist := sqrt32(dd)
		w.hurtPlayer(p, hurt*(1-.5*dist/burstReach))
		p.slow(blastSlow)
		if dist < burstStunR {
			p.stun(burstStun)
		}
	}
	for i := range w.Structs {
		s := &w.Structs[i]
		if !s.Alive || s.Kind == SArmory {
			continue
		}
		if dx, dy := clampf(x, float32(s.X), float32(s.X)+float32(s.W))-x, clampf(y, float32(s.Y), float32(s.Y)+float32(s.H))-y; dx*dx+dy*dy <= burstReach*burstReach {
			s.HP -= burstStruct
		}
	}
	w.pumpsIn(x, y, burstReach, by, pumpChain)
	w.Blasts = append(w.Blasts, Blast{x, y, burstReach, 0})
	w.Effects = append(w.Effects, Effect{Kind: EffNapalm, X0: x, Y0: y, X: x, Y: y, R: burstFireR, Left: burstFire, Total: burstFire,
		Damage: burstFireDPS * lateScale(w.Wave), Owner: by, Trap: true})
}
