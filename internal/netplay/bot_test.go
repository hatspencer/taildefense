package netplay

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"taildefense/internal/game"
)

func TestTooManyBotsAreRefused(t *testing.T) {
	for _, n := range []int{-1, MaxBots + 1} {
		if s, err := Listen(ServerConfig{Addrs: []string{"127.0.0.1:0"}, Bots: n}); err == nil {
			s.Close()
			t.Fatalf("%d bots accepted", n)
		}
	}
}

// A host with bots: they come in once someone joins, after them, and play.
func TestBotsJoinAfterTheFirstPersonAndPlay(t *testing.T) {
	s, err := Listen(ServerConfig{Addrs: []string{"127.0.0.1:0"}, Seed: 5, Version: "test", Host: "box", LocalLogin: "me", LocalName: "me", Bots: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if n := len(s.Info().Players); n != 0 {
		t.Fatalf("players before anyone joined: %v", s.Info().Players)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, wel, err := Dial(ctx, s.Addrs()[0], Hello{Name: "tester", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if wel.You != 0 {
		t.Errorf("the first person is player %d, want 0", wel.You)
	}
	r := NewReplica(wel.W, wel.H, wel.Terrain, wel.You, wel.Seed)
	type start struct {
		x, y float32
		gold uint64
	}
	var at map[uint8]start
	deadline := time.After(8 * time.Second)
	for {
		select {
		case m := <-c.Msgs():
			if m.Err != nil {
				t.Fatal(m.Err)
			}
			if m.Type != MsgFrame {
				continue
			}
			if err := r.Apply(m.Payload); err != nil {
				t.Fatal(err)
			}
			if !r.Synced || len(r.Players) < 3 {
				continue
			}
			if at == nil {
				at = map[uint8]start{}
				for _, p := range r.Players {
					if p.ID != r.You {
						at[p.ID] = start{p.X, p.Y, p.Gold}
					}
				}
			}
			acted := 0
			for _, p := range r.Players {
				if s0, ok := at[p.ID]; ok && (p.X != s0.x || p.Y != s0.y || p.Gold != s0.gold) {
					acted++
				}
			}
			if acted == 2 {
				in := s.Info()
				if !slices.Contains(in.Players, "bot-1") || !slices.Contains(in.Players, "bot-2") || !slices.Contains(in.Players, "tester") {
					t.Errorf("info players %v", in.Players)
				}
				return
			}
		case <-deadline:
			t.Fatalf("the bots did nothing: players %+v", r.Players)
		}
	}
}

// A bot in a game with people readies as soon as everyone else is, and never pings.
func TestALiveBotFollowsTheTeam(t *testing.T) {
	w := game.NewGame(9, game.DiffNormal)
	me, _ := w.Join("me", "me@x")
	pl, _ := w.Join("bot-1", "bot-1@bots")
	b := NewBot(pl.ID, 9)
	b.Live = true
	w.SetReady(me, true)
	act := func() {
		b.Act(w, func(c Cmd) {
			if c.Op == OpPing {
				t.Fatalf("tick %d: a live bot pinged", w.Tick)
			}
			_, _ = Exec(w, pl, c)
		})
		w.Step()
	}
	for i := 0; i < 2*game.TickRate/think; i++ { // two looks
		act()
	}
	if !pl.Ready {
		t.Fatal("the bot was not ready once the team was")
	}
	for i := 0; i < 5*60*game.TickRate && w.Phase != game.PhaseOver; i++ {
		act()
	}
}

// A weapon a teammate drops is picked up by a bot with a hand free for it.
func TestABotPicksUpADroppedWeapon(t *testing.T) {
	w := game.NewGame(9, game.DiffNormal)
	me, _ := w.Join("me", "me@x")
	pl, _ := w.Join("bot-1", "bot-1@bots")
	b := NewBot(pl.ID, 9)
	b.Live = true
	me.Weapons[game.WRifle] = game.WeaponState{Owned: true, Ammo: 4}
	if err := w.DropWeapon(me, game.WRifle); err != nil {
		t.Fatal(err)
	}
	if !w.CanTake(pl, game.WRifle) {
		t.Fatal("the bot already has a rifle")
	}
	for i := 0; i < 20*game.TickRate && len(w.Guns) > 0; i++ {
		b.Act(w, func(c Cmd) { _, _ = Exec(w, pl, c) })
		w.Step()
	}
	if len(w.Guns) > 0 || !pl.Weapons[game.WRifle].Owned {
		t.Fatalf("the rifle is still on the ground: %d there, bot order %d at %.1f,%.1f", len(w.Guns), pl.Order.Kind, pl.X, pl.Y)
	}
}

// Three bots and a teammate down: one revives, the others guard, and the teammate gets up.
func TestOneBotRevivesAndTheOthersGuard(t *testing.T) {
	w := game.NewGame(9, game.DiffNormal)
	me, _ := w.Join("me", "me@x")
	var bots []*Bot
	for i := range 3 {
		pl, _ := w.Join(fmt.Sprintf("bot-%d", i+1), fmt.Sprintf("bot-%d@bots", i+1))
		bots = append(bots, NewBot(pl.ID, 9))
	}
	w.Step()
	me.Alive, me.HP, me.Respawn = false, 0, 60
	revived := false
	for i := 0; i < 15*game.TickRate && !me.Alive; i++ {
		for _, b := range bots {
			pl := w.Players[b.ID]
			b.Act(w, func(c Cmd) { _, _ = Exec(w, pl, c) })
		}
		n := 0
		for _, b := range bots {
			if o := w.Players[b.ID].Order; o.Kind == game.OrderRevive && o.Mate == int(me.ID) {
				n++
			}
		}
		if n > 1 {
			t.Fatalf("tick %d: %d bots reviving at once", w.Tick, n)
		}
		revived = revived || n == 1
		w.Step()
	}
	if !revived || !me.Alive {
		t.Fatalf("revive ordered %v, up %v", revived, me.Alive)
	}
}
