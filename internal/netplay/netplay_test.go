package netplay

import (
	"compress/flate"
	"context"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"taildefense/internal/game"
)

func newWorldWithCreeps(n int) *game.World {
	w := game.New(21)
	w.Join("ana", "ana@example")
	w.Phase = game.PhaseWave
	w.Wave = 8
	w.Queue = []game.Spawn{{At: 1e9}}
	for i := 0; i < n; i++ {
		sp := w.SpawnPts[i%len(w.SpawnPts)]
		w.SpawnCreep(game.CreepKind(i%4), sp[0]+float32(i%5)-2, sp[1]+float32(i%3)-1)
	}
	return w
}

func checkReplica(t *testing.T, w *game.World, r *Replica) {
	t.Helper()
	if r.Count != len(w.Creeps) {
		t.Fatalf("tick %d: replica has %d creeps, world %d", w.Tick, r.Count, len(w.Creeps))
	}
	for _, c := range w.Creeps {
		if !r.Alive.has(c.ID) {
			t.Fatalf("creep %d missing", c.ID)
		}
		if dx, dy := math.Abs(float64(r.CX[c.ID]-c.X)), math.Abs(float64(r.CY[c.ID]-c.Y)); dx > .1 || dy > .1 {
			t.Fatalf("creep %d at %.2f,%.2f, world %.2f,%.2f", c.ID, r.CX[c.ID], r.CY[c.ID], c.X, c.Y)
		}
		if game.CreepKind(r.Kind[c.ID]) != c.Kind {
			t.Fatalf("creep %d kind %d, world %d", c.ID, r.Kind[c.ID], c.Kind)
		}
	}
	for i, s := range w.Structs {
		v := r.Structs[i]
		if v.Alive != s.Alive || (s.Alive && (v.Kind != s.Kind || int(v.HP) != int(math.Ceil(float64(s.HP))))) {
			t.Fatalf("structure %d: replica %+v, world %+v", i, v, s)
		}
	}
}

// Deltas applied to a keyframe reproduce the world, through spawns, deaths and destroyed
// walls, and a second client that joins late with a keyframe agrees with the first.
func TestDeltasTrackTheWorld(t *testing.T) {
	w := newWorldWithCreeps(600)
	var e Encoder
	r := NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
	if err := r.Apply(e.Key(w, nil)); err != nil {
		t.Fatal(err)
	}
	var late *Replica
	for tick := 0; tick < 400; tick++ {
		w.Step()
		if tick%40 == 0 {
			for i := 0; i < 30; i++ {
				w.SpawnCreep(game.CSwarmer, w.SpawnPts[0][0], w.SpawnPts[0][1])
			}
		}
		if tick == 200 {
			w.Structs[5].HP = 0 // a wall falls
		}
		if tick%50 == 0 {
			w.Sites[tick/50].Searched = true
		}
		d := e.Delta(w, nil)
		if err := r.Apply(d); err != nil {
			t.Fatal(err)
		}
		if tick == 150 {
			late = NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
			if err := late.Apply(e.Key(w, nil)); err != nil {
				t.Fatal(err)
			}
		} else if late != nil {
			if err := late.Apply(d); err != nil {
				t.Fatal(err)
			}
		}
		checkReplica(t, w, r)
		for i, s := range w.Sites {
			if r.Searched[i] != s.Searched || r.Guards[i] != s.Guards {
				t.Fatalf("tick %d: site %d searched %v guards %d, replica %v %d", tick, i, s.Searched, s.Guards, r.Searched[i], r.Guards[i])
			}
		}
		if late != nil {
			checkReplica(t, w, late)
		}
	}
	if w.TotalKills == 0 {
		t.Log("no creep died during the test; deaths were not exercised")
	}
}

// A delta leaves out what did not change in a player: the stream still says every player's
// name, look, arsenal and the rest as a keyframe of the same tick would, through a survivor
// joining mid-game and every slow field changing at some point, and a player standing still
// costs only their few always-sent fields.
func TestPlayerRecordsSurviveTheirDeltas(t *testing.T) {
	w := newWorldWithCreeps(50)
	var e Encoder
	r := NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
	if err := r.Apply(e.Key(w, nil)); err != nil {
		t.Fatal(err)
	}
	strip := func(ps []PlayerView) []PlayerView {
		out := append([]PlayerView(nil), ps...)
		for i := range out {
			out[i].PX, out[i].PY = 0, 0
		}
		return out
	}
	for tick := 0; tick < 120; tick++ {
		w.Step()
		p := w.Players[0]
		switch tick {
		case 10:
			p.Name = "ana banana"
		case 20:
			p.Look ^= 0xdeadbeef
		case 30:
			p.Weapons[game.WShotgun].Owned = true
			p.Weapons[game.WShotgun].Lv[1] = 3
		case 40:
			p.Gear[0]++
		case 50:
			p.Gold += 77
			p.Tally.Built++
		case 60:
			if _, err := w.Join("bo", "bo@example"); err != nil {
				t.Fatal(err)
			}
		case 70:
			w.Players[1].Name = "bo the second"
			p.Weapons[game.WShotgun].Owned = false
		}
		d := e.Delta(w, nil)
		if err := r.Apply(d); err != nil {
			t.Fatal(err)
		}
		fresh := NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
		if err := fresh.Apply(e.Key(w, nil)); err != nil {
			t.Fatal(err)
		}
		if got, want := strip(r.Players), strip(fresh.Players); !reflect.DeepEqual(got, want) {
			t.Fatalf("tick %d: the deltas say\n%+v\na keyframe\n%+v", tick, got, want)
		}
		if v := &r.Players[0]; v.Name != p.Name || v.Look != p.Look || v.Owned[game.WShotgun] != p.Weapons[game.WShotgun].Owned || v.Gear != p.Gear || v.Gold != uint64(p.Gold) || v.Stats.Built != uint64(p.Tally.Built) {
			t.Fatalf("tick %d: player %+v, world %+v", tick, *v, *p)
		}
		if len(w.Players) > 1 && r.Players[1].Name != w.Players[1].Name {
			t.Fatalf("tick %d: second player %q, world %q", tick, r.Players[1].Name, w.Players[1].Name)
		}
	}
	// Nobody moving and nothing ticking: the record is the id, flags, position, aim, hit
	// points and an empty mask.
	var b enc
	e.player(&b, w, w.Players[1], nil, false)
	b.b = b.b[:0]
	e.player(&b, w, w.Players[1], nil, false)
	if len(b.b) != 11 {
		t.Fatalf("a player standing still costs %d bytes", len(b.b))
	}
}

// A restart's new map has fewer structures than the old one had by the end: none of the old
// ones may linger on the client, where the host has nothing to sell or destroy.
func TestNoStructureOutlivesAShorterList(t *testing.T) {
	w := newWorldWithCreeps(0)
	var e Encoder
	r := NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
	n := len(w.Structs)
	for i := 0; i < 20; i++ {
		s := w.Structs[0]
		s.Alive, s.Kind, s.X = true, game.STurretGun, s.X+int16(i+1)
		w.Structs = append(w.Structs, s)
	}
	e.Delta(w, nil)
	if err := r.Apply(e.Key(w, nil)); err != nil {
		t.Fatal(err)
	}
	w.Structs = w.Structs[:n]
	if err := r.Apply(e.Delta(w, nil)); err != nil {
		t.Fatal(err)
	}
	late := NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
	if err := late.Apply(e.Key(w, nil)); err != nil {
		t.Fatal(err)
	}
	for name, rr := range map[string]*Replica{"delta": r, "key": late} {
		for i := n; i < len(rr.Structs); i++ {
			if rr.Structs[i].Alive || rr.Structs[i].Ghost {
				t.Errorf("%s: structure %d past the world's %d is still there: %+v", name, i, n, rr.Structs[i])
			}
		}
	}
}

func TestATruncatedFrameIsAnErrorNotAPanic(t *testing.T) {
	w := newWorldWithCreeps(50)
	var e Encoder
	k := e.Key(w, nil)
	for n := 0; n < len(k); n += 7 {
		r := NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
		_ = r.Apply(k[:n])
	}
}

func TestPingsReachTheReplica(t *testing.T) {
	w := newWorldWithCreeps(10)
	var e Encoder
	r := NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
	if err := r.Apply(e.Key(w, nil)); err != nil {
		t.Fatal(err)
	}
	_ = w.Ping(w.Players[0], 40.5, 33.25, game.PingLoot)
	w.Step()
	if err := r.Apply(e.Delta(w, nil)); err != nil {
		t.Fatal(err)
	}
	_, _, _, _, g := r.Drain()
	if len(g) != 1 || g[0].X != 40.5 || g[0].Y != 33.25 || g[0].Kind != game.PingLoot || g[0].Player != w.Players[0].ID {
		t.Fatalf("pings %+v", g)
	}
}

func TestCommandRoundTrip(t *testing.T) {
	c := Cmd{Op: OpAbility, A: 2, X: 12.5, Y: 199.25, T: 4000, Text: "hi"}
	gc, err := decodeCmd(c.encode())
	if err != nil || gc != c {
		t.Fatalf("%+v -> %+v (%v)", c, gc, err)
	}
}

// A real host on loopback: probe, join, frames arrive, a command is answered.
func TestHostOnLoopback(t *testing.T) {
	s, err := Listen(ServerConfig{Addrs: []string{"127.0.0.1:0"}, Seed: 3, Version: "test", Host: "box", LocalLogin: "me", LocalName: "me"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	addr := s.Addrs()[0]
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	info, err := Probe(ctx, addr)
	if err != nil || info.Host != "box" || info.Proto != Proto {
		t.Fatalf("probe: %+v %v", info, err)
	}
	c, wel, err := Dial(ctx, addr, Hello{Name: "tester", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	r := NewReplica(wel.W, wel.H, wel.Terrain, wel.You, wel.Seed)
	if len(wel.Sites) == 0 || wel.Sites[3].Tier > 2 || wel.Sites[3].SX == 0 {
		t.Fatalf("welcome sites: %+v", wel.Sites[:min(len(wel.Sites), 4)])
	}
	frames := 0
	sentCmd := false
	toast, echo := "", ""
	if err := c.Echo([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(4 * time.Second)
	for frames < 30 || toast == "" || echo == "" {
		select {
		case m := <-c.Msgs():
			if m.Err != nil {
				t.Fatal(m.Err)
			}
			switch m.Type {
			case MsgFrame:
				if err := r.Apply(m.Payload); err != nil {
					t.Fatal(err)
				}
				frames++
			case MsgToast:
				_, toast = DecodeToast(m.Payload)
			case MsgEcho:
				echo = string(m.Payload)
			}
			if r.Synced && !sentCmd {
				me := r.Me()
				if me == nil || me.Name != "tester" {
					t.Fatalf("me = %+v", me)
				}
				_ = c.Send(Cmd{Op: OpMove, X: me.X + 2, Y: me.Y})
				_ = c.Send(Cmd{Op: OpBuyWeapon, A: uint8(game.WRifle)})
				sentCmd = true
			}
		case <-deadline:
			t.Fatalf("after 4s: %d frames, toast %q, echo %q", frames, toast, echo)
		}
	}
	if toast == "" {
		t.Error("no toast for a purchase away from the armory")
	}
	if echo != "hi" {
		t.Errorf("echo = %q, want the payload back", echo)
	}
	// A wrong protocol is refused with both versions named.
	_, _, err = dialRaw(ctx, addr, Hello{Proto: Proto + 1, Version: "old", Name: "x"})
	var rej *RejectError
	if err == nil || !asReject(err, &rej) {
		t.Fatalf("protocol mismatch not refused: %v", err)
	}
	// So is another td on the same protocol, with how to fix it.
	_, _, err = Dial(ctx, addr, Hello{Version: "abc1234", Name: "x"})
	if !IsVersionMismatch(err) || !asReject(err, &rej) || !strings.Contains(err.Error(), "td update") || !strings.Contains(err.Error(), "abc1234") {
		t.Fatalf("version mismatch not refused: %v", err)
	}
}

func dialRaw(ctx context.Context, addr string, h Hello) (*Client, Welcome, error) {
	c, br, _, err := dial(ctx, addr, h)
	if err != nil {
		return nil, Welcome{}, err
	}
	defer c.Close()
	typ, p, err := readMsg(br)
	if err != nil {
		return nil, Welcome{}, err
	}
	if typ == MsgReject {
		return nil, Welcome{}, &RejectError{string(p)}
	}
	return nil, Welcome{}, nil
}

func asReject(err error, r **RejectError) bool {
	e, ok := err.(*RejectError)
	*r = e
	return ok
}

func BenchmarkDelta5000(b *testing.B) {
	w := newWorldWithCreeps(5000)
	var e Encoder
	e.Key(w, nil)
	b.ReportAllocs()
	size := 0
	for i := 0; i < b.N; i++ {
		w.Step()
		size = len(e.Delta(w, nil))
	}
	b.ReportMetric(float64(size), "bytes/frame")
}

func BenchmarkDelta5000Compressed(b *testing.B) {
	w := newWorldWithCreeps(5000)
	var e Encoder
	e.Key(w, nil)
	var sink countWriter
	zw, _ := flate.NewWriter(&sink, flate.BestSpeed)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		w.Step()
		_ = writeMsg(zw, MsgFrame, e.Delta(w, nil))
		_ = zw.Flush()
	}
	b.ReportMetric(float64(sink)/float64(b.N), "wire-bytes/frame")
	b.ReportMetric(float64(sink)/float64(b.N)*game.TickRate/1024, "KiB/s")
}

type countWriter int

func (c *countWriter) Write(p []byte) (int, error) { *c += countWriter(len(p)); return len(p), nil }

// At night the ground the team has found reaches a client that was there all along through
// deltas, and one that joins late through its keyframe, and both agree with the host.
func TestFoundGroundIsShared(t *testing.T) {
	w := game.NewGame(5, game.DiffHard)
	p, _ := w.Join("ana", "ana@example")
	var e Encoder
	r := NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
	if err := r.Apply(e.Key(w, nil)); err != nil {
		t.Fatal(err)
	}
	far := 0
	for i := 0; i < 200; i++ {
		// Out of the base and on, faster than any survivor runs.
		p.X, p.Y = w.CoreX+20+float32(i)*.25, w.CoreY
		w.Step()
		if err := r.Apply(e.Delta(w, nil)); err != nil {
			t.Fatal(err)
		}
	}
	late := NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
	if err := late.Apply(e.Key(w, nil)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < w.W*w.H; i++ {
		if w.Seen.Has(i) != r.Seen.Has(i) || w.Seen.Has(i) != late.Seen.Has(i) {
			t.Fatalf("tile %d: host %v, client %v, late joiner %v", i, w.Seen.Has(i), r.Seen.Has(i), late.Seen.Has(i))
		}
		if w.Seen.Has(i) && float32(i%w.W) > w.CoreX+40 {
			far++
		}
	}
	if far == 0 {
		t.Fatal("the ground the survivor walked was never found")
	}
	if at := int(w.CoreY+60)*w.W + int(w.CoreX); w.Seen.Has(at) {
		t.Fatal("ground nobody went near was found")
	}
	// Without the night nothing is kept.
	n := game.NewGame(5, game.DiffNormal)
	n.Join("ana", "ana@example")
	n.Step()
	n.Step()
	n.Step()
	n.Step()
	if n.Seen != nil {
		t.Fatal("the map is kept on normal")
	}
}

// The host changes the difficulty as the game goes, and everyone is told; anyone else is refused.
func TestOnlyTheHostChangesTheDifficulty(t *testing.T) {
	for _, owner := range []string{"me", "someone else"} {
		s, err := Listen(ServerConfig{Addrs: []string{"127.0.0.1:0"}, Seed: 3, Version: "test", Host: "box", LocalLogin: "me", LocalName: "me", Owner: owner})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		c, _, err := Dial(ctx, s.Addrs()[0], Hello{Name: "tester", Version: "test"})
		if err != nil {
			t.Fatal(err)
		}
		_ = c.Send(Cmd{Op: OpDifficulty, A: uint8(game.DiffHard)})
		got, toast := -1, ""
		deadline := time.After(3 * time.Second)
		for got < 0 && toast == "" {
			select {
			case m := <-c.Msgs():
				if m.Err != nil {
					t.Fatal(m.Err)
				}
				switch m.Type {
				case MsgDiff:
					got = int(m.Payload[0])
				case MsgToast:
					_, toast = DecodeToast(m.Payload)
				}
			case <-deadline:
				t.Fatalf("owner %q: no answer", owner)
			}
		}
		if owner == "me" && got != int(game.DiffHard) {
			t.Fatalf("the host's change: got %d, toast %q", got, toast)
		}
		if owner != "me" && (got >= 0 || !strings.Contains(toast, "only the host")) {
			t.Fatalf("a guest's change: got %d, toast %q", got, toast)
		}
		c.Close()
		cancel()
		s.Close()
	}
}
