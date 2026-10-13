package game

import (
	"errors"
	"math"
	"math/rand/v2"
)

// The church: one on every map, out on the outskirts far from the base. A long stone nave,
// roofless now, with its bell tower standing at the end that faces the generator. A survivor
// who pulls the bell rope, inside at the foot of the tower, rings it out over the whole map,
// and every dead thing there is (the wave on its way in, the wanderers, the guards asleep at
// their sites) drops what it was doing and makes for the church. It draws a wave off the
// base for a minute, or empties the sites round the map for a raid; whoever rang it had
// better be gone before they arrive. The bell swings on for a while after, and can't be rung
// again until it settles.

// The church in its own frame: x across the nave, y along it towards the tower. '#' is wall,
// '.' floor, ' ' the churchyard. The tower is solid; its rope hangs inside the nave at rope.
var churchPlan = [...]string{
	"#########",
	"#.......#",
	"#.......#",
	"#.......#",
	"........#",
	"#.......#",
	"#.......#",
	"#.......#",
	"#........",
	"#.......#",
	"#.......#",
	"#.......#",
	"#.......#",
	"#..###..#",
	"   ###   ",
	"   ###   ",
	"   ###   ",
}

const (
	churchW, churchL = 9, 17 // the plan's size, tower included
	naveL            = 14    // rows of it that are the nave: the site
	churchYard       = 3     // the ground cleared round it
	ropeX, ropeY     = 4, 12 // where the rope hangs, in the plan
	churchGap        = 12    // how far it keeps from the outpost, the station and the plane

	bellRing = 60  // seconds the creeps keep coming
	bellRest = 150 // seconds from ringing until it can be rung again
)

// bell is the church bell's state: the field of steps to the church while it rings, how long
// it still draws them, and how long until it can be rung again.
type bell struct {
	flow       flowField
	site       int
	left, rest float32
}

// churchAt is where tile lx, ly of a church whose plan's middle is at cx, cy and whose tower
// faces fx, fy lands.
func churchAt(cx, cy, fx, fy, lx, ly int) (int, int) {
	sx, sy := fy, -fx // across the nave
	ox, oy := lx-churchW/2, ly-churchL/2
	return cx + ox*sx + oy*fx, cy + ox*sy + oy*fy
}

// church raises the church somewhere out on the outskirts, clear of the other landmarks and
// open to the rest of the map, its tower towards the middle. Houses in its yard are flattened.
func church(t []Tile, w, h int, rng *rand.Rand, road []bool, houses []ruin) []ruin {
	open := openFromMiddle(t, w, h)
	const r = churchL/2 + churchYard
	type pick struct{ x, y, fx, fy int }
	var best pick
	bestScore := math.MaxInt
	for try := 0; try < 600; try++ {
		x, y := r+4+rng.IntN(w-2*r-8), r+4+rng.IntN(h-2*r-8)
		if math.Hypot(float64(x-w/2), float64(y-h/2)) < tierFar {
			continue
		}
		clash := false
		for _, o := range houses {
			if (o.outpost || o.station || o.plane) && o.x < x+r+churchGap && x-r-churchGap < o.x+o.w && o.y < y+r+churchGap && y-r-churchGap < o.y+o.h {
				clash = true
			}
		}
		if clash {
			continue
		}
		score, reached := 0, 0
		for dy := -r; dy <= r; dy++ {
			for dx := -r; dx <= r; dx++ {
				i := (y+dy)*w + x + dx
				if open[i] && (abs(dx) == r || abs(dy) == r) {
					reached++
				}
				switch {
				case road[i]:
					score += 4
				case t[i] == TWater:
					score += 6
				case t[i].Solid():
					score++
				}
			}
		}
		if reached < 8 {
			continue
		}
		if score = score*64 + rng.IntN(64); score < bestScore {
			fx, fy := sign(w/2-x), 0
			if abs(h/2-y)*w > abs(w/2-x)*h {
				fx, fy = 0, sign(h/2-y)
			}
			best, bestScore = pick{x, y, fx, fy}, score
		}
	}
	if bestScore == math.MaxInt {
		return houses
	}
	cx, cy, fx, fy := best.x, best.y, best.fx, best.fy
	kept := houses[:0]
	for _, o := range houses {
		if !o.outpost && !o.station && !o.plane && o.x <= cx+r && cx-r < o.x+o.w && o.y <= cy+r && cy-r < o.y+o.h {
			for y := o.y; y < o.y+o.h; y++ {
				for x := o.x; x < o.x+o.w; x++ {
					t[y*w+x] = TDirt
				}
			}
			continue
		}
		kept = append(kept, o)
	}
	// The yard: whatever grew or stood there cleared to grass.
	for dy := -r; dy <= r; dy++ {
		for dx := -r; dx <= r; dx++ {
			if i := (cy+dy)*w + cx + dx; t[i].Solid() || t[i] == TWater {
				t[i] = TGrass
			}
		}
	}
	x0, y0, x1, y1 := w, h, 0, 0
	for ly, row := range churchPlan {
		for lx, c := range row {
			x, y := churchAt(cx, cy, fx, fy, lx, ly)
			switch c {
			case '#':
				t[y*w+x] = TRock
			case '.':
				t[y*w+x] = TFloor
			}
			if ly < naveL {
				x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)
			}
		}
	}
	rx, ry := churchAt(cx, cy, fx, fy, ropeX, ropeY)
	yaw := float32(math.Atan2(float64(fy), float64(fx)))
	return append(kept, ruin{x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: rx, cy: ry, church: true, yaw: yaw})
}

// openFromMiddle is, per tile, whether it can be walked to from the middle of the map.
func openFromMiddle(t []Tile, w, h int) []bool {
	open := make([]bool, w*h)
	var q [][2]int
	for y := h/2 - 6; y <= h/2+6; y++ {
		for x := w/2 - 6; x <= w/2+6; x++ {
			if !t[y*w+x].Solid() {
				open[y*w+x] = true
				q = append(q, [2]int{x, y})
			}
		}
	}
	for len(q) > 0 {
		c := q[len(q)-1]
		q = q[:len(q)-1]
		for _, d := range [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
			x, y := c[0]+d[0], c[1]+d[1]
			if x > 0 && y > 0 && x < w-1 && y < h-1 && !open[y*w+x] && !t[y*w+x].Solid() {
				open[y*w+x] = true
				q = append(q, [2]int{x, y})
			}
		}
	}
	return open
}

// errBellRinging is pulling the rope while the bell still swings.
var errBellRinging = errors.New("the bell is still swinging; it can't be rung again yet")

// ringBell is p's pull on the rope of church si: everything on the map makes for the church.
func (w *World) ringBell(p *Player, si int) {
	s := &w.Sites[si]
	s.Searched = true
	b := &w.bell
	b.site, b.left, b.rest = si, bellRing, bellRest
	if b.flow.dist == nil {
		b.flow.init(w.W, w.H)
	}
	// They gather in the nave.
	w.goals = w.goals[:0]
	for y := int(s.Y) + 1; y < int(s.Y)+int(s.H)-1; y++ {
		for x := int(s.X) + 1; x < int(s.X)+int(s.W)-1; x++ {
			if !w.At(x, y).Solid() {
				w.goals = append(w.goals, int32(y*w.W+x))
			}
		}
	}
	w.fillFlow(&b.flow, w.goals)
	w.flowDirt = true // goals was the generator's field's too
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if c.HP <= 0 {
			continue
		}
		c.lured, c.Asleep, c.Returning = true, false, false
		c.Hunt, c.HuntLeft, c.Siege, c.SiegeLeft = -1, 0, -1, 0
	}
	w.Blasts = append(w.Blasts, Blast{s.SX, s.SY, 24, 11})
	w.note(2, "%s rang the church bell: every dead thing on the map is coming to it", p.Name)
}

// stepBell counts the bell down: when it stops ringing the dead lose interest, and when it
// has settled it can be rung again.
func (w *World) stepBell() {
	b := &w.bell
	if b.left > 0 {
		if b.left -= Dt; b.left <= 0 {
			for i := range w.Creeps {
				w.Creeps[i].lured = false
			}
			w.note(0, "the church bell has gone quiet")
		}
	}
	if b.rest > 0 {
		if b.rest -= Dt; b.rest <= 0 && b.site < len(w.Sites) {
			w.Sites[b.site].Searched = false
		}
	}
}
