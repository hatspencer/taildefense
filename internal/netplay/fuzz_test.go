package netplay

import (
	"bufio"
	"bytes"
	"testing"

	"taildefense/internal/game"
)

// A length that does not fit an int, or overflows one past the read position, is a truncated
// message, not a slice out of range: a player could otherwise stop the host with nine bytes.
func TestAnImpossibleLengthIsAnErrorNotAPanic(t *testing.T) {
	huge := []uint64{1<<64 - 1, 1 << 63, 1<<63 - 1, 1<<63 - 9}
	for _, n := range huge {
		var b enc
		b.u8(OpChat)
		b.u8(0)
		b.u8(0)
		b.u16(0)
		b.u16(0)
		b.u16(0)
		b.uv(n)
		b.b = append(b.b, "hi"...)
		if _, err := decodeCmd(b.b); err == nil {
			t.Fatalf("a command whose text is %d bytes long decoded", n)
		}
		d := &dec{b: b.b, i: 9}
		if d.bytes(); d.err == nil {
			t.Fatalf("%d bytes read from %d", n, len(b.b))
		}
	}
}

// Whatever a player sends, the host's decoder answers with a command or an error, and a
// command it decodes travels back as the same command.
func FuzzDecodeCmd(f *testing.F) {
	f.Add(Cmd{Op: OpAbility, A: 2, X: 12.5, Y: 199.25, T: 4000, Text: "hi"}.encode())
	f.Add(Cmd{Op: OpChat, Text: "gg"}.encode())
	f.Add([]byte{OpMove, 0, 0, 1, 2, 3, 4, 5, 6, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01})
	f.Fuzz(func(t *testing.T, p []byte) {
		c, err := decodeCmd(p)
		if err != nil {
			return
		}
		if len(c.Text) > 255 {
			c.Text = c.Text[:255] // the most a string travels as
		}
		if again, err := decodeCmd(c.encode()); err != nil || again != c {
			t.Fatalf("%+v came back as %+v, %v", c, again, err)
		}
	})
}

// A peer's byte stream is read as framed messages or an error, never a panic or more than
// maxMessage allocated.
func FuzzReadMsg(f *testing.F) {
	var b bytes.Buffer
	_ = writeMsg(&b, MsgCmd, Cmd{Op: OpChat, Text: "gg"}.encode())
	_ = writeMsg(&b, MsgEcho, []byte{1, 2, 3})
	f.Add(b.Bytes())
	f.Add([]byte{MsgCmd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01})
	f.Fuzz(func(t *testing.T, p []byte) {
		br := bufio.NewReader(bytes.NewReader(p))
		for {
			_, m, err := readMsg(br)
			if err != nil {
				return
			}
			if len(m) > maxMessage {
				t.Fatalf("a message of %d bytes", len(m))
			}
		}
	})
}

// Whatever a host sends, a client reads it as a welcome, a frame or a toast, or an error.
func FuzzClientDecoders(f *testing.F) {
	w := newWorldWithCreeps(40)
	s := &Server{world: w}
	p := &peer{player: w.Players[0]}
	f.Add(s.welcome(p).payload)
	var e Encoder
	f.Add(e.Key(w, nil))
	w.Step()
	f.Add(e.Delta(w, nil))
	key := append([]byte(nil), e.Key(w, nil)...)
	f.Add([]byte{2, 3, 'h', 'e', 'y'})
	f.Fuzz(func(t *testing.T, b []byte) {
		_, _ = DecodeWelcome(b)
		_, _ = DecodeToast(b)
		r := NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
		if r.Apply(b) == nil && r.Synced {
			_ = r.Apply(b) // the same frame again, now as a delta on itself if it is one
		}
		if r.Count < 0 || r.Count > game.MaxCreeps {
			t.Fatalf("%d creeps", r.Count)
		}
		// And as a delta on a replica that has a world to apply it to.
		r = NewReplica(w.W, w.H, w.Terrain, 0, w.Seed)
		if err := r.Apply(key); err != nil {
			t.Fatal(err)
		}
		_ = r.Apply(b)
		if r.Count < 0 || r.Count > game.MaxCreeps {
			t.Fatalf("%d creeps", r.Count)
		}
	})
}

// Whatever arrives on a UDP socket, from the network at large, is refused or read, never a
// panic: a datagram, the fragments it may complete, the unit they make and its frames.
func FuzzDatagram(f *testing.F) {
	var pk unitPacker
	for _, dg := range fragment(1, 9, pk.pack([]seqFrame{{8, []byte{0, 1, 2}}, {9, make([]byte, 3000)}})) {
		f.Add(dg)
	}
	f.Add(helloDatagram(dgHello, 42))
	f.Add(ackDatagram(42, 1, 7, 9, ackWantKey))
	f.Add(pk.pack([]seqFrame{{1, []byte{frameKey, 1, 0, 0, 0}}}))
	f.Fuzz(func(t *testing.T, b []byte) {
		var r reassembler
		var fl frameFlow
		if m, ok := parseDatagram(b); ok && m.typ == dgFrag {
			// Twice, as two fragments of one unit.
			for range 2 {
				if u := r.add(m); u != nil {
					if frames, err := unpack(u); err == nil {
						for _, fr := range frames {
							fl.frame(fr.seq, fr.p, true)
						}
					}
				}
			}
		}
		if frames, err := unpack(b); err == nil {
			for _, fr := range frames {
				fl.frame(fr.seq, fr.p, true)
			}
		}
		_, _ = decodeOffer(b)
		if sf, err := decodeSeqFrame(b); err == nil {
			fl.frame(sf.seq, sf.p, false)
		}
		fl.ack(Msg{Type: MsgAck, Payload: b})
	})
}
