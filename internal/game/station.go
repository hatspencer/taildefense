package game

import (
	"math"
	"math/rand/v2"
	"slices"
	"strings"
)

// The gas station: one on every map, beside a road near the edge. A shop with a weapon behind
// its counter, a concrete lot out front, and fuel pumps under a canopy that go up in a ball of
// fire when shot, hurting whoever stands too close, survivor or creep. Its garrison sleeps
// round the pumps; more hide in the shop and come out at the first survivor on the lot.

// The station's layout, in its own frame: x along the road, y from the back of the lot (0)
// to the kerb (stationH-1).
const (
	stationW, stationH = 16, 13
	shopX0, shopX1     = 4, 11 // the shop's walls
	shopY1             = 5     // its front wall, with the door in the middle
)

// pumpSpots are the fuel pumps, in the station's frame: two islands of two under the canopy.
var pumpSpots = [...][2]int{{6, 8}, {9, 8}, {6, 10}, {9, 10}}

// Fuel pumps.
const (
	pumpRadius = .45 // what a shot has to pass within
	pumpBlast  = 3.5 // the fireball's reach
	pumpDamage = 160 // to a creep at its heart, half at its edge
	pumpHurt   = 55  // the same for a survivor
	pumpChain  = .35 // seconds before a pump caught in a blast goes up too
	pumpFire   = 6   // seconds the spilt fuel burns
	pumpFireR  = 2.2
	pumpFireDP = 30 // per second, to a creep in the fire
)

// onLot is how far from the middle of the pumps a survivor counts as on the forecourt.
const onLot = 6

// gasStation builds the gas station beside one of the roads, a little way in from the map's
// edge, where the roads cross least of it. Houses it lands on are torn down.
func gasStation(t []Tile, w, h int, rng *rand.Rand, roads [][][2]int, road []bool, houses []ruin) []ruin {
	type frame struct{ px, py, ax, ay, nx, ny int }
	// at is a tile of the station, in its frame: lx along the road, ly towards it.
	at := func(f frame, lx, ly int) (int, int) {
		gap := 1
		if f.nx+f.ny > 0 {
			gap = 2 // a road two wide runs from its point to the next tile on
		}
		d := gap + stationH - 1 - ly
		return f.px + f.nx*d + f.ax*(lx-stationW/2), f.py + f.ny*d + f.ay*(lx-stationW/2)
	}
	box := func(f frame, x0, y0, x1, y1 int) (int, int, int, int) {
		ax, ay := at(f, x0, y0)
		bx, by := at(f, x1, y1)
		return min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)
	}
	best, bestScore := frame{}, math.MaxInt
	for ri, rd := range roads {
		ax, ay := 1, 0
		if ri >= 2 {
			ax, ay = 0, 1
		}
		for k := 12; k < min(len(rd), 40); k += 2 {
			for _, side := range [2]int{-1, 1} {
				f := frame{rd[k][0], rd[k][1], ax, ay, ay * side, ax * side}
				x0, y0, x1, y1 := box(f, -1, -1, stationW, stationH)
				if x0 < 3 || y0 < 3 || x1 > w-4 || y1 > h-4 {
					continue
				}
				// Out past the middle ring of the map, where the loot is better.
				if math.Hypot(float64(x0+x1-w)/2, float64(y0+y1-h)/2) < tierMid+8 {
					continue
				}
				clash := false
				for _, r := range houses {
					if r.outpost && r.x < x1+5 && x0-4 < r.x+r.w && r.y < y1+5 && y0-4 < r.y+r.h {
						clash = true
					}
				}
				if clash {
					continue
				}
				score := 0
				sx0, sy0, sx1, sy1 := box(f, shopX0-1, -1, shopX1+1, shopY1+1)
				for y := y0; y <= y1; y++ {
					for x := x0; x <= x1; x++ {
						if road[y*w+x] {
							score++
							if x >= sx0 && x <= sx1 && y >= sy0 && y <= sy1 {
								score += 20
							}
						}
					}
				}
				if score = score*64 + rng.IntN(64); score < bestScore {
					best, bestScore = f, score
				}
			}
		}
	}
	if bestScore == math.MaxInt {
		return houses
	}
	f := best
	set := func(lx, ly int, k Tile) {
		if x, y := at(f, lx, ly); x > 0 && y > 0 && x < w-1 && y < h-1 {
			t[y*w+x] = k
		}
	}
	// The lot is concrete; round it, nothing stands in the way of getting on to it.
	for ly := -1; ly <= stationH; ly++ {
		for lx := -1; lx <= stationW; lx++ {
			x, y := at(f, lx, ly)
			switch {
			case lx >= 0 && ly >= 0 && lx < stationW && ly < stationH:
				set(lx, ly, TFloor)
			case t[y*w+x].Solid():
				set(lx, ly, TDirt)
			}
		}
	}
	// The shop: four walls, the door facing the pumps.
	for ly := 0; ly <= shopY1; ly++ {
		for lx := shopX0; lx <= shopX1; lx++ {
			edge := ly == 0 || ly == shopY1 || lx == shopX0 || lx == shopX1
			door := ly == shopY1 && (lx == stationW/2-1 || lx == stationW/2)
			if edge && !door {
				set(lx, ly, TRock)
			}
		}
	}
	x0, y0, x1, y1 := box(f, -3, -3, stationW+2, stationH+2)
	kept := houses[:0]
	for _, r := range houses {
		if !r.outpost && r.x <= x1 && x0 < r.x+r.w && r.y <= y1 && y0 < r.y+r.h {
			continue
		}
		kept = append(kept, r)
	}
	sx0, sy0, sx1, sy1 := box(f, shopX0, 0, shopX1, shopY1)
	shop := ruin{x: sx0, y: sy0, w: sx1 - sx0 + 1, h: sy1 - sy0 + 1, station: true}
	for _, p := range pumpSpots {
		x, y := at(f, p[0], p[1])
		shop.pumps = append(shop.pumps, [2]int{x, y})
	}
	return append(kept, shop)
}

// station is the index of the map's gas station, or -1.
func (w *World) station() int {
	for i := range w.Sites {
		if w.Sites[i].Kind == SiteStation {
			return i
		}
	}
	return -1
}

// forecourt is the middle of the station's pumps.
func (w *World) forecourt() (float32, float32) {
	var x, y float32
	n := 0
	for _, i := range w.pumps() {
		x += w.Sites[i].SX
		y += w.Sites[i].SY
		n++
	}
	if n == 0 {
		return 0, 0
	}
	return x / float32(n), y / float32(n)
}

// onForecourt reports whether p is on station si's lot or in its shop.
func (w *World) onForecourt(si int, p *Player) bool {
	s := &w.Sites[si]
	if p.X >= float32(s.X) && p.Y >= float32(s.Y) && p.X < float32(s.X)+float32(s.W) && p.Y < float32(s.Y)+float32(s.H) {
		return true
	}
	x, y := w.forecourt()
	dx, dy := p.X-x, p.Y-y
	return dx*dx+dy*dy < onLot*onLot
}

// rouse wakes every sleeping guard of site si and sets them on p.
func (w *World) rouse(si int, p *Player) {
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if c.Home == int16(si+1) && c.HP > 0 {
			c.Asleep, c.Returning = false, false
			c.Hunt, c.HuntLeft = int8(p.ID), 8
		}
	}
}

// stationPost is where the station's guard j sleeps: the first few in the shop, the rest
// round the pumps.
func (w *World) stationPost(s *Site, j int) (float32, float32) {
	if j%4 == 3 {
		return float32(s.X) + 1 + w.rng.Float32()*float32(max(int(s.W)-2, 1)), float32(s.Y) + 1 + w.rng.Float32()*float32(max(int(s.H)-2, 1))
	}
	x, y := w.forecourt()
	a := w.rng.Float64() * 2 * math.Pi
	d := 1.5 + w.rng.Float64()*4.5
	return x + float32(math.Cos(a)*d), y + float32(math.Sin(a)*d)
}

// searchStation hands over what is behind the counter: always a weapon the searcher does not
// have yet, one of the dearer ones, with a level or two on it, and something good besides.
// Someone who has every gun gets parts for the one in their hands instead.
func (w *World) searchStation(p *Player, s *Site) {
	var guns []WeaponKind
	for k := WeaponKind(0); k < NumWeapons; k++ {
		if !p.Weapons[k].Owned {
			guns = append(guns, k)
		}
	}
	slices.SortFunc(guns, func(a, b WeaponKind) int { return int(Weapons[b].Price - Weapons[a].Price) })
	var got []string
	if len(guns) > 0 {
		g, _ := w.giveWeapon(p, guns[w.rng.IntN((len(guns)+1)/2)], 1+uint8(w.rng.IntN(2)))
		got = append(got, g)
	} else if g, ok := w.giveUpgrade(p, p.Cur, 3); ok {
		got = append(got, g)
	}
	r := max(RollRarity(w.rng.Float64(), w.Luck(p, s)), Good)
	got = append(got, w.grant(p, r, FavorNone))
	p.Dry = 0
	w.Blasts = append(w.Blasts, Blast{s.SX, s.SY, 1.5, 5})
	w.note(1, "%s cleaned out the gas station: %s", p.Name, strings.Join(got, " and "))
}

// pumps lists the fuel pumps' site indices.
func (w *World) pumps() []int {
	if w.pumpIdx != nil && w.pumpsFor == len(w.Sites) {
		return w.pumpIdx
	}
	w.pumpIdx = []int{}
	for i := range w.Sites {
		if w.Sites[i].Kind == SitePump {
			w.pumpIdx = append(w.pumpIdx, i)
		}
	}
	w.pumpsFor = len(w.Sites)
	return w.pumpIdx
}

// pumpOnRay is the nearest standing pump a shot from x, y along dx, dy hits before maxT, and
// how far along it is; -1 for none.
func (w *World) pumpOnRay(x, y, dx, dy, maxT float32) (int, float32) {
	best, bt := -1, maxT
	for _, i := range w.pumps() {
		s := &w.Sites[i]
		if s.Searched {
			continue
		}
		ox, oy := s.SX-x, s.SY-y
		t := ox*dx + oy*dy
		if t < .3 || t >= bt {
			continue
		}
		if px, py := ox-dx*t, oy-dy*t; px*px+py*py <= pumpRadius*pumpRadius {
			best, bt = i, t
		}
	}
	return best, bt
}

// pumpsIn sets off every standing pump within r of x, y, after delay seconds.
func (w *World) pumpsIn(x, y, r float32, by int8, delay float32) {
	for _, i := range w.pumps() {
		s := &w.Sites[i]
		if dx, dy := s.SX-x, s.SY-y; dx*dx+dy*dy <= (r+pumpRadius)*(r+pumpRadius) {
			w.lightPump(i, by, delay)
		}
	}
}

// pumpCone sets off the standing pumps in a cone of fire.
func (w *World) pumpCone(by int8, x, y, dx, dy, rng, cosHalf float32) {
	for _, i := range w.pumps() {
		s := &w.Sites[i]
		ox, oy := s.SX-x, s.SY-y
		d := sqrt32(ox*ox + oy*oy)
		if d <= rng && d > 1e-3 && (ox*dx+oy*dy)/d >= cosHalf && w.clearShot(x, y, s.SX, s.SY) {
			w.lightPump(i, by, Dt)
		}
	}
}

// lightPump sets pump i to go up in delay seconds, unless it is going already.
func (w *World) lightPump(i int, by int8, delay float32) {
	s := &w.Sites[i]
	if s.Searched || s.fuse > 0 {
		return
	}
	s.fuse, s.by = max(delay, Dt), by
}

// stepPumps counts down the pumps that were hit and blows them.
func (w *World) stepPumps() {
	for _, i := range w.pumps() {
		s := &w.Sites[i]
		if s.fuse <= 0 {
			continue
		}
		if s.fuse -= Dt; s.fuse <= 0 {
			w.blowPump(i)
		}
	}
}

// blowPump is a fuel pump going up: a fireball that hurts survivors and creeps alike, sets
// off the pumps beside it, leaves a pool of burning fuel, and wakes the guards for a way round.
func (w *World) blowPump(i int) {
	s := &w.Sites[i]
	first := true
	for _, j := range w.pumps() {
		if w.Sites[j].Searched {
			first = false
		}
	}
	s.Searched, s.fuse = true, 0
	x, y, by := s.SX, s.SY, s.by
	w.shooter = by
	w.explode(x, y, pumpBlast, pumpDamage, by, 0)
	w.shooter = -1
	for _, p := range w.Players {
		if !p.Alive {
			continue
		}
		dx, dy := p.X-x, p.Y-y
		if dd := dx*dx + dy*dy; dd < pumpBlast*pumpBlast {
			w.hurtPlayer(p, pumpHurt*(1-.5*sqrt32(dd)/pumpBlast))
		}
	}
	w.Effects = append(w.Effects, Effect{Kind: EffNapalm, X0: x, Y0: y, X: x, Y: y, R: pumpFireR, Left: pumpFire, Total: pumpFire, Damage: pumpFireDP, Owner: by})
	w.grid.each(x, y, 12, func(k int32) bool {
		if c := &w.Creeps[k]; c.Home > 0 && c.Asleep {
			w.wakeSite(c)
		}
		return true
	})
	if first {
		if by >= 0 && int(by) < len(w.Players) {
			w.note(2, "%s blew up a fuel pump at the gas station", w.Players[by].Name)
		} else {
			w.note(2, "a fuel pump went up at the gas station")
		}
	}
}
