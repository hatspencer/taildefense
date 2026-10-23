package game

import (
	"errors"
	"fmt"
	"math"
)

// Handing weapons over: a survivor drops a weapon they carry, upgrades and all, and it lies
// where they stood until someone walks up to it and picks it up. It is how a team shares out
// what the armory and the loot gave them: the rifle with five levels of damage goes to the one
// who hangs back, the shotgun to the one at the gate.

const (
	gunMax      = 32  // weapons on the ground at once; past it nobody can drop another
	gunReach    = 1.2 // tiles from a weapon on the ground to pick it up
	gunPickup   = .2  // seconds picking one up takes
	gunDropAway = .9  // tiles ahead of a survivor a weapon lands when they drop it
)

// GunPickupTime is how long picking up a weapon takes, for the client.
func GunPickupTime() float32 { return gunPickup }

// Gun is a weapon on the ground, with whatever upgrades it had in the hands that dropped it.
type Gun struct {
	ID   uint16 // names it in a pickup order; never reused within a game
	Kind WeaponKind
	Lv   [NumTracks]uint8
	Ammo int16 // rounds left in the magazine
	X, Y float32
	By   uint8 // who dropped it
}

// gunIndex finds a weapon on the ground by id, or -1.
func (w *World) gunIndex(id uint16) int {
	for i := range w.Guns {
		if w.Guns[i].ID == id {
			return i
		}
	}
	return -1
}

// DropWeapon puts weapon k of p's on the ground in front of them, upgrades and all, for
// anyone to pick up. A survivor keeps at least one weapon.
func (w *World) DropWeapon(p *Player, k WeaponKind) error {
	switch {
	case w.Phase == PhaseOver:
		return errOver
	case !p.Alive:
		return errors.New("you are down")
	case k >= NumWeapons || !p.Weapons[k].Owned:
		return errors.New("you do not carry that weapon")
	case len(w.Guns) >= gunMax:
		return errors.New("too many weapons lying about already; pick some up first")
	}
	ws := p.Weapons[k]
	dual := k == WPistol && ws.Dual
	other := NumWeapons
	if dual {
		other = k
	}
	for o := WeaponKind(0); o < NumWeapons && !dual; o++ {
		if o != k && p.Weapons[o].Owned && (other == NumWeapons || Weapons[o].Price > Weapons[other].Price) {
			other = o
		}
	}
	if other == NumWeapons {
		return fmt.Errorf("the %s is the only weapon you have", Weapons[k].Name)
	}
	x, y := p.X, p.Y
	sin, cos := math.Sincos(float64(p.Aim))
	if ax, ay := p.X+float32(cos)*gunDropAway, p.Y+float32(sin)*gunDropAway; CanStand(w, ax, ay) {
		x, y = ax, ay
	}
	w.gunSerial++
	if dual {
		// One of the pair: the half of the rounds in it go with it, the other stays in hand.
		half := max(ws.Ammo, 0) / 2
		w.Guns = append(w.Guns, Gun{ID: w.gunSerial, Kind: k, Lv: ws.Lv, Ammo: half, X: x, Y: y, By: p.ID})
		p.Weapons[k].Dual = false
		p.Weapons[k].Ammo = max(ws.Ammo, 0) - half
		w.note(0, "%s dropped one of their pistols%s", p.Name, levelsNote(ws.Lv))
		return nil
	}
	w.Guns = append(w.Guns, Gun{ID: w.gunSerial, Kind: k, Lv: ws.Lv, Ammo: max(ws.Ammo, 0), X: x, Y: y, By: p.ID})
	p.Weapons[k] = WeaponState{}
	if p.Cur == k {
		p.Cur = other
	}
	w.note(0, "%s dropped %s%s", p.Name, article(Weapons[k].Name), levelsNote(ws.Lv))
	return nil
}

// levelsNote says what upgrades a weapon carries, " (damage 3, rate 1)", or nothing.
func levelsNote(lv [NumTracks]uint8) string {
	s := ""
	for t, l := range lv {
		if l == 0 {
			continue
		}
		if s != "" {
			s += ", "
		}
		s += fmt.Sprintf("%s %d", TrackNames[t], l)
	}
	if s == "" {
		return ""
	}
	return " (" + s + ")"
}

// OrderPickup sends the player to pick up a weapon on the ground.
func (w *World) OrderPickup(p *Player, id uint16) error {
	gi := w.gunIndex(id)
	switch {
	case w.Phase == PhaseOver:
		return errOver
	case gi < 0:
		return errors.New("that weapon is gone")
	case !w.canTake(p, w.Guns[gi].Kind):
		return fmt.Errorf("you already carry a %s", Weapons[w.Guns[gi].Kind].Name)
	}
	g := &w.Guns[gi]
	w.order(p, Order{Kind: OrderPickup, Gun: id, X: g.X, Y: g.Y})
	return nil
}

// actPickup carries out a pickup order for one tick; false when the order is over.
func (w *World) actPickup(p *Player, o *Order, walk func() bool) bool {
	gi := w.gunIndex(o.Gun)
	if gi < 0 {
		w.toast(p, 2, "someone picked that weapon up first")
		return false
	}
	g := &w.Guns[gi]
	if !w.canTake(p, g.Kind) {
		w.toast(p, 2, "you already carry a %s", Weapons[g.Kind].Name)
		return false
	}
	if dx, dy := g.X-p.X, g.Y-p.Y; dx*dx+dy*dy <= gunReach*gunReach {
		// Like a search, only quicker: a hit starts it over.
		if p.Hurt > 0 {
			p.Search = 0
			return true
		}
		if p.Search += Dt; p.Search >= gunPickup {
			p.Search = 0
			w.pickUp(p, gi)
			return false
		}
		return true
	}
	if !walk() {
		w.toast(p, 2, "cannot get there to pick it up")
		return false
	}
	return true
}

// canTake reports whether p has a hand free for a weapon of kind k: one they do not carry,
// or a pistol to pair with theirs.
func (w *World) canTake(p *Player, k WeaponKind) bool {
	ws := &p.Weapons[k]
	return !ws.Owned || k == WPistol && !ws.Dual
}

// pickUp hands weapon gi on the ground to p, upgrades and all, and puts it in their hands. A
// pistol to one who carries one goes in the other hand, the pair as upgraded as theirs.
func (w *World) pickUp(p *Player, gi int) {
	g := w.Guns[gi]
	w.Guns = append(w.Guns[:gi], w.Guns[gi+1:]...)
	if p.Weapons[g.Kind].Owned {
		w.dualPistols(p)
		w.note(0, "%s picked up a second pistol: dual pistols", p.Name)
		return
	}
	ws := WeaponState{Owned: true, Lv: g.Lv, Ammo: g.Ammo}
	if ws.Ammo <= 0 {
		ws.Reload = WeaponStats(g.Kind, g.Lv).Reload
	}
	p.Weapons[g.Kind] = ws
	p.Cur = g.Kind
	whose := "their"
	if g.By != p.ID && int(g.By) < len(w.Players) {
		whose = w.Players[g.By].Name + "'s"
	}
	w.note(0, "%s picked up %s %s%s", p.Name, whose, Weapons[g.Kind].Name, levelsNote(g.Lv))
}
