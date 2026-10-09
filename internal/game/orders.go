package game

import (
	"errors"
	"math"
)

// OrderKind is what a survivor has been told to do, WC3 style: the client clicks, the host
// walks and fights.
type OrderKind uint8

const (
	OrderIdle       OrderKind = iota // stand, shoot whatever comes in range
	OrderMove                        // walk there, ignoring creeps
	OrderAttackMove                  // walk there, stopping to fight anything in range
	OrderAttack                      // chase and shoot one creep
	OrderHold                        // stand, shoot what comes in range, never move
	OrderBuild                       // walk to a tile and build there
	OrderRepair                      // walk to a structure and repair it
	OrderLoot                        // walk to a loot site and search it
	OrderRevive                      // walk to a downed teammate and revive them
	OrderSteer                       // walk along X, Y (a unit vector) while the client holds a key
)

// Order is a survivor's current order.
type Order struct {
	Kind    OrderKind
	X, Y    float32    // destination
	Target  uint16     // OrderAttack: creep id
	Struct  int        // OrderRepair: structure index
	Site    int        // OrderLoot: site index
	Started bool       // OrderLoot: the search has begun (an ambush may have sprung)
	Mate    int        // OrderRevive: player index
	Build   StructKind // OrderBuild
	TX, TY  int        // OrderBuild: tile
}

// buildReach is how close a survivor walks to a tile before building on it.
const buildReach = 2.5

// Command orders. Each replaces whatever the player was doing.

// MoveTo walks the player to x, y; attack makes it an attack-move.
func (w *World) MoveTo(p *Player, x, y float32, attack bool) {
	k := OrderMove
	if attack {
		k = OrderAttackMove
	}
	w.order(p, Order{Kind: k, X: x, Y: y})
}

// AttackCreep sends the player after one creep.
func (w *World) AttackCreep(p *Player, id uint16) error {
	if i := w.creepIndex(id); i < 0 {
		return errors.New("that creep is gone")
	}
	w.order(p, Order{Kind: OrderAttack, Target: id})
	return nil
}

// steerLapse is how long a steer lasts without a repeat; the client repeats it several times a
// second while a key is held, so a lost release cannot leave a survivor walking off the map.
const steerLapse = .4

// Steer walks the player along the angle ang (radians) for WASD, or stops when on is false.
func (w *World) Steer(p *Player, ang float32, on bool) {
	if !on {
		if p.Order.Kind == OrderSteer {
			w.order(p, Order{})
		}
		return
	}
	if p.Order.Kind != OrderSteer {
		w.order(p, Order{Kind: OrderSteer})
	}
	s, c := math.Sincos(float64(ang))
	p.Order.X, p.Order.Y = float32(c), float32(s)
	p.steerLeft = steerLapse
}

// Stop drops the order; Hold also keeps the player from moving.
func (w *World) Stop(p *Player, hold bool) {
	k := OrderIdle
	if hold {
		k = OrderHold
	}
	w.order(p, Order{Kind: k})
}

// OrderBuild sends the player to build k at tile x, y. It is refused at once when it could
// never succeed; whether there is still gold and room is checked again on arrival.
func (w *World) OrderBuild(p *Player, k StructKind, x, y int) error {
	if k >= NumStructKinds {
		return errors.New("no such building")
	}
	if err := w.canBuild(p, k, x, y, false); err != nil {
		return err
	}
	w.order(p, Order{Kind: OrderBuild, Build: k, TX: x, TY: y, X: float32(x) + .5, Y: float32(y) + .5})
	return nil
}

// OrderRepair sends the player to repair a structure.
func (w *World) OrderRepair(p *Player, si int) error {
	if si < 0 || si >= len(w.Structs) || !w.Structs[si].Alive {
		return errors.New("nothing to repair there")
	}
	s := &w.Structs[si]
	if s.HP >= s.MaxHP {
		return errors.New("it is not damaged")
	}
	w.order(p, Order{Kind: OrderRepair, Struct: si, X: s.CX(), Y: s.CY()})
	return nil
}

func (w *World) order(p *Player, o Order) {
	p.Order = o
	p.Search = 0
	p.walk.reset()
	if o.Kind == OrderMove || o.Kind == OrderAttackMove || o.Kind == OrderBuild || o.Kind == OrderRepair || o.Kind == OrderLoot || o.Kind == OrderRevive {
		w.route(p, o.X, o.Y)
	}
}

// creepIndex finds a creep alive at the start of this tick by id, or -1.
func (w *World) creepIndex(id uint16) int32 {
	if int(id) >= len(w.byID) {
		return -1
	}
	i := w.byID[id]
	if i < 0 || int(i) >= len(w.Creeps) || w.Creeps[i].ID != id || w.Creeps[i].HP <= 0 {
		return -1
	}
	return i
}

func (w *World) indexCreeps() {
	for i := range w.Creeps {
		w.byID[w.Creeps[i].ID] = int32(i)
	}
}

// ---- walking ---------------------------------------------------------------------------

// walker is a player's path: waypoints in tiles, and how well following it is going.
type walker struct {
	pts    [][2]float32
	i      int
	gx, gy float32 // where the path was planned to
	check  float32 // seconds until the next progress check
	cx, cy float32 // position at the last check
	fails  int
	repath float32 // seconds until a moving goal (a chased creep) is planned again
}

func (k *walker) reset() {
	k.pts = k.pts[:0]
	k.i = 0
	k.fails = 0
	k.check = .5
	k.repath = 0
}

func (k *walker) done() bool { return k.i >= len(k.pts) }

// route plans the player's path to x, y.
func (w *World) route(p *Player, x, y float32) {
	k := &p.walk
	k.pts = w.paths.find(w, p.X, p.Y, x, y, k.pts[:0])
	k.i = 0
	k.gx, k.gy = x, y
	k.check = .5
	k.cx, k.cy = p.X, p.Y
}

// stride is how far the player walks this tick.
func (w *World) stride(p *Player) float32 {
	speed := p.Speed() * w.playerSpeedMul() * Dt
	if p.Sprinting() {
		speed *= sprintMul
	}
	return speed
}

// step walks the player one tick along the path; false when there is nowhere left to go.
func (w *World) step(p *Player) bool {
	k := &p.walk
	speed := w.stride(p)
	for speed > 0 && !k.done() {
		t := k.pts[k.i]
		dx, dy := t[0]-p.X, t[1]-p.Y
		d := sqrt32(dx*dx + dy*dy)
		if d < .05 {
			k.i++
			continue
		}
		s := min(speed, d)
		nx, ny := Move(w, p.X, p.Y, dx/d*s, dy/d*s)
		p.Aim = float32(math.Atan2(float64(dy), float64(dx)))
		moved := nx != p.X || ny != p.Y
		p.X, p.Y = nx, ny
		if !moved {
			break
		}
		speed -= s
	}
	if k.done() {
		return false
	}
	// Twice a second, see whether the walk is getting anywhere; a structure built across the
	// path, or another survivor, can leave the player pushing against a wall.
	k.check -= Dt
	if k.check <= 0 {
		k.check = .5
		dx, dy := p.X-k.cx, p.Y-k.cy
		if dx*dx+dy*dy < .2*.2 {
			k.fails++
			if k.fails > 2 {
				k.pts = k.pts[:0]
				return false
			}
			w.route(p, k.gx, k.gy)
		} else {
			k.fails = 0
		}
		k.cx, k.cy = p.X, p.Y
	}
	return true
}

// ---- the survivor's tick ---------------------------------------------------------------

func (w *World) stepPlayers() {
	for _, p := range w.Players {
		p.Revived = 0 // revivers below set it again
	}
	for _, p := range w.Players {
		if !p.Connected {
			continue
		}
		if p.TauntCool > 0 {
			p.TauntCool = max(p.TauntCool-Dt, 0)
		}
		if p.EmoteLeft > 0 {
			if p.EmoteLeft -= Dt; p.EmoteLeft <= 0 {
				p.EmoteLeft, p.Emote = 0, 0
			}
		}
		if !p.Alive {
			p.Respawn -= Dt
			if p.Respawn <= 0 {
				w.respawn(p)
			}
			continue
		}
		if p.Hurt > 0 {
			p.Hurt -= Dt
		}
		regen := 1.5 * float32(p.Gear[GearVitamins])
		if w.Phase == PhaseBuild {
			regen += 8
		}
		if p.Heal > 0 {
			regen += p.MaxHP * medkitHeal / medkitTime
			p.Heal = max(p.Heal-Dt, 0)
		}
		p.HP = min(p.MaxHP, p.HP+regen*Dt)
		for i := range p.Abil {
			if p.Abil[i].Cool > 0 {
				p.Abil[i].Cool = max(p.Abil[i].Cool-Dt, 0)
			}
		}
		if p.BuffLeft > 0 {
			p.BuffLeft = max(p.BuffLeft-Dt, 0)
		}

		// Every weapon reloads, not only the one in hand: run one dry, switch, and it comes
		// back full in the background.
		for k := range p.Weapons {
			o := &p.Weapons[k]
			if o.Reload > 0 {
				if o.Reload -= Dt; o.Reload <= 0 {
					o.Reload = 0
					o.Ammo = WeaponStats(WeaponKind(k), o.Lv).Mag
				}
			}
		}
		ws := &p.Weapons[p.Cur]
		st := w.playerStats(p)
		ws.Cool -= Dt

		target := w.act(p, st)
		p.stepStamina()
		w.ambushOnEntry(p)
		if p.noise > 0 {
			p.noise -= Dt
		}
		fire := target >= 0
		p.Firing = fire && ws.Reload <= 0
		if fire {
			c := &w.Creeps[target]
			ang := float32(math.Atan2(float64(c.Y-p.Y), float64(c.X-p.X)))
			p.Aim = ang
			w.shooter = int8(p.ID)
			for ws.Cool <= 0 && ws.Reload <= 0 && ws.Ammo > 0 {
				if p.noise <= 0 {
					p.noise = noiseEvery
					w.noise(p)
				}
				w.shoot(p, st, ang)
				ws.Ammo--
				ws.Cool += 1 / st.Rate
				if ws.Ammo == 0 {
					ws.Reload = st.Reload
				}
			}
			w.shooter = -1
		}
		if ws.Cool < 0 {
			ws.Cool = 0
		}
	}
}

// act carries out the player's order for one tick: walks, builds, repairs. It returns the
// creep to shoot at, or -1.
func (w *World) act(p *Player, st Stats) int32 {
	o := &p.Order
	p.Moving = false
	walk := func() bool {
		ok := w.step(p)
		p.Moving = ok
		return ok
	}
	switch o.Kind {
	case OrderIdle, OrderHold:
		return w.nearestVisible(p.X, p.Y, st.Range)
	case OrderSteer:
		if p.steerLeft -= Dt; p.steerLeft <= 0 {
			o.Kind = OrderIdle
		} else {
			s := w.stride(p)
			nx, ny := Move(w, p.X, p.Y, o.X*s, o.Y*s)
			p.Moving = nx != p.X || ny != p.Y
			p.X, p.Y = nx, ny
			p.Aim = float32(math.Atan2(float64(o.Y), float64(o.X)))
		}
		return w.nearestVisible(p.X, p.Y, st.Range)
	case OrderMove:
		if !walk() {
			o.Kind = OrderIdle
		}
		return -1
	case OrderAttackMove:
		if t := w.nearestVisible(p.X, p.Y, st.Range); t >= 0 {
			// Fighting pauses the walk; its progress check must not count the pause.
			p.walk.check = .5
			p.walk.cx, p.walk.cy = p.X, p.Y
			return t
		}
		if !walk() {
			o.Kind = OrderIdle
		}
		return -1
	case OrderAttack:
		t := w.creepIndex(o.Target)
		if t < 0 {
			o.Kind = OrderIdle
			return w.nearestVisible(p.X, p.Y, st.Range)
		}
		c := &w.Creeps[t]
		dx, dy := c.X-p.X, c.Y-p.Y
		// In range and in sight; otherwise walk on, round the wall if there is one.
		if dx*dx+dy*dy <= st.Range*st.Range*.9 && w.clearShot(p.X, p.Y, c.X, c.Y) {
			return t
		}
		k := &p.walk
		k.repath -= Dt
		if k.repath <= 0 || k.done() {
			k.repath = .5
			w.route(p, c.X, c.Y)
		}
		walk()
		return -1
	case OrderBuild:
		dx, dy := o.X-p.X, o.Y-p.Y
		if dx*dx+dy*dy <= buildReach*buildReach {
			if err := w.Build(p, o.Build, o.TX, o.TY); err != nil {
				w.toast(p, 2, "%v", err)
			}
			o.Kind = OrderIdle
			return -1
		}
		if !walk() {
			w.toast(p, 2, "cannot get there to build")
			o.Kind = OrderIdle
		}
		return -1
	case OrderRepair:
		if o.Struct >= len(w.Structs) {
			o.Kind = OrderIdle
			return -1
		}
		s := &w.Structs[o.Struct]
		if !s.Alive || s.HP >= s.MaxHP {
			o.Kind = OrderIdle
			return -1
		}
		reach := float32(max(s.W, s.H))/2 + 1.8
		dx, dy := s.CX()-p.X, s.CY()-p.Y
		if dx*dx+dy*dy <= reach*reach {
			if !w.repair(p, o.Struct) {
				w.toast(p, 2, "not enough gold to repair")
				o.Kind = OrderIdle
			}
			return -1
		}
		if !walk() {
			w.toast(p, 2, "cannot get there to repair")
			o.Kind = OrderIdle
		}
		return -1
	case OrderLoot:
		s := &w.Sites[o.Site]
		if s.Searched {
			w.toast(p, 2, "someone searched the %s first", SiteDefs[s.Kind].lower())
			o.Kind = OrderIdle
			p.Search = 0
			return -1
		}
		dx, dy := s.SX-p.X, s.SY-p.Y
		if dx*dx+dy*dy <= lootReach*lootReach {
			// Searching is all a survivor does: no shooting, and a hit starts it over. Guards
			// don't forbid it; they only make it hard to get through without a scratch.
			if p.Search == 0 && !o.Started {
				o.Started = true
				w.ambushOnSearch(o.Site, p)
			}
			if p.Hurt > 0 {
				p.Search = 0
				return -1
			}
			p.Search += Dt
			if p.Search >= SiteDefs[s.Kind].Search {
				o.Kind = OrderIdle
				p.Search = 0
				w.search(p, o.Site)
			}
			return -1
		}
		if !walk() {
			w.toast(p, 2, "cannot get there to search")
			o.Kind = OrderIdle
		}
		return -1
	case OrderRevive:
		if !w.actRevive(p, o) {
			o.Kind = OrderIdle
		}
		return -1
	}
	return -1
}

// ---- pathfinding -----------------------------------------------------------------------

// pathfinder is A* over the tile grid for survivors: anything but solid ground and
// structures other than gates. Its arrays are reused; a stamp per search stands in for
// clearing them.
type pathfinder struct {
	w, h  int
	g     []int32
	from  []int32
	stamp []uint32
	shut  []uint32
	gen   uint32
	heap  []uint64
	tiles []int32
}

func (f *pathfinder) init(w, h int) {
	f.w, f.h = w, h
	f.g = make([]int32, w*h)
	f.from = make([]int32, w*h)
	f.stamp = make([]uint32, w*h)
	f.shut = make([]uint32, w*h)
}

func walkable(b Blocker, x, y int) bool {
	if b.At(x, y).Solid() {
		return false
	}
	k := b.StructKindAt(x, y)
	return k == SNone || k == SGate
}

// maxExpand bounds one search; past it the path goes as near as it got.
const maxExpand = 40000

func octile(ax, ay, bx, by int) int32 {
	dx, dy := abs(ax-bx), abs(ay-by)
	return int32(10*max(dx, dy) + 4*min(dx, dy))
}

// find returns waypoints from x0, y0 to x1, y1, or as near to it as can be reached, with
// the staircase of the grid pulled straight wherever the way is clear.
func (f *pathfinder) find(b Blocker, x0, y0, x1, y1 float32, out [][2]float32) [][2]float32 {
	sx, sy := int(x0), int(y0)
	gx, gy := int(x1), int(y1)
	gx, gy = min(max(gx, 0), f.w-1), min(max(gy, 0), f.h-1)
	if sx == gx && sy == gy || clearLine(b, x0, y0, x1, y1) {
		if CanStand(b, x1, y1) {
			return append(out, [2]float32{x1, y1})
		}
	}
	f.gen++
	if f.gen == 0 {
		clear(f.stamp)
		clear(f.shut)
		f.gen = 1
	}
	gen := f.gen
	start := int32(sy*f.w + sx)
	goal := int32(gy*f.w + gx)
	f.heap = f.heap[:0]
	f.g[start], f.from[start], f.stamp[start] = 0, -1, gen
	f.push(octile(sx, sy, gx, gy), start)
	best, bestH := start, octile(sx, sy, gx, gy)
	for n := 0; len(f.heap) > 0 && n < maxExpand; n++ {
		i := f.pop()
		if f.shut[i] == gen {
			continue
		}
		f.shut[i] = gen
		if i == goal {
			best = i
			break
		}
		x, y := int(i)%f.w, int(i)/f.w
		if h := octile(x, y, gx, gy); h < bestH {
			best, bestH = i, h
		}
		for _, d := range dirs8 {
			nx, ny := x+d[0], y+d[1]
			if nx < 0 || ny < 0 || nx >= f.w || ny >= f.h || !walkable(b, nx, ny) {
				continue
			}
			if d[0] != 0 && d[1] != 0 && (!walkable(b, nx, y) || !walkable(b, x, ny)) {
				continue
			}
			ni := int32(ny*f.w + nx)
			ng := f.g[i] + int32(d[2])
			if f.stamp[ni] == gen && ng >= f.g[ni] {
				continue
			}
			f.stamp[ni], f.g[ni], f.from[ni] = gen, ng, i
			f.push(ng+octile(nx, ny, gx, gy), ni)
		}
	}
	// Walk back from the goal, or the nearest tile to it, into tile centres.
	tiles := f.tiles[:0]
	for i := best; i >= 0 && i != start; i = f.from[i] {
		tiles = append(tiles, i)
	}
	f.tiles = tiles
	if len(tiles) == 0 {
		return out
	}
	pts := out
	for j := len(tiles) - 1; j >= 0; j-- {
		i := tiles[j]
		pts = append(pts, [2]float32{float32(int(i)%f.w) + .5, float32(int(i)/f.w) + .5})
	}
	if best == goal && CanStand(b, x1, y1) {
		pts[len(pts)-1] = [2]float32{x1, y1}
	}
	return pull(b, x0, y0, pts)
}

// pull removes every waypoint that the one before it can see past, in place.
func pull(b Blocker, x, y float32, pts [][2]float32) [][2]float32 {
	out := pts[:0]
	cx, cy := x, y
	for i := 0; i < len(pts); {
		j := i
		for j+1 < len(pts) && clearLine(b, cx, cy, pts[j+1][0], pts[j+1][1]) {
			j++
		}
		out = append(out, pts[j])
		cx, cy = pts[j][0], pts[j][1]
		i = j + 1
	}
	return out
}

// clearLine reports whether a survivor can walk straight from one point to the other.
func clearLine(b Blocker, x0, y0, x1, y1 float32) bool {
	dx, dy := x1-x0, y1-y0
	d := sqrt32(dx*dx + dy*dy)
	n := int(d/.25) + 1
	for s := 1; s <= n; s++ {
		t := float32(s) / float32(n)
		if !CanStand(b, x0+dx*t, y0+dy*t) {
			return false
		}
	}
	return true
}

func (f *pathfinder) push(pri int32, i int32) {
	h := append(f.heap, uint64(pri)<<32|uint64(uint32(i)))
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

func (f *pathfinder) pop() int32 {
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
	return int32(uint32(top))
}
