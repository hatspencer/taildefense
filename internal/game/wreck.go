package game

import "math"

// Wrecks are solid: a survivor walks round a car, not through it. Each lies along its road
// (Site.Yaw, sent to clients so the model lies the same way) as a box the size of the model,
// and a grid of the tiles each covers keeps the checks cheap. Creeps still pass, as they
// always have: they climb over.

// wreckHalf is half a wreck's length and width in tiles, by kind, from the client's models.
func wreckHalf(k SiteKind) (float32, float32) {
	switch k {
	case SitePickup:
		return .9, .46
	case SitePolice:
		return .84, .45
	case SiteAmbulance:
		return 1, .47
	case SiteBus:
		return 1.55, .54
	case SiteArmy:
		return 1.2, .5
	}
	return .82, .44
}

// wreckYaw lays a wreck along the road under it, give or take, either way round: the road
// runs the way more of the tiles beside it are dirt. A hash rather than the map's generator,
// so the rest of the map comes out the same.
func (w *World) wreckYaw(i, x, y int) float32 {
	along, across := 0, 0
	for d := 1; d <= 2; d++ {
		for _, s := range [2]int{-d, d} {
			if w.At(x+s, y) == TDirt {
				along++
			}
			if w.At(x, y+s) == TDirt {
				across++
			}
		}
	}
	h := hash01(uint64(i)*0x9e3779b97f4a7c15 ^ w.Seed)
	yaw := (h - .5) * .7 // a little askew
	if across > along {
		yaw += math.Pi / 2
	}
	if hash01(uint64(i)*0xbf58476d1ce4e5b9^w.Seed^0x5a5a) < .5 {
		yaw += math.Pi
	}
	return float32(yaw)
}

func hash01(x uint64) float64 {
	x ^= x >> 31
	x *= 0x94d049bb133111eb
	x ^= x >> 29
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 32
	return float64(x>>11) / float64(1<<53)
}

// wreckDist is how far x, y is from wreck s's box, 0 inside it.
func wreckDist(s *Site, x, y float32) float32 {
	hl, hw := wreckHalf(s.Kind)
	c, sn := float32(math.Cos(float64(s.Yaw))), float32(math.Sin(float64(s.Yaw)))
	dx, dy := x-s.SX, y-s.SY
	u, v := abs32(dx*c+dy*sn)-hl, abs32(-dx*sn+dy*c)-hw
	u, v = max(u, 0), max(v, 0)
	return sqrt32(u*u + v*v)
}

func abs32(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}

// wreckGrid is, per tile, 1 + the index of the wreck whose box (grown by a survivor's
// radius) reaches into it, or 0. Wrecks are placed four tiles clear of every other site, so
// one per tile is enough. Built on first use, since a client's replica of the world has its
// sites only after the welcome.
func (w *World) wreckGrid() []int16 {
	if w.wrecks != nil && w.wrecksFor == len(w.Sites) {
		return w.wrecks
	}
	g := make([]int16, w.W*w.H)
	for i := range w.Sites {
		s := &w.Sites[i]
		if !s.Kind.Wreck() {
			continue
		}
		hl, _ := wreckHalf(s.Kind)
		r := int(hl+PlayerRadius) + 1
		for ty := int(s.SY) - r; ty <= int(s.SY)+r; ty++ {
			for tx := int(s.SX) - r; tx <= int(s.SX)+r; tx++ {
				if tx < 0 || ty < 0 || tx >= w.W || ty >= w.H {
					continue
				}
				// The nearest point of the tile to the box decides.
				nx := min(max(s.SX, float32(tx)), float32(tx+1))
				ny := min(max(s.SY, float32(ty)), float32(ty+1))
				if wreckDist(s, nx, ny) < PlayerRadius+.75 {
					g[ty*w.W+tx] = int16(i + 1)
				}
			}
		}
	}
	w.wrecks, w.wrecksFor = g, len(w.Sites)
	return g
}

// wreckAt reports whether a survivor's middle at x, y would be inside a wreck.
func (w *World) wreckAt(x, y float32) bool {
	tx, ty := int(math.Floor(float64(x))), int(math.Floor(float64(y)))
	if tx < 0 || ty < 0 || tx >= w.W || ty >= w.H {
		return false
	}
	i := w.wreckGrid()[ty*w.W+tx]
	return i > 0 && wreckDist(&w.Sites[i-1], x, y) < PlayerRadius
}

// wreckBlocker is a Blocker with wrecks; the world is one.
type wreckBlocker interface {
	wreckAt(x, y float32) bool
}

// siteReached reports whether a survivor at x, y is close enough to search site s: by a
// wreck's side, or within reach of anything else's spot.
func siteReached(s *Site, x, y float32) bool {
	if s.Kind.Wreck() {
		return wreckDist(s, x, y) <= PlayerRadius+.5
	}
	dx, dy := s.SX-x, s.SY-y
	return dx*dx+dy*dy <= lootReach*lootReach
}
