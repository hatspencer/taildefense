package netplay

import (
	"bufio"
	"compress/flate"
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"taildefense/internal/game"
)

// huge is a ten-byte varint past 2^63: as an int it is negative.
const huge = 1<<63 | 5

// frameHead is a frame's flags and a header with nothing in it, as Replica.header reads one.
func frameHead(flags uint8, sites uint64) *enc {
	e := &enc{}
	e.u8(flags)
	e.u32(1)    // tick
	e.u8(0)     // phase
	e.u16(1)    // wave
	e.u16(0)    // phase left
	e.uv(0)     // left
	e.uv(0)     // kills
	e.u16(0)    // best
	e.u8(0)     // weather
	e.u8(0)     // weather amount
	e.u8(0)     // paused by
	e.u8(0)     // affix
	e.u8(0)     // next affix
	e.u8(0)     // from
	e.u8(0)     // tier
	e.u16(0)    // tier paid
	e.u16(0)    // tier cost
	e.u8(0)     // overload
	e.uv(sites) // loot sites
	e.uv(0)     // crates
	e.uv(0)     // guns
	e.u8(uint8(game.EvacNone))
	e.u8(0) // players
	return e
}

// emptyKey is a keyframe of an empty world.
func emptyKey() []byte {
	e := frameHead(frameKey, 0)
	e.uv(0) // creeps
	e.uv(0) // structures
	for range 6 {
		e.uv(0) // tracers, blasts, deaths, effects, notes, pings
	}
	e.uv(0) // words of found ground
	return e.b
}

// hostileDelta is a delta that changes nothing but one structure's hit points and one found
// tile, at the indices given.
func hostileDelta(hpIdx, ground uint64) []byte {
	e := frameHead(0, 0)
	e.uv(0) // gone
	e.uv(0) // new
	e.uv(0) // changed
	e.uv(0) // structures
	e.uv(1) // structure hit points
	e.uv(hpIdx)
	e.u16(7)
	for range 6 {
		e.uv(0)
	}
	e.uv(1) // found ground
	e.uv(ground)
	return e.b
}

func hostileFrames() map[string][]byte {
	structIdx := frameHead(frameKey, 0)
	structIdx.uv(0)
	structIdx.uv(1)
	structIdx.uv(huge)
	return map[string][]byte{
		"structure index":      structIdx.b,
		"loot sites":           frameHead(frameKey, huge).b,
		"structure hit points": hostileDelta(huge, 0),
		"found ground":         hostileDelta(0, huge),
	}
}

// A varint past 2^63 where a frame has an index or a count does not panic: a structure index
// or a count of loot sites that large is an error, a structure's hit points or a found tile
// that far off are ignored, as one past the end always was.
func TestAHugeVarintIsNotAPanic(t *testing.T) {
	for name, f := range hostileFrames() {
		r := NewReplica(64, 64, make([]game.Tile, 64*64), 0, 1)
		if err := r.Apply(emptyKey()); err != nil {
			t.Fatalf("the empty keyframe: %v", err)
		}
		err := r.Apply(f)
		if name == "structure index" || name == "loot sites" {
			if err == nil {
				t.Errorf("%s: no error", name)
			}
		}
	}
}

// A failed frame leaves no events behind, and notes stop at what the page can take.
func TestEventsDoNotPileUp(t *testing.T) {
	r := NewReplica(64, 64, make([]game.Tile, 64*64), 0, 1)
	if err := r.Apply(emptyKey()); err != nil {
		t.Fatal(err)
	}
	notes := func(n int, cut bool) []byte {
		e := frameHead(0, 0)
		e.uv(0)
		e.uv(0)
		e.uv(0)
		e.uv(0)
		e.uv(0)
		e.uv(0)
		e.uv(0)
		e.uv(0)
		e.uv(0)
		e.uv(uint64(n))
		for range n {
			e.u8(1)
			e.str("hi")
		}
		e.uv(0)
		if !cut {
			e.uv(0)
		}
		return e.b
	}
	for range 10 {
		if err := r.Apply(notes(100, true)); err == nil {
			t.Fatal("a frame cut short applied")
		}
	}
	if len(r.Notes) != 0 {
		t.Fatalf("%d notes from frames that failed", len(r.Notes))
	}
	for range 10 {
		if err := r.Apply(notes(100, false)); err != nil {
			t.Fatal(err)
		}
	}
	if len(r.Notes) != maxNotes {
		t.Fatalf("%d notes kept, want %d", len(r.Notes), maxNotes)
	}
}

// Structures off the map cost only what is on it, and land where they did before.
func TestStructAtClampsToTheMap(t *testing.T) {
	r := NewReplica(8, 6, make([]game.Tile, 48), 0, 1)
	r.Structs = []StructView{
		{Alive: true, X: -2, Y: -1, W: 4, H: 3},
		{Alive: true, X: 6, Y: 4, W: 255, H: 255},
		{Alive: true, X: 30, Y: 2, W: 2, H: 2},
		{Alive: false, X: 3, Y: 3, W: 1, H: 1},
	}
	r.rebuildStructAt()
	for y := range 6 {
		for x := range 8 {
			want := -1
			if x < 2 && y < 2 {
				want = 0
			} else if x >= 6 && y >= 4 {
				want = 1
			}
			if got := r.StructIndexAt(x, y); got != want {
				t.Errorf("%d,%d: %d, want %d", x, y, got, want)
			}
		}
	}
}

// What a hostile host says in a probe reply or a refusal comes out as one line of text.
func TestAHostsWordsArePlainText(t *testing.T) {
	const nasty = "evil\x1b]52;c;ZWNobyBoaQ==\x07\x1b[2K\x1b[1Arow\nfake row"
	const clean = "evilrow fake row"
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				br := bufio.NewReader(c)
				_, p, err := readMsg(br)
				if err != nil {
					return
				}
				var h Hello
				_ = json.Unmarshal(p, &h)
				fw, _ := flate.NewWriter(c, flate.BestSpeed)
				bw := bufio.NewWriter(fw)
				if h.Probe {
					b, _ := json.Marshal(Info{Proto: Proto, Version: nasty, Host: nasty, Owner: nasty, Players: []string{nasty}, Phase: nasty})
					_ = writeMsg(bw, MsgInfo, b)
				} else {
					_ = writeMsg(bw, MsgReject, []byte(nasty))
				}
				_ = bw.Flush()
				_ = fw.Flush()
				time.Sleep(100 * time.Millisecond)
			}()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	in, err := Probe(ctx, ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{in.Version, in.Host, in.Owner, in.Phase, in.Players[0]} {
		if s != clean {
			t.Errorf("probe reply %q, want %q", s, clean)
		}
	}
	_, _, err = Dial(ctx, ln.Addr().String(), Hello{Name: "ana"})
	var rej *RejectError
	if !errors.As(err, &rej) || rej.Reason != clean || strings.ContainsAny(err.Error(), "\x1b\n\x07") {
		t.Fatalf("refusal %q", err)
	}
}
