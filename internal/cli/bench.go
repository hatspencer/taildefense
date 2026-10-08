package cli

import (
	"fmt"
	"io"
	"time"

	"taildefense/internal/game"
	"taildefense/internal/ui"
	"taildefense/internal/web"
)

// BenchOptions shape `td bench`.
type BenchOptions struct {
	Wave    int    // the wave to time, 0 is 12
	Players int    // 0 is 4
	Seconds int    // of that wave, 0 is 40
	Seed    uint64 // 0 is 42
}

// Bench plays a busy wave with nobody at the keys and times every stage a tick goes through:
// the host's step and delta encode, the relay's decode, and the frame for the browser.
func Bench(w io.Writer, o BenchOptions) int {
	if o.Wave <= 0 {
		o.Wave = 12
	}
	if o.Players <= 0 {
		o.Players = 4
	}
	if o.Seconds <= 0 {
		o.Seconds = 40
	}
	if o.Seed == 0 {
		o.Seed = 42
	}
	st := web.BenchWave(o.Wave, o.Players, o.Seconds, o.Seed)
	p := ui.New(w)
	p.Info("wave %d · %d players · %ds · %d ticks · peak %d creeps", o.Wave, o.Players, o.Seconds, st.Ticks, st.Peak)
	p.Fields([][2]string{
		{"sim", per(st.Sim, st.Ticks) + "/tick"},
		{"host encode", per(st.Encode, st.Ticks) + "/tick"},
		{"relay decode", per(st.Decode, st.Ticks) + "/tick"},
		{"browser frame", per(st.View, st.Ticks) + "/tick"},
		{"tailnet", fmt.Sprintf("%.1f KiB/s deflated, keyframe %d bytes", float64(st.Wire)/float64(st.Ticks)*game.TickRate/1024, st.Key)},
		{"localhost", fmt.Sprintf("%.1f KiB/s to the browser", float64(st.ViewBytes)/float64(st.Ticks)*game.TickRate/1024)},
	})
	budget := time.Second / game.TickRate
	if worst := st.Sim + st.Encode; worst/time.Duration(st.Ticks) > budget/2 {
		p.Warn("the host spends over half its tick budget (%s)", budget)
	}
	return 0
}

func per(d time.Duration, n int) string {
	return (d / time.Duration(max(n, 1))).Round(time.Microsecond).String()
}
