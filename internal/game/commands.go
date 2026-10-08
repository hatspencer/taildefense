package game

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

// PlayerRadius is the half-width of a survivor's collision box.
const PlayerRadius = .3

// Blocker answers what is at a tile, for movement. The host answers from the World, a client
// from its replica, so prediction and the host agree on what is in the way.
type Blocker interface {
	At(x, y int) Tile
	StructKindAt(x, y int) StructKind
}

// StructKindAt is the kind of structure on a tile, SNone when there is none.
func (w *World) StructKindAt(x, y int) StructKind {
	if si := w.StructAt(x, y); si >= 0 {
		return w.Structs[si].Kind
	}
	return SNone
}

// CanStand reports whether a survivor fits at x, y: no solid ground and no structure under
// any corner of its box, gates excepted.
func CanStand(b Blocker, x, y float32) bool {
	for _, c := range [4][2]float32{{-PlayerRadius, -PlayerRadius}, {PlayerRadius, -PlayerRadius}, {-PlayerRadius, PlayerRadius}, {PlayerRadius, PlayerRadius}} {
		tx, ty := int(math.Floor(float64(x+c[0]))), int(math.Floor(float64(y+c[1])))
		if b.At(tx, ty).Solid() {
			return false
		}
		if k := b.StructKindAt(tx, ty); k != SNone && k != SGate {
			return false
		}
	}
	return true
}

// Move slides a survivor from x, y by dx, dy, one axis at a time so it glides along walls.
func Move(b Blocker, x, y, dx, dy float32) (float32, float32) {
	if CanStand(b, x+dx, y) {
		x += dx
	}
	if CanStand(b, x, y+dy) {
		y += dy
	}
	return x, y
}

// Join adds a player, or reconnects the one with the same login, who keeps their gold and
// loadout.
func (w *World) Join(name, login string) (*Player, error) {
	for _, p := range w.Players {
		if p.Login == login {
			if p.Connected {
				return nil, fmt.Errorf("%s is already in this game", login)
			}
			p.Connected = true
			p.Name = name
			p.lastAct = w.Tick
			w.note(0, "%s is back", name)
			return p, nil
		}
	}
	if len(w.Players) >= MaxPlayers {
		return nil, fmt.Errorf("the game is full (%d players)", MaxPlayers)
	}
	p := &Player{ID: uint8(len(w.Players)), Name: name, Login: login, Connected: true, lastAct: w.Tick, Look: w.dealLook()}
	w.resetPlayer(p)
	w.Players = append(w.Players, p)
	w.note(0, "%s joined as %s", name, p.Archetype())
	return p, nil
}

func (w *World) resetPlayer(p *Player) {
	p.Gold = 150
	p.Weapons = [NumWeapons]WeaponState{}
	p.Weapons[WPistol] = WeaponState{Owned: true, Ammo: Weapons[WPistol].Mag}
	p.Cur = WPistol
	p.Gear = [NumGear]uint8{}
	p.MaxHP = 100
	p.Kills, p.Damage = 0, 0
	p.Ready = false
	p.Abil = [NumAbilities]AbilityState{}
	for i, a := range Abilities {
		if a.Always {
			p.Abil[i].Lv = 1
		}
	}
	w.respawn(p)
	n := float32(p.ID)
	p.X, p.Y = w.CoreX-3+n, w.CoreY+3.8
}

// Leave marks a player gone. They stay in the roster so a reconnect picks up where they were.
func (w *World) Leave(p *Player) {
	p.Connected = false
	p.Firing = false
	p.Sprint = false
	if w.Paused == int8(p.ID) {
		w.Paused = -1
		w.note(0, "%s left, so the game goes on", p.Name)
	}
	p.Ready = false
	w.note(0, "%s left", p.Name)
}

// Errors a command can return; the client shows them as a toast.
var (
	errNotAtArmory = errors.New("go to the armory to buy (the gold building next to the generator)")
	errBroke       = errors.New("not enough gold")
	errMaxed       = errors.New("already at the maximum level")
	errOver        = errors.New("the game is over")
)

func (w *World) atArmory(p *Player) bool {
	a := &w.Structs[w.Armory]
	dx, dy := a.CX()-p.X, a.CY()-p.Y
	return p.Alive && dx*dx+dy*dy <= ShopRadius*ShopRadius
}

// AtArmory reports whether the player can shop right now.
func (w *World) AtArmory(p *Player) bool { return w.atArmory(p) }

func (w *World) pay(p *Player, cost int32) error {
	if p.Gold < cost {
		return fmt.Errorf("%w: need %d, have %d", errBroke, cost, p.Gold)
	}
	p.Gold -= cost
	return nil
}

// BuyWeapon buys a weapon and switches to it.
func (w *World) BuyWeapon(p *Player, k WeaponKind) error {
	if k >= NumWeapons {
		return errors.New("no such weapon")
	}
	if !w.atArmory(p) {
		return errNotAtArmory
	}
	ws := &p.Weapons[k]
	if ws.Owned {
		return fmt.Errorf("you already own the %s", Weapons[k].Name)
	}
	if err := w.pay(p, Weapons[k].Price); err != nil {
		return err
	}
	*ws = WeaponState{Owned: true, Ammo: Weapons[k].Mag}
	p.Cur = k
	return nil
}

// Upgrade raises one track of an owned weapon.
func (w *World) Upgrade(p *Player, k WeaponKind, t Track) error {
	if k >= NumWeapons || t >= NumTracks {
		return errors.New("no such upgrade")
	}
	if !w.atArmory(p) {
		return errNotAtArmory
	}
	ws := &p.Weapons[k]
	if !ws.Owned {
		return fmt.Errorf("buy the %s first", Weapons[k].Name)
	}
	if ws.Lv[t] >= MaxLevel {
		return errMaxed
	}
	if err := w.pay(p, UpgradeCost(k, ws.Lv[t])); err != nil {
		return err
	}
	ws.Lv[t]++
	if t == TrackHandling && ws.Reload <= 0 {
		ws.Ammo = WeaponStats(k, ws.Lv).Mag
	}
	return nil
}

// BuyGear raises a gear level.
func (w *World) BuyGear(p *Player, g Gear) error {
	if g >= NumGear {
		return errors.New("no such gear")
	}
	if !w.atArmory(p) {
		return errNotAtArmory
	}
	if p.Gear[g] >= MaxLevel {
		return errMaxed
	}
	if err := w.pay(p, GearCost(g, p.Gear[g])); err != nil {
		return err
	}
	p.Gear[g]++
	if g == GearArmor {
		p.MaxHP += 25
		p.HP += 25
	}
	return nil
}

// Select switches weapon.
func (w *World) Select(p *Player, k WeaponKind) error {
	if k >= NumWeapons || !p.Weapons[k].Owned {
		return errors.New("you do not own that weapon; buy it at the armory")
	}
	p.Cur = k
	return nil
}

// Reload starts a reload of the current weapon.
func (w *World) Reload(p *Player) {
	ws := &p.Weapons[p.Cur]
	if ws.Reload <= 0 && ws.Ammo < WeaponStats(p.Cur, ws.Lv).Mag {
		ws.Reload = WeaponStats(p.Cur, ws.Lv).Reload
	}
}

// SetReady marks a player ready to start the next wave early.
func (w *World) SetReady(p *Player, ready bool) {
	p.Ready = ready
}

// CanBuild reports why the player cannot build at tile x, y right now, or nil.
func (w *World) CanBuild(p *Player, k StructKind, x, y int) error {
	return w.canBuild(p, k, x, y, true)
}

// canBuild is CanBuild; near also asks that the player be standing close enough.
func (w *World) canBuild(p *Player, k StructKind, x, y int, near bool) error {
	d := Structs[k]
	if d.Price == 0 {
		return errors.New("that cannot be built")
	}
	if w.Phase == PhaseOver {
		return errOver
	}
	if x < 1 || y < 1 || x >= w.W-1 || y >= w.H-1 || w.Terrain[y*w.W+x].Solid() {
		return errors.New("cannot build there")
	}
	if w.StructAt(x, y) >= 0 {
		return errors.New("something is already built there")
	}
	cx, cy := float32(x)+.5-w.CoreX-.5, float32(y)+.5-w.CoreY-.5
	if cx*cx+cy*cy > BuildRadius*BuildRadius {
		return fmt.Errorf("too far from the generator to build (stay within %d tiles)", BuildRadius)
	}
	if px, py := float32(x)+.5-p.X, float32(y)+.5-p.Y; near && px*px+py*py > (buildReach+1)*(buildReach+1) {
		return errors.New("too far away; walk closer")
	}
	for _, o := range w.Players {
		if o.Connected && o.Alive && math.Abs(float64(o.X-float32(x)-.5)) < .5+PlayerRadius && math.Abs(float64(o.Y-float32(y)-.5)) < .5+PlayerRadius {
			return errors.New("someone is standing there")
		}
	}
	if w.nearestCreep(float32(x)+.5, float32(y)+.5, 1) >= 0 {
		return errors.New("a creep is in the way")
	}
	if p.Gold < d.Price {
		return fmt.Errorf("%w: need %d, have %d", errBroke, d.Price, p.Gold)
	}
	return nil
}

// Build places a structure owned by the player.
func (w *World) Build(p *Player, k StructKind, x, y int) error {
	if k >= NumStructKinds {
		return errors.New("no such building")
	}
	if err := w.CanBuild(p, k, x, y); err != nil {
		return err
	}
	p.Gold -= Structs[k].Price
	w.place(k, x, y, int8(p.ID))
	return nil
}

// Nearest returns the index of the closest live structure within r of the player, optionally
// only turrets, or -1.
func (w *World) Nearest(p *Player, r float32, turretsOnly bool) int {
	best, bi := r*r, -1
	for i := range w.Structs {
		s := &w.Structs[i]
		if !s.Alive || (turretsOnly && !Structs[s.Kind].Turret) {
			continue
		}
		dx, dy := s.CX()-p.X, s.CY()-p.Y
		if dd := dx*dx + dy*dy; dd < best {
			best, bi = dd, i
		}
	}
	return bi
}

// UpgradeStruct raises a turret's level.
func (w *World) UpgradeStruct(p *Player, si int) error {
	if si < 0 || si >= len(w.Structs) || !w.Structs[si].Alive {
		return errors.New("nothing to upgrade there")
	}
	s := &w.Structs[si]
	if !Structs[s.Kind].Turret {
		return fmt.Errorf("a %s cannot be upgraded; right-click it to repair", Structs[s.Kind].Name)
	}
	if s.Level >= MaxStructLevel {
		return errMaxed
	}
	if err := w.pay(p, StructUpgradeCost(s.Kind, s.Level)); err != nil {
		return err
	}
	s.Level++
	grow := Structs[s.Kind].HP * .25
	s.MaxHP += grow
	s.HP += grow
	return nil
}

// SellFraction is the share of what went into a structure that selling it returns, at full
// health; a damaged one returns that much less.
const SellFraction = .5

// SellValue is what selling s would return.
func SellValue(s *Structure) int32 {
	spent := Structs[s.Kind].Price
	for l := uint8(1); l < s.Level; l++ {
		spent += StructUpgradeCost(s.Kind, l)
	}
	return int32(float32(spent) * SellFraction * s.HP / s.MaxHP)
}

// Sell removes a structure the player built for half of what went into it.
func (w *World) Sell(p *Player, si int) (int32, error) {
	if si < 0 || si >= len(w.Structs) || !w.Structs[si].Alive {
		return 0, errors.New("nothing to sell there")
	}
	s := &w.Structs[si]
	if s.Kind == SCore || s.Kind == SArmory {
		return 0, errors.New("that cannot be sold")
	}
	if s.Owner >= 0 && s.Owner != int8(p.ID) {
		return 0, errors.New("someone else built that")
	}
	refund := SellValue(s)
	p.Gold += refund
	w.remove(si)
	return refund, nil
}

// Restart begins a new game on a new map with the same players, everything reset.
func (w *World) Restart(seed uint64) *World {
	nw := NewGame(seed, w.Diff)
	for _, p := range w.Players {
		np := &Player{ID: p.ID, Name: p.Name, Login: p.Login, Connected: p.Connected}
		nw.resetPlayer(np)
		nw.Players = append(nw.Players, np)
	}
	nw.note(1, "a new game begins  ·  wave 1 in %ds", int(nw.PhaseLeft))
	return nw
}

// TogglePause stops the game for everyone, or starts it again; any player may do either.
// Nothing moves while it is paused, but chat still works.
func (w *World) TogglePause(p *Player) {
	if w.Paused >= 0 {
		w.Paused = -1
		w.note(0, "%s resumed the game", p.Name)
		return
	}
	w.Paused = int8(p.ID)
	w.note(0, "%s paused the game", p.Name)
}

// Touch marks p as playing: any command does.
func (w *World) Touch(p *Player) { p.lastAct = w.Tick }

// idleAfter is how long a player may go without a command before the waves stop counting them.
const idleAfter = 90 * TickRate

// active is how many players are connected and playing, at least one.
func (w *World) active() int {
	n := 0
	for _, p := range w.Players {
		if p.Connected && w.Tick-p.lastAct < idleAfter {
			n++
		}
	}
	return max(n, 1)
}

// ArchetypeNames are the survivor outfits, in the order of the look's low bits. The client
// draws them; the host only deals them out.
var ArchetypeNames = [...]string{"paramedic", "mechanic", "hunter", "student", "builder", "nurse", "biker", "farmer", "ex-soldier", "office worker"}

// Archetypes is how many there are.
const Archetypes = len(ArchetypeNames)

// Archetype is p's outfit, "a paramedic".
func (p *Player) Archetype() string {
	n := ArchetypeNames[int(p.Look&15)%Archetypes]
	if strings.ContainsRune("aeiou", rune(n[0])) {
		return "an " + n
	}
	return "a " + n
}

// dealLook picks what a new survivor looks like. The bits are read by the client:
//
//	0-3 archetype, 4-6 skin tone, 7-8 body, 9-12 hair style, 13-15 hair colour,
//	16-17 facial hair, 18-19 build, 20-21 height, 22-23 glasses when both are 0
//
// Everything is random but the archetype, which comes from a shuffled bag so a team gets
// as many different outfits as it can before any repeats.
func (w *World) dealLook() uint32 {
	var used [Archetypes]int
	for _, p := range w.Players {
		used[int(p.Look&15)%Archetypes]++
	}
	least := len(w.Players)
	for _, n := range used {
		least = min(least, n)
	}
	var free []uint32
	for a, n := range used {
		if n == least {
			free = append(free, uint32(a))
		}
	}
	return w.rng.Uint32()&^15 | free[w.rng.IntN(len(free))]
}

// pingCost is how many ticks of budget one ping spends, and pingBurst how many a player may
// send back to back before they have to wait for it to refill.
const (
	pingCost  = TickRate
	pingBurst = 3
)

// Ping marks a spot for the whole team. Pings are cheap but metered, so one player holding
// Alt cannot fill everyone's map; past the burst they are dropped quietly.
func (w *World) Ping(p *Player, x, y float32, k PingKind) error {
	if k >= NumPingKinds {
		k = PingHere
	}
	if x < 0 || y < 0 || x > float32(w.W) || y > float32(w.H) {
		return errors.New("that is off the map")
	}
	free := max(p.pingFree, w.Tick)
	if free > w.Tick+(pingBurst-1)*pingCost {
		return nil
	}
	p.pingFree = free + pingCost
	w.Pings = append(w.Pings, Ping{Player: p.ID, X: x, Y: y, Kind: k})
	return nil
}
