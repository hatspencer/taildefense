package playtest

import (
	"encoding/binary"
	"math/rand/v2"
	"testing"

	"taildefense/internal/game"
	"taildefense/internal/netplay"
)

// numOps is one past the last op a client can send.
const numOps = netplay.OpPickup + 1

// commandSize is how many fuzz bytes make one command: player, op, A, B, X, Y, T, and how many
// ticks to play after it.
const commandSize = 11

// command reads one command from fuzz bytes. Positions run over the whole wire range, far
// off the map included; A, B and T take any value, as a broken or hostile client could send.
func command(b []byte) (pl uint8, c netplay.Cmd, ticks int) {
	pl = b[0]
	c = netplay.Cmd{Op: 1 + b[1]%numOps, A: b[2], B: b[3],
		X: float32(binary.LittleEndian.Uint16(b[4:])) / 8, Y: float32(binary.LittleEndian.Uint16(b[6:])) / 8,
		T: binary.LittleEndian.Uint16(b[8:])}
	if c.Op == netplay.OpChat {
		c.Text = "hi"
	}
	return pl, c, int(b[10] % 8)
}

// maxCommands bounds one fuzz input.
const maxCommands = 64

// mess plays a wave on a world while players give the commands in data between its ticks,
// and fails on the first panic or broken invariant.
func mess(t *testing.T, seed uint64, data []byte) {
	s := New(seed, game.DiffNormal, 3)
	w := s.W
	// The third survivor is down, to be revived; the wave is under way, with creeps about.
	w.Players[2].Alive, w.Players[2].HP = false, 0
	w.PhaseLeft = game.Dt
	for i := 0; i < 3*game.TickRate; i++ {
		if err := s.Step(); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range w.Players {
		p.Gold = 50000
	}
	for len(data) >= commandSize {
		pl, c, ticks := command(data)
		data = data[commandSize:]
		_ = s.Do(pl%uint8(len(w.Players)), c)
		if err := w.Check(); err != nil {
			t.Fatalf("after %+v between ticks: %v", c, err)
		}
		for i := 0; i < ticks; i++ {
			if err := s.Step(); err != nil {
				t.Fatalf("after %+v: %v", c, err)
			}
		}
	}
	for i := 0; i < game.TickRate; i++ {
		if err := s.Step(); err != nil {
			t.Fatal(err)
		}
	}
}

// Any commands, in any order, any number between two ticks, leave the world sound. Run the
// fuzzer with ./build.sh go test ./internal/playtest -run '^$' -fuzz FuzzCommands -fuzztime 2m.
func FuzzCommands(f *testing.F) {
	r := rand.New(rand.NewPCG(1, 2))
	for n := 0; n < 8; n++ {
		b := make([]byte, commandSize*40)
		for i := range b {
			b[i] = byte(r.Uint32())
		}
		f.Add(uint64(n), b)
	}
	f.Fuzz(func(t *testing.T, seed uint64, data []byte) {
		// A long input is many short ones played end to end; the fuzzer learns faster from these.
		if len(data) > maxCommands*commandSize {
			data = data[:maxCommands*commandSize]
		}
		mess(t, seed%64, data)
	})
}

// Thousands of random commands, aimed at the things in the world rather than anywhere, so
// they mostly land: attacks on creeps that exist, sales of structures that stand, builds and
// casts next to the survivor.
func TestRandomCommandsBreakNothing(t *testing.T) {
	n := 4
	if testing.Short() {
		n = 1
	}
	for seed := uint64(1); seed <= uint64(n); seed++ {
		r := rand.New(rand.NewPCG(seed, 3))
		s := New(seed, game.Difficulty(seed%uint64(game.NumDifficulties)), 3)
		w := s.W
		w.PhaseLeft = game.Dt
		for _, p := range w.Players {
			p.Gold = 1 << 20
		}
		for i := 0; i < 2000; i++ {
			pl := uint8(r.IntN(len(w.Players)))
			p := w.Players[pl]
			c := netplay.Cmd{Op: 1 + uint8(r.IntN(int(numOps))), A: uint8(r.IntN(10)), B: uint8(r.IntN(5)),
				X: p.X + (r.Float32()*2-1)*12, Y: p.Y + (r.Float32()*2-1)*12}
			switch r.IntN(3) {
			case 0:
				if len(w.Creeps) > 0 {
					c.T = w.Creeps[r.IntN(len(w.Creeps))].ID
				}
			case 1:
				c.T = uint16(r.IntN(len(w.Structs)))
			case 2:
				c.T = uint16(r.IntN(len(w.Sites)))
			}
			if c.Op == netplay.OpPause && r.IntN(4) > 0 {
				continue // a game paused most of the time plays nothing
			}
			_ = s.Do(pl, c)
			if err := w.Check(); err != nil {
				t.Fatalf("seed %d: after %+v between ticks: %v", seed, c, err)
			}
			for k := r.IntN(4); k > 0; k-- {
				if err := s.Step(); err != nil {
					t.Fatalf("seed %d: after %+v: %v", seed, c, err)
				}
			}
		}
	}
}
