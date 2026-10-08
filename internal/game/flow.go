package game

import "math"

// flowField is the shortest way to the generator from every tile, computed once whenever a
// structure appears or disappears and then read by every creep. A structure tile is
// passable at a price that grows with its hit points, so creeps go round walls when a gap is
// near and break through when it is not, which is how a besieged base should feel.
type flowField struct {
	w, h int
	dist []int32
	next []int32 // tile index to step to, -1 at the goal or when unreachable
	heap []uint64
}

const unreachable = math.MaxInt32

func (f *flowField) init(w, h int) {
	f.w, f.h = w, h
	f.dist = make([]int32, w*h)
	f.next = make([]int32, w*h)
	f.heap = make([]uint64, 0, w*h/4)
}

var dirs8 = [8][3]int{{1, 0, 10}, {-1, 0, 10}, {0, 1, 10}, {0, -1, 10}, {1, 1, 14}, {1, -1, 14}, {-1, 1, 14}, {-1, -1, 14}}

// structCost is what crossing a structure tile adds, in tenths of a tile.
func structCost(s *Structure) int32 {
	if s.Kind == SCore {
		return 0
	}
	return 40 + int32(s.HP/5)
}

// updateFlow recomputes the field if a structure changed since the last time.
func (w *World) updateFlow() {
	if !w.flowDirt {
		return
	}
	w.flowDirt = false
	f := &w.flow
	for i := range f.dist {
		f.dist[i] = unreachable
		f.next[i] = -1
	}
	f.heap = f.heap[:0]
	core := &w.Structs[w.Core]
	for y := int(core.Y); y < int(core.Y)+int(core.H); y++ {
		for x := int(core.X); x < int(core.X)+int(core.W); x++ {
			i := y*w.W + x
			f.dist[i] = 0
			f.push(0, int32(i))
		}
	}
	for len(f.heap) > 0 {
		d, i := f.pop()
		if d > f.dist[i] {
			continue
		}
		x, y := int(i)%w.W, int(i)/w.W
		for _, dv := range dirs8 {
			nx, ny := x+dv[0], y+dv[1]
			if nx < 0 || ny < 0 || nx >= w.W || ny >= w.H {
				continue
			}
			ni := ny*w.W + nx
			if w.Terrain[ni].Solid() {
				continue
			}
			if si := w.structAt[ni]; si >= 0 && w.Structs[si].Kind == SArmory {
				continue // the armory is not a target; creeps go round it
			}
			if dv[0] != 0 && dv[1] != 0 {
				// No cutting corners past solid ground or between two buildings.
				if w.Terrain[y*w.W+nx].Solid() || w.Terrain[ny*w.W+x].Solid() ||
					w.structAt[y*w.W+nx] >= 0 || w.structAt[ny*w.W+x] >= 0 {
					continue
				}
			}
			// The cost is paid for entering tile ni, but flows backwards: a creep standing on
			// ni steps to i. Breaking into a structure therefore costs the creep that stands
			// outside it.
			c := int32(dv[2])
			if si := w.structAt[i]; si >= 0 && w.structAt[ni] != si {
				c += structCost(&w.Structs[si])
			}
			nd := d + c
			if nd < f.dist[ni] {
				f.dist[ni] = nd
				f.next[ni] = i
				f.push(nd, int32(ni))
			}
		}
	}
}

func (f *flowField) push(d int32, i int32) {
	h := append(f.heap, uint64(d)<<32|uint64(uint32(i)))
	j := len(h) - 1
	for j > 0 {
		p := (j - 1) / 2
		if h[p] <= h[j] {
			break
		}
		h[p], h[j] = h[j], h[p]
		j = p
	}
	f.heap = h
}

func (f *flowField) pop() (int32, int32) {
	h := f.heap
	top := h[0]
	n := len(h) - 1
	h[0] = h[n]
	h = h[:n]
	j := 0
	for {
		l := 2*j + 1
		if l >= n {
			break
		}
		m := l
		if r := l + 1; r < n && h[r] < h[l] {
			m = r
		}
		if h[j] <= h[m] {
			break
		}
		h[j], h[m] = h[m], h[j]
		j = m
	}
	f.heap = h
	return int32(top >> 32), int32(uint32(top))
}

// spatial is a uniform grid over the map rebuilt every tick by counting sort: cell starts,
// then creep indices grouped by cell. Building it is two passes over the creeps and no
// allocation; a query touches only the cells under its circle or ray.
type spatial struct {
	cw, ch int
	start  []int32 // len cells+1
	items  []int32
	cellOf []int32
}

const cellSize = 2

func (g *spatial) init(w, h int) {
	g.cw, g.ch = (w+cellSize-1)/cellSize, (h+cellSize-1)/cellSize
	g.start = make([]int32, g.cw*g.ch+1)
}

func (g *spatial) cell(x, y float32) int32 {
	cx, cy := int(x)/cellSize, int(y)/cellSize
	cx = min(max(cx, 0), g.cw-1)
	cy = min(max(cy, 0), g.ch-1)
	return int32(cy*g.cw + cx)
}

func (g *spatial) build(cs []Creep) {
	for i := range g.start {
		g.start[i] = 0
	}
	if cap(g.cellOf) < len(cs) {
		g.cellOf = make([]int32, len(cs), cap(cs)+cap(cs)/2+64)
		g.items = make([]int32, len(cs), cap(g.cellOf))
	}
	g.cellOf = g.cellOf[:len(cs)]
	g.items = g.items[:len(cs)]
	for i := range cs {
		c := g.cell(cs[i].X, cs[i].Y)
		g.cellOf[i] = c
		g.start[c+1]++
	}
	for i := 1; i < len(g.start); i++ {
		g.start[i] += g.start[i-1]
	}
	// Fill using the start of the next cell as a moving cursor, walking backwards so each
	// cell ends up in ascending creep order.
	for i := len(cs) - 1; i >= 0; i-- {
		c := g.cellOf[i] + 1
		g.start[c]--
		g.items[g.start[c]] = int32(i)
	}
	// Each start[c+1] has been walked down to where cell c begins; shift them into place.
	cells := len(g.start) - 1
	copy(g.start[:cells], g.start[1:])
	g.start[cells] = int32(len(cs))
}

// each calls fn with every creep index whose cell overlaps the circle; fn returns false to stop.
func (g *spatial) each(x, y, r float32, fn func(i int32) bool) {
	x0, y0 := int(x-r)/cellSize, int(y-r)/cellSize
	x1, y1 := int(x+r)/cellSize, int(y+r)/cellSize
	x0, y0 = max(x0, 0), max(y0, 0)
	x1, y1 = min(x1, g.cw-1), min(y1, g.ch-1)
	for cy := y0; cy <= y1; cy++ {
		for cx := x0; cx <= x1; cx++ {
			c := cy*g.cw + cx
			for _, i := range g.items[g.start[c]:g.start[c+1]] {
				if !fn(i) {
					return
				}
			}
		}
	}
}
