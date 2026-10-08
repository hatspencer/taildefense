package game

import (
	"fmt"
	"strings"
)

// Difficulty is how hard a game is, chosen by the host before it starts and fixed for it.
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
	First  float32 // seconds before the first wave
	Build  float32 // seconds between waves
	Revive float32 // seconds a downed survivor can be revived before respawning at the base
	Guard  float32 // loot guards: how many, and how tough
}

// Difficulties is indexed by Difficulty.
var Difficulties = [NumDifficulties]DifficultyDef{
	DiffEasy:   {Name: "Easy", HP: .75, Count: .75, Gold: 1.25, First: 60, Build: 40, Revive: 14, Guard: .7},
	DiffNormal: {Name: "Normal", HP: 1, Count: 1, Gold: 1, First: 45, Build: 30, Revive: 10, Guard: 1},
	DiffHard:   {Name: "Hard", HP: 1.3, Count: 1.25, Gold: .9, First: 40, Build: 25, Revive: 8, Guard: 1.3},
	DiffBrutal: {Name: "Brutal", HP: 1.7, Count: 1.5, Gold: .8, First: 30, Build: 20, Revive: 6, Guard: 1.7},
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
