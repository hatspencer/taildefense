package game

import "math/rand/v2"

// The ruined houses come in kinds, each its own shape: a cottage of one room, a house split
// into two by a wall, an L-shaped house, a barn with wide doors through it and the loft's
// rubble on its floor, a garden shed, and a house half fallen in. The page builds each in
// its own style of wall (terrain.ts).

// RuinKind is the shape of a ruined house.
type RuinKind uint8

const (
	RuinCottage   RuinKind = iota // one room, one doorway
	RuinTwoRoom                   // split by an inner wall with a gap in it
	RuinL                         // a corner missing; a concrete floor
	RuinBarn                      // big, a wide door at each end, rubble inside
	RuinShed                      // small, one doorway
	RuinCollapsed                 // walls broken through, rubble inside
	NumRuinKinds
)

// ruinOdds is how often each kind of house turns up, out of 100.
var ruinOdds = [NumRuinKinds]int{RuinCottage: 26, RuinTwoRoom: 18, RuinL: 16, RuinBarn: 10, RuinShed: 12, RuinCollapsed: 18}

// ruinSize is the range of each kind's width and height: least, then how many more it can be.
var ruinSize = [NumRuinKinds][4]int{
	RuinCottage:   {4, 6, 4, 5},
	RuinTwoRoom:   {7, 4, 6, 3},
	RuinL:         {7, 4, 7, 3},
	RuinBarn:      {10, 4, 7, 3},
	RuinShed:      {4, 2, 4, 2},
	RuinCollapsed: {5, 6, 5, 5},
}

func pickRuin(rng *rand.Rand) RuinKind {
	r := rng.IntN(100)
	for k, o := range ruinOdds {
		if r < o {
			return RuinKind(k)
		}
		r -= o
	}
	return RuinCottage
}

// house lays out a ruined house of kind k over the box bx, by, bw, bh. Its middle is always
// open floor, where it is searched from.
func house(t []Tile, w int, rng *rand.Rand, bx, by, bw, bh int, k RuinKind) {
	mx, my := bx+bw/2, by+bh/2
	// The L's missing corner, as the box it cuts away; never reaching the middle.
	cx0, cy0, cx1, cy1 := 0, 0, -1, -1
	if k == RuinL {
		cw, ch := 2+rng.IntN(bw/2-2), 2+rng.IntN(bh/2-2)
		cx0, cy0 = bx, by
		if rng.IntN(2) == 0 {
			cx0 = bx + bw - cw
		}
		if rng.IntN(2) == 0 {
			cy0 = by + bh - ch
		}
		cx1, cy1 = cx0+cw-1, cy0+ch-1
	}
	in := func(x, y int) bool {
		if x < bx || y < by || x >= bx+bw || y >= by+bh {
			return false
		}
		return !(x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1)
	}
	floor := TDirt
	if k == RuinL || k == RuinTwoRoom {
		floor = TFloor
	}
	// Walls wherever the footprint meets the outside, corners too, so nothing slips through
	// diagonally; floor within.
	for y := by; y < by+bh; y++ {
		for x := bx; x < bx+bw; x++ {
			if !in(x, y) {
				continue
			}
			edge := false
			for dy := -1; dy <= 1; dy++ {
				for dx := -1; dx <= 1; dx++ {
					if !in(x+dx, y+dy) {
						edge = true
					}
				}
			}
			if edge {
				t[y*w+x] = TRock
			} else {
				t[y*w+x] = floor
			}
		}
	}
	// The two rooms: an inner wall across the shorter way, a third of the way along, with a
	// doorway in it.
	if k == RuinTwoRoom {
		if bw >= bh {
			px, gap := bx+bw/3, by+1+rng.IntN(bh-3)
			for y := by + 1; y < by+bh-1; y++ {
				if y != gap && y != gap+1 {
					t[y*w+px] = TRock
				}
			}
		} else {
			py, gap := by+bh/3, bx+1+rng.IntN(bw-3)
			for x := bx + 1; x < bx+bw-1; x++ {
				if x != gap && x != gap+1 {
					t[py*w+x] = TRock
				}
			}
		}
	}
	rock := func(x, y int) bool { return x >= 0 && y >= 0 && x < w && y*w+x < len(t) && t[y*w+x] == TRock }
	open := func(x, y int) { t[y*w+x] = TDirt }
	// door reports whether x, y is the middle of a straight run of outer wall, open floor on
	// one side of it and the outside on the other, and which way the wall runs.
	door := func(x, y int) (bool, int, int) {
		if !rock(x, y) || !in(x, y) {
			return false, 0, 0
		}
		if rock(x-1, y) && rock(x+1, y) && in(x, y-1) != in(x, y+1) && !rock(x, y-1) && !rock(x, y+1) {
			return true, 1, 0
		}
		if rock(x, y-1) && rock(x, y+1) && in(x-1, y) != in(x+1, y) && !rock(x-1, y) && !rock(x+1, y) {
			return true, 0, 1
		}
		return false, 0, 0
	}
	var doors [][2]int
	for y := by; y < by+bh; y++ {
		for x := bx; x < bx+bw; x++ {
			if ok, _, _ := door(x, y); ok {
				doors = append(doors, [2]int{x, y})
			}
		}
	}
	// A doorway two wide, where it fits.
	opening := func() {
		if len(doors) == 0 {
			return
		}
		d := doors[rng.IntN(len(doors))]
		ok, ax, ay := door(d[0], d[1])
		if !ok {
			return
		}
		two, _, _ := door(d[0]+ax, d[1]+ay)
		open(d[0], d[1])
		if two {
			open(d[0]+ax, d[1]+ay)
		}
	}
	// rubble drops a heap on the floor, never by the middle.
	rubble := func(n int) {
		for i := 0; i < n*4 && n > 0; i++ {
			x, y := bx+1+rng.IntN(bw-2), by+1+rng.IntN(bh-2)
			if abs(x-mx) <= 1 && abs(y-my) <= 1 || t[y*w+x] != floor {
				continue
			}
			t[y*w+x] = TRock
			n--
		}
	}
	switch k {
	case RuinBarn:
		// Wide doors at each end, the long way through.
		for o := -1; o <= 1; o++ {
			if bw >= bh {
				open(bx, my+o)
				open(bx+bw-1, my+o)
			} else {
				open(mx+o, by)
				open(mx+o, by+bh-1)
			}
		}
		rubble(2 + rng.IntN(3))
	case RuinCollapsed:
		opening()
		// Stretches of wall fallen in, and what's left of the roof on the floor.
		for i := 0; i < 2+rng.IntN(3); i++ {
			if len(doors) == 0 {
				break
			}
			d := doors[rng.IntN(len(doors))]
			ok, ax, ay := door(d[0], d[1])
			for j, n := 0, 1+rng.IntN(3); ok && j < n; j++ {
				x, y := d[0]+ax*j, d[1]+ay*j
				ok, _, _ = door(x+ax, y+ay)
				open(x, y)
			}
		}
		rubble(1 + rng.IntN(3))
	case RuinTwoRoom, RuinL:
		opening()
		if rng.IntN(2) == 0 {
			opening() // a back door
		}
	default:
		opening()
	}
}
