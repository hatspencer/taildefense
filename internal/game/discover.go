package game

import (
	"math"
	"slices"
)

// The map the team has found, at night (hard and brutal): the ground no survivor or structure
// has ever lit stays black for everyone, and what one survivor has seen everyone keeps. Each
// page works out what is in sight now from the frames, by the same rules as here (web/src/
// vision.ts); the host keeps the ground found so far, so a survivor who joins late or reloads
// starts from the team's map rather than a blank one.

// Seen is a bit per tile, set once someone has seen it. It is nil when the night is off.
type Seen []uint64

// Has reports whether tile i has been seen.
func (s Seen) Has(i int) bool { return i >= 0 && i>>6 < len(s) && s[i>>6]&(1<<(i&63)) != 0 }

// discover marks the ground in sight now in w.lit, adds it to what has been found, and
// appends the tiles seen for the first time to w.Found. The radii follow the page's, so a
// creep is in sight here exactly when the pages show it.
func (w *World) discover() {
	dark := w.diff().Dark
	if dark <= 0 {
		return
	}
	if w.Seen == nil {
		w.Seen = make(Seen, (w.W*w.H+63)/64)
		w.lit = make(Seen, len(w.Seen))
	}
	clear(w.lit)
	if w.rooms == nil || w.roomsFor != len(w.Sites) {
		w.rooms, w.roomsFor = w.roomGrid(), len(w.Sites)
	}
	mul := w.rangeMul()
	for _, p := range w.Players {
		r := float32(4)
		if p.Alive {
			r = w.sight(p)
		}
		in := w.roomAt(p.X, p.Y)
		if in >= 0 {
			s := &w.Sites[in]
			w.lightRect(int(s.X)+1, int(s.Y)+1, int(s.W)-2, int(s.H)-2)
		}
		w.lightDisc(p.X, p.Y, r*mul, in)
	}
	for i := range w.Structs {
		s := &w.Structs[i]
		if !s.Alive {
			continue
		}
		r := float32(2)
		switch {
		case s.Kind == SCore:
			r = darkLit
		case s.Kind == SArmory:
			r = 7
		case Structs[s.Kind].Turret:
			r = 4
		}
		w.lightDisc(s.CX(), s.CY(), r, -1)
	}
	slices.Sort(w.Found)
}

// rifleSight is how much further a survivor with a rifle in hand sees: the scope.
const rifleSight = 2

// sight is how far survivor p sees at night.
func (w *World) sight(p *Player) float32 {
	if p.Cur == WRifle {
		return w.diff().Dark * rifleSight
	}
	return w.diff().Dark
}

// roomGrid is, per tile, the walled site whose inside it is, walls excluded, or -1.
func (w *World) roomGrid() []int16 {
	g := make([]int16, w.W*w.H)
	for i := range g {
		g[i] = -1
	}
	for k, s := range w.Sites {
		if !s.Kind.Walled() {
			continue
		}
		for y := max(0, int(s.Y)+1); y < min(w.H, int(s.Y)+int(s.H)-1); y++ {
			for x := max(0, int(s.X)+1); x < min(w.W, int(s.X)+int(s.W)-1); x++ {
				g[y*w.W+x] = int16(k)
			}
		}
	}
	return g
}

func (w *World) roomAt(x, y float32) int {
	tx, ty := int(x), int(y)
	if x < 0 || y < 0 || tx >= w.W || ty >= w.H {
		return -1
	}
	return int(w.rooms[ty*w.W+tx])
}

func (w *World) see(i int) {
	w.lit[i>>6] |= 1 << (i & 63)
	if w.Seen[i>>6]&(1<<(i&63)) == 0 {
		w.Seen[i>>6] |= 1 << (i & 63)
		w.Found = append(w.Found, int32(i))
	}
}

// hidden reports whether creep c is out in the dark where no survivor can see it, so a
// survivor's shot can't find it. Turrets have their own eyes.
func (w *World) hidden(c *Creep) bool {
	if w.lit == nil || w.turretFire {
		return false
	}
	tx, ty := int(c.X), int(c.Y)
	return c.X < 0 || c.Y < 0 || tx >= w.W || ty >= w.H || !w.lit.Has(ty*w.W+tx)
}

func (w *World) lightRect(x0, y0, rw, rh int) {
	for y := max(0, y0); y < min(w.H, y0+rh); y++ {
		for x := max(0, x0); x < min(w.W, x0+rw); x++ {
			w.see(y*w.W + x)
		}
	}
}

// lightDisc marks a disc of open ground, and of the room inside (-1: none) its source stands in.
func (w *World) lightDisc(cx, cy, r float32, inside int) {
	y0, y1 := max(0, int(floor32(cy-r))), min(w.H-1, int(floor32(cy+r)))
	for y := y0; y <= y1; y++ {
		dy := float32(y) + .5 - cy
		span := sqrt32(max(0, r*r-dy*dy))
		x0, x1 := max(0, int(floor32(cx-span+.5))), min(w.W-1, int(floor32(cx+span-.5)))
		for i := y*w.W + x0; i <= y*w.W+x1; i++ {
			if rm := int(w.rooms[i]); rm != -1 && rm != inside {
				continue
			}
			w.see(i)
		}
	}
}

func floor32(v float32) float32 { return float32(math.Floor(float64(v))) }
