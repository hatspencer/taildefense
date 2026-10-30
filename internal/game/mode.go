package game

import (
	"errors"
	"fmt"
	"strings"
)

// Mode is the kind of game, chosen by the host before it starts and kept for its length.
type Mode uint8

const (
	ModeStandard Mode = iota
	// ModeBlades has no guns at all: nothing sells, drops or hands over one. Every survivor
	// picks a blade to start with (StartBlades), and the rest is found.
	ModeBlades
	NumModes
)

// ModeNames are the modes as td config and --mode write them.
var ModeNames = [NumModes]string{"standard", "blades"}

func (m Mode) String() string {
	if m < NumModes {
		return ModeNames[m]
	}
	return fmt.Sprintf("mode %d", int(m))
}

// ParseMode reads a mode by name or number; "" is standard.
func ParseMode(s string) (Mode, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return ModeStandard, nil
	}
	for m := Mode(0); m < NumModes; m++ {
		if s == ModeNames[m] || s == fmt.Sprint(int(m)) {
			return m, nil
		}
	}
	return ModeStandard, fmt.Errorf("%q is not a mode (standard or blades)", s)
}

// StartBlades are what a survivor of a blades game picks from, in the order the page offers
// them. The crowbar is the plain one; the legendaries start at level 0 like any found one.
var StartBlades = []WeaponKind{WCrowbar, WKatana, WGreat}

// allows reports whether weapon k may be had in this game at all: in a blades game, only
// what swings.
func (w *World) allows(k WeaponKind) bool {
	return k < NumWeapons && (w.Mode != ModeBlades || Weapons[k].Fire == FireMelee)
}

// PickBlade is a survivor of a blades game choosing what to start with. They hold the
// crowbar until they do; a legendary picked takes its place, unless they have already put
// levels on the crowbar, in which case they keep both.
func (w *World) PickBlade(p *Player, k WeaponKind) error {
	switch {
	case w.Mode != ModeBlades:
		return errors.New("only a blades game starts with a choice of blade")
	case !p.Picking:
		return errors.New("you have already picked your blade")
	}
	ok := false
	for _, b := range StartBlades {
		ok = ok || b == k
	}
	if !ok {
		return errors.New("that is not one of the blades to start with")
	}
	p.Picking = false
	if k != WCrowbar {
		if p.Weapons[WCrowbar].Lv == ([NumTracks]uint8{}) {
			p.Weapons[WCrowbar] = WeaponState{}
		}
		if !p.Weapons[k].Owned {
			p.Weapons[k] = WeaponState{Owned: true, Ammo: Weapons[k].Mag}
		}
	}
	p.Cur = k
	w.note(0, "%s takes up the %s", p.Name, strings.ToLower(Weapons[k].Name))
	return nil
}
