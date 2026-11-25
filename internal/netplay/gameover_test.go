package netplay

import (
	"testing"
	"time"

	"taildefense/internal/game"
)

// TestGameOverIsToldOncePerGame drives a server's ticks by hand: the hook hears of a game's end
// once however many ticks it stays over, and again for the game after a restart.
func TestGameOverIsToldOncePerGame(t *testing.T) {
	var ends []GameEnd
	s := &Server{
		cfg: ServerConfig{Seed: 3, Version: "test", Host: "box",
			Log:      func(string, ...any) {},
			GameOver: func(e GameEnd) { ends = append(ends, e) }},
		world:   game.NewGame(3, game.DiffNormal),
		byTok:   map[uint64]*peer{},
		tickGap: Window{Span: 10 * time.Second},
		started: time.Now(),
	}
	s.publishInfo()
	ticks := func(n int) {
		for range n {
			s.tick()
		}
	}
	ticks(5)
	if len(ends) != 0 {
		t.Fatalf("a running game was told over: %+v", ends)
	}
	fall := func() {
		w := s.world
		w.Structs[w.Core].HP = 0
		for i := 0; i < 10*game.TickRate && w.Phase != game.PhaseOver; i++ {
			s.tick()
		}
		if w.Phase != game.PhaseOver {
			t.Fatal("the generator at 0 hp did not end the game")
		}
		ticks(30)
	}
	fall()
	if len(ends) != 1 {
		t.Fatalf("one game over was told %d times", len(ends))
	}
	if e := ends[0]; e.Evac || e.Aboard != 0 || e.Wave != s.world.Best {
		t.Errorf("the generator falling reads as %+v", e)
	}
	s.restart(true)
	ticks(5)
	if len(ends) != 1 {
		t.Fatalf("a restarted game was told over before it ended: %d", len(ends))
	}
	fall()
	if len(ends) != 2 {
		t.Fatalf("two games over were told %d times", len(ends))
	}
}
