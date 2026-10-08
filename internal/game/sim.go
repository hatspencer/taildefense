package game

import (
	"fmt"
	"math"
	"sort"
)

func sqrt32(v float32) float32 { return float32(math.Sqrt(float64(v))) }

// Step advances the world by one tick.
func (w *World) Step() {
	w.Tracers = w.Tracers[:0]
	w.Blasts = w.Blasts[:0]
	w.Deaths = w.Deaths[:0]
	// Notes and toasts from commands that arrived since the last tick go out with this one.
	w.Notes = append(w.Notes[:0], w.Notes[w.sentNotes:]...)
	w.Toasts = append(w.Toasts[:0], w.Toasts[w.sentToasts:]...)
	w.Pings = append(w.Pings[:0], w.Pings[w.sentPings:]...)
	defer func() { w.sentNotes, w.sentToasts, w.sentPings = len(w.Notes), len(w.Toasts), len(w.Pings) }()
	if w.Paused >= 0 {
		return
	}
	w.Tick++

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
		if w.QueueHead >= len(w.Queue) {
			n := w.waveCreeps()
			if n < w.waveLeft {
				w.stall = 0
			}
			w.waveLeft = n
			if w.stall += Dt; w.stall > stallLimit && n > 0 && n <= stallFew {
				w.dropStragglers()
				n = 0
			}
			// The waves keep coming: a team off looting while the last of one roams the base
			// gets the next on top of it.
			if w.overtime > 0 || w.WaveTime > overtimeLate || w.atTheGates() {
				w.overtime += Dt
			}
			if n == 0 || w.overtime > overtime {
				w.endWave(n)
			}
		}
	}

	w.stepWeather()
	w.updateFlow()
	w.grid.build(w.Creeps)
	w.indexCreeps()
	w.stepPlayers()
	w.stepTurrets()
	w.stepRockets()
	w.stepEffects()
	w.stepCreeps()
	w.reap()
	w.countGuards()
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
	w.Queue = w.plan(w.Wave, w.active())
	w.QueueHead = 0
	w.stall, w.waveLeft, w.overtime = 0, 0, 0
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
	w.note(2, "wave %d: %d creeps incoming%s", w.Wave, len(w.Queue), label)
}

// stallLimit is how long a wave may go without a single creep of it dying, once all are out,
// before the stragglers give up. A creep stuck where nobody can reach it must not hold the
// game forever.
const (
	stallLimit = 30
	stallFew   = 10 // only this few stragglers give up; a real fight is never cut short

	// overtime is how long a wave may run, once all of it is out and it has reached the base,
	// before the next countdown starts anyway with what is left of it still about.
	overtime = 40
	// overtimeLate starts the overtime clock even if the wave never gets to the base.
	overtimeLate = 150
)

// atTheGates reports whether a creep of the wave is within the base's build radius.
func (w *World) atTheGates() bool {
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if dx, dy := c.X-w.CoreX, c.Y-w.CoreY; c.Home == 0 && dx*dx+dy*dy < BuildRadius*BuildRadius {
			return true
		}
	}
	return false
}

// dropStragglers takes the creeps of the wave still about off the map, for nobody's bounty.
func (w *World) dropStragglers() {
	n := 0
	for i := 0; i < len(w.Creeps); {
		if w.Creeps[i].Home != 0 {
			i++
			continue
		}
		w.freeIDs = append(w.freeIDs, w.Creeps[i].ID)
		last := len(w.Creeps) - 1
		w.Creeps[i] = w.Creeps[last]
		w.Creeps = w.Creeps[:last]
		n++
	}
	w.note(0, "the last %d of the wave slunk off into the dark", n)
}

// endWave pays the wave bonus and starts the build countdown; left is how many of the wave
// are still out there.
func (w *World) endWave(left int) {
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
	w.Phase = PhaseBuild
	w.PhaseLeft = w.diff().Build
	if w.longBreak() {
		w.PhaseLeft = w.diff().Rest
	}
	w.rollWeather()
	if left > 0 {
		w.note(2, "wave %d is still out there (%d left)  ·  +%d gold each  ·  the next comes in %.0fs", w.Wave, left, bonus, w.PhaseLeft)
	} else {
		w.note(1, "wave %d cleared  ·  +%d gold each  ·  wave %d in %.0fs", w.Wave, bonus, w.Wave+1, w.PhaseLeft)
	}
	if w.longBreak() {
		w.note(1, "long break: %.0fs to explore and loot before wave %d", w.PhaseLeft, w.Wave+1)
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
// grow more common up to wave 24.
var mixWeight = [NumCreepKinds]float32{CWalker: 1, CRunner: .5, CSwarmer: .6, CBrute: .1, CSpitter: .25}

// groupSize is the range of a group's size per kind.
var groupSize = [NumCreepKinds][2]int{CWalker: {4, 12}, CRunner: {3, 8}, CSwarmer: {12, 30}, CBrute: {1, 2}, CSpitter: {2, 4}, CBoss: {1, 1}}

// plan lays out every spawn of a wave: groups of one kind at one spawn point, spread over the
// wave's opening seconds.
func (w *World) plan(wave, players int) []Spawn {
	budget := Budget(wave, players) * w.diff().Count
	swarm := wave%5 == 0
	var weights [NumCreepKinds]float32
	for k := CreepKind(0); k < NumCreepKinds; k++ {
		if Creeps[k].MinWave > wave || k == CBoss {
			continue
		}
		weights[k] = mixWeight[k]
		if k == CBrute {
			weights[k] *= float32(min(wave, 24)) / 4
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
	q := make([]Spawn, 0, int(budget*1.5))
	add := func(k CreepKind, at float32, sp [2]float32, j int) {
		x := sp[0] + (w.rng.Float32()-.5)*4
		y := sp[1] + (w.rng.Float32()-.5)*4
		if w.At(int(x), int(y)).Solid() {
			x, y = sp[0], sp[1]
		}
		q = append(q, Spawn{At: at + float32(j)*.12, Kind: k, X: x, Y: y})
	}
	if wave%10 == 0 {
		for i := 0; i < wave/10; i++ {
			add(CBoss, dur*.5+float32(i)*3, w.SpawnPts[w.rng.IntN(len(w.SpawnPts))], 0)
			budget -= Creeps[CBoss].Cost * .5
		}
	}
	if wave%5 == 0 && wave >= hordeFrom {
		// The horde: a third of the wave pours out of every spawn point together, a few
		// seconds into it, so it hits as one wall.
		surge := budget / 3
		budget -= surge
		at := 4 + w.rng.Float32()*4
		for surge > 0 {
			for _, sp := range w.SpawnPts {
				k := CSwarmer
				if w.rng.IntN(3) == 0 {
					k = CWalker
				}
				add(k, at+w.rng.Float32()*6, sp, 0)
				surge -= Creeps[k].Cost
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
		sp := w.SpawnPts[w.rng.IntN(len(w.SpawnPts))]
		at := w.rng.Float32() * dur
		for j := 0; j < n && budget > 0; j++ {
			add(k, at, sp, j)
			budget -= Creeps[k].Cost
		}
	}
	sort.Slice(q, func(i, j int) bool { return q[i].At < q[j].At })
	return q
}

func (w *World) spawnDue() {
	for w.QueueHead < len(w.Queue) && w.Queue[w.QueueHead].At <= w.WaveTime {
		s := w.Queue[w.QueueHead]
		w.QueueHead++
		w.SpawnCreep(s.Kind, s.X, s.Y)
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
		Hunt: -1, Siege: -1, Chase: -1, think: w.rng.Float32() * 2})
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
		if c.Burn > 0 {
			c.Burn -= Dt
			c.HP -= c.BurnDPS * w.burnMul() * Dt
			if c.HP <= 0 {
				continue
			}
		}
		speed := d.Speed * w.creepSpeedMul()
		if c.Slow > 0 {
			c.Slow -= Dt
			speed *= .45
		}
		c.Cool -= Dt
		c.Chase = -1
		if c.Asleep {
			if !w.wakes(c, d) {
				continue
			}
			w.wakeSite(c)
		}
		if c.Home == 0 {
			w.think(c, d)
		}

		// The survivor it is after, if any; else a guard goes home, a creep that took against
		// a structure goes for it, and the rest follow the field to the generator.
		tp := w.creepTarget(c, d)
		var mx, my float32
		if tp == nil && c.Home > 0 {
			w.goHome(c, d, speed)
			continue
		}
		if tp == nil && c.Siege >= 0 {
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
				w.moveCreep(c, d, c.X+dx/dist*speed*Dt, c.Y+dy/dist*speed*Dt)
				continue
			}
		}
		if tp != nil {
			c.Chase = int8(tp.ID)
			dx, dy := tp.X-c.X, tp.Y-c.Y
			dist := sqrt32(dx*dx + dy*dy)
			if dist <= d.Radius+d.Reach {
				if c.Cool <= 0 {
					c.Cool = 1 / d.Rate
					w.hurtPlayer(tp, d.Damage)
					if d.Ranged {
						w.tracer(c.X, c.Y, tp.X, tp.Y, TracerSpit)
					}
				}
				continue
			}
			mx, my = (tp.X-c.X)/dist, (tp.Y-c.Y)/dist
		} else {
			tx, ty := int(c.X), int(c.Y)
			ti := ty*w.W + tx
			if tx < 0 || ty < 0 || tx >= w.W || ty >= w.H {
				continue
			}
			nx := w.flow.next[ti]
			if nx < 0 {
				// Unreachable from here: walk straight at the generator and break what is in the way.
				dx, dy := w.CoreX-c.X, w.CoreY-c.Y
				dl := sqrt32(dx*dx+dy*dy) + 1e-6
				mx, my = dx/dl, dy/dl
			} else {
				gx, gy := float32(int(nx)%w.W)+.5, float32(int(nx)/w.W)+.5
				if si := w.structAt[nx]; si >= 0 {
					reach := d.Radius + d.Reach + .55
					if dx, dy := gx-c.X, gy-c.Y; dx*dx+dy*dy <= reach*reach {
						w.attackStruct(c, d, int(si))
						continue
					}
				}
				// Look one step further to cut the staircase a grid path makes.
				if nn := w.flow.next[nx]; nn >= 0 && w.structAt[nn] < 0 {
					gx = (gx + float32(int(nn)%w.W) + .5) / 2
					gy = (gy + float32(int(nn)/w.W) + .5) / 2
				}
				dx, dy := gx-c.X, gy-c.Y
				dl := sqrt32(dx*dx+dy*dy) + 1e-6
				mx, my = dx/dl, dy/dl
			}
		}

		// Separation: a crowd spreads out instead of stacking into one cell.
		var px, py float32
		seen := 0
		cx, cy, cr := c.X, c.Y, d.Radius
		id := c.ID
		w.grid.each(cx, cy, cr+1, func(j int32) bool {
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
		w.moveCreep(c, d, nxp, nyp)
	}
}

// moveCreep moves a creep to nx, ny, sliding along what it cannot enter and attacking a
// structure that blocks it.
func (w *World) moveCreep(c *Creep, d *CreepDef, nx, ny float32) {
	if ok, si := w.creepFree(nx, c.Y); ok {
		c.X = nx
	} else if si >= 0 {
		w.attackStruct(c, d, si)
	}
	if ok, si := w.creepFree(c.X, ny); ok {
		c.Y = ny
	} else if si >= 0 {
		w.attackStruct(c, d, si)
	}
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
	if si := w.structAt[i]; si >= 0 {
		return false, int(si)
	}
	return true, -1
}

func (w *World) attackStruct(c *Creep, d *CreepDef, si int) {
	if c.Cool > 0 {
		return
	}
	c.Cool = 1 / d.Rate
	s := &w.Structs[si]
	if !s.Alive || s.Kind == SArmory {
		return
	}
	dmg := d.Damage
	if c.Kind == CBrute || c.Kind == CBoss {
		dmg *= 1.5 // built for walls
	}
	s.HP -= dmg
	if d.Ranged {
		w.tracer(c.X, c.Y, s.CX(), s.CY(), TracerSpit)
	}
}

func (w *World) hurtPlayer(p *Player, dmg float32) {
	p.HP -= dmg
	p.Hurt = .25
	if p.HP <= 0 {
		p.HP = 0
		p.Alive = false
		p.Respawn = w.diff().Revive
		p.Firing = false
		p.Order = Order{}
		p.Search, p.Revived, p.Emote, p.EmoteLeft = 0, 0, 0, 0
		w.note(2, "%s is down  ·  revive them within %.0fs or they are back at the base", p.Name, p.Respawn)
	}
}

// ---- players ---------------------------------------------------------------------------

func (w *World) respawn(p *Player) {
	p.Alive = true
	p.HP = p.MaxHP
	p.X, p.Y = w.CoreX+.5, w.CoreY+3.8
	p.Order = Order{}
	p.Search, p.Revived = 0, 0
	p.walk.reset()
	p.BuffLeft = 0
	p.Stamina, p.Winded = 1, false
	for i := range p.Weapons {
		if p.Weapons[i].Owned {
			p.Weapons[i].Reload = 0
			p.Weapons[i].Ammo = WeaponStats(WeaponKind(i), p.Weapons[i].Lv).Mag
		}
	}
}

// repair heals a structure for one tick, paid for as it goes; false when the gold ran out.
func (w *World) repair(p *Player, si int) bool {
	s := &w.Structs[si]
	hp := min(80*Dt*float32(1+p.Gear[GearMedkit]/2), s.MaxHP-s.HP)
	cost := int32(math.Ceil(float64(hp * RepairCostPerHP)))
	if p.Gold < cost {
		return false
	}
	p.Gold -= cost
	s.HP += hp
	return true
}

func (w *World) toast(p *Player, level uint8, format string, a ...any) {
	w.Toasts = append(w.Toasts, Toast{Player: p.ID, Level: level, Text: fmt.Sprintf(format, a...)})
}

// clearShot reports whether a shot from x0, y0 reaches x1, y1, walked the way hitscan walks
// it: ruin walls and rocks stop it.
func (w *World) clearShot(x0, y0, x1, y1 float32) bool {
	dx, dy := x1-x0, y1-y0
	d := sqrt32(dx*dx + dy*dy)
	if d < .5 {
		return true
	}
	dx, dy = dx/d, dy/d
	for t := float32(.5); t < d; t += .5 {
		if w.At(int(x0+dx*t), int(y0+dy*t)).BlocksShots() {
			return false
		}
	}
	return true
}

// nearestVisible is the closest living creep within r of x, y that a shot from there
// reaches, or -1: the one to shoot, rather than one behind a wall.
func (w *World) nearestVisible(x, y, r float32) int32 {
	best, bi := r*r, int32(-1)
	w.grid.each(x, y, r, func(i int32) bool {
		c := &w.Creeps[i]
		if c.HP <= 0 {
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
	switch Weapons[p.Cur].Fire {
	case FireCone:
		w.cone(owner, p.X, p.Y, ang, st.Range, st.Spread, st.Damage, st.Burn, kind)
	case FireRocket:
		a := ang + (w.rng.Float32()*2-1)*st.Spread
		const speed = 22
		w.Rockets = append(w.Rockets, Projectile{X: p.X, Y: p.Y, VX: float32(math.Cos(float64(a))) * speed, VY: float32(math.Sin(float64(a))) * speed,
			TTL: st.Range / speed, Damage: st.Damage, Blast: st.Blast, Owner: owner})
	default:
		for k := 0; k < st.Pellets; k++ {
			a := ang + (w.rng.Float32()*2-1)*st.Spread
			w.hitscan(owner, p.X, p.Y, a, st.Range, st.Damage, st.Pierce, st.Burn, kind)
		}
	}
}

type hitCand struct {
	t float32
	i int32
}

// hitscan resolves a bullet: every creep the ray passes close enough to, nearest first,
// up to pierce+1 of them. Trees and buildings stop it; walls do not, so the base can be
// defended from behind its own walls.
func (w *World) hitscan(owner int8, x, y, ang, rng, dmg float32, pierce int, burn float32, kind uint8) {
	dx, dy := float32(math.Cos(float64(ang))), float32(math.Sin(float64(ang)))
	maxT := rng
	for t := float32(.5); t < rng; t += .5 {
		if w.At(int(x+dx*t), int(y+dy*t)).BlocksShots() {
			maxT = t
			break
		}
	}
	cands := w.hitBuf[:0]
	w.rayCells(x, y, dx, dy, maxT, func(i int32) {
		c := &w.Creeps[i]
		if c.HP <= 0 {
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
		w.damage(cands[k].i, dmg, owner)
		if burn > 0 {
			w.ignite(cands[k].i, burn)
		}
		if k == n-1 && n == pierce+1 {
			endT = cands[k].t
		}
	}
	w.hitBuf = cands[:0]
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

func (w *World) cone(owner int8, x, y, ang, rng, half, dmg, burn float32, kind uint8) {
	dx, dy := float32(math.Cos(float64(ang))), float32(math.Sin(float64(ang)))
	cosHalf := float32(math.Cos(float64(half)))
	hits := 0
	w.grid.each(x, y, rng, func(i int32) bool {
		c := &w.Creeps[i]
		if c.HP <= 0 {
			return true
		}
		ox, oy := c.X-x, c.Y-y
		dd := ox*ox + oy*oy
		if dd > rng*rng || dd < 1e-6 {
			return true
		}
		d := sqrt32(dd)
		if (ox*dx+oy*dy)/d < cosHalf {
			return true
		}
		w.damage(i, dmg, owner)
		w.ignite(i, burn)
		hits++
		return hits < 48
	})
	// Two tongues of flame either side of the aim, so the cone reads as a cone.
	for _, s := range [...]float32{-half * .6, 0, half * .6} {
		a := float64(ang + s)
		w.tracer(x, y, x+float32(math.Cos(a))*rng, y+float32(math.Sin(a))*rng, kind)
	}
}

func (w *World) ignite(i int32, dps float32) {
	c := &w.Creeps[i]
	c.Burn = 2.5
	if dps > c.BurnDPS {
		c.BurnDPS = dps
	}
}

func (w *World) damage(i int32, dmg float32, owner int8) {
	c := &w.Creeps[i]
	if c.HP <= 0 {
		return
	}
	d := dmg - Creeps[c.Kind].Armor
	if d < dmg*.25 {
		d = dmg * .25
	}
	c.HP -= d
	w.provoke(c)
	if owner >= 0 {
		c.LastHit = owner
		if int(owner) < len(w.Players) {
			w.Players[owner].Damage += float64(d)
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
	w.Blasts = append(w.Blasts, Blast{x, y, r, kind})
}

// ---- turrets and rockets ---------------------------------------------------------------

func (w *World) stepTurrets() {
	for si := range w.Structs {
		s := &w.Structs[si]
		if !s.Alive || !Structs[s.Kind].Turret {
			continue
		}
		s.Cool -= Dt
		if s.Cool > 0 {
			continue
		}
		dmg, rng, rate := TurretStats(s.Kind, s.Level)
		rng *= w.rangeMul()
		x, y := s.CX(), s.CY()
		t := w.nearestVisible(x, y, rng)
		if t < 0 {
			s.Cool = .2 // idle: look again shortly rather than every tick
			continue
		}
		s.Cool = 1 / rate
		c := &w.Creeps[t]
		kind := TracerTurret + uint8(s.Kind)
		switch s.Kind {
		case STurretGun:
			ang := float32(math.Atan2(float64(c.Y-y), float64(c.X-x)))
			w.hitscan(s.Owner, x, y, ang, rng, dmg, int(s.Level/3), 0, kind)
		case STurretCannon:
			w.tracer(x, y, c.X, c.Y, kind)
			w.explode(c.X, c.Y, Structs[s.Kind].Blast+.3*float32(s.Level-1), dmg, s.Owner, 0)
		case STurretFrost:
			slow := Structs[s.Kind].Slow + .25*float32(s.Level-1)
			w.grid.each(x, y, rng, func(i int32) bool {
				o := &w.Creeps[i]
				dx, dy := o.X-x, o.Y-y
				if dx*dx+dy*dy <= rng*rng {
					o.Slow = slow
					w.damage(i, dmg, s.Owner)
				}
				return true
			})
			w.Blasts = append(w.Blasts, Blast{x, y, rng, 1})
		case STurretTesla:
			w.chain(s, t, dmg, Structs[s.Kind].Chains+int(s.Level)-1)
		}
	}
}

// chain arcs from a tesla coil to its target and on to the nearest creep not yet struck,
// losing some damage at every jump.
func (w *World) chain(s *Structure, first int32, dmg float32, jumps int) {
	var struck [16]uint16
	n := 0
	x, y := s.CX(), s.CY()
	cur := first
	for j := 0; j <= jumps && cur >= 0 && n < len(struck); j++ {
		c := &w.Creeps[cur]
		w.tracer(x, y, c.X, c.Y, TracerTurret+uint8(STurretTesla))
		w.damage(cur, dmg, s.Owner)
		struck[n] = c.ID
		n++
		x, y = c.X, c.Y
		dmg *= .85
		best, next := float32(3.5*3.5), int32(-1)
		w.grid.each(x, y, 3.5, func(i int32) bool {
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
		boom := r.TTL <= 0 || w.At(int(r.X), int(r.Y)).BlocksShots()
		if !boom {
			if t := w.nearestCreep(r.X, r.Y, .9); t >= 0 {
				boom = true
			}
		}
		if boom {
			w.shooter = r.Owner
			w.explode(r.X, r.Y, r.Blast, r.Damage, r.Owner, 0)
			w.shooter = -1
			continue
		}
		w.tracer(r.X-r.VX*Dt, r.Y-r.VY*Dt, r.X, r.Y, uint8(WLauncher))
		live = append(live, r)
	}
	w.Rockets = live
}

// ---- bookkeeping -----------------------------------------------------------------------

// reap removes dead creeps, pays their bounties, and tears down destroyed structures.
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
			p.Gold += int32(float32(Creeps[c.Kind].Bounty) * mult)
			p.Kills++
		}
		w.TotalKills++
		w.freeIDs = append(w.freeIDs, c.ID)
		last := len(w.Creeps) - 1
		w.Creeps[i] = w.Creeps[last]
		w.Creeps = w.Creeps[:last]
	}
	for i := range w.Structs {
		s := &w.Structs[i]
		if !s.Alive || s.HP > 0 {
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
	}
}
