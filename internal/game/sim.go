package game

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

func sqrt32(v float32) float32 { return float32(math.Sqrt(float64(v))) }

// Step advances the world by one tick.
func (w *World) Step() {
	w.Tracers = w.Tracers[:0]
	w.Blasts = w.Blasts[:0]
	w.Deaths = w.Deaths[:0]
	w.Found = w.Found[:0]
	// Notes and toasts from commands that arrived since the last tick go out with this one.
	w.Notes = append(w.Notes[:0], w.Notes[w.sentNotes:]...)
	w.Toasts = append(w.Toasts[:0], w.Toasts[w.sentToasts:]...)
	w.Pings = append(w.Pings[:0], w.Pings[w.sentPings:]...)
	defer func() { w.sentNotes, w.sentToasts, w.sentPings = len(w.Notes), len(w.Toasts), len(w.Pings) }()
	w.freeIDs = append(w.freeIDs, w.freed...)
	w.freed = w.freed[:0]
	if w.Paused >= 0 {
		return
	}
	w.Tick++

	w.CreepsLeft = 0
	switch w.Phase {
	case PhaseOver:
		return
	case PhaseBuild:
		was := w.PhaseLeft
		w.PhaseLeft -= Dt
		if w.allReady() && w.PhaseLeft > 3 {
			w.PhaseLeft = 3
		}
		if w.longBreak() && was > callBack && w.PhaseLeft <= callBack {
			w.note(2, "wave %d in %ds  ·  head back to the base", w.Wave+1, callBack)
		}
		if w.PhaseLeft <= 0 {
			w.startWave()
		}
	case PhaseWave:
		w.WaveTime += Dt
		w.spawnDue()
		n := w.waveCreeps()
		if w.QueueHead >= len(w.Queue) {
			if n < w.aliveLast {
				w.stall = 0
			}
			w.aliveLast = n
			if w.stall += Dt; w.stall > stallLimit && n > 0 && n <= stallFew {
				w.dropStragglers()
				n = 0
			}
			// A wave holds until the last of it is dead, and on a tenth wave until the
			// wanderers have rushed too; the next never lands on top of it.
			if n == 0 && w.rushAt == 0 {
				w.endWave()
			}
		}
		if w.Phase == PhaseWave {
			w.CreepsLeft = w.creepsLeft(n)
		}
	case PhaseEvac:
		w.WaveTime += Dt
		w.spawnDue()
		w.CreepsLeft = w.creepsLeft(w.waveCreeps())
	}

	w.stepWanderers()
	w.stepWeather()
	w.updateFlow()
	w.grid.build(w.Creeps)
	w.indexCreeps()
	w.stepPlayers()
	w.stepTurrets()
	w.stepGates()
	w.stepTraps()
	w.stepRockets()
	w.stepEffects()
	w.stepPumps()
	w.stepBell()
	w.stepCrates()
	w.stepEvac()
	w.stepCreeps()
	w.stepBrood()
	w.reap()
	// Reaping moves creeps about in the slice; commands run between ticks query the grid
	// too, so it must match what is left.
	w.grid.build(w.Creeps)
	w.countGuards()
	w.discover()
}

func (w *World) allReady() bool {
	n := 0
	for _, p := range w.Players {
		if !p.Connected {
			continue
		}
		if !p.Ready {
			return false
		}
		n++
	}
	return n > 0
}

func (w *World) note(level uint8, format string, a ...any) {
	w.Notes = append(w.Notes, Note{Text: fmt.Sprintf(format, a...), Level: level})
}

// ---- waves -----------------------------------------------------------------------------

func (w *World) startWave() {
	w.Wave++
	w.Phase = PhaseWave
	w.WaveTime = 0
	w.Affix, w.NextAffix, w.NextFrom = w.NextAffix, 0, 0
	w.Overloaded = false
	w.Queue = w.plan(w.Wave, w.active())
	w.QueueHead = 0
	w.stall, w.aliveLast = 0, 0
	w.frenzied = false
	if w.Wave%rushEvery == 0 {
		w.rushAt = rushFrom + w.rng.Float32()*rushSpread
	}
	for _, p := range w.Players {
		p.Ready = false
	}
	label := ""
	switch {
	case w.Wave%10 == 0:
		label = "  ·  BOSS WAVE"
	case w.Wave%5 == 0 && w.Wave >= hordeFrom:
		label = "  ·  HORDE"
	case w.Wave%5 == 0:
		label = "  ·  SWARM"
	}
	from := ""
	if f := w.frontsSaid(); f != "" && !w.diff().Unsaid {
		from = " from " + f
	}
	if w.Affix != 0 {
		label += "  ·  " + strings.ToUpper(w.Affix.String())
	}
	w.note(2, "wave %d: %d creeps incoming%s%s", w.Wave, len(w.Queue), from, label)
	if w.Wave == 1 && !w.PadKnown() && !w.Endless() {
		w.note(1, "somewhere out in the dark is a helipad  ·  the evac Huey lands there after wave %d: find it", w.LastWave)
	}
}

// stallLimit is how long a wave may go without a single creep of it dying, once all are out,
// before the stragglers give up. A creep stuck where nobody can reach it must not hold the
// game forever.
const (
	stallLimit = 30
	stallFew   = 10 // only this few stragglers give up; a real fight is never cut short
)

// dropStragglers takes the creeps of the wave still about off the map, for nobody's bounty.
func (w *World) dropStragglers() {
	n := 0
	for i := 0; i < len(w.Creeps); {
		if c := &w.Creeps[i]; c.Home != 0 || c.Wander {
			i++
			continue
		}
		w.freed = append(w.freed, w.Creeps[i].ID)
		last := len(w.Creeps) - 1
		w.Creeps[i] = w.Creeps[last]
		w.Creeps = w.Creeps[:last]
		n++
	}
	w.note(0, "the last %d of the wave slunk off into the dark", n)
}

// endWave pays the wave bonus and starts the build countdown.
func (w *World) endWave() {
	bonus := int32(float32(40+15*w.Wave) * w.diff().Gold)
	for _, p := range w.Players {
		if !p.Connected {
			continue
		}
		p.Gold += bonus
		if !p.Alive {
			p.Respawn = 0
		}
	}
	if w.lastWave() {
		w.startEvac()
		return
	}
	w.Phase = PhaseBuild
	w.PhaseLeft = w.diff().Build
	if w.longBreak() {
		w.PhaseLeft = w.diff().Rest
	}
	w.rollWeather()
	defer w.forecast()
	w.note(1, "wave %d cleared  ·  +%d gold each  ·  wave %d in %.0fs", w.Wave, bonus, w.Wave+1, w.PhaseLeft)
	if w.longBreak() {
		w.note(1, "long break: %.0fs to explore and loot before wave %d", w.PhaseLeft, w.Wave+1)
	}
	if w.Wave%dropEvery == 0 {
		w.callDrop()
	}
	if w.Wave%5 == 0 {
		if n := w.restock(); n > 0 {
			w.note(0, "%d searched places out there have something in them again", n)
		}
	}
}

// callBack is how long before the end of a long break the team is told to come home.
const callBack = 10

// longBreak reports whether the break after the wave just played is the long one: every
// fifth wave, time to go out exploring and looting.
func (w *World) longBreak() bool { return w.Wave > 0 && w.Wave%5 == 0 }

// Budget is the wave's size in walker equivalents. It grows faster the longer the game goes,
// and each player beyond the first adds more of it as the game goes on.
func Budget(wave, players int) float32 {
	f := float32(wave)
	base := 20 + 12*f + 1.1*f*f + .015*f*f*f
	crowd := 1 + (.6+.015*min(f, 30))*float32(players-1)
	if wave%5 == 0 {
		// Every fifth wave is a swarm, and they swell: twice the creeps at wave 10, three
		// times at wave 30.
		base *= 1.5 + .05*min(f, 40)
	}
	return base * crowd
}

// hordeFrom is the first swarm wave that also breaks over the base all at once.
const hordeFrom = 10

// mixWeight is how often each kind is picked for a group once its wave is reached; brutes
// grow more common up to wave 24, maulers up to wave 30.
var mixWeight = [NumCreepKinds]float32{CWalker: 1, CRunner: .5, CSwarmer: .6, CBrute: .1, CSpitter: .25, CHurler: .15, CHound: .3, CMauler: .02}

// walkersFor is how many times over a wave's budget pays for walkers: twice from wave 3. The
// first wave is left as it was, all the starting turrets can hold alone, the second between.
func walkersFor(wave int) float32 {
	return min(.5+.5*float32(wave), 2)
}

// cost is what one creep of kind k takes from wave's budget.
func cost(k CreepKind, wave int) float32 {
	if k == CWalker {
		return Creeps[k].Cost / walkersFor(wave)
	}
	return Creeps[k].Cost
}

// groupSize is the range of a group's size per kind.
var groupSize = [NumCreepKinds][2]int{CWalker: {4, 12}, CRunner: {3, 8}, CSwarmer: {12, 30}, CBrute: {1, 2}, CSpitter: {2, 4}, CBoss: {1, 1}, CHurler: {1, 3}, CMother: {1, 1}, CHound: {4, 8}, CMauler: {1, 1}, CGoliath: {1, 1}}

// plan lays out every spawn of a wave: groups of one kind at one place on one of the wave's
// fronts, spread over the wave's opening seconds.
func (w *World) plan(wave, players int) []Spawn {
	budget := Budget(wave, players) * w.diff().Count
	swarm := wave%5 == 0
	var weights [NumCreepKinds]float32
	for k := CreepKind(0); k < NumCreepKinds; k++ {
		if Creeps[k].MinWave > wave || k.Boss() {
			continue
		}
		weights[k] = mixWeight[k]
		switch k {
		case CBrute:
			weights[k] *= float32(min(wave, 24)) / 4
		case CMauler:
			weights[k] *= float32(min(wave, 30) - 9)
		}
	}
	if swarm {
		weights[CSwarmer] = 5
	}
	var total float32
	for _, v := range weights {
		total += v
	}
	dur := 14 + min(float32(wave), 30)
	fronts := w.nextFronts
	if fronts == nil {
		fronts = w.pickFronts(wave)
	}
	w.nextFronts = nil
	at := func() [2]float32 {
		f := fronts[w.rng.IntN(len(fronts))]
		return f[w.rng.IntN(len(f))]
	}
	q := make([]Spawn, 0, int(budget*1.5))
	add := func(k CreepKind, at float32, sp [2]float32, j int) {
		x := sp[0] + (w.rng.Float32()-.5)*4
		y := sp[1] + (w.rng.Float32()-.5)*4
		// Not on solid ground, nor in a sealed room of a ruin by the edge, which no creep
		// could leave and no survivor get into, holding the wave for good.
		if w.At(int(x), int(y)).Solid() || !w.reachable(x, y) {
			x, y = sp[0], sp[1]
		}
		q = append(q, Spawn{At: at + float32(j)*.12, Kind: k, X: x, Y: y})
	}
	if wave%10 == 0 {
		for i := 0; i < wave/10; i++ {
			k := bossKind(wave/10 - 1 + i)
			add(k, dur*.5+float32(i)*3, at(), 0)
			budget -= Creeps[k].Cost * .5
		}
	}
	if wave%5 == 0 && wave >= hordeFrom {
		// The horde: a third of the wave pours out of every place on its fronts together, a
		// few seconds into it, so it hits as one wall.
		surge := budget / 3
		budget -= surge
		t0 := 4 + w.rng.Float32()*4
		for surge > 0 {
			for _, f := range fronts {
				for _, sp := range f {
					k := CSwarmer
					if w.rng.IntN(3) == 0 {
						k = CWalker
					}
					add(k, t0+w.rng.Float32()*6, sp, 0)
					surge -= cost(k, wave)
				}
			}
		}
	}
	for budget > 0 {
		r := w.rng.Float32() * total
		k := CWalker
		for kk, v := range weights {
			if r < v {
				k = CreepKind(kk)
				break
			}
			r -= v
		}
		lo, hi := groupSize[k][0], groupSize[k][1]
		n := lo + w.rng.IntN(hi-lo+1)
		sp, t := at(), w.rng.Float32()*dur
		for j := 0; j < n && budget > 0; j++ {
			add(k, t, sp, j)
			budget -= cost(k, wave)
		}
	}
	sort.Slice(q, func(i, j int) bool { return q[i].At < q[j].At })
	return q
}

func (w *World) spawnDue() {
	for w.QueueHead < len(w.Queue) && w.Queue[w.QueueHead].At <= w.WaveTime {
		s := w.Queue[w.QueueHead]
		w.QueueHead++
		if w.SpawnCreep(s.Kind, s.X, s.Y) {
			w.mark(&w.Creeps[len(w.Creeps)-1])
		}
	}
}

// SpawnCreep adds a creep scaled to the current wave. It returns false when the id space is
// full.
func (w *World) SpawnCreep(k CreepKind, x, y float32) bool {
	if len(w.freeIDs) == 0 {
		return false
	}
	id := w.freeIDs[len(w.freeIDs)-1]
	w.freeIDs = w.freeIDs[:len(w.freeIDs)-1]
	hp := Creeps[k].HP * HPScale(max(w.Wave, 1)) * w.diff().HP
	w.Creeps = append(w.Creeps, Creep{X: x, Y: y, HP: hp, MaxHP: hp, ID: id, Kind: k, LastHit: -1, Cool: w.rng.Float32(),
		Hunt: -1, Siege: -1, Chase: -1, think: w.rng.Float32() * 2, ox: x, oy: y})
	if w.rng.Float32() < Creeps[k].Sprint {
		c := &w.Creeps[len(w.Creeps)-1]
		c.Sprinter, c.sprint = true, sprintFor
	}
	return true
}

// ---- creeps ----------------------------------------------------------------------------

func (w *World) stepCreeps() {
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if c.HP <= 0 {
			continue
		}
		d := &Creeps[c.Kind]
		if c.Mark > 0 {
			c.Mark -= Dt
		}
		if c.Burn > 0 {
			c.Burn -= Dt
			c.HP -= c.BurnDPS * w.burnMul() * Dt
			if c.HP <= 0 {
				continue
			}
		}
		w.patience(c, c.ox, c.oy)
		c.ox, c.oy = c.X, c.Y
		if c.stunned() {
			continue
		}
		speed := d.Speed * w.creepSpeedMul()
		if c.Frenzy {
			speed *= frenzySpeed
		}
		if c.Aff&AffixHasty != 0 {
			speed *= affixHaste
		}
		if c.Slow > 0 {
			c.Slow -= Dt
			speed *= c.slowed()
		}
		c.Cool -= Dt
		c.rest()
		c.Chase = -1
		c.swung, c.Swing = c.Swing, SwingNone
		if c.Asleep {
			if !w.wakes(c, d) {
				continue
			}
			w.wakeSite(c)
		}
		if c.Home == 0 && !c.Wander && !c.lured {
			w.think(c, d)
		}

		// The survivor it is after, if any; else a guard goes home, a creep that took against
		// a structure goes for it, and the rest follow the field to the generator.
		tp := w.creepTarget(c, d)
		w.rally(c, tp)
		if w.creepGrab(c, d, tp) || w.bossSlam(c, tp) || w.motherLob(c, tp) {
			continue
		}
		var mx, my float32
		// The church bell outweighs home, wandering and a grudge against a structure.
		lure := tp == nil && c.lured
		if tp == nil && c.Home > 0 && !lure {
			w.goHome(c, d, speed)
			continue
		}
		if tp == nil && c.Wander && !lure {
			w.wander(c, d, speed)
			continue
		}
		if tp == nil && c.Siege >= 0 && !lure {
			s := &w.Structs[c.Siege]
			if !s.Alive {
				c.Siege = -1
			} else {
				dx, dy := s.CX()-c.X, s.CY()-c.Y
				dist := sqrt32(dx*dx+dy*dy) + 1e-6
				if dist <= d.Radius+d.Reach+float32(max(s.W, s.H))/2+.2 {
					w.attackStruct(c, d, int(c.Siege))
					continue
				}
				// It goes for what it can walk up to, and gives up on what a wall stands in front of.
				ox, oy := c.X, c.Y
				w.moveCreep(c, d, c.X+dx/dist*speed*Dt, c.Y+dy/dist*speed*Dt, c.breaks())
				if c.X == ox && c.Y == oy {
					c.Siege = -1
				}
				continue
			}
		}
		brk := c.breaks() // whether it breaks what it walks into
		if tp != nil {
			c.Chase = int8(tp.ID)
			dx, dy := tp.X-c.X, tp.Y-c.Y
			dist := sqrt32(dx*dx + dy*dy)
			reach := d.Radius + d.Reach
			// A spitter needs a clear line, the same one a survivor's shot needs back.
			if d.Ranged && dist <= reach && w.clearShot(c.X, c.Y, tp.X, tp.Y) {
				if c.swing(d, tp.X, tp.Y) {
					if c.Kind == CSpitter {
						w.spit(c, d, tp)
						continue
					}
					w.hurtPlayer(tp, d.Damage)
					tp.slow(playerSlow[c.Kind])
					kind := uint8(TracerSpit)
					if c.Kind == CHurler {
						kind = TracerShard
					}
					w.tracer(c.X, c.Y, tp.X, tp.Y, kind)
				}
				continue
			}
			if !d.Ranged && (dist <= reach || c.swung != SwingNone && dist <= reach+lunge) {
				// A chaser swings on the run: it keeps after a survivor who moves while it
				// winds up, and the blow lands on them if they are still within a lunge.
				if c.swing(d, tp.X, tp.Y) {
					w.hurtPlayer(tp, d.Damage)
					tp.slow(playerSlow[c.Kind])
				}
				close := d.Radius + PlayerRadius + .1
				if dist <= close+.05 {
					continue
				}
				speed = min(w.pursuit(c, d, speed, dist), (dist-close)/Dt)
				mx, my = dx/dist, dy/dist
			} else if wx, wy, ok := w.chaseWay(c, tp, dist); ok {
				mx, my = wx, wy
				speed = w.pursuit(c, d, speed, dist)
			} else {
				// Behind a wall with no way round to them: it keeps to the maze, wanting them,
				// and its patience wears the faster for it.
				tp, c.Chase = nil, -1
				if c.trekMax > 0 {
					c.trek += balkWear * Dt
				}
			}
		}
		if tp == nil {
			tx, ty := int(c.X), int(c.Y)
			ti := ty*w.W + tx
			if tx < 0 || ty < 0 || tx >= w.W || ty >= w.H {
				continue
			}
			// The generator's field, or the church's while its bell draws them, at a hurry.
			f, gx, gy := &w.flow, w.CoreX, w.CoreY
			brk = true
			if lure {
				s := &w.Sites[w.bell.site]
				f, gx, gy = &w.bell.flow, s.SX, s.SY
				speed *= pullPace
			} else {
				f, brk = w.fieldFor(c, ti)
				if f == &w.maze && w.shoulder(c, d, ti) {
					continue
				}
			}
			nx := f.next[ti]
			switch {
			case nx < 0 && f.dist[ti] == 0:
				// In the nave, or on the helipad the evac lands on: milling about, only the
				// crowd moving it.
			case nx < 0:
				// Unreachable from here: walk straight at the goal and break what is in the way.
				dx, dy := gx-c.X, gy-c.Y
				dl := sqrt32(dx*dx+dy*dy) + 1e-6
				mx, my = dx/dl, dy/dl
			default:
				gx, gy := float32(int(nx)%w.W)+.5, float32(int(nx)/w.W)+.5
				if si := w.creepWall(int(nx)); si >= 0 && (brk || int(si) == w.Core) {
					reach := d.Radius + d.Reach + .55
					if dx, dy := gx-c.X, gy-c.Y; dx*dx+dy*dy <= reach*reach {
						w.attackStruct(c, d, int(si))
						continue
					}
				}
				// Look one step further to cut the staircase a grid path makes.
				if nn := f.next[nx]; nn >= 0 && w.creepWall(int(nn)) < 0 {
					gx = (gx + float32(int(nn)%w.W) + .5) / 2
					gy = (gy + float32(int(nn)/w.W) + .5) / 2
				}
				dx, dy := gx-c.X, gy-c.Y
				dl := sqrt32(dx*dx+dy*dy) + 1e-6
				mx, my = dx/dl, dy/dl
			}
		}

		// Separation: a crowd spreads out instead of stacking into one cell. A creep that has
		// got nowhere for a while is let through: two pressed together against water or a
		// wall can hold each other in place for good, the push cancelling the step.
		var px, py float32
		seen := 0
		cx, cy, cr := c.X, c.Y, d.Radius
		id := c.ID
		w.grid.each(cx, cy, cr+1, func(j int32) bool {
			if c.jam > jamAfter {
				return false
			}
			o := &w.Creeps[j]
			if o.ID == id {
				return true
			}
			dx, dy := cx-o.X, cy-o.Y
			minD := (cr + Creeps[o.Kind].Radius) * .8
			dd := dx*dx + dy*dy
			if dd < minD*minD {
				if dd < 1e-6 {
					a := float32(id) * 2.399963
					dx, dy, dd = float32(math.Cos(float64(a)))*.01, float32(math.Sin(float64(a)))*.01, 1e-4
				}
				dist := sqrt32(dd)
				push := (minD - dist) / dist * .5
				px += dx * push
				py += dy * push
			}
			seen++
			return seen < 8
		})
		step := speed * Dt
		nxp := c.X + mx*step + px*.6
		nyp := c.Y + my*step + py*.6
		ox, oy := c.X, c.Y
		w.moveCreep(c, d, nxp, nyp, brk)
		// Let through, it keeps going for jamThrough seconds before the crowd pushes again:
		// pressed against one that never moves, a sleeping guard, the first free step would
		// otherwise bring the push back and it would stand there for good.
		switch moved := abs32(c.X-ox) + abs32(c.Y-oy); {
		case moved >= step*.1 && c.jam > jamAfter:
			c.jam = max(c.jam-Dt, jamAfter)
		case moved >= step*.1:
			c.jam = 0
		case c.jam <= jamAfter:
			if c.jam += Dt; c.jam > jamAfter {
				c.jam = jamAfter + jamThrough
			}
		}
	}
}

// Swing is where a creep's attack is, for the client to animate it.
type Swing uint8

const (
	SwingNone   Swing = iota
	SwingReady        // in reach, between blows
	SwingWindup       // the blow is coming: the last Windup seconds before it lands
	SwingStrike       // it lands this tick
)

// lunge is how far past its reach a chaser's wound-up blow still lands on a survivor who
// has stepped away.
const lunge = .6

// swing is a creep in reach of what it attacks at tx, ty this tick: it turns to it, and
// reports whether a blow lands now. Coming into reach it winds up first, so every blow is
// telegraphed by Windup seconds of the swing pose before the strike.
func (c *Creep) swing(d *CreepDef, tx, ty float32) bool {
	c.Face = float32(math.Atan2(float64(ty-c.Y), float64(tx-c.X)))
	if c.swung == SwingNone && c.Swing == SwingNone && c.Cool < d.Windup {
		c.Cool = d.Windup
	}
	switch {
	case c.Cool <= 0:
		c.Cool = 1 / d.Rate
		c.Swing = SwingStrike
		return true
	case c.Cool <= d.Windup:
		c.Swing = max(c.Swing, SwingWindup)
	default:
		c.Swing = max(c.Swing, SwingReady)
	}
	return false
}

// moveCreep moves a creep to nx, ny, sliding along what it cannot enter; it attacks the
// generator when it walks into it, and with brk any structure that blocks it.
func (w *World) moveCreep(c *Creep, d *CreepDef, nx, ny float32, brk bool) {
	if ok, si := w.creepFree(nx, c.Y); ok {
		c.X = nx
	} else if si >= 0 && (brk || si == w.Core) {
		w.attackStruct(c, d, si)
	}
	if ok, si := w.creepFree(c.X, ny); ok {
		c.Y = ny
	} else if si >= 0 && (brk || si == w.Core) {
		w.attackStruct(c, d, si)
	}
}

// jamAfter is how long a creep gets nowhere before the crowd stops pushing it about, and
// jamThrough how long after that it walks through the crowd.
const (
	jamAfter   = 1
	jamThrough = 2
)

// reachable reports whether the generator's field reaches the tile under x, y.
func (w *World) reachable(x, y float32) bool {
	tx, ty := int(x), int(y)
	return tx >= 0 && ty >= 0 && tx < w.W && ty < w.H && w.flow.dist[ty*w.W+tx] < unreachable
}

// creepFree reports whether a creep may stand at x, y, and the structure in the way if not.
func (w *World) creepFree(x, y float32) (bool, int) {
	tx, ty := int(x), int(y)
	if tx < 0 || ty < 0 || tx >= w.W || ty >= w.H {
		return false, -1
	}
	i := ty*w.W + tx
	if w.Terrain[i].Solid() {
		return false, -1
	}
	if si := w.creepWall(i); si >= 0 {
		return false, int(si)
	}
	return true, -1
}

func (w *World) attackStruct(c *Creep, d *CreepDef, si int) {
	s := &w.Structs[si]
	if !c.swing(d, s.CX(), s.CY()) {
		return
	}
	if !s.Alive || s.Kind == SArmory {
		return
	}
	if c.Aff&AffixSappers != 0 && si != w.Core {
		w.sap(c)
		return
	}
	dmg := d.Damage
	if c.Kind.Heavy() {
		dmg *= 1.5 // built for walls
	}
	if c.Frenzy {
		dmg *= frenzyStruct
	}
	s.HP -= dmg
	if d.Ranged {
		kind := uint8(TracerSpit)
		if c.Kind == CHurler {
			kind = TracerShard
		}
		w.tracer(c.X, c.Y, s.CX(), s.CY(), kind)
	}
}

func (w *World) hurtPlayer(p *Player, dmg float32) {
	if p.Shield > 0 {
		return
	}
	p.Tally.Taken += float64(min(dmg, max(p.HP, 0)))
	p.HP -= dmg
	p.Hurt = .25
	if p.Heal > 0 {
		p.Heal = 0
		w.toast(p, 2, "a hit cut the medkit short")
	}
	if p.HP <= 0 {
		p.HP = 0
		p.Alive = false
		p.Tally.Downs++
		p.Respawn = w.diff().Revive
		p.Firing = false
		p.Order = Order{}
		p.Search, p.Revived, p.Emote, p.EmoteLeft = 0, 0, 0, 0
		p.BuffLeft = 0
		p.held, p.fly = false, 0
		w.note(2, "%s is down  ·  revive them within %.0fs or they are back at the base", p.Name, p.Respawn)
	}
}

// ---- players ---------------------------------------------------------------------------

// standNear is the nearest place to x, y a survivor fits, so one put back at the base is never
// put inside a wall or turret built on the spot, where they could not move.
func (w *World) standNear(x, y float32) (float32, float32) {
	for r := 0; r <= 24; r++ {
		for dy := -r; dy <= r; dy++ {
			for dx := -r; dx <= r; dx++ {
				if max(abs(dx), abs(dy)) != r {
					continue
				}
				if qx, qy := x+float32(dx)*.5, y+float32(dy)*.5; CanStand(w, qx, qy) {
					return qx, qy
				}
			}
		}
	}
	return x, y
}

func (w *World) respawn(p *Player) {
	p.Alive = true
	p.HP = p.MaxHP
	p.Shield = 0
	p.X, p.Y = w.standNear(w.CoreX+.5, w.CoreY+3.8)
	p.Order = Order{}
	p.Search, p.Revived = 0, 0
	p.slowLeft, p.slowCool, p.stunLeft = 0, 0, 0
	p.held, p.fly = false, 0
	p.walk.reset()
	p.BuffLeft = 0
	p.Stamina, p.Winded = 1, false
	for i := range p.Weapons {
		if p.Weapons[i].Owned {
			p.Weapons[i].Reload = 0
			p.Weapons[i].Ammo = p.Weapons[i].Stats(WeaponKind(i)).Mag
		}
	}
}

// repair heals a structure for one tick, paid for as it goes; false when the gold ran out.
// The gold is charged by the hit point, a coin at a time as the cost adds up, so mending a
// scratch costs a scratch's worth and not a coin a tick.
func (w *World) repair(p *Player, si int) bool {
	s := &w.Structs[si]
	hp := min(80*Dt*float32(1+p.Gear[GearVitamins]/2), s.MaxHP-s.HP)
	owed := p.repairOwed + hp*RepairRate(s)
	if float32(p.Gold) < owed {
		return false
	}
	coins := int32(owed)
	p.Gold -= coins
	p.repairOwed = owed - float32(coins)
	s.HP += hp
	return true
}

// mended reports whether s is as good as whole: within half a hit point of its max, which is
// what the survivors see as full.
func (s *Structure) mended() bool { return s.HP > s.MaxHP-.5 }

func (w *World) toast(p *Player, level uint8, format string, a ...any) {
	w.Toasts = append(w.Toasts, Toast{Player: p.ID, Level: level, Text: fmt.Sprintf(format, a...)})
}

// blocksShot reports whether bullets and spit stop at tile x, y: trees and ruin walls do,
// but a lone rock, drawn as a low junk heap, is shot over.
func (w *World) blocksShot(x, y int) bool {
	t := w.At(x, y)
	if t != TRock {
		return t.BlocksShots()
	}
	return w.At(x-1, y) == TRock || w.At(x+1, y) == TRock || w.At(x, y-1) == TRock || w.At(x, y+1) == TRock
}

// clearShot reports whether a shot from x0, y0 reaches x1, y1, walked the way hitscan walks
// it: ruin walls and trees stop it.
func (w *World) clearShot(x0, y0, x1, y1 float32) bool {
	dx, dy := x1-x0, y1-y0
	d := sqrt32(dx*dx + dy*dy)
	if d < .5 {
		return true
	}
	dx, dy = dx/d, dy/d
	for t := float32(.5); t < d; t += .5 {
		if w.blocksShot(int(x0+dx*t), int(y0+dy*t)) {
			return false
		}
	}
	return true
}

// nearestVisible is the closest living creep within r of x, y that a shot from there
// reaches, or -1: the one to shoot, rather than one behind a wall.
func (w *World) nearestVisible(x, y, r float32) int32 { return w.nearestShot(x, y, r, false) }

func (w *World) nearestShot(x, y, r float32, seen bool) int32 {
	best, bi := r*r, int32(-1)
	w.grid.each(x, y, r, func(i int32) bool {
		c := &w.Creeps[i]
		if c.HP <= 0 || seen && w.hidden(c) {
			return true
		}
		dx, dy := c.X-x, c.Y-y
		if dd := dx*dx + dy*dy; dd < best && w.clearShot(x, y, c.X, c.Y) {
			best, bi = dd, i
		}
		return true
	})
	return bi
}

// nearestSeen is nearestVisible for a survivor's gun: at night, only what the team can see.
func (w *World) nearestSeen(x, y, r float32) int32 { return w.nearestShot(x, y, r, true) }

func (w *World) nearestCreep(x, y, r float32) int32 {
	best, bi := r*r, int32(-1)
	w.grid.each(x, y, r, func(i int32) bool {
		c := &w.Creeps[i]
		if c.HP <= 0 {
			return true
		}
		dx, dy := c.X-x, c.Y-y
		if dd := dx*dx + dy*dy; dd < best {
			best, bi = dd, i
		}
		return true
	})
	return bi
}

func (w *World) tracer(x0, y0, x1, y1 float32, kind uint8) {
	if len(w.Tracers) < 768 {
		w.Tracers = append(w.Tracers, Tracer{x0, y0, x1, y1, kind})
	}
}

func (w *World) shoot(p *Player, st Stats, ang float32) {
	owner := int8(p.ID)
	kind := uint8(p.Cur)
	ult := p.ulting(p.Cur)
	if ult {
		kind += TracerUlt
	}
	switch Weapons[p.Cur].Fire {
	case FireMelee:
		hits := w.melee(owner, p.X, p.Y, ang, st.Range, st.Spread, st.Damage, kind)
		if ult && p.Cur == WCrowbar {
			p.HP = min(p.MaxHP, p.HP+float32(hits)*st.Damage*berserkLeech)
		}
	case FireRocket:
		a := ang + (w.rng.Float32()*2-1)*st.Spread
		const speed = 22
		w.Rockets = append(w.Rockets, Projectile{X: p.X, Y: p.Y, VX: float32(math.Cos(float64(a))) * speed, VY: float32(math.Sin(float64(a))) * speed,
			TTL: st.Range / speed, Damage: st.Damage, Blast: st.Blast, Owner: owner})
	default:
		sh := shot{stun: st.Stun, shove: st.Shove}
		// Dragon's breath burns as hot at the end of its reach as at the muzzle.
		if p.Cur == WShotgun && !ult {
			sh.fall = shotFall
		}
		if ult && p.Cur == WShotgun {
			sh.shoveFar = shoveStep
		}
		for k := 0; k < st.Pellets; k++ {
			a := ang + (w.rng.Float32()*2-1)*st.Spread
			w.hitscan(owner, p.X, p.Y, a, st.Range, st.Damage, st.Pierce, st.Burn, kind, sh)
		}
	}
}

// shot is what a bullet does to the creeps it hits besides its damage.
type shot struct {
	stun     float32 // how many times a hit's stun
	shove    float32 // how far it pushes a creep back up close (shoveAt)
	shoveFar float32 // and how far at any distance, under Dragon's breath
	fall     float32 // the share of its damage it has lost by the end of its range (fallAt)
}

// A shotgun pellet hits full out to shotNear tiles, then loses its damage evenly until, at
// the gun's range, it has lost shotFall of it: brutal across a room, a scatter of weak hits
// across a field, where the spread has already lost most of the load.
const (
	shotNear = 3
	shotFall = .65
)

// fallAt is the share of its damage a round of shot s keeps t tiles out of a range of rng.
func (s shot) fallAt(t, rng float32) float32 {
	if s.fall <= 0 || rng <= shotNear {
		return 1
	}
	return 1 - s.fall*clampf((t-shotNear)/(rng-shotNear), 0, 1)
}

// plainShot stuns as any hit does and pushes nothing.
var plainShot = shot{stun: 1}

// How far a shotgun pellet pushes a creep back, before its size: shotShove and shotShoveLevel
// more for each level of the special track, and shoveStep more under Dragon's breath. A
// point-blank load lands most of its pellets, so it shoves a walker about a quarter of a tile at
// first and a tile and a half fully upgraded. The shotgun is for close range, so the push is
// full out to shoveNear, fades to nothing at shoveReach, and is gone past it, well short of the
// gun's range; only Dragon's breath shoves at any distance.
const (
	shotShove      = .05
	shotShoveLevel = .015
	shoveStep      = .1
	shoveNear      = 2
	shoveReach     = 5
)

// shoveAt is how far a pellet of shot s that travelled t pushes its creep.
func (s shot) shoveAt(t float32) float32 {
	near := min(max((shoveReach-t)/(shoveReach-shoveNear), 0), 1)
	return s.shove*near + s.shoveFar
}

// push moves creep i up to d along dx, dy, as far as it is free to go; bosses stand firm.
func (w *World) push(i int32, dx, dy, d float32) {
	c := &w.Creeps[i]
	if c.Kind.Boss() {
		return
	}
	d /= 1 + Creeps[c.Kind].Radius
	for s := 0; s < 3; s++ {
		nx, ny := c.X+dx*d/3, c.Y+dy*d/3
		if ok, _ := w.creepFree(nx, ny); !ok {
			break
		}
		c.X, c.Y = nx, ny
	}
}

type hitCand struct {
	t float32
	i int32
}

// hitscan resolves a bullet: every creep the ray passes close enough to, nearest first,
// up to pierce+1 of them. Trees and buildings stop it; walls do not, so the base can be
// defended from behind its own walls.
func (w *World) hitscan(owner int8, x, y, ang, rng, dmg float32, pierce int, burn float32, kind uint8, sh shot) {
	dx, dy := float32(math.Cos(float64(ang))), float32(math.Sin(float64(ang)))
	maxT := rng
	for t := float32(.5); t < rng; t += .5 {
		if w.blocksShot(int(x+dx*t), int(y+dy*t)) {
			maxT = t
			break
		}
	}
	// A fuel pump in the way stops the shot, and goes up, unless a creep takes it first.
	pump, pumpT := w.pumpOnRay(x, y, dx, dy, maxT)
	if pump >= 0 {
		maxT = pumpT
	}
	cands := w.hitBuf[:0]
	w.rayCells(x, y, dx, dy, maxT, func(i int32) {
		c := &w.Creeps[i]
		if c.HP <= 0 || w.hidden(c) {
			return
		}
		ox, oy := c.X-x, c.Y-y
		t := ox*dx + oy*dy
		if t < 0 || t > maxT {
			return
		}
		px, py := ox-dx*t, oy-dy*t
		r := Creeps[c.Kind].Radius + .2
		if px*px+py*py <= r*r {
			cands = append(cands, hitCand{t, i})
		}
	})
	// Insertion sort: the list is short and usually nearly sorted already.
	for a := 1; a < len(cands); a++ {
		for b := a; b > 0 && cands[b].t < cands[b-1].t; b-- {
			cands[b], cands[b-1] = cands[b-1], cands[b]
		}
	}
	endT := maxT
	n := min(len(cands), pierce+1)
	for k := 0; k < n; k++ {
		w.hit(cands[k].i, dmg*sh.fallAt(cands[k].t, rng), owner, sh.stun)
		if burn > 0 {
			w.ignite(cands[k].i, burn)
		}
		if d := sh.shoveAt(cands[k].t); d > 0 {
			w.push(cands[k].i, dx, dy, d)
		}
		if k == n-1 && n == pierce+1 {
			endT = cands[k].t
		}
	}
	w.hitBuf = cands[:0]
	if pump >= 0 && endT >= pumpT {
		w.lightPump(pump, owner, Dt)
	}
	w.tracer(x, y, x+dx*endT, y+dy*endT, kind)
}

// rayCells calls fn once for every creep in the grid cells within reach of the segment.
func (w *World) rayCells(x, y, dx, dy, length float32, fn func(i int32)) {
	g := &w.grid
	cs := w.scratch[:0]
	for t := float32(0); ; t += cellSize * .5 {
		if t > length {
			t = length
		}
		px, py := x+dx*t, y+dy*t
		cx, cy := int(px)/cellSize, int(py)/cellSize
		for oy := -1; oy <= 1; oy++ {
			for ox := -1; ox <= 1; ox++ {
				nx, ny := cx+ox, cy+oy
				if nx < 0 || ny < 0 || nx >= g.cw || ny >= g.ch {
					continue
				}
				c := int32(ny*g.cw + nx)
				dup := false
				for _, s := range cs {
					if s == c {
						dup = true
						break
					}
				}
				if !dup {
					cs = append(cs, c)
				}
			}
		}
		if t >= length {
			break
		}
	}
	for _, c := range cs {
		for _, i := range g.items[g.start[c]:g.start[c+1]] {
			fn(i)
		}
	}
	w.scratch = cs[:0]
}

// meleeHits is how many creeps one swing of a melee weapon goes through.
const meleeHits = 4

// melee is a swing: the nearest few creeps within reach and within half radians of the aim
// are hit. One tracer, from the survivor along the swing, lets the client draw it.
func (w *World) melee(owner int8, x, y, ang, reach, half, dmg float32, kind uint8) int {
	dx, dy := float32(math.Cos(float64(ang))), float32(math.Sin(float64(ang)))
	cosHalf := float32(math.Cos(float64(half)))
	cands := w.hitBuf[:0]
	w.grid.each(x, y, reach+1, func(i int32) bool {
		c := &w.Creeps[i]
		if c.HP <= 0 || w.hidden(c) {
			return true
		}
		ox, oy := c.X-x, c.Y-y
		d := sqrt32(ox*ox + oy*oy)
		if d > reach+Creeps[c.Kind].Radius || d > 1e-3 && (ox*dx+oy*dy)/d < cosHalf {
			return true
		}
		cands = append(cands, hitCand{d, i})
		return true
	})
	for a := 1; a < len(cands); a++ {
		for b := a; b > 0 && cands[b].t < cands[b-1].t; b-- {
			cands[b], cands[b-1] = cands[b-1], cands[b]
		}
	}
	hits := min(len(cands), meleeHits)
	for k := 0; k < hits; k++ {
		w.damage(cands[k].i, dmg, owner)
	}
	w.hitBuf = cands[:0]
	w.tracer(x, y, x+dx*reach, y+dy*reach, kind)
	return hits
}

func (w *World) ignite(i int32, dps float32) {
	c := &w.Creeps[i]
	c.Burn = 2.5
	if dps > c.BurnDPS {
		c.BurnDPS = dps
	}
}

// damage is a hit on creep i that stuns as any hit does.
func (w *World) damage(i int32, dmg float32, owner int8) { w.hit(i, dmg, owner, 1) }

// hit deals dmg to creep i from owner, -1 for nobody, and stuns it stun times as long as a hit
// does.
func (w *World) hit(i int32, dmg float32, owner int8, stun float32) {
	c := &w.Creeps[i]
	if c.HP <= 0 || owner >= 0 && w.hidden(c) {
		return
	}
	d := dmg
	if !w.noArmor {
		d = max(dmg-c.armor(), dmg*.25)
	}
	if c.Mark > 0 {
		d *= 1 + markBonus
	}
	dealt := min(d, c.HP) // what the creep had left: overkill charges nothing
	c.HP -= d
	w.provoke(c)
	if owner >= 0 && !w.turretFire && !w.burning {
		c.stun(stun)
	}
	if owner >= 0 {
		c.LastHit, c.Shared = owner, w.turretFire || w.trap
		if int(owner) < len(w.Players) {
			p := w.Players[owner]
			p.Damage += float64(d)
			if w.turretFire {
				p.Tally.Turret += float64(d)
			} else if !w.burning {
				p.charge(dealt / w.ultFull())
			}
		}
	}
}

func (w *World) explode(x, y, r, dmg float32, owner int8, kind uint8) {
	w.grid.each(x, y, r, func(i int32) bool {
		c := &w.Creeps[i]
		dx, dy := c.X-x, c.Y-y
		dd := dx*dx + dy*dy
		if dd > r*r {
			return true
		}
		w.damage(i, dmg*(1-.5*sqrt32(dd)/r), owner)
		return true
	})
	w.pumpsIn(x, y, r, owner, pumpChain)
	w.Blasts = append(w.Blasts, Blast{x, y, r, kind})
}

// ---- turrets and rockets ---------------------------------------------------------------

func (w *World) stepTurrets() {
	w.turretFire = true
	defer func() { w.turretFire, w.noArmor = false, false }()
	w.findPylons()
	for si := range w.Structs {
		s := &w.Structs[si]
		if !s.Alive || !Structs[s.Kind].Turret {
			continue
		}
		s.Cool -= Dt
		if s.Cool > 0 {
			continue
		}
		st := StructStats(s)
		var fx evoFx
		if e := evolution(s); e != nil {
			fx = e.fx
		}
		if len(w.pylons) > 0 && w.pylonNear(s) {
			st.Rate *= 1 + pylonAmp
		}
		rng := st.Range * w.rangeMul()
		x, y := s.CX(), s.CY()
		var t int32
		switch {
		case s.Kind == STurretSniper:
			t = w.toughestVisible(x, y, rng)
		case fx == fxLob:
			t = w.nearestCreep(x, y, rng)
		default:
			t = w.nearestVisible(x, y, rng)
		}
		if t < 0 {
			s.Cool = .2 // idle: look again shortly rather than every tick
			continue
		}
		s.Cool = 1 / st.Rate
		c := &w.Creeps[t]
		kind := TracerTurret + uint8(s.Kind)
		w.noArmor = fx == fxPierce
		switch fx {
		case fxStorm:
			st.Damage *= 1 + w.wet()
		case fxSpot:
			c.Mark = markFor
		}
		switch s.Kind {
		case STurretGun, STurretSniper:
			if st.Share > 0 {
				// A sniper's round tears a share of what its mark can take out of it, armour
				// and all: the bigger the creep, the harder it hits.
				w.noArmor = true
				w.damage(t, st.Share*c.MaxHP, s.Owner)
				w.noArmor = fx == fxPierce
			}
			ang := float32(math.Atan2(float64(c.Y-y), float64(c.X-x)))
			w.hitscan(s.Owner, x, y, ang, rng, st.Damage, st.Pierce, 0, kind, plainShot)
		case STurretCannon:
			w.tracer(x, y, c.X, c.Y, kind)
			w.explode(c.X, c.Y, st.Blast, st.Damage, s.Owner, 0)
		case STurretFrost:
			s.pulses++
			freeze := fx == fxCryo && s.pulses%cryoEvery == 0
			w.grid.each(x, y, rng, func(i int32) bool {
				o := &w.Creeps[i]
				dx, dy := o.X-x, o.Y-y
				if dx*dx+dy*dy <= rng*rng {
					o.chill(st.Slow, st.Chill)
					if freeze {
						o.stunLeft = max(o.stunLeft, cryoFreeze)
					}
					w.damage(i, st.Damage, s.Owner)
				}
				return true
			})
			w.Blasts = append(w.Blasts, Blast{x, y, rng, 1})
		case STurretTesla:
			w.chain(s, t, st.Damage, st.Chains, st.Hop)
		case STurretMissile:
			var burn float32
			if fx == fxNapalm {
				burn = napalmBurn * st.Damage
			}
			w.salvo(s, t, rng, st, burn)
		}
		w.noArmor = false
	}
}

// toughestVisible is the creep with the most hit points left within r of x, y that a shot
// from there can reach: a sniper's mark.
func (w *World) toughestVisible(x, y, r float32) int32 {
	most, bi := float32(0), int32(-1)
	w.grid.each(x, y, r, func(i int32) bool {
		c := &w.Creeps[i]
		if c.HP <= most {
			return true
		}
		dx, dy := c.X-x, c.Y-y
		if dx*dx+dy*dy <= r*r && w.clearShot(x, y, c.X, c.Y) {
			most, bi = c.HP, i
		}
		return true
	})
	return bi
}

// missileSpeed is how fast a battery's missiles fly, tiles per second.
const missileSpeed = 18

// salvo fires a missile battery: one missile at its target and one at each of the next
// nearest creeps it can reach, round them again when there are fewer creeps than missiles.
func (w *World) salvo(s *Structure, first int32, rng float32, st TurretStat, burn float32) {
	x, y := s.CX(), s.CY()
	var marks [16]hitCand
	marks[0] = hitCand{0, first}
	n := 1
	w.grid.each(x, y, rng, func(i int32) bool {
		c := &w.Creeps[i]
		if i == first || c.HP <= 0 {
			return true
		}
		dx, dy := c.X-x, c.Y-y
		dd := dx*dx + dy*dy
		if dd > rng*rng || !w.clearShot(x, y, c.X, c.Y) {
			return true
		}
		// Keep the nearest few, nearest first.
		j := n
		if j == len(marks) {
			if dd >= marks[j-1].t {
				return true
			}
			j--
		} else {
			n++
		}
		for j > 1 && marks[j-1].t > dd {
			marks[j] = marks[j-1]
			j--
		}
		marks[j] = hitCand{dd, i}
		return true
	})
	for k := range st.Salvo {
		c := &w.Creeps[marks[k%n].i]
		// A missile goes for where its mark stands now, give or take: it neither leads a
		// creep on the move nor flies true, and bursts where it comes down.
		ax, ay := c.X, c.Y
		if st.Scatter > 0 {
			a, r := w.rng.Float32()*2*math.Pi, st.Scatter*sqrt32(w.rng.Float32())
			ax, ay = ax+r*cos32(a), ay+r*sin32(a)
		}
		dx, dy := ax-x, ay-y
		d := max(sqrt32(dx*dx+dy*dy), .1)
		w.Rockets = append(w.Rockets, Projectile{X: x, Y: y, VX: dx / d * missileSpeed, VY: dy / d * missileSpeed,
			TTL: d / missileSpeed, Damage: st.Damage, Blast: st.Blast, Owner: s.Owner, Turret: true, Burn: burn})
		if k < n {
			w.tracer(x, y, x+dx/d, y+dy/d, TracerTurret+uint8(STurretMissile))
		}
	}
}

// teslaFalloff is the share of its damage a tesla's arc keeps at every jump.
const teslaFalloff = .9

// chain arcs from a tesla coil to its target and on to the nearest creep not yet struck,
// losing some damage at every jump, each jump at most hop tiles. An arc web's jumps are drawn
// as its own, and each struck creep is linked to the one two back too, so the strike reads as
// a web rather than a line.
func (w *World) chain(s *Structure, first int32, dmg float32, jumps int, hop float32) {
	var struck [16]uint16
	var at [16][2]float32
	n := 0
	x, y := s.CX(), s.CY()
	web := s.Evo == 2
	cur := first
	for j := 0; j <= jumps && cur >= 0 && n < len(struck); j++ {
		c := &w.Creeps[cur]
		switch {
		case j == 0 || !web:
			w.tracer(x, y, c.X, c.Y, TracerTurret+uint8(STurretTesla))
		default:
			w.tracer(x, y, c.X, c.Y, TracerArc)
			if n >= 2 {
				w.tracer(at[n-2][0], at[n-2][1], c.X, c.Y, TracerArc)
			}
		}
		at[n] = [2]float32{c.X, c.Y}
		w.damage(cur, dmg, s.Owner)
		struck[n] = c.ID
		n++
		x, y = c.X, c.Y
		dmg *= teslaFalloff
		best, next := hop*hop, int32(-1)
		w.grid.each(x, y, hop, func(i int32) bool {
			o := &w.Creeps[i]
			if o.HP <= 0 {
				return true
			}
			for _, id := range struck[:n] {
				if id == o.ID {
					return true
				}
			}
			dx, dy := o.X-x, o.Y-y
			if dd := dx*dx + dy*dy; dd < best {
				best, next = dd, i
			}
			return true
		})
		cur = next
	}
	w.Blasts = append(w.Blasts, Blast{x, y, .8, 2})
}

func (w *World) stepRockets() {
	live := w.Rockets[:0]
	for _, r := range w.Rockets {
		r.X += r.VX * Dt
		r.Y += r.VY * Dt
		r.TTL -= Dt
		boom := r.TTL <= 0 || w.blocksShot(int(r.X), int(r.Y))
		// A cluster rocket flies over the crowd to its point, and a turret's missile to where
		// it was sent.
		if !boom && r.Cluster == 0 {
			// A rocket flies on through what nobody can see.
			if !r.Turret {
				t := w.nearestCreep(r.X, r.Y, .9)
				boom = t >= 0 && !w.hidden(&w.Creeps[t])
			}
			if v := sqrt32(r.VX*r.VX + r.VY*r.VY); !boom && v > 0 {
				if p, _ := w.pumpOnRay(r.X-r.VX*Dt, r.Y-r.VY*Dt, r.VX/v, r.VY/v, v*Dt+tankRadius); p >= 0 {
					boom = true
				}
			}
		}
		if boom {
			// A survivor's rocket provokes what it hits into coming for them; a turret's,
			// like any turret's shot, does not.
			if !r.Turret {
				w.shooter = r.Owner
			}
			w.turretFire = r.Turret
			w.explode(r.X, r.Y, r.Blast, r.Damage, r.Owner, 0)
			if !r.Turret && r.Cluster == 0 {
				w.backblast(&r)
			}
			if r.Burn > 0 {
				w.Blasts = append(w.Blasts, Blast{r.X, r.Y, r.Blast, BlastNapalm})
				w.grid.each(r.X, r.Y, r.Blast, func(i int32) bool {
					if c := &w.Creeps[i]; (c.X-r.X)*(c.X-r.X)+(c.Y-r.Y)*(c.Y-r.Y) <= r.Blast*r.Blast {
						w.ignite(i, r.Burn)
					}
					return true
				})
			}
			if r.Cluster > 0 {
				w.mirv(&r)
			}
			w.shooter, w.turretFire = -1, false
			continue
		}
		kind := uint8(WLauncher)
		if r.Cluster > 0 {
			kind += TracerUlt
		}
		if r.Burn > 0 {
			kind = TracerNapalm
		}
		w.tracer(r.X-r.VX*Dt, r.Y-r.VY*Dt, r.X, r.Y, kind)
		live = append(live, r)
	}
	w.Rockets = live
}

// A survivor's rocket bursting within its blast of them catches them too: rocketSelf hit
// points at the heart of it, half at its edge, whatever the rocket's upgrades, so seven in a
// row at a creep in your face put down a survivor in no armour. The launcher is for creeps
// still coming; one at arm's length is a job for the gun in another slot. The cluster rocket
// is sent to a point, out of harm's way, and spares its shooter.
const rocketSelf = 15

// backblast is rocket r's burst on its own shooter.
func (w *World) backblast(r *Projectile) {
	if r.Owner < 0 || int(r.Owner) >= len(w.Players) {
		return
	}
	p := w.Players[r.Owner]
	dx, dy := p.X-r.X, p.Y-r.Y
	if !p.Alive || dx*dx+dy*dy > r.Blast*r.Blast {
		return
	}
	w.hurtPlayer(p, rocketSelf*(1-.5*sqrt32(dx*dx+dy*dy)/r.Blast))
}

// ---- bookkeeping -----------------------------------------------------------------------

// share splits a bounty a turret or a trap earned evenly among the survivors in the game, what
// does not divide kept for the next, so the team's gold is the same as had one taken it all.
func (w *World) share(g int32) {
	var n int32
	for _, p := range w.Players {
		if p.Connected {
			n++
		}
	}
	w.pot += g
	if n == 0 {
		return
	}
	each := w.pot / n
	w.pot -= each * n
	for _, p := range w.Players {
		if p.Connected {
			p.Gold += each
		}
	}
}

// reap removes dead creeps, pays their bounties, and tears down destroyed structures. A kill by
// a survivor's own hand pays them; one by their turret or a trap they set off pays the team.
func (w *World) reap() {
	mult := (1 + .04*float32(w.Wave)) * w.diff().Gold
	for i := 0; i < len(w.Creeps); {
		c := &w.Creeps[i]
		if c.HP > 0 {
			i++
			continue
		}
		if len(w.Deaths) < 1024 {
			w.Deaths = append(w.Deaths, Death{c.X, c.Y, c.Kind})
		}
		if c.LastHit >= 0 && int(c.LastHit) < len(w.Players) {
			p := w.Players[c.LastHit]
			if g := int32(float32(Creeps[c.Kind].Bounty) * mult); c.Shared {
				w.share(g)
			} else {
				p.Gold += g
			}
			p.Kills++
			if c.Kind.Boss() {
				p.Tally.Bosses++
			}
		}
		w.TotalKills++
		w.freed = append(w.freed, c.ID)
		split, x, y := c.Aff&AffixSplitters != 0, c.X, c.Y
		last := len(w.Creeps) - 1
		w.Creeps[i] = w.Creeps[last]
		w.Creeps = w.Creeps[:last]
		if split {
			w.split(x, y)
		}
	}
	for i := range w.Structs {
		s := &w.Structs[i]
		if !s.Alive || s.HP > 0 {
			continue
		}
		if i == w.Core && w.Phase == PhaseEvac {
			// The Huey is the way out now: the generator holds on its last legs, so a game
			// played to the end is not lost a minute from the ride home.
			s.HP = 1
			continue
		}
		if i == w.Core {
			w.Phase = PhaseOver
			w.Best = w.Wave - 1
			w.note(2, "the generator is gone  ·  you held out %d waves", w.Best)
			return
		}
		if Structs[s.Kind].Turret {
			w.note(2, "%s destroyed", Structs[s.Kind].Name)
		}
		w.Blasts = append(w.Blasts, Blast{s.CX(), s.CY(), 1.5, 0})
		w.remove(i)
		// Its outline stays, to be put back between waves (FixAll).
		s.Ghost = Structs[s.Kind].Price > 0
	}
}
