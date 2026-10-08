package web

import (
	"compress/flate"
	"time"

	"taildefense/internal/game"
	"taildefense/internal/netplay"
)

// BenchStats is what `td bench` measured, summed over every tick.
type BenchStats struct {
	Ticks, Peak          int
	Sim, Encode, Decode  time.Duration
	View                 time.Duration
	Wire, ViewBytes, Key int
}

type counter int

func (c *counter) Write(p []byte) (int, error) { *c += counter(len(p)); return len(p), nil }

// BenchWave plays seconds of a wave through the whole pipeline: the host's world and
// encoder, a deflate stream as the tailnet carries it, a replica as the relay keeps it, and
// the browser's frame.
func BenchWave(wave, players, seconds int, seed uint64) BenchStats {
	w := game.New(seed)
	for i := 0; i < players; i++ {
		_, _ = w.Join("p", string(rune('a'+i)))
	}
	w.Wave = wave - 1
	w.PhaseLeft = game.Dt
	var enc netplay.Encoder
	var wire counter
	zw, _ := flate.NewWriter(&wire, flate.BestSpeed)
	r := netplay.NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
	var view viewEncoder
	var st BenchStats

	w.Step()
	key := enc.Key(w, w.AtArmory)
	st.Key = len(key)
	_ = r.Apply(append([]byte(nil), key...))
	for i := 0; i < seconds*game.TickRate; i++ {
		t0 := time.Now()
		w.Step()
		t1 := time.Now()
		d := enc.Delta(w, w.AtArmory)
		t2 := time.Now()
		_ = r.Apply(d)
		t3 := time.Now()
		st.ViewBytes += len(view.frame(r))
		t4 := time.Now()
		_, _ = zw.Write(d)
		_ = zw.Flush()
		st.Sim += t1.Sub(t0)
		st.Encode += t2.Sub(t1)
		st.Decode += t3.Sub(t2)
		st.View += t4.Sub(t3)
		st.Peak = max(st.Peak, len(w.Creeps))
		st.Ticks++
		if w.Phase != game.PhaseWave && i > game.TickRate {
			break
		}
	}
	st.Wire = int(wire)
	return st
}
