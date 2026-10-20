package game

// Traps are what a maze is lined with: buildings laid flat on the ground that the dead walk
// over, and survivors too, without noticing them. They are not walls and nothing paths round
// them, so they sit in their own grid (floorAt), out of the one creeps and survivors are
// stopped by. What they do happens to a creep standing on one:
//
//   - The spike strip cuts it, and wears down by every creep-second it cuts, until it breaks
//     and leaves a ghost to rebuild between waves.
//   - The tar pit slows it for as long as it wades through, and a little after.
//   - The flame vent bursts, every so often, when a creep steps on it, setting everything in
//     its reach alight.
//   - The mine blows up under the first one and is gone, a ghost for H to lay again.
//
// Their damage counts as turret fire: it never turns a creep on anyone, and kills pay the one
// who built the trap.

const (
	spikeWear = 3   // a spike strip's hit points a creep-second on it costs
	tarLinger = .4  // seconds of slow a creep keeps after wading out of tar
	ventBurn  = 10  // a flame vent's burning, per second, for 2.5 s
	trapLevel = .35 // each level past the first adds this share of a trap's damage
)

// FloorAt is the trap on tile x, y, or -1.
func (w *World) FloorAt(x, y int) int {
	if x < 0 || y < 0 || x >= w.W || y >= w.H {
		return -1
	}
	return int(w.floorAt[y*w.W+x])
}

// trapDamage is trap s's damage at its level.
func trapDamage(s *Structure) float32 {
	return Structs[s.Kind].Damage * (1 + trapLevel*float32(s.Level-1))
}

// stepTraps springs every trap a creep stands on, once a tick.
func (w *World) stepTraps() {
	w.turretFire = true
	defer func() { w.turretFire = false }()
	for si := range w.Structs {
		if s := &w.Structs[si]; s.Alive && s.Kind == STrapVent && s.Cool > 0 {
			s.Cool -= Dt
		}
	}
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if c.HP <= 0 {
			continue
		}
		tx, ty := int(c.X), int(c.Y)
		if tx < 0 || ty < 0 || tx >= w.W || ty >= w.H {
			continue
		}
		si := w.floorAt[ty*w.W+tx]
		if si < 0 {
			continue
		}
		s := &w.Structs[si]
		d := &Structs[s.Kind]
		switch s.Kind {
		case STrapSpikes:
			w.damage(int32(i), trapDamage(s)*Dt, s.Owner)
			s.HP -= spikeWear * Dt
		case STrapTar:
			c.Slow = max(c.Slow, tarLinger+Dt)
		case STrapVent:
			if s.Cool > 0 {
				continue
			}
			s.Cool = 1 / d.Rate
			w.flame(s.CX(), s.CY(), d.Range, trapDamage(s), s.Owner)
		case STrapMine:
			w.explode(s.CX(), s.CY(), d.Range, trapDamage(s), s.Owner, 0)
			s.HP = 0
		}
	}
}

// flame is a flame vent's burst: a hit on every creep within r of x, y, and it alight.
func (w *World) flame(x, y, r, dmg float32, owner int8) {
	w.grid.each(x, y, r, func(i int32) bool {
		c := &w.Creeps[i]
		if dx, dy := c.X-x, c.Y-y; dx*dx+dy*dy <= r*r {
			w.damage(i, dmg, owner)
			w.ignite(i, ventBurn)
		}
		return true
	})
	w.Blasts = append(w.Blasts, Blast{x, y, r, BlastFlame})
}
