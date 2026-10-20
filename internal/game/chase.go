package game

// Chasing round walls: a creep after a survivor goes straight at them while nothing solid
// stands between, and otherwise follows a field of steps spread out from the survivor's tile,
// so the dead find the door of a ruin and pour in rather than pawing at its wall. Structures
// stop it too, but for an open gate: a survivor behind the base's walls is out of its reach
// unless there is a way round to them, and only a frenzied creep (maze.go) breaks through.

const (
	chaseDepth = 48 // steps the field spreads from the survivor
	chaseEvery = 5  // ticks between recomputing it while they move
)

// chaseField is the step count to one survivor from the tiles around them.
type chaseField struct {
	stamp []uint32 // gen when dist was written; any other value means not reached
	dist  []uint16
	queue []int32
	gen   uint32
	at    int    // the survivor's tile when it was computed
	tick  uint32 // and when
}

// openWalk reports whether a creep walking straight from x0, y0 to x1, y1 meets nothing solid
// and no structure in its way but except, -1 for none.
func (w *World) openWalk(x0, y0, x1, y1 float32, except int16) bool {
	dx, dy := x1-x0, y1-y0
	d := sqrt32(dx*dx + dy*dy)
	if d < .5 {
		return true
	}
	dx, dy = dx/d, dy/d
	for t := float32(.4); t < d; t += .4 {
		x, y := int(x0+dx*t), int(y0+dy*t)
		if w.At(x, y).Solid() {
			return false
		}
		if si := w.creepWall(y*w.W + x); si >= 0 && si != except {
			return false
		}
	}
	return true
}

// walled reports whether a structure that stops creeps stands on the straight line from x0, y0
// to x1, y1.
func (w *World) walled(x0, y0, x1, y1 float32) bool {
	dx, dy := x1-x0, y1-y0
	d := sqrt32(dx*dx + dy*dy)
	if d < .5 {
		return false
	}
	dx, dy = dx/d, dy/d
	for t := float32(.4); t < d; t += .4 {
		if x, y := int(x0+dx*t), int(y0+dy*t); x >= 0 && y >= 0 && x < w.W && y < w.H && w.creepWall(y*w.W+x) >= 0 {
			return true
		}
	}
	return false
}

// chaseFor is the field to p, brought up to date.
func (w *World) chaseFor(p *Player) *chaseField {
	f := &w.chase[p.ID]
	at := int(p.Y)*w.W + int(p.X)
	if f.stamp != nil && f.gen != 0 && (f.at == at || w.Tick-f.tick < chaseEvery) {
		return f
	}
	if f.stamp == nil {
		f.stamp = make([]uint32, w.W*w.H)
		f.dist = make([]uint16, w.W*w.H)
	}
	f.gen++
	f.at, f.tick = at, w.Tick
	f.queue = f.queue[:0]
	if p.X < 0 || p.Y < 0 || int(p.X) >= w.W || int(p.Y) >= w.H {
		return f
	}
	f.stamp[at], f.dist[at] = f.gen, 0
	f.queue = append(f.queue, int32(at))
	for q := 0; q < len(f.queue); q++ {
		i := int(f.queue[q])
		d := f.dist[i]
		if d >= chaseDepth {
			continue
		}
		x, y := i%w.W, i/w.W
		for _, dv := range dirs8 {
			nx, ny := x+dv[0], y+dv[1]
			if !w.chaseStep(x, y, nx, ny) {
				continue
			}
			ni := ny*w.W + nx
			if f.stamp[ni] == f.gen {
				continue
			}
			f.stamp[ni], f.dist[ni] = f.gen, d+1
			f.queue = append(f.queue, int32(ni))
		}
	}
	return f
}

// chaseStep reports whether a creep can step from tile x, y to its neighbour nx, ny, without
// cutting a corner past solid ground.
func (w *World) chaseStep(x, y, nx, ny int) bool {
	if nx < 0 || ny < 0 || nx >= w.W || ny >= w.H || w.Terrain[ny*w.W+nx].Solid() || w.creepWall(ny*w.W+nx) >= 0 {
		return false
	}
	return nx == x || ny == y || w.creepFloor(nx, y) && w.creepFloor(x, ny)
}

// creepFloor reports whether a creep can stand on tile x, y, which is on the map.
func (w *World) creepFloor(x, y int) bool {
	i := y*w.W + x
	return !w.Terrain[i].Solid() && w.creepWall(i) < 0
}

// downhill is the neighbour of tile i nearest p by the field, or -1 if i is not on it.
func (f *chaseField) downhill(w *World, i int) int {
	if i < 0 || i >= len(f.stamp) || f.stamp[i] != f.gen {
		return -1
	}
	best, bd := -1, f.dist[i]
	x, y := i%w.W, i/w.W
	for _, dv := range dirs8 {
		nx, ny := x+dv[0], y+dv[1]
		if !w.chaseStep(x, y, nx, ny) {
			continue
		}
		if ni := ny*w.W + nx; f.stamp[ni] == f.gen && f.dist[ni] < bd {
			best, bd = ni, f.dist[ni]
		}
	}
	return best
}

// chaseWay is the direction creep c takes towards p: straight when the way is open, else
// along the field. Off the field it goes straight anyway out in the wastes, or frenzied; but
// with a structure between them it has no way to p, and ok is false.
func (w *World) chaseWay(c *Creep, p *Player, dist float32) (mx, my float32, ok bool) {
	mx, my = (p.X-c.X)/dist, (p.Y-c.Y)/dist
	if w.openWalk(c.X, c.Y, p.X, p.Y, -1) {
		return mx, my, true
	}
	f := w.chaseFor(p)
	n := f.downhill(w, int(c.Y)*w.W+int(c.X))
	if n < 0 {
		return mx, my, c.breaks() || !w.walled(c.X, c.Y, p.X, p.Y)
	}
	gx, gy := float32(n%w.W)+.5, float32(n/w.W)+.5
	// Look one step further to cut the staircase a grid path makes.
	if nn := f.downhill(w, n); nn >= 0 {
		gx = (gx + float32(nn%w.W) + .5) / 2
		gy = (gy + float32(nn/w.W) + .5) / 2
	}
	dx, dy := gx-c.X, gy-c.Y
	dl := sqrt32(dx*dx+dy*dy) + 1e-6
	return dx / dl, dy / dl, true
}
