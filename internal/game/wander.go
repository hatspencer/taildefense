package game

import "math"

// Wanderers: the dead that roam the wastes between the waves. They shamble about far from the
// base in loose packs, mostly walkers, go for a survivor who comes near or shoots at them, and
// come back with time as they are killed. Every tenth wave they hear the call: partway into it, every wanderer left turns
// and rushes the generator, and the wave holds until they are dead too.

const (
	wanderSpawn = 40   // a wanderer appears at least this far from the generator
	wanderAway  = 26   // and this far from every survivor, out of sight
	wanderKeep  = 30   // it wanders no closer to the generator than this
	wanderEvery = 5    // seconds between new packs while there are fewer than the map holds
	wanderPace  = .4   // of its kind's speed, while it wanders
	rushEvery   = 10   // the waves the wanderers rush
	rushFrom    = 15   // seconds into the wave, at the earliest, that they rush
	rushSpread  = 25   // and at the latest, rushFrom later
	wanderMost  = 300  // the most wanderers the map ever holds
	wanderBase  = 48.0 // how many it holds before the first wave
	wanderWave  = 4.0  // and how many more each wave
	packLo      = 3    // a pack is this many
	packHi      = 6    // to this many
	packSpread  = 2.5  // tiles round its middle
	packKeep    = 8    // a wanderer drifts back towards the others within this many tiles
)

// wanderCap is how many wanderers the map holds now.
func (w *World) wanderCap() int {
	return min(int(math.Round((wanderBase+wanderWave*float64(w.Wave))*float64(w.diff().Count))), wanderMost)
}

// wanderers is how many wanderers are about.
func (w *World) wanderers() int {
	n := 0
	for i := range w.Creeps {
		if w.Creeps[i].Wander {
			n++
		}
	}
	return n
}

// stepWanderers brings a new wanderer now and then while the map holds fewer than it may,
// and sets the tenth waves' wanderers rushing.
func (w *World) stepWanderers() {
	if w.Phase == PhaseWave && w.rushAt > 0 && w.WaveTime >= w.rushAt {
		w.rushAt = 0
		w.rush()
	}
	if w.wanderCool -= Dt; w.wanderCool > 0 {
		return
	}
	w.wanderCool = wanderEvery
	if w.wanderers()+packLo <= w.wanderCap() {
		w.spawnPack()
	}
}

// fillWanderers puts the map's wanderers down at once, for a new game.
func (w *World) fillWanderers() {
	for try := 0; try < 100 && w.wanderers()+packLo <= w.wanderCap(); try++ {
		w.spawnPack()
	}
	w.wanderCool = wanderEvery
}

// spawnPack puts a pack of wanderers down somewhere out in the wastes, away from the base,
// the survivors and the loot sites, where the generator can be reached from: walkers
// huddled together, now and then something worse among them. It returns how many came.
func (w *World) spawnPack() int {
	for try := 0; try < 40; try++ {
		x, y := float32(w.rng.IntN(w.W))+.5, float32(w.rng.IntN(w.H))+.5
		if !w.wanderSpot(x, y) {
			continue
		}
		// Never past the map's share of them.
		n, got := min(packLo+w.rng.IntN(packHi-packLo+1), w.wanderCap()-w.wanderers()), 0
		for j := 0; j < n*3 && got < n; j++ {
			px, py := x, y
			if got > 0 {
				px += (w.rng.Float32()*2 - 1) * packSpread
				py += (w.rng.Float32()*2 - 1) * packSpread
			}
			if ok, _ := w.creepFree(px, py); !ok {
				continue
			}
			k := CWalker
			if got == n-1 {
				// The last of a pack may be something other than a walker.
				switch r := w.rng.IntN(10); {
				case w.Wave >= 8 && r == 0:
					k = CBrute
				case w.Wave >= 6 && r == 1:
					k = CSpitter
				case w.Wave >= 3 && r < 4:
					k = CRunner
				}
			}
			if !w.SpawnCreep(k, px, py) {
				return got
			}
			c := &w.Creeps[len(w.Creeps)-1]
			c.Wander, c.HX, c.HY = true, px, py
			got++
		}
		return got
	}
	return 0
}

// wanderSpot reports whether a pack may come in at x, y.
func (w *World) wanderSpot(x, y float32) bool {
	if ok, _ := w.creepFree(x, y); !ok || w.flow.dist[int(y)*w.W+int(x)] >= unreachable {
		return false
	}
	if dx, dy := x-w.CoreX, y-w.CoreY; dx*dx+dy*dy < wanderSpawn*wanderSpawn {
		return false
	}
	return w.nearestPlayer(x, y, wanderAway) == nil && !w.nearSite(x, y, 6)
}

// nearSite reports whether x, y is within r of a loot site.
func (w *World) nearSite(x, y, r float32) bool {
	for i := range w.Sites {
		s := &w.Sites[i]
		if dx, dy := x-s.SX, y-s.SY; dx*dx+dy*dy < r*r {
			return true
		}
	}
	return false
}

// wander is one tick of a wanderer with nobody to go for: it walks slowly to a spot nearby,
// stands about a while, and picks another, never one near the base. HX, HY is where it goes.
func (w *World) wander(c *Creep, d *CreepDef, speed float32) {
	if c.think -= Dt; c.think <= 0 {
		c.think = 4 + w.rng.Float32()*8
		c.HX, c.HY = w.wanderTo(c)
	}
	dx, dy := c.HX-c.X, c.HY-c.Y
	dd := dx*dx + dy*dy
	if dd < .25 {
		return
	}
	dl := sqrt32(dd)
	step := speed * wanderPace * Dt
	nx, ny := c.X+dx/dl*step, c.Y+dy/dl*step
	// It walks round nothing and breaks nothing: blocked, it stands until it picks again.
	moved := false
	if ok, _ := w.creepFree(nx, c.Y); ok {
		c.X, moved = nx, true
	}
	if ok, _ := w.creepFree(c.X, ny); ok {
		c.Y, moved = ny, true
	}
	if !moved {
		c.HX, c.HY = c.X, c.Y
	}
}

// wanderTo is a spot a few tiles from wanderer c to wander to, away from the generator and
// near the others of its pack; one that strayed too close to the base heads straight out.
func (w *World) wanderTo(c *Creep) (float32, float32) {
	x, y := c.X, c.Y
	cx, cy := x-w.CoreX, y-w.CoreY
	if cd := sqrt32(cx*cx + cy*cy); cd < wanderKeep {
		cd += 1e-6
		return x + cx/cd*8, y + cy/cd*8
	}
	// The pack's middle: a wanderer with others about wanders round them, not off alone.
	var mx, my float32
	n := 0
	id := c.ID
	w.grid.each(x, y, packKeep, func(i int32) bool {
		if o := &w.Creeps[i]; o.Wander && o.ID != id {
			mx, my = mx+o.X, my+o.Y
			n++
		}
		return n < 8
	})
	ox, oy, lo, span := x, y, 3., 7.
	if n > 0 {
		// Round the middle, a little wider than the pack, so the pack as a whole slowly drifts.
		ox, oy, lo, span = mx/float32(n), my/float32(n), 1, 4
	}
	for try := 0; try < 8; try++ {
		a := w.rng.Float64() * 2 * math.Pi
		r := lo + w.rng.Float64()*span
		tx, ty := ox+float32(math.Cos(a)*r), oy+float32(math.Sin(a)*r)
		if dx, dy := tx-w.CoreX, ty-w.CoreY; dx*dx+dy*dy < wanderKeep*wanderKeep {
			continue
		}
		if ok, _ := w.creepFree(tx, ty); ok {
			return tx, ty
		}
	}
	return x, y
}

// rush turns every wanderer into a creep of the wave, at the wave's strength, going for the
// generator.
func (w *World) rush() {
	n := 0
	hp := HPScale(max(w.Wave, 1)) * w.diff().HP
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if !c.Wander || c.HP <= 0 {
			continue
		}
		frac := c.HP / c.MaxHP
		c.Wander = false
		c.MaxHP = Creeps[c.Kind].HP * hp
		c.HP = c.MaxHP * frac
		c.Hunt, c.Siege = -1, -1
		n++
	}
	if n > 0 {
		w.note(2, "the dead out in the wastes heard the call: %d rushing the generator", n)
	}
}
