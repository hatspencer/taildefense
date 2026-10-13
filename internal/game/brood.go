package game

import "math"

// The broodmother: the other boss, alongside the abomination. A bloated, swollen thing on
// spindly legs, its belly a sack of bile and young. It does not slam; it fights from afar.
// Every few seconds, with a survivor between lobMin and lobMax tiles off, it stops, rears
// back and lobs a sac of bile at where they stand, high over walls and all (EffBile). The spot
// is marked on the ground while the sac is in the air: whoever is still there when it bursts
// is splashed and slowed, whatever is built there is eaten into, a pool of acid is left
// burning where it fell (EffAcid), and a couple of swarmers crawl out of the burst. Up close
// it claws like anything else. And it is full of them: each quarter of its life shot away
// splits it open and spills a brood of swarmers round it.

const (
	lobEvery   = 4.5 // seconds between sacs
	lobWindup  = .7  // rearing back, standing still, before the sac leaves it
	lobFlight  = 1.2 // seconds in the air
	lobMin     = 4   // tiles: closer than this it claws instead
	lobMax     = 16
	lobStart   = 1.5 // seconds after a survivor first comes in range before the first sac
	bileR      = 2.5 // the splash, and the pool it leaves
	bileHurt   = 45  // the splash on a survivor at its middle, half at its edge
	bileSlow   = 1.4 // seconds the splash slows a survivor
	bileStruct = 60  // the splash on a structure
	bileHatch  = 2   // swarmers out of each sac
	acidFor    = 6   // seconds the pool burns
	acidHurt   = 14  // a second, to a survivor standing in it
	acidStruct = 20  // a second, to a structure in it
	broodBurst = 6   // swarmers spilled at each quarter of its life lost
)

// Boss reports whether creeps of kind k are bosses: an abomination or a broodmother.
func (k CreepKind) Boss() bool { return k == CBoss || k == CMother }

// bossKind picks the boss for a wave's i-th boss or an outpost's warlord: the abomination
// and the broodmother take turns from n.
func bossKind(n int) CreepKind {
	if n%2 == 0 {
		return CBoss
	}
	return CMother
}

// motherLob runs the broodmother c's sac at tp, and reports whether it took the creep's tick:
// it stands still while it rears back.
func (w *World) motherLob(c *Creep, tp *Player) bool {
	if c.Kind != CMother {
		return false
	}
	// slam is the countdown here too: to the next sac, and within the last lobWindup of it,
	// the rearing back.
	if c.slam > lobEvery-lobWindup {
		c.slam -= Dt
		c.Swing = SwingWindup
		return true
	}
	if tp == nil {
		c.slam = max(c.slam, lobStart)
		return false
	}
	dx, dy := tp.X-c.X, tp.Y-c.Y
	dd := dx*dx + dy*dy
	if dd < lobMin*lobMin || dd > lobMax*lobMax {
		c.slam = max(c.slam-Dt, min(c.slam, lobStart))
		return false
	}
	if c.slam -= Dt; c.slam > 0 {
		return false
	}
	c.slam = lobEvery
	c.Swing = SwingWindup
	c.Face = float32(math.Atan2(float64(dy), float64(dx)))
	// Aimed where they stand as it rears; the sac leaves it after lobWindup and lands lobFlight
	// later, so whoever keeps moving is clear of it.
	w.Effects = append(w.Effects, Effect{Kind: EffBile, X0: c.X, Y0: c.Y, X: tp.X, Y: tp.Y, R: bileR,
		Left: lobWindup + lobFlight, Total: lobWindup + lobFlight, Damage: bileHurt, Owner: -1})
	return true
}

// bileLands is a sac bursting: survivors under it splashed and slowed, structures eaten into,
// a pool of acid left, and a few swarmers out of it.
func (w *World) bileLands(e *Effect) {
	for _, p := range w.Players {
		if !p.Alive {
			continue
		}
		dx, dy := p.X-e.X, p.Y-e.Y
		if dd := dx*dx + dy*dy; dd <= e.R*e.R {
			w.hurtPlayer(p, e.Damage*(1-.5*sqrt32(dd)/e.R))
			p.slow(bileSlow)
		}
	}
	w.structsIn(e.X, e.Y, e.R, bileStruct)
	w.Effects = append(w.Effects, Effect{Kind: EffAcid, X0: e.X, Y0: e.Y, X: e.X, Y: e.Y, R: e.R, Left: acidFor, Total: acidFor, Damage: acidHurt, Owner: -1})
	w.hatch(e.X, e.Y, bileHatch, e.R*.6, nil)
	w.Blasts = append(w.Blasts, Blast{e.X, e.Y, e.R, BlastBile})
}

// BlastBile is a sac of bile bursting.
const BlastBile = 12

// stepAcid is a tick of a pool of acid: it eats at survivors and structures in it. The dead
// walk through it unharmed.
func (w *World) stepAcid(e *Effect) {
	for _, p := range w.Players {
		if !p.Alive {
			continue
		}
		dx, dy := p.X-e.X, p.Y-e.Y
		if dx*dx+dy*dy <= e.R*e.R {
			w.hurtPlayer(p, e.Damage*Dt)
		}
	}
	w.structsIn(e.X, e.Y, e.R, acidStruct*Dt)
}

// structsIn hurts every structure but the armory with any of its footprint within r of x, y.
func (w *World) structsIn(x, y, r, dmg float32) {
	for i := range w.Structs {
		st := &w.Structs[i]
		if !st.Alive || st.Kind == SArmory {
			continue
		}
		dx := x - min(max(x, float32(st.X)), float32(st.X)+float32(st.W))
		dy := y - min(max(y, float32(st.Y)), float32(st.Y)+float32(st.H))
		if dx*dx+dy*dy <= r*r {
			st.HP -= dmg
		}
	}
}

// hatch spills n swarmers round x, y within r, on open ground; a mother's brood (from
// mother, if any) keeps to her site if she guards one, and answers the bell with her.
func (w *World) hatch(x, y float32, n int, r float32, mother *Creep) {
	var home int16
	var hx, hy float32
	lured := false
	if mother != nil {
		home, hx, hy, lured = mother.Home, mother.HX, mother.HY, mother.lured
	}
	for j := 0; j < n; j++ {
		a := w.rng.Float64() * 2 * math.Pi
		d := r * sqrt32(w.rng.Float32())
		sx, sy := x+float32(math.Cos(a))*d, y+float32(math.Sin(a))*d
		if !CanStand(w, sx, sy) {
			sx, sy = x, y
		}
		if !w.SpawnCreep(CSwarmer, sx, sy) {
			return
		}
		b := &w.Creeps[len(w.Creeps)-1]
		b.Home, b.HX, b.HY, b.lured = home, hx, hy, lured
	}
}

// stepBrood splits open every broodmother that has lost another quarter of her life.
func (w *World) stepBrood() {
	for i := 0; i < len(w.Creeps); i++ {
		c := &w.Creeps[i]
		if c.Kind != CMother || c.HP <= 0 || c.brood >= 3 {
			continue
		}
		if c.HP > c.MaxHP*(1-float32(c.brood+1)/4) {
			continue
		}
		c.brood++
		x, y, r := c.X, c.Y, Creeps[CMother].Radius+1.2
		m := *c // SpawnCreep may move the slice; hatch reads her copy
		w.hatch(x, y, broodBurst, r, &m)
		w.Blasts = append(w.Blasts, Blast{x, y, r, BlastBile})
	}
}
