// Package playtest plays whole games of taildefense with nobody at the keys: bots give the
// commands a client would, through the host's own command path, and after every tick the
// world's invariants are checked and a replica is rebuilt from the wire to see it agrees.
// Every command is logged with its tick, so a game replays exactly from its seed and log.
package playtest

import (
	"fmt"
	"math"

	"taildefense/internal/game"
	"taildefense/internal/netplay"
)

// Entry is one command as it was given: before the tick after Tick.
type Entry struct {
	Tick   uint32
	Player uint8
	Cmd    netplay.Cmd
}

// Session is a game being played. W is the host's world.
type Session struct {
	W   *game.World
	Log []Entry
	// Hold keeps the generator standing and the bots in money: it is mended before every
	// tick, and every break each survivor has gold to arm and build as the wave asks, so a
	// game of bots that play worse than people still reaches the late waves and their bosses.
	Hold bool

	enc     netplay.Encoder
	replica *netplay.Replica
}

// New starts a game on a seed and difficulty with players survivors joined.
func New(seed uint64, diff game.Difficulty, players int) *Session {
	w := game.NewGame(seed, diff)
	for i := 0; i < players; i++ {
		name := string(rune('a' + i))
		if _, err := w.Join(name, name+"@playtest"); err != nil {
			panic(err)
		}
	}
	s := &Session{W: w}
	s.replica = netplay.NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
	if err := s.replica.Apply(s.enc.Key(w, w.AtArmory)); err != nil {
		panic(err)
	}
	return s
}

// Do gives a command as player pl, logged for the replay. A refusal is not a failure: bots
// ask for things they cannot have, as players do.
func (s *Session) Do(pl uint8, c netplay.Cmd) error {
	s.Log = append(s.Log, Entry{s.W.Tick, pl, c})
	p := s.W.Players[pl]
	s.W.Touch(p)
	_, err := netplay.Exec(s.W, p, c)
	return err
}

// Step plays one tick, then checks the world and the replica the wire builds of it.
func (s *Session) Step() error {
	if s.Hold {
		c := &s.W.Structs[s.W.Core]
		c.HP = c.MaxHP
		if s.W.Phase == game.PhaseBuild {
			for _, p := range s.W.Players {
				p.Gold = max(p.Gold, int32(600*(s.W.Wave+1)))
			}
		}
	}
	s.W.Step()
	if err := s.W.Check(); err != nil {
		return fmt.Errorf("tick %d, wave %d: %w", s.W.Tick, s.W.Wave, err)
	}
	if err := s.replica.Apply(s.enc.Delta(s.W, s.W.AtArmory)); err != nil {
		return fmt.Errorf("tick %d: replica: %w", s.W.Tick, err)
	}
	if err := agree(s.W, s.replica); err != nil {
		return fmt.Errorf("tick %d, wave %d: replica: %w", s.W.Tick, s.W.Wave, err)
	}
	return nil
}

// agree reports where a replica differs from the world beyond the wire's rounding.
func agree(w *game.World, r *netplay.Replica) error {
	if r.Tick != w.Tick || r.Phase != w.Phase || r.Wave != w.Wave {
		return fmt.Errorf("tick %d phase %s wave %d, world tick %d phase %s wave %d", r.Tick, r.Phase, r.Wave, w.Tick, w.Phase, w.Wave)
	}
	if r.Count != len(w.Creeps) {
		return fmt.Errorf("%d creeps, world %d", r.Count, len(w.Creeps))
	}
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if game.CreepKind(r.Kind[c.ID]) != c.Kind {
			return fmt.Errorf("creep %d kind %d, world %d", c.ID, r.Kind[c.ID], c.Kind)
		}
		if far(r.CX[c.ID], c.X) || far(r.CY[c.ID], c.Y) {
			return fmt.Errorf("creep %d at %.2f,%.2f, world %.2f,%.2f", c.ID, r.CX[c.ID], r.CY[c.ID], c.X, c.Y)
		}
	}
	for i := range w.Structs {
		s, v := &w.Structs[i], r.Structs[i]
		if v.Alive != s.Alive || (s.Alive && (v.Kind != s.Kind || v.Level != s.Level || v.Lv != s.Lv || int(v.HP) != int(math.Ceil(float64(max(s.HP, 0)))))) {
			return fmt.Errorf("structure %d %+v, world %+v", i, v, *s)
		}
	}
	if len(r.Players) != len(w.Players) {
		return fmt.Errorf("%d players, world %d", len(r.Players), len(w.Players))
	}
	for i, p := range w.Players {
		v := &r.Players[i]
		if v.Alive != p.Alive || v.Gold != uint64(p.Gold) || v.Kills != uint64(p.Kills) || far(v.X, p.X) || far(v.Y, p.Y) {
			return fmt.Errorf("player %s alive %v gold %d kills %d at %.2f,%.2f, world %v %d %d %.2f,%.2f",
				p.Name, v.Alive, v.Gold, v.Kills, v.X, v.Y, p.Alive, p.Gold, p.Kills, p.X, p.Y)
		}
	}
	for i, st := range w.Sites {
		if r.Searched[i] != st.Searched || r.Guards[i] != st.Guards {
			return fmt.Errorf("site %d searched %v guards %d, world %v %d", i, r.Searched[i], r.Guards[i], st.Searched, st.Guards)
		}
	}
	return nil
}

func far(a, b float32) bool { return math.Abs(float64(a-b)) > .1 }

// Replay plays a logged game again from its seed, checking as it goes, and returns the
// world's hash after every tick.
func Replay(seed uint64, diff game.Difficulty, players int, hold bool, log []Entry, ticks int) ([]uint64, error) {
	s := New(seed, diff, players)
	s.Hold = hold
	hashes := make([]uint64, 0, ticks)
	for i := 0; i < ticks; i++ {
		for len(log) > 0 && log[0].Tick == s.W.Tick {
			_ = s.Do(log[0].Player, log[0].Cmd)
			log = log[1:]
		}
		if err := s.Step(); err != nil {
			return hashes, err
		}
		hashes = append(hashes, s.W.Hash())
	}
	return hashes, nil
}
