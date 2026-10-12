package game

import (
	"math"
	"strings"
)

// Fronts: a wave comes in from one side of the map, or a few, never the same every time. The
// map's edge is lined with places the dead can come in by; each wave picks its sides, and its
// groups come in at those near them. The first waves come from one side, later ones from two
// or three at once, and a side just hit is seldom hit again straight after.

const (
	edgeStep  = 6   // tiles between the places along the edge the dead come in by
	edgeIn    = 3   // how far in from the border they are looked for
	frontArc  = .45 // radians either side of a front's bearing that its places lie in
	frontSpan = math.Pi / 2.5
)

// edgePoints lines the map's edge with places the dead can come in by: open tiles near the
// border from which the generator can be reached.
func (w *World) edgePoints() [][2]float32 {
	var pts [][2]float32
	try := func(x, y int) {
		for i := 0; i < 40; i++ {
			if x <= 0 || y <= 0 || x >= w.W-1 || y >= w.H-1 {
				return
			}
			if !w.At(x, y).Solid() && w.flow.dist[y*w.W+x] < unreachable {
				break
			}
			x += sign(w.W/2 - x)
			y += sign(w.H/2 - y)
		}
		if w.At(x, y).Solid() || w.flow.dist[y*w.W+x] >= unreachable {
			return
		}
		p := [2]float32{float32(x) + .5, float32(y) + .5}
		for _, q := range pts {
			if dx, dy := q[0]-p[0], q[1]-p[1]; dx*dx+dy*dy < edgeStep*edgeStep/2 {
				return
			}
		}
		pts = append(pts, p)
	}
	for x := edgeIn; x < w.W-edgeIn; x += edgeStep {
		try(x, edgeIn)
		try(x, w.H-1-edgeIn)
	}
	for y := edgeIn; y < w.H-edgeIn; y += edgeStep {
		try(edgeIn, y)
		try(w.W-1-edgeIn, y)
	}
	return pts
}

// bearing is the angle of x, y seen from the generator.
func (w *World) bearing(x, y float32) float64 {
	return math.Atan2(float64(y-w.CoreY), float64(x-w.CoreX))
}

// angleOff is how far apart two angles are, 0..π.
func angleOff(a, b float64) float64 {
	d := math.Mod(math.Abs(a-b), 2*math.Pi)
	return min(d, 2*math.Pi-d)
}

// compass names the side of the map an angle points to; +y is south.
func compass(a float64) string {
	names := [8]string{"east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"}
	i := int(math.Round(a/(math.Pi/4))) % 8
	return names[(i+8)%8]
}

// pickFronts chooses the sides wave comes from and the places on each it comes in by, and
// names them for the wave's notice.
func (w *World) pickFronts(wave int) [][][2]float32 {
	pts := w.edgePts
	if len(pts) == 0 {
		pts = w.SpawnPts
	}
	n := 1
	switch {
	case wave >= 10:
		n = 2 + w.rng.IntN(2)
	case wave >= 4:
		n = 1 + w.rng.IntN(2)
	}
	var bearings []float64
	for len(bearings) < n {
		a, ok := 0., false
		for try := 0; try < 12 && !ok; try++ {
			a = w.rng.Float64()*2*math.Pi - math.Pi
			ok = len(bearings) > 0 || !w.fronted || angleOff(a, w.lastFront) > math.Pi/3
			for _, b := range bearings {
				ok = ok && angleOff(a, b) > frontSpan
			}
		}
		bearings = append(bearings, a)
	}
	w.lastFront, w.fronted = bearings[0], true
	fronts := make([][][2]float32, 0, n)
	var names []string
	for _, b := range bearings {
		var at [][2]float32
		for arc := frontArc; len(at) < 2 && arc < math.Pi+.1; arc += .25 {
			at = at[:0]
			for _, p := range pts {
				if angleOff(w.bearing(p[0], p[1]), b) <= arc {
					at = append(at, p)
				}
			}
		}
		if len(at) == 0 {
			continue
		}
		// Named for where its places actually are, not the bearing it was aimed at.
		var sx, sy float32
		for _, p := range at {
			sx, sy = sx+p[0], sy+p[1]
		}
		name := compass(w.bearing(sx/float32(len(at)), sy/float32(len(at))))
		if !strings.Contains(strings.Join(names, ","), name) {
			names = append(names, name)
		}
		fronts = append(fronts, at)
	}
	if len(fronts) == 0 {
		fronts = append(fronts, pts)
	}
	w.frontNames = names
	return fronts
}

// frontsSaid is "the north", "the north and east", "the north, east and southwest".
func (w *World) frontsSaid() string {
	n := w.frontNames
	switch len(n) {
	case 0:
		return ""
	case 1:
		return "the " + n[0]
	}
	return "the " + strings.Join(n[:len(n)-1], ", ") + " and " + n[len(n)-1]
}
