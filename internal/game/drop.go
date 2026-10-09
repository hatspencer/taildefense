package game

import (
	"fmt"
	"math"
)

// Supply drops: after every tenth wave a Huey gunship flies a crate out beyond the walls. Its
// door gunner works over the drop zone on the way in, the crate comes down under a chute, and
// whoever stands by it long enough opens it for the whole team. It is the long break's lure:
// worth the walk, out where the creeps are.

const (
	dropEvery  = 10  // waves
	dropFlight = 14  // seconds from the call to the crate landing
	dropHover  = 3   // of those, seconds the Huey hangs over the zone before the crate is down
	dropGunR   = 11  // tiles the door gunner reaches from the Huey
	dropGunGap = .12 // seconds between the gunner's shots
	crateReach = 1.8 // tiles from the crate to open it
	crateOpen  = 2.5 // seconds of standing by it, unhurt, to open it
	crateMax   = 3   // unopened crates kept; the oldest goes when a fourth lands
)

// CrateOpenTime is how long opening a crate takes, for the client's progress ring.
func CrateOpenTime() float32 { return crateOpen }

// TracerHeli marks a shot of the Huey's door gunner; it starts at the Huey, in the air.
const TracerHeli = 34

// Crate is a supply crate on the ground, waiting to be opened.
type Crate struct {
	X, Y float32
	Open float32 // seconds of opening done; it starts over when nobody is at it
}

// heliAt is where the Huey of a drop is over the ground: flying in from X0, Y0 and hanging
// over X, Y for the last dropHover seconds.
func heliAt(e *Effect) (float32, float32) {
	k := min(max((e.Total-e.Left)/(e.Total-dropHover), 0), 1)
	k = 1 - (1-k)*(1-k) // slows into the hover
	return e.X0 + (e.X-e.X0)*k, e.Y0 + (e.Y-e.Y0)*k
}

// callDrop sends a Huey with a crate to a spot out beyond the walls.
func (w *World) callDrop() {
	x, y, ok := w.dropZone()
	if !ok {
		return
	}
	// In from further out along the same bearing, so it crosses the wilds on the way.
	dx, dy := x-w.CoreX, y-w.CoreY
	d := sqrt32(dx*dx + dy*dy)
	fx := min(max(x+dx/d*50, 1), float32(w.W-1))
	fy := min(max(y+dy/d*50, 1), float32(w.H-1))
	w.Effects = append(w.Effects, Effect{Kind: EffDrop, X0: fx, Y0: fy, X: x, Y: y, R: 1, Left: dropFlight, Total: dropFlight, Owner: -1})
	w.note(1, "supply drop inbound: a Huey is bringing a crate in, %s", w.where(x, y))
}

// dropZone picks open ground well outside the walls that a survivor can walk to.
func (w *World) dropZone() (float32, float32, bool) {
	core := &w.Structs[w.Core]
	for try := 0; try < 200; try++ {
		a := w.rng.Float64() * 2 * math.Pi
		r := BuildRadius + 8 + w.rng.Float32()*14
		x := w.CoreX + float32(math.Cos(a))*r
		y := w.CoreY + float32(math.Sin(a))*r
		if x < 4 || y < 4 || x > float32(w.W-4) || y > float32(w.H-4) {
			continue
		}
		clear := true
		for oy := -1; oy <= 1 && clear; oy++ {
			for ox := -1; ox <= 1 && clear; ox++ {
				tx, ty := int(x)+ox, int(y)+oy
				clear = walkable(w, tx, ty) && w.StructAt(tx, ty) < 0
			}
		}
		if !clear {
			continue
		}
		// Reachable from the base: a path that ends at the spot.
		pts := w.paths.find(w, core.CX(), core.CY()+float32(core.H)/2+1.5, x, y, nil)
		if n := len(pts); n == 0 || absf(pts[n-1][0]-x)+absf(pts[n-1][1]-y) > 1.5 {
			continue
		}
		return float32(int(x)) + .5, float32(int(y)) + .5, true
	}
	return 0, 0, false
}

// stepDrop runs a drop in flight for one tick: the gunner fires, and the crate lands when
// Left runs out.
func (w *World) stepDrop(e *Effect) {
	if e.Total-e.Left > 2 {
		e.R -= Dt // R is the gunner's cooldown
		hx, hy := heliAt(e)
		for e.R <= 0 {
			e.R += dropGunGap
			t := w.nearestVisible(hx, hy, dropGunR)
			if t < 0 {
				break
			}
			c := &w.Creeps[t]
			w.tracer(hx, hy, c.X, c.Y, TracerHeli)
			w.damage(t, 28+3*float32(w.Wave), -1)
		}
	}
	if e.Left <= 0 {
		if len(w.Crates) >= crateMax {
			w.Crates = w.Crates[1:]
		}
		w.Crates = append(w.Crates, Crate{X: e.X, Y: e.Y})
		w.Blasts = append(w.Blasts, Blast{e.X, e.Y, 1.5, 5})
		w.note(1, "the supply crate is down %s  ·  stand by it to open it", w.where(e.X, e.Y))
	}
}

// stepCrates opens a crate for whoever stands by it, unhurt, long enough.
func (w *World) stepCrates() {
	for i := 0; i < len(w.Crates); i++ {
		c := &w.Crates[i]
		var opener *Player
		for _, p := range w.Players {
			if !p.Connected || !p.Alive || p.Hurt > 0 {
				continue
			}
			if dx, dy := p.X-c.X, p.Y-c.Y; dx*dx+dy*dy <= crateReach*crateReach {
				opener = p
				break
			}
		}
		if opener == nil {
			c.Open = 0
			continue
		}
		if c.Open += Dt; c.Open < crateOpen {
			continue
		}
		w.openCrate(opener, c)
		w.Crates = append(w.Crates[:i], w.Crates[i+1:]...)
		i--
	}
}

// openCrate shares a crate out: gold and full medkits for everyone, a good find for the opener.
func (w *World) openCrate(p *Player, c *Crate) {
	gold := int32(float32(150+25*w.Wave) * w.diff().Gold)
	for _, o := range w.Players {
		if o.Connected {
			o.Gold += gold
			o.Medkits = medkitMax
		}
	}
	got := w.grant(p, Rare, FavorNone)
	w.Blasts = append(w.Blasts, Blast{c.X, c.Y, 1.5, 5})
	w.note(1, "%s opened the supply crate: +%d gold and full medkits for everyone, and %s", p.Name, gold, got)
}

// where says where a spot is the way players do: "NE of the base, 40 m". North is the top of
// the map; a tile is about a metre.
func (w *World) where(x, y float32) string {
	dx, dy := float64(x-w.CoreX), float64(y-w.CoreY)
	points := [8]string{"N", "NE", "E", "SE", "S", "SW", "W", "NW"}
	deg := math.Atan2(dx, -dy) * 180 / math.Pi
	pt := points[(int(math.Round(deg/45))+8)%8]
	return fmt.Sprintf("%s of the base, %.0f m", pt, math.Round(math.Hypot(dx, dy)/5)*5)
}

func absf(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}
