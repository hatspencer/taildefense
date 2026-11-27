package game

import (
	"math"
	"math/rand/v2"
	"strings"
)

// The wastes' other places, beside the outposts, the gas station, the plane, the church and
// the shrines: hamlets strung along the roads, an army checkpoint across one of them, a
// cemetery and a quarantine camp out in the wilds. Each is laid from a plan, as the church
// and the shrines are, and the page draws each from the same plan (web/src/scene/places.ts).

// ---- plans -------------------------------------------------------------------------------

// planAt is the map tile of cell lx, ly of a plan whose cell 0, 0 lands on ax, ay, its rows
// running along fx, fy and its columns along fy, -fx: the shrine's frame (shrineAt), from a
// corner instead of the middle.
func planAt(ax, ay, fx, fy, lx, ly int) (int, int) {
	return ax + lx*fy + ly*fx, ay - lx*fx + ly*fy
}

// planSpot is the cell of a plan marked c.
func planSpot(plan []string, c byte) (int, int) {
	for ly, row := range plan {
		if lx := strings.IndexByte(row, c); lx >= 0 {
			return lx, ly
		}
	}
	return 0, 0
}

// planOrigin is where cell 0, 0 of a plan lands for a site searched from its 's' cell, its
// rows towards the site's yaw: what a client works out the same way from the welcome.
func planOrigin(plan []string, s *Site) (ax, ay, fx, fy int) {
	fx, fy = int(math.Round(math.Cos(float64(s.Yaw)))), int(math.Round(math.Sin(float64(s.Yaw))))
	lx, ly := planSpot(plan, 's')
	sx, sy := int(s.SX), int(s.SY)
	return sx - lx*fy - ly*fx, sy + lx*fx - ly*fy, fx, fy
}

// planBox is the box a plan covers, its cells with something in them.
func planBox(plan []string, ax, ay, fx, fy int, only func(c byte) bool) (x0, y0, x1, y1 int) {
	x0, y0, x1, y1 = math.MaxInt, math.MaxInt, math.MinInt, math.MinInt
	for ly, row := range plan {
		for lx := 0; lx < len(row); lx++ {
			if !only(row[lx]) {
				continue
			}
			x, y := planAt(ax, ay, fx, fy, lx, ly)
			x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)
		}
	}
	return
}

// landmark reports whether a ruin is one of the map's places rather than a house.
func (r ruin) landmark() bool {
	return r.outpost || r.station || r.plane || r.church || r.shrine || r.checkpoint || r.cemetery || r.camp
}

// clashes reports whether the box x0, y0 to x1, y1 comes within gap of a landmark.
func clashes(houses []ruin, x0, y0, x1, y1, gap int) bool {
	for _, o := range houses {
		if o.landmark() && o.x <= x1+gap && x0-gap < o.x+o.w && o.y <= y1+gap && y0-gap < o.y+o.h {
			return true
		}
	}
	return false
}

// flatten knocks down the houses that reach into the box x0, y0 to x1, y1 (the landmarks
// stand), and returns those left.
func flatten(t []Tile, w int, houses []ruin, x0, y0, x1, y1 int) []ruin {
	kept := houses[:0]
	for _, o := range houses {
		if !o.landmark() && o.x <= x1 && x0 < o.x+o.w && o.y <= y1 && y0 < o.y+o.h {
			for y := o.y; y < o.y+o.h; y++ {
				for x := o.x; x < o.x+o.w; x++ {
					t[y*w+x] = TDirt
				}
			}
			continue
		}
		kept = append(kept, o)
	}
	return kept
}

// clearBox turns whatever grows or stands or lies wet in the box to ground.
func clearBox(t []Tile, w, h, x0, y0, x1, y1 int, to Tile) {
	for y := max(1, y0); y <= min(h-2, y1); y++ {
		for x := max(1, x0); x <= min(w-2, x1); x++ {
			if i := y*w + x; t[i].Solid() || t[i] == TWater {
				t[i] = to
			}
		}
	}
}

// ---- the hamlets -------------------------------------------------------------------------

// The hamlets: a few on every map, a row of houses either side of a road a little way out
// of town, their front doors on the street, the biggest with a side street crossing the road
// and houses down that too. Terraces and burnt-out shells among them, as a village would have.
const (
	hamletCount = 3
	hamletNear  = 48  // from the middle of the map, at least
	hamletFar   = 130 // and at most
	hamletApart = 55  // from each other
	hamletSpan  = 19  // tiles either way along its street
	hamletMost  = 8   // houses in one
	crossSpan   = 17  // the side street, either way from the road
)

// hamletKinds is what a hamlet's houses are, a kind drawn at random for each.
var hamletKinds = [...]RuinKind{RuinCottage, RuinCottage, RuinTwoRoom, RuinL, RuinTerrace, RuinTerrace, RuinShell, RuinCollapsed, RuinShed}

// hamlets lines the roads with their hamlets, and returns the houses with theirs added and
// the middle of each, where it meets its road.
func hamlets(t []Tile, w, h int, rng *rand.Rand, roads [][][2]int, road []bool, houses []ruin) ([]ruin, [][2]int) {
	var at [][2]int
	used := make([]bool, len(roads))
	for n := 0; n < hamletCount; n++ {
		for try := 0; try < 120; try++ {
			ri := rng.IntN(len(roads))
			rd := roads[ri]
			if used[ri] && try < 80 || len(rd) == 0 {
				continue
			}
			p := rd[rng.IntN(len(rd))]
			if d := math.Hypot(float64(p[0]-w/2), float64(p[1]-h/2)); d < hamletNear || d > hamletFar {
				continue
			}
			apart := true
			for _, q := range at {
				if math.Hypot(float64(p[0]-q[0]), float64(p[1]-q[1])) < hamletApart {
					apart = false
				}
			}
			if !apart || clashes(houses, p[0]-hamletSpan, p[1]-hamletSpan, p[0]+hamletSpan, p[1]+hamletSpan, 4) {
				continue
			}
			horiz := ri < 2
			cross := n == 0
			if cross {
				// The side street, two wide, across the road both ways.
				for o := -crossSpan; o <= crossSpan; o++ {
					for k := 0; k <= 1; k++ {
						x, y := p[0]+k, p[1]+o
						if !horiz {
							x, y = p[0]+o, p[1]+k
						}
						if x > 1 && y > 1 && x < w-2 && y < h-2 {
							t[y*w+x] = TDirt
							road[y*w+x] = true
						}
					}
				}
			}
			left := hamletMost
			for _, side := range [2]int{-1, 1} {
				houses = street(t, w, h, rng, road, houses, p, horiz, side, cross, hamletSpan, &left)
			}
			if cross {
				for _, side := range [2]int{-1, 1} {
					houses = street(t, w, h, rng, road, houses, p, !horiz, side, true, crossSpan, &left)
				}
			}
			used[ri] = true
			at = append(at, p)
			break
		}
	}
	return houses, at
}

// street builds houses down one side (-1 the lower side, 1 the higher) of the street through
// p, which runs along x if horiz and along y if not, within span of p, their fronts to it. A
// street that a side street crosses keeps the crossing clear. left is how many more houses the
// hamlet may have.
func street(t []Tile, w, h int, rng *rand.Rand, road []bool, houses []ruin, p [2]int, horiz bool, side int, skip bool, span int, left *int) []ruin {
	a0, c0 := p[0], p[1] // along the street, across it
	if !horiz {
		a0, c0 = p[1], p[0]
	}
	isRoad := func(a, c int) bool {
		x, y := a, c
		if !horiz {
			x, y = c, a
		}
		return x >= 0 && y >= 0 && x < w && y < h && road[y*w+x]
	}
	for a := a0 - span + rng.IntN(3); a < a0+span && *left > 0; {
		k := hamletKinds[rng.IntN(len(hamletKinds))]
		bw, bh := ruinBox(rng, k)
		if k == RuinTerrace && (bw >= bh) != horiz {
			bw, bh = bh, bw // a terrace's long side along the street
		}
		along, deep := bw, bh
		if !horiz {
			along, deep = bh, bw
		}
		if skip && a < a0+4 && a+along > a0-3 {
			a = a0 + 4
			continue
		}
		// The street's edge on this side, along the house's length.
		edge, found := 0, false
		for i := a; i < a+along; i++ {
			for c := c0 - 10; c <= c0+11; c++ {
				if isRoad(i, c) && (!found || side < 0 && c < edge || side > 0 && c > edge) {
					edge, found = c, true
				}
			}
		}
		if !found {
			a += 3
			continue
		}
		back := 1 + rng.IntN(2) // a front yard
		c := edge + 1 + back
		if side < 0 {
			c = edge - back - deep
		}
		bx, by := a, c
		if !horiz {
			bx, by = c, a
		}
		ok := bx >= 3 && by >= 3 && bx+bw <= w-4 && by+bh <= h-4
		if nx, ny := max(bx, min(w/2, bx+bw)), max(by, min(h/2, by+bh)); ok {
			dx, dy := nx-w/2, ny-h/2
			ok = dx*dx+dy*dy >= (BuildRadius+3)*(BuildRadius+3)
		}
		for y := by - 1; ok && y <= by+bh; y++ {
			for x := bx - 1; x <= bx+bw; x++ {
				if road[y*w+x] {
					ok = false
				}
			}
		}
		if !ok || clashes(houses, bx, by, bx+bw-1, by+bh-1, 2) {
			a += 2
			continue
		}
		houses = flatten(t, w, houses, bx-1, by-1, bx+bw, by+bh)
		clearBox(t, w, h, bx-1, by-1, bx+bw, by+bh, TGrass)
		front := faceS
		switch {
		case horiz && side > 0:
			front = faceN
		case !horiz && side < 0:
			front = faceE
		case !horiz:
			front = faceW
		}
		house(t, w, rng, bx, by, bw, bh, k, front)
		houses = append(houses, ruin{x: bx, y: by, w: bw, h: bh, kind: k, hamlet: true})
		*left--
		a += along + 2 + rng.IntN(2)
	}
	return houses
}

// ---- the army checkpoint -----------------------------------------------------------------

// The checkpoint: one on every map, across a road out past the middle ring, where the army
// tried to hold the way into town. Two lines of concrete barriers stagger across the road so
// that nothing drives straight through, sandbagged gun pits either side, the command tent
// beside the road with the unit's kit still in it, and the trucks they came in, left where
// they stood. The dead in uniform still man it. It is searched in the tent: weapons, mostly,
// and a medkit.
//
// Its plan: x along the road, y across it, the road on rows 7 and 8 ('='). 'b' a barrier,
// 'S' sandbags, 'c' the tent's canvas, '.' its floor, 's' where it is searched from, 'T' where
// a truck stands, ' ' open ground.
var checkpointPlan = [...]string{
	"                       ",
	"  SSS           ccccccc",
	"  S     b       c.....c",
	"  SSS   b       c..s..c",
	"        b  T    c.....c",
	"        b       cc..ccc",
	"        b     b        ",
	"========b=====b========",
	"========b=====b========",
	"        b     b        ",
	"              b        ",
	"   T          b    T   ",
	"              b        ",
	"              b  SSS   ",
	"                 S     ",
	"                 SSS   ",
}

const (
	checkpointMidX, checkpointMidY = 11, 7.5 // the middle of the chicane, in the plan
	checkpointRoad                 = 7       // the first of its road rows
	checkpointGap                  = 12      // from the other landmarks
	checkpointHamlet               = 45      // from a hamlet's middle
	checkpointClear                = 3       // ground cleared round it
	checkpointGuardLo              = 2.5     // its garrison sleeps between these distances from the chicane's middle
	checkpointGuardHi              = 9.5
)

// checkpoint sets the checkpoint across a road out past the middle ring, away from the
// hamlets and the other landmarks; the road runs straight through it.
func checkpoint(t []Tile, w, h int, rng *rand.Rand, roads [][][2]int, road []bool, houses []ruin, hamletAt [][2]int) []ruin {
	plan := checkpointPlan[:]
	for try := 0; try < 400; try++ {
		ri := rng.IntN(len(roads))
		rd := roads[ri]
		if len(rd) == 0 {
			continue
		}
		p := rd[rng.IntN(len(rd))]
		if d := math.Hypot(float64(p[0]-w/2), float64(p[1]-h/2)); d < tierMid+4 || d > tierFar+6 {
			continue
		}
		near := false
		for _, q := range hamletAt {
			if math.Hypot(float64(p[0]-q[0]), float64(p[1]-q[1])) < checkpointHamlet {
				near = true
			}
		}
		if near {
			continue
		}
		// Rows across the road, the tent on either side of it.
		side := 1 - 2*rng.IntN(2)
		fx, fy := 0, side
		if ri >= 2 {
			fx, fy = side, 0
		}
		row := checkpointRoad
		if fx+fy < 0 {
			row++ // the road's two tiles run from p towards +x or +y
		}
		mid := checkpointMidX
		ax, ay := p[0]-mid*fy-row*fx, p[1]+mid*fx-row*fy
		x0, y0, x1, y1 := planBox(plan, ax, ay, fx, fy, func(byte) bool { return true })
		const m = checkpointClear
		if x0-m < 3 || y0-m < 3 || x1+m > w-4 || y1+m > h-4 || clashes(houses, x0, y0, x1, y1, checkpointGap) {
			continue
		}
		houses = flatten(t, w, houses, x0-m, y0-m, x1+m, y1+m)
		clearBox(t, w, h, x0-m, y0-m, x1+m, y1+m, TGrass)
		r := ruin{checkpoint: true, yaw: float32(math.Atan2(float64(fy), float64(fx)))}
		for ly, line := range plan {
			for lx := 0; lx < len(line); lx++ {
				x, y := planAt(ax, ay, fx, fy, lx, ly)
				switch line[lx] {
				case 'b', 'S', 'c':
					t[y*w+x] = TRock
				case '.', 's':
					t[y*w+x] = TFloor
				case '=':
					t[y*w+x] = TDirt
					road[y*w+x] = true
				case 'T':
					r.trucks = append(r.trucks, [2]int{x, y})
				}
				if line[lx] == 's' {
					r.cx, r.cy = x, y
				}
			}
		}
		r.x, r.y, x1, y1 = planBox(plan, ax, ay, fx, fy, func(c byte) bool { return c == 'c' })
		r.w, r.h = x1-r.x+1, y1-r.y+1
		return append(houses, r)
	}
	return houses
}

// checkpointMid is the middle of checkpoint s's chicane.
func checkpointMid(s *Site) (float32, float32) {
	ax, ay, fx, fy := planOrigin(checkpointPlan[:], s)
	return float32(ax) + .5 + checkpointMidX*float32(fy) + checkpointMidY*float32(fx), float32(ay) + .5 - checkpointMidX*float32(fx) + checkpointMidY*float32(fy)
}

// checkpointPost is somewhere about the barriers for one of the checkpoint's garrison.
func (w *World) checkpointPost(s *Site) (float32, float32) {
	mx, my := checkpointMid(s)
	a := w.rng.Float64() * 2 * math.Pi
	d := checkpointGuardLo + w.rng.Float64()*(checkpointGuardHi-checkpointGuardLo)
	return mx + float32(math.Cos(a)*d), my + float32(math.Sin(a)*d)
}

// ---- the cemetery and the quarantine camp ------------------------------------------------

// The cemetery: one on every map, far out, a walled yard of graves behind iron railings, its
// gate towards town and a gap where the railings came down, the family crypt at the back. The
// dead lie in it, not all of them still: some sleep among the stones, and when someone breaks
// into the crypt the graves give up the rest, all over the yard. The crypt holds what the
// family was buried with: gold, and something rare besides.
//
// Its plan, as the shrine's: x across, y along towards the gate. 'f' railings, 'g' a
// gravestone, '#' the crypt, ',' its floor, 's' where it is searched from, '.' grass.
var cemeteryPlan = [...]string{
	"fffffffffffffffffff",
	"f......#####......f",
	"f..g...#,,,#...g..f",
	"f......#,s,#......f",
	"f..g...##,##...g..f",
	"f.................f",
	"f..g..g.....g..g..f",
	"f.................f",
	"f.................f",
	"f..g..g.....g..g...",
	"f..................",
	"f.................f",
	"f..g..g.....g..g..f",
	"f.................f",
	"f.................f",
	"f..g..g.....g..g..f",
	"fffffff.....fffffff",
}

// The quarantine camp: one on every map, out past the middle ring, where the sick were
// fenced in and left. A wire fence round a yard of trodden mud, a gate and a stretch flattened,
// rows of small tents open to the yard and the field hospital's big tent in the middle, its
// supplies still on the shelves. Searching it patches the searcher up and turns up kit and a
// medkit; but the camp's sick are often still in it, and come out of the tents.
//
// Its plan, as the cemetery's: 'w' the wire, 'c' canvas, ',' the hospital's boards, 's' where
// it is searched from, '.' mud.
var campPlan = [...]string{
	"wwwwwwwwwwwwwwwwwwwwwww",
	"w.....................w",
	"w.ccc...ccccccc...ccc.w",
	"w.c.....c,,,,,c.....c.w",
	"w.ccc...c,,s,,c...ccc.w",
	"w.......c,,,,,c.......w",
	"w.......cc,,,cc.......w",
	"w.....................w",
	"w.ccc.............ccc.w",
	"w.c.................c.w",
	"w.ccc.............ccc..",
	"w......................",
	"w.ccc.............ccc.w",
	"w.c.................c.w",
	"w.ccc.............ccc.w",
	"w.....................w",
	"wwwwwwwww.....wwwwwwwww",
}

const (
	yardClear = 3  // ground cleared round the cemetery and the camp
	yardGap   = 14 // from the other landmarks
)

// yard lays a walled place from its plan somewhere at least near tiles from the middle,
// clear of the other landmarks and open to the rest of the map, its last row towards the
// middle; ground is what its '.' cells are. mark sets what kind of place the ruin is.
func yard(t []Tile, w, h int, rng *rand.Rand, road []bool, houses []ruin, plan []string, near float64, ground Tile, mark func(*ruin)) []ruin {
	open := openFromMiddle(t, w, h)
	pw, pl := len(plan[0]), len(plan)
	r := max(pw, pl)/2 + yardClear
	type pick struct{ x, y, fx, fy int }
	var best pick
	bestScore := math.MaxInt
	for try := 0; try < 500; try++ {
		x, y := r+4+rng.IntN(w-2*r-8), r+4+rng.IntN(h-2*r-8)
		if math.Hypot(float64(x-w/2), float64(y-h/2)) < near || clashes(houses, x-r, y-r, x+r, y+r, yardGap) {
			continue
		}
		if score, ok := siteScore(t, w, open, road, rng, x, y, r); ok && score < bestScore {
			fx, fy := faceMiddle(w, h, x, y)
			best, bestScore = pick{x, y, fx, fy}, score
		}
	}
	if bestScore == math.MaxInt {
		return houses
	}
	cx, cy, fx, fy := best.x, best.y, best.fx, best.fy
	houses = flatten(t, w, houses, cx-r, cy-r, cx+r, cy+r)
	clearBox(t, w, h, cx-r, cy-r, cx+r, cy+r, TGrass)
	ax, ay := cx-pw/2*fy-pl/2*fx, cy+pw/2*fx-pl/2*fy
	var out ruin
	for ly, row := range plan {
		for lx := 0; lx < len(row); lx++ {
			x, y := planAt(ax, ay, fx, fy, lx, ly)
			switch row[lx] {
			case '.':
				t[y*w+x] = ground
			case ',', 's':
				t[y*w+x] = TFloor
			default:
				t[y*w+x] = TRock
			}
			if row[lx] == 's' {
				out.cx, out.cy = x, y
			}
		}
	}
	x0, y0, x1, y1 := planBox(plan, ax, ay, fx, fy, func(byte) bool { return true })
	out.x, out.y, out.w, out.h = x0, y0, x1-x0+1, y1-y0+1
	out.yaw = float32(math.Atan2(float64(fy), float64(fx)))
	mark(&out)
	return append(houses, out)
}

// cemetery lays the cemetery far out.
func cemetery(t []Tile, w, h int, rng *rand.Rand, road []bool, houses []ruin) []ruin {
	return yard(t, w, h, rng, road, houses, cemeteryPlan[:], tierMid+12, TGrass, func(r *ruin) { r.cemetery = true })
}

// camp lays the quarantine camp out past the middle ring.
func camp(t []Tile, w, h int, rng *rand.Rand, road []bool, houses []ruin) []ruin {
	return yard(t, w, h, rng, road, houses, campPlan[:], tierMid, TDirt, func(r *ruin) { r.camp = true })
}

// risenFrom is somewhere in the cemetery's yard for one of its dead to come up out of.
func (w *World) risenFrom(s *Site) (float32, float32) {
	return float32(s.X) + 1.5 + w.rng.Float32()*float32(max(int(s.W)-3, 1)), float32(s.Y) + 1.5 + w.rng.Float32()*float32(max(int(s.H)-3, 1))
}

// searchCemetery hands over what the crypt's dead were buried with: rings and coins, and
// something rare or better besides.
func (w *World) searchCemetery(p *Player, s *Site) {
	got := []string{w.grant(p, Good, FavorGold)}
	r := max(RollRarity(w.rng.Float64(), w.Luck(p, s)), Rare)
	got = append(got, w.grant(p, r, FavorNone))
	p.Dry = 0
	w.Blasts = append(w.Blasts, Blast{s.SX, s.SY, 1.5, 5})
	tag := ""
	if rarityNames[r] != "" {
		tag = "  ·  " + rarityNames[r]
	}
	w.note(1, "%s robbed the cemetery's crypt: %s%s", p.Name, strings.Join(got, " and "), tag)
}
