package game

import (
	"math"
	"math/rand/v2"
	"strings"
)

// The crashed plane: one on every map, out in the wilds past the middle ring. A cargo plane
// came down in a long burnt scar, its back broken: the hull lies with its hold open, the tail
// torn off behind it, one wing still on and the other in pieces. Its hold has the best kit on
// the map short of the outpost. The engines leak fuel and go up like the gas station's pumps,
// and a garrison sleeps in the wreckage, with more that come out at the first survivor in it.

// The plane's shape, in its own frame: x along the hull, nose towards +x, y across it.
const (
	planeClear       = 14  // the scar's radius, cleared of trees, rocks and water
	planeHalfL       = 5.5 // the hull
	planeHalfW       = 1.15
	tailX, tailY     = -9.1, 1.6 // the tail section, broken off behind
	tailTurn         = .5
	tailHalfL        = 2.4
	tailHalfW        = .85
	planeReach       = 13  // how far from the hull's middle any of it reaches
	planeLot         = 10  // how close to the hull's middle a survivor is in the wreckage
	planeYawSteps    = 256 // its heading is a whole step, so clients get it exactly
	planeGuardLo     = 2.5 // the garrison sleeps between these distances from the hull's middle
	planeGuardHi     = 9.5
	planeEngineCount = 2
)

// planeEngineSpots are the engines, in the plane's frame: one still under its wing, one thrown
// clear when the other wing broke up.
var planeEngineSpots = [planeEngineCount][2]float32{{.4, 4.6}, {-2.4, -6.9}}

// planeFrame turns a point in the plane's frame into the world.
func planeFrame(sx, sy, yaw, fx, fy float32) (float32, float32) {
	c, s := float32(math.Cos(float64(yaw))), float32(math.Sin(float64(yaw)))
	return sx + fx*c - fy*s, sy + fx*s + fy*c
}

// planeEngines is where the plane's engines lie.
func planeEngines(sx, sy, yaw float32) [planeEngineCount][2]float32 {
	var e [planeEngineCount][2]float32
	for i, p := range planeEngineSpots {
		e[i][0], e[i][1] = planeFrame(sx, sy, yaw, p[0], p[1])
	}
	return e
}

// boxDist is how far x, y is from a box of half length hl and half width hw round cx, cy
// turned by yaw, 0 inside it.
func boxDist(cx, cy, yaw, hl, hw, x, y float32) float32 {
	c, sn := float32(math.Cos(float64(yaw))), float32(math.Sin(float64(yaw)))
	dx, dy := x-cx, y-cy
	u, v := abs32(dx*c+dy*sn)-hl, abs32(-dx*sn+dy*c)-hw
	u, v = max(u, 0), max(v, 0)
	return sqrt32(u*u + v*v)
}

// planeDist is how far x, y is from the plane's hull or its tail, 0 inside either.
func planeDist(s *Site, x, y float32) float32 {
	d := boxDist(s.SX, s.SY, s.Yaw, planeHalfL, planeHalfW, x, y)
	tx, ty := planeFrame(s.SX, s.SY, s.Yaw, tailX, tailY)
	return min(d, boxDist(tx, ty, s.Yaw+tailTurn, tailHalfL, tailHalfW, x, y))
}

// planeCrash brings the plane down somewhere open out past the middle ring, well clear of
// the gas station and the outposts and off the roads, and burns its scar into the ground.
// Houses it lands on are flattened.
func planeCrash(t []Tile, w, h int, rng *rand.Rand, road []bool, houses []ruin) []ruin {
	const r, gap = planeClear, 14
	// What can be walked to from the middle of the map: the scar must open onto it.
	open := openFromMiddle(t, w, h)
	bx, by, best := 0, 0, math.MaxInt
	for try := 0; try < 400; try++ {
		x, y := r+4+rng.IntN(w-2*r-8), r+4+rng.IntN(h-2*r-8)
		if math.Hypot(float64(x-w/2), float64(y-h/2)) < tierMid+15 {
			continue
		}
		clash := false
		for _, o := range houses {
			if (o.outpost || o.station) && o.x < x+r+gap && x-r-gap < o.x+o.w && o.y < y+r+gap && y-r-gap < o.y+o.h {
				clash = true
			}
		}
		if clash {
			continue
		}
		score, reached := 0, 0
		for dy := -r; dy <= r; dy++ {
			for dx := -r; dx <= r; dx++ {
				if dx*dx+dy*dy > r*r {
					continue
				}
				i := (y+dy)*w + x + dx
				if open[i] && dx*dx+dy*dy > (r-3)*(r-3) {
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
		if score = score*64 + rng.IntN(64); score < best {
			bx, by, best = x, y, score
		}
	}
	if best == math.MaxInt {
		return houses
	}
	yaw := float32(rng.IntN(planeYawSteps)) * 2 * math.Pi / planeYawSteps
	// Houses in the way are flattened, walls and all.
	kept := houses[:0]
	for _, o := range houses {
		if !o.outpost && !o.station && o.x <= bx+r && bx-r < o.x+o.w && o.y <= by+r && by-r < o.y+o.h {
			for y := o.y; y < o.y+o.h; y++ {
				for x := o.x; x < o.x+o.w; x++ {
					t[y*w+x] = TDirt
				}
			}
			continue
		}
		kept = append(kept, o)
	}
	for dy := -r; dy <= r; dy++ {
		for dx := -r; dx <= r; dx++ {
			if x, y := bx+dx, by+dy; dx*dx+dy*dy <= r*r && x > 0 && y > 0 && x < w-1 && y < h-1 && t[y*w+x].Solid() {
				t[y*w+x] = TDirt
			}
		}
	}
	return append(kept, ruin{x: bx - r, y: by - r, w: 2*r + 1, h: 2*r + 1, cx: bx, cy: by, plane: true, yaw: yaw})
}

// plane is the index of the map's crashed plane, or -1.
func (w *World) plane() int {
	for i := range w.Sites {
		if w.Sites[i].Kind == SitePlane {
			return i
		}
	}
	return -1
}

// atCrash reports whether p is in the wreckage of plane si.
func (w *World) atCrash(si int, p *Player) bool {
	s := &w.Sites[si]
	dx, dy := p.X-s.SX, p.Y-s.SY
	return dx*dx+dy*dy < planeLot*planeLot
}

// planePost is somewhere in the wreckage, clear of the hull, for one of the plane's garrison.
func (w *World) planePost(s *Site) (float32, float32) {
	for try := 0; ; try++ {
		a := w.rng.Float64() * 2 * math.Pi
		d := planeGuardLo + w.rng.Float64()*(planeGuardHi-planeGuardLo)
		x, y := s.SX+float32(math.Cos(a)*d), s.SY+float32(math.Sin(a)*d)
		if planeDist(s, x, y) > .6 || try >= 8 {
			return x, y
		}
	}
}

// searchPlane hands over what is in the plane's hold: field manuals and kit, and something
// rare or better besides. Who has every manual and every piece of kit maxed gets parts for the
// gun in their hands instead.
func (w *World) searchPlane(p *Player, s *Site) {
	var got []string
	if g, ok := w.giveAbility(p); ok {
		got = append(got, g)
	} else if g, ok := w.giveUpgrade(p, p.Cur, 2); ok {
		got = append(got, g)
	}
	if g, ok := w.giveGear(p); ok {
		got = append(got, g)
	} else if g, ok := w.giveUpgrade(p, p.Cur, 2); ok {
		got = append(got, g)
	}
	tag := ""
	if w.legendFor(p) != NumWeapons && w.rng.Float32() < legendChance {
		// A crate in the hold, stencilled for some collector who never got it.
		g, _ := w.giveLegend(p)
		got = append(got, g)
		tag = "  ·  legendary"
	} else {
		r := max(RollRarity(w.rng.Float64(), w.Luck(p, s)), Rare)
		got = append(got, w.grant(p, r, FavorWeapons))
	}
	p.Dry = 0
	w.Blasts = append(w.Blasts, Blast{s.SX, s.SY, 1.5, 5})
	w.note(1, "%s got into the crashed plane's hold: %s%s", p.Name, strings.Join(got, ", "), tag)
}
