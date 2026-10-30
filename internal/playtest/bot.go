package playtest

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"taildefense/internal/game"
	"taildefense/internal/netplay"
)

// Bot is the host's bot (netplay.Bot), which the playtests play whole games with.
type Bot = netplay.Bot

// NewBot is a bot for player id.
func NewBot(id uint8, seed uint64) *Bot { return netplay.NewBot(id, seed) }

func d2(ax, ay, bx, by float32) float32 { return (ax-bx)*(ax-bx) + (ay-by)*(ay-by) }

// Result is what a played game came to.
type Result struct {
	Waves  int // waves fully survived
	Ticks  int
	Kills  uint32
	Over   bool // the game ended: the generator fell, or the evac Huey left
	Out    int  // survivors who got out on the evac Huey
	Hashes []uint64
}

// Play runs a game of bots for up to maxWave waves or limit ticks, checking every tick. It
// stops at the first broken check, and fails a wave that will not end within stuck seconds.
func Play(s *Session, bots []*Bot, maxWave, limit int) (Result, error) {
	const stuck = 6 * 60
	var res Result
	waveStart := 0
	for i := 0; i < limit; i++ {
		for _, b := range bots {
			b.Act(s.W, func(c netplay.Cmd) { _ = s.Do(b.ID, c) })
		}
		wasWave := s.W.Phase == game.PhaseWave
		if err := s.Step(); err != nil {
			return res, err
		}
		res.Ticks++
		res.Hashes = append(res.Hashes, s.W.Hash())
		w := s.W
		if w.Phase == game.PhaseWave && !wasWave {
			waveStart = i
		}
		if w.Phase == game.PhaseWave && i-waveStart > stuck*game.TickRate {
			return res, stuckAt(w)
		}
		if wasWave && (w.Phase == game.PhaseBuild || w.Phase == game.PhaseEvac) {
			res.Waves = w.Wave
		}
		if w.Phase == game.PhaseOver {
			res.Over = true
			for _, p := range w.Players {
				if p.Aboard {
					res.Out++
				}
			}
			break
		}
		if res.Waves >= maxWave {
			break
		}
	}
	res.Kills = s.W.TotalKills
	return res, nil
}

// StuckError is a wave that would not end, with what is left of it.
type StuckError struct {
	Wave, Queued int
	Left         []string // the wave's creeps still alive, a line per kind and what it is doing
}

func stuckAt(w *game.World) *StuckError {
	e := &StuckError{Wave: w.Wave, Queued: len(w.Queue) - w.QueueHead}
	type key struct {
		kind              game.CreepKind
		hunt, siege, slow bool
		far               int
	}
	n := map[key]int{}
	for i := range w.Creeps {
		c := &w.Creeps[i]
		if c.Home != 0 || c.Wander {
			continue
		}
		d := math.Sqrt(float64(d2(c.X, c.Y, w.CoreX, w.CoreY)))
		n[key{c.Kind, c.Hunt >= 0, c.Siege >= 0, c.Slow > 0, int(d/10) * 10}]++
	}
	for k, v := range n {
		e.Left = append(e.Left, fmt.Sprintf("%4d %s %d+ tiles from the generator, hunting %v, sieging %v", v, game.Creeps[k.kind].Name, k.far, k.hunt, k.siege))
	}
	sort.Strings(e.Left)
	return e
}

func (e *StuckError) Error() string {
	return fmt.Sprintf("wave %d did not end in 6 minutes, %d still to come, left:\n%s", e.Wave, e.Queued, strings.Join(e.Left, "\n"))
}
