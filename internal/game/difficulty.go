package game

import (
	"errors"
	"fmt"
	"strings"
)

// Difficulty is how hard a game is, chosen by the host before it starts; the host can
// change it as it goes (SetDifficulty).
type Difficulty uint8

const (
	DiffEasy Difficulty = iota
	DiffNormal
	DiffHard
	DiffBrutal
	NumDifficulties
)

// DefaultDifficulty is what a game is hosted at when nobody says otherwise.
const DefaultDifficulty = DiffNormal

// DifficultyDef is what a difficulty changes.
type DifficultyDef struct {
	Name   string
	HP     float32 // creep health
	Count  float32 // wave size
	Gold   float32 // bounties, wave bonuses and gold finds
	Start  int32   // gold a survivor starts with
	First  float32 // seconds before the first wave
	Build  float32 // seconds between waves
	Rest   float32 // the long break after every fifth wave, to go out exploring and looting
	Revive float32 // seconds a downed survivor can be revived before respawning at the base
	Guard  float32 // loot guards: how many, and how tough
	Melee  bool    // survivors start with a crowbar instead of the pistol
	Dark   float32 // how far a survivor sees out in the wastes at night, 0 for no night
	Cone   float32 // brutal: how far the flashlight reaches along the aim; the night shows only what is lit now
	Unsaid bool    // the wave's notice doesn't say which sides it comes from
	Pad    float32 // tiles from the generator to the helipad, give or take padSpread; past BuildRadius, out in the night, it has to be found
}

// Difficulties is indexed by Difficulty.
var Difficulties = [NumDifficulties]DifficultyDef{
	DiffEasy:   {Name: "Easy", HP: .75, Count: .75, Gold: 1.25, Start: 150, First: 40, Build: 20, Rest: 75, Revive: 28, Guard: .7, Pad: 22},
	DiffNormal: {Name: "Normal", HP: 1, Count: 1, Gold: 1, Start: 150, First: 20, Build: 15, Rest: 60, Revive: 20, Guard: 1, Pad: 28},
	DiffHard:   {Name: "Hard", HP: 1.3, Count: 1.25, Gold: .9, Start: 150, First: 25, Build: 18, Rest: 60, Revive: 16, Guard: 1.3, Dark: 7, Unsaid: true, Pad: 48},
	DiffBrutal: {Name: "Brutal", HP: 1.7, Count: 1.5, Gold: .8, Start: 0, First: 30, Build: 20, Rest: 60, Revive: 12, Guard: 1.7, Melee: true, Dark: 3, Cone: 11, Unsaid: true, Pad: 58},
}

// String is the difficulty's name.
func (d Difficulty) String() string {
	if d >= NumDifficulties {
		return "?"
	}
	return Difficulties[d].Name
}

// ParseDifficulty reads a difficulty by name, any case, or by number 0..3; "" is the default.
func ParseDifficulty(s string) (Difficulty, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return DefaultDifficulty, nil
	}
	for d := Difficulty(0); d < NumDifficulties; d++ {
		if s == strings.ToLower(Difficulties[d].Name) || s == fmt.Sprint(int(d)) {
			return d, nil
		}
	}
	return DefaultDifficulty, fmt.Errorf("%q is not a difficulty (easy, normal, hard or brutal)", s)
}

func (w *World) diff() *DifficultyDef { return &Difficulties[w.Diff] }

// SetDifficulty changes the difficulty mid-game. What it scales is read as it is needed, so
// the change shows from here on: the next creeps' health, the next wave's size, gold, the
// breaks, guards spawned from now. Creeps already about keep their health, and a survivor's
// starting weapon was dealt when they joined. Night comes and goes with it: a survivor sees
// the dark in from what is in sight now.
func (w *World) SetDifficulty(by *Player, d Difficulty) error {
	if d >= NumDifficulties {
		return errors.New("no such difficulty")
	}
	if d == w.Diff {
		return nil
	}
	w.Diff = d
	if w.diff().Dark <= 0 {
		w.Seen, w.lit = nil, nil
	}
	w.Notes = append(w.Notes, Note{Text: fmt.Sprintf("%s set the difficulty to %s", by.Name, w.diff().Name)})
	return nil
}
