package game

import "testing"

// On hard and brutal, every survivor down at once ends the game as if the generator fell; on
// easy and normal they wait out the revive, and a survivor who has left doesn't hold it up.
func TestTeamDownEndsHardGames(t *testing.T) {
	for d := Difficulty(0); d < NumDifficulties; d++ {
		w := NewGame(3, d)
		a, _ := w.Join("ann", "ann@example")
		b, _ := w.Join("bo", "bo@example")
		c, _ := w.Join("cy", "cy@example")
		w.Leave(c)
		w.Step()
		w.hurtPlayer(a, 1e6)
		w.Step()
		if w.Phase == PhaseOver {
			t.Fatalf("%s: over with %s still standing", w.diff().Name, b.Name)
		}
		w.hurtPlayer(b, 1e6)
		w.Step()
		over := w.Phase == PhaseOver
		if over != Difficulties[d].Wipe {
			t.Fatalf("%s: everyone down, game over %v", w.diff().Name, over)
		}
		if over && w.Structs[w.Core].HP > 0 {
			t.Fatalf("%s: over with the generator standing", w.diff().Name)
		}
		if err := w.Check(); err != nil {
			t.Fatalf("%s: %v", w.diff().Name, err)
		}
	}
	if !Difficulties[DiffHard].Wipe || !Difficulties[DiffBrutal].Wipe || Difficulties[DiffNormal].Wipe || Difficulties[DiffEasy].Wipe {
		t.Fatal("a team wipe should end hard and brutal games, and only those")
	}
}
