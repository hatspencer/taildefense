package game

import (
	"errors"
	"math"
)

// Mazes: the creeps of the waves walk round walls for as long as there is a way round, however
// long, so the team can build a labyrinth for them to walk under the turrets' guns. Only a base
// sealed tight makes them break in, where it is cheapest, as before. Three things keep a maze
// honest:
//
//   - The big creeps, brutes and the bosses, need ground two tiles wide. Where a maze is all
//     one-tile lanes they have no way round and smash through it instead.
//   - Patience: a creep counts the ground it walks inside the build ring, and past Patience
//     times the straight way in from where it came in, it frenzies: faster, harder on walls,
//     and done walking round anything (frenzy).
//   - A creep that cannot get at a survivor behind a wall does not claw at the wall for it;
//     it keeps to the maze, and every second it spends wanting them wears its patience down
//     the faster.
//
// Gates are the maze's moving parts. Shut, a gate is a wall to the dead that survivors walk
// through; open, it is open ground to both. A survivor works one standing beside it (OrderGate).

// creepWall is the structure at tile i that stops a creep, or -1: anything standing but an
// open gate.
func (w *World) creepWall(i int) int16 {
	si := w.structAt[i]
	if si >= 0 && w.Structs[si].Open {
		return -1
	}
	return si
}

// markWide works out which tiles a big creep fits on: those in a square of two by two with no
// structure in the way. Only structures count; the wastes are as they always were.
func (w *World) markWide() {
	if w.wide == nil {
		w.wide = make([]bool, w.W*w.H)
	}
	free := func(x, y int) bool {
		return x >= 0 && y >= 0 && x < w.W && y < w.H && w.creepWall(y*w.W+x) < 0
	}
	cx, cy := int(w.CoreX), int(w.CoreY)
	r := BuildRadius + 4
	for y := 0; y < w.H; y++ {
		for x := 0; x < w.W; x++ {
			i := y*w.W + x
			if abs(x-cx) > r || abs(y-cy) > r {
				w.wide[i] = true // nothing is built out here
				continue
			}
			ok := false
			for _, o := range [4][2]int{{0, 0}, {-1, 0}, {0, -1}, {-1, -1}} {
				if free(x+o[0], y+o[1]) && free(x+o[0]+1, y+o[1]) && free(x+o[0], y+o[1]+1) && free(x+o[0]+1, y+o[1]+1) {
					ok = true
					break
				}
			}
			w.wide[i] = ok
		}
	}
}

// wideField is the maze field for the big creeps, brought up to date.
func (w *World) wideField() *flowField {
	if w.wideDirt {
		w.wideDirt = false
		w.fillField(&w.mazeWide, w.wideGoals, fieldWide)
	}
	return &w.mazeWide
}

// fieldFor is the field creep c follows from tile ti, and whether it breaks what is in its way
// on it: the maze while there is a way round, for a creep that has not lost its patience,
// the wide one for a big creep while there is one; else the breach field.
func (w *World) fieldFor(c *Creep, ti int) (*flowField, bool) {
	if c.Frenzy {
		return &w.flow, true
	}
	if Creeps[c.Kind].Size >= 2 {
		if f := w.wideField(); f.dist[ti] < unreachable {
			return f, false
		}
	}
	if w.maze.dist[ti] < unreachable {
		return &w.maze, false
	}
	return &w.flow, true
}

// shoulder is a big creep with only a narrow way round shouldering into the walls of a lane
// too narrow for it: on such a tile it smashes the weakest wall beside it, and it reports
// whether it did, standing there to do it.
func (w *World) shoulder(c *Creep, d *CreepDef, ti int) bool {
	if d.Size < 2 || c.Frenzy || w.wide == nil || w.wide[ti] {
		return false
	}
	x, y := ti%w.W, ti/w.W
	best, bi := float32(math.MaxFloat32), int16(-1)
	for _, o := range [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
		nx, ny := x+o[0], y+o[1]
		if nx < 0 || ny < 0 || nx >= w.W || ny >= w.H {
			continue
		}
		si := w.creepWall(ny*w.W + nx)
		if si < 0 || int(si) == w.Core || w.Structs[si].Kind == SArmory {
			continue
		}
		if hp := w.Structs[si].HP; hp < best {
			best, bi = hp, si
		}
	}
	if bi < 0 {
		return false
	}
	w.attackStruct(c, d, int(bi))
	return true
}

// MazeDist is how far creeps walk from tile x, y to the generator, in tiles, going round every
// wall; -1 when the base is sealed from there, so that they break in.
func (w *World) MazeDist(x, y int) float32 {
	if x < 0 || y < 0 || x >= w.W || y >= w.H || w.maze.dist[y*w.W+x] >= unreachable {
		return -1
	}
	return float32(w.maze.dist[y*w.W+x]) / 10
}

// Patience: how far past the straight way in a creep walks inside the build ring before it
// frenzies, and how much faster and harder on structures it is then.
const (
	ringPad       = 4   // the ring a creep's patience counts in reaches this far past BuildRadius
	patienceSlack = 12  // tiles it walks on top of Patience times the straight way in
	frenzySpeed   = 1.4 // times its speed
	frenzyStruct  = 1.5 // times its blows on a structure
	balkWear      = 1   // tiles of patience a second of wanting an unreachable survivor wears
)

// patience counts the ground creep c walked this tick, from ox, oy, inside the build ring;
// past its patience it frenzies. Guards and wanderers never get that far.
func (w *World) patience(c *Creep, ox, oy float32) {
	if c.Frenzy || c.Home != 0 || c.Wander {
		return
	}
	dx, dy := c.X-w.CoreX, c.Y-w.CoreY
	r := float32(BuildRadius + ringPad)
	dd := dx*dx + dy*dy
	if dd > r*r {
		return
	}
	if c.trekMax == 0 {
		c.trekMax = sqrt32(dd)*w.diff().Patience + patienceSlack
	}
	mx, my := c.X-ox, c.Y-oy
	c.trek += sqrt32(mx*mx + my*my)
	if c.trek > c.trekMax {
		w.frenzy(c)
	}
}

// frenzy is creep c losing its patience with the maze.
func (w *World) frenzy(c *Creep) {
	c.Frenzy = true
	c.Siege = -1
	if !w.frenzied && w.Phase == PhaseWave {
		w.frenzied = true
		w.note(2, "the dead are losing patience with the maze: frenzied ones tear through walls")
	}
}

// Patience is how far a creep of the wave will walk inside the build ring, as a share of the
// straight way in, before it frenzies; for the client.
func (w *World) Patience() float32 { return w.diff().Patience }

// Gates: how long working one takes and how soon it can be worked again.
const (
	gateTime  = .8
	gateCool  = 4
	gateReach = 2.3
)

// GateInfo is working a gate's numbers, for the client.
func GateInfo() (time, cool, reach float32) { return gateTime, gateCool, gateReach }

// OrderGate sends the player to open or shut gate si.
func (w *World) OrderGate(p *Player, si int) error {
	if si < 0 || si >= len(w.Structs) || !w.Structs[si].Alive || w.Structs[si].Kind != SGate {
		return errors.New("no gate there")
	}
	if !p.Alive {
		return errors.New("you are down")
	}
	s := &w.Structs[si]
	w.order(p, Order{Kind: OrderGate, Struct: si, X: s.CX(), Y: s.CY()})
	return nil
}

// actGate is one tick of a gate order; it reports whether the order is still going.
func (w *World) actGate(p *Player, o *Order, walk func() bool) bool {
	if o.Struct >= len(w.Structs) {
		return false
	}
	s := &w.Structs[o.Struct]
	if !s.Alive || s.Kind != SGate {
		p.Search = 0
		return false
	}
	dx, dy := s.CX()-p.X, s.CY()-p.Y
	if dx*dx+dy*dy > gateReach*gateReach {
		if !walk() {
			w.toast(p, 2, "cannot get to the gate")
			return false
		}
		return true
	}
	if p.Search == 0 && s.Cool > 0 {
		w.toast(p, 2, "the gate is still swinging (%.0fs)", math.Ceil(float64(s.Cool)))
		return false
	}
	p.Search += Dt
	if p.Search < gateTime {
		return true
	}
	p.Search = 0
	if err := w.swingGate(o.Struct); err != nil {
		w.toast(p, 2, "%v", err)
	}
	return false
}

// swingGate opens gate si, or shuts it if nothing stands in the gateway.
func (w *World) swingGate(si int) error {
	s := &w.Structs[si]
	if s.Open {
		if t := w.nearestCreep(s.CX(), s.CY(), .5+creepGap); t >= 0 {
			return errors.New("a creep is in the gateway")
		}
	}
	s.Open = !s.Open
	s.Cool = gateCool
	w.flowDirt = true
	return nil
}

// creepGap is how far into a gateway a creep may stand for it to still shut.
const creepGap = .35

// stepGates winds the gates' cool down.
func (w *World) stepGates() {
	for i := range w.Structs {
		if s := &w.Structs[i]; s.Alive && s.Kind == SGate && s.Cool > 0 {
			s.Cool -= Dt
		}
	}
}
