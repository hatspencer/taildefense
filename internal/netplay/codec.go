// Package netplay carries a game between the host and its players over the tailnet.
//
// The host is authoritative: it runs the simulation and sends a frame every tick. Frames are
// deltas against the previous one: a creep that moved costs two bytes, one that only lost
// hit points three, and structures are sent only when they change. The host-to-client
// stream is deflate-compressed with the window kept across frames, so the repeated shape of a
// horde moving along the same road compresses to a fraction of that. A client that falls
// behind gets no backlog; it is sent a keyframe as soon as its queue drains.
//
// Clients send orders, WC3 style: move here, attack that, cast this there, build that. The
// host walks the path and fights; nothing is predicted on the client.
package netplay

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
)

// Proto is the wire protocol version. A host refuses a client with a different one and names
// both versions, so the fix (td update) is obvious. Beyond the protocol, a host only lets in a
// player running the same td (SameVersion).
const Proto = 10

// DefaultPort is where a host listens.
const DefaultPort = 7787

// Message types.
const (
	MsgHello   byte = 1 // c->s JSON Hello
	MsgWelcome byte = 2 // s->c
	MsgReject  byte = 3 // s->c reason
	MsgInfo    byte = 4 // s->c JSON Info, the answer to a probe
	MsgFrame   byte = 5 // s->c
	MsgCmd     byte = 7 // c->s
	MsgToast   byte = 8 // s->c, to one player
)

// maxMessage bounds what a peer may make us allocate.
const maxMessage = 8 << 20

// writeMsg frames one message: type, uvarint length, payload.
func writeMsg(w io.Writer, typ byte, payload []byte) error {
	var hdr [1 + binary.MaxVarintLen64]byte
	hdr[0] = typ
	n := binary.PutUvarint(hdr[1:], uint64(len(payload)))
	if _, err := w.Write(hdr[:1+n]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

// readMsg reads one framed message.
func readMsg(r *bufio.Reader) (byte, []byte, error) {
	typ, err := r.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	n, err := binary.ReadUvarint(r)
	if err != nil {
		return 0, nil, err
	}
	if n > maxMessage {
		return 0, nil, fmt.Errorf("message of %d bytes is too large", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return typ, buf, nil
}

// enc appends to a byte slice.
type enc struct{ b []byte }

func (e *enc) u8(v uint8) { e.b = append(e.b, v) }
func (e *enc) i8(v int8)  { e.b = append(e.b, uint8(v)) }
func (e *enc) flag(v bool) {
	if v {
		e.u8(1)
	} else {
		e.u8(0)
	}
}
func (e *enc) u16(v uint16) { e.b = binary.LittleEndian.AppendUint16(e.b, v) }
func (e *enc) u32(v uint32) { e.b = binary.LittleEndian.AppendUint32(e.b, v) }
func (e *enc) uv(v uint64)  { e.b = binary.AppendUvarint(e.b, v) }
func (e *enc) str(s string) {
	if len(s) > 255 {
		s = s[:255]
	}
	e.uv(uint64(len(s)))
	e.b = append(e.b, s...)
}
func (e *enc) bytes(p []byte) {
	e.uv(uint64(len(p)))
	e.b = append(e.b, p...)
}

// dec reads from a byte slice. Every read is bounds-checked; the first failure sticks in err
// and later reads return zeros, so a decoder checks once at the end.
type dec struct {
	b   []byte
	i   int
	err error
}

var errShort = errors.New("truncated message")

func (d *dec) need(n int) bool {
	if d.err != nil {
		return false
	}
	if d.i+n > len(d.b) {
		d.err = errShort
		return false
	}
	return true
}

func (d *dec) u8() uint8 {
	if !d.need(1) {
		return 0
	}
	v := d.b[d.i]
	d.i++
	return v
}

func (d *dec) i8() int8 { return int8(d.u8()) }

func (d *dec) u16() uint16 {
	if !d.need(2) {
		return 0
	}
	v := binary.LittleEndian.Uint16(d.b[d.i:])
	d.i += 2
	return v
}

func (d *dec) u32() uint32 {
	if !d.need(4) {
		return 0
	}
	v := binary.LittleEndian.Uint32(d.b[d.i:])
	d.i += 4
	return v
}

func (d *dec) uv() uint64 {
	if d.err != nil {
		return 0
	}
	v, n := binary.Uvarint(d.b[d.i:])
	if n <= 0 {
		d.err = errShort
		return 0
	}
	d.i += n
	return v
}

func (d *dec) str() string {
	n := int(d.uv())
	if !d.need(n) {
		return ""
	}
	s := string(d.b[d.i : d.i+n])
	d.i += n
	return s
}

func (d *dec) bytes() []byte {
	n := int(d.uv())
	if !d.need(n) {
		return nil
	}
	p := d.b[d.i : d.i+n]
	d.i += n
	return p
}

// Positions travel as unsigned 1/8 tile.
const posQ = 8

func qpos(v float32) uint16 {
	q := math.Round(float64(v) * posQ)
	return uint16(min(max(q, 0), 65535))
}

func unq(v uint16) float32 { return float32(v) / posQ }

func qangle(a float32) uint16 {
	t := float64(a) / (2 * math.Pi)
	t -= math.Floor(t)
	return uint16(t * 65536)
}

func unqAngle(v uint16) float32 { return float32(float64(v) / 65536 * 2 * math.Pi) }
