package netplay

// Frames over UDP. Over TCP one lost segment holds every frame behind it for a retransmit
// timeout, a quarter of a second or more, though the frame after it would have made the lost
// one moot. So once a player's td has shown that datagrams get through both ways, the host
// sends that player's frames as datagrams and everything else stays on the TCP connection:
// the handshake, welcomes, toasts, acks, stats and commands, all of which must arrive and in
// order. A lost datagram costs a frame, not a stall.
//
// Frames stay deltas against the previous tick from the one shared encoder. To stand alone
// they are numbered: every frame to a player that has UDP, on either path, carries the host's
// frame seq, and the client applies a delta only on top of the seq before it, so a frame that
// went missing, came twice or was overtaken by the other path can never be applied to the
// wrong base. Each datagram unit also repeats the one or two deltas before it when that does
// not more than double its size, which repairs a single loss without anything sent back. A
// hole the repeats do not cover makes the client ask for a keyframe. A unit is compressed on
// its own, without the window the TCP stream keeps, so any unit can be read without the ones
// before it, and cut into fragments that fit the tailnet's MTU.
//
// The host binds a player's UDP address only from a datagram carrying the token it gave that
// player over TCP and sent from the IP of the TCP connection, which the tailnet vouches for.
// Such a hello may move the binding to another port of that IP at any time, as a NAT that
// gives the player's socket a new port mid-game makes it. If nothing comes back over UDP for
// udpTimeout, a few round trips, the player's frames go over TCP, starting with a keyframe.
// That is never final: a client whose frames stop coming as datagrams says hello again, fast
// at first and then once a second for as long as it plays. The host answers at once after a
// first fallback, and after a hold that grows with each further one in a row; the client
// confirms, over TCP and with an ack datagram both, since after an outage the TCP direction
// may still be resending what it held; and the frames come back to UDP, again starting with
// a keyframe. Since every frame is numbered, a frame still on its way by the path left
// behind is dropped as old or applied in its place, never twice.

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"strings"
)

// EnvNoUDP turns the UDP path off on whichever side has it set: the host offers none, the
// player asks for none, and every frame goes over TCP as before.
const EnvNoUDP = "TAILDEFENSE_NO_UDP"

func udpDisabled() bool {
	v := strings.TrimSpace(os.Getenv(EnvNoUDP))
	return v != "" && v != "0"
}

// udpMax is the largest datagram sent: Tailscale's MTU is 1280, less 40 for an IPv6 header
// and 8 for UDP leaves 1232, and the rest is slack for any other encapsulation on the way.
const udpMax = 1200

// Every datagram starts with the magic and its type, so a stray packet is told apart cheaply.
const (
	udpMagic0, udpMagic1 = 't', 'd'
	udpHdr               = 3
)

// Datagram types.
const (
	dgHello    byte = 1 // c->s: u64 token, sent until the hello is answered
	dgHelloAck byte = 2 // s->c: u64 token, the answer
	dgAck      byte = 3 // c->s: u64 token, u16 epoch, u32 applied seq, u32 newest seq, u8 flags; also the answer to a dgHelloAck
	dgFrag     byte = 4 // s->c: u16 epoch, u32 seq, u16 index, u16 count, a piece of a unit
)

// fragHdr is a fragment's header, magic included; fragData what is left for the unit.
const (
	fragHdr  = udpHdr + 2 + 4 + 2 + 2
	fragData = udpMax - fragHdr
)

// maxFrags bounds a unit, about 75 KB: a delta any bigger puts the player back on TCP, where
// a frame that size is better off, and a client never holds more than this for one.
const maxFrags = 64

// ackWantKey is the flag in a dgAck for a client missing a delta it cannot do without.
const ackWantKey = 1

// noSeq is the applied seq of a client that has applied nothing yet in this epoch.
const noSeq = ^uint32(0)

// udpOffer is what MsgUDP carries: where the host listens for UDP, the token that names this
// player there, and the host's epoch, the count of its restarts, which tags every datagram so
// a frame of a map the player has not yet been welcomed to is never applied to the old one.
type udpOffer struct {
	Port  uint16
	Token uint64
	Epoch uint16
}

func (o udpOffer) encode() []byte {
	var b enc
	b.u16(o.Port)
	b.b = binary.LittleEndian.AppendUint64(b.b, o.Token)
	b.u16(o.Epoch)
	return b.b
}

func decodeOffer(p []byte) (udpOffer, error) {
	d := &dec{b: p}
	o := udpOffer{Port: d.u16()}
	lo, hi := d.u32(), d.u32()
	o.Token = uint64(hi)<<32 | uint64(lo)
	o.Epoch = d.u16()
	return o, d.err
}

// seqFrame is one frame payload with the seq the host gave it.
type seqFrame struct {
	seq uint32
	p   []byte
}

// encodeSeqFrame is a MsgSeqFrame payload: the seq, then the frame.
func encodeSeqFrame(seq uint32, frame []byte) []byte {
	return append(binary.LittleEndian.AppendUint32(make([]byte, 0, 4+len(frame)), seq), frame...)
}

func decodeSeqFrame(p []byte) (seqFrame, error) {
	if len(p) < 5 {
		return seqFrame{}, errShort
	}
	return seqFrame{binary.LittleEndian.Uint32(p), p[4:]}, nil
}

// frameTick is the game tick a frame payload is of: its header starts after the flags byte.
func frameTick(p []byte) (uint32, bool) {
	if len(p) < 5 {
		return 0, false
	}
	return binary.LittleEndian.Uint32(p[1:]), true
}

// unitPacker compresses units, reusing its compressor; a unit is its frames, oldest first,
// each as seq and length-prefixed payload, deflated on its own.
type unitPacker struct {
	raw enc
	out bytes.Buffer
	zw  *flate.Writer
}

func (u *unitPacker) pack(frames []seqFrame) []byte {
	u.raw.b = u.raw.b[:0]
	u.raw.u8(uint8(len(frames)))
	for _, f := range frames {
		u.raw.u32(f.seq)
		u.raw.bytes(f.p)
	}
	u.out.Reset()
	if u.zw == nil {
		u.zw, _ = flate.NewWriter(&u.out, flate.BestSpeed)
	} else {
		u.zw.Reset(&u.out)
	}
	_, _ = u.zw.Write(u.raw.b)
	_ = u.zw.Close()
	return append([]byte(nil), u.out.Bytes()...)
}

// fragment cuts a packed unit into datagrams of at most udpMax bytes.
func fragment(epoch uint16, seq uint32, unit []byte) [][]byte {
	n := max(1, (len(unit)+fragData-1)/fragData)
	if n > maxFrags {
		return nil
	}
	dgs := make([][]byte, 0, n)
	for i := range n {
		chunk := unit[i*fragData : min(len(unit), (i+1)*fragData)]
		b := make([]byte, 0, fragHdr+len(chunk))
		b = append(b, udpMagic0, udpMagic1, dgFrag)
		b = binary.LittleEndian.AppendUint16(b, epoch)
		b = binary.LittleEndian.AppendUint32(b, seq)
		b = binary.LittleEndian.AppendUint16(b, uint16(i))
		b = binary.LittleEndian.AppendUint16(b, uint16(n))
		dgs = append(dgs, append(b, chunk...))
	}
	return dgs
}

var errUnit = errors.New("bad unit")

// unpack reads a reassembled unit back into its frames. The payload is untrusted: it is
// inflated to at most maxMessage and every length is checked.
func unpack(unit []byte) ([]seqFrame, error) {
	raw, err := io.ReadAll(io.LimitReader(flate.NewReader(bytes.NewReader(unit)), maxMessage+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxMessage {
		return nil, errUnit
	}
	d := &dec{b: raw}
	n := int(d.u8())
	frames := make([]seqFrame, 0, n)
	for range n {
		seq := d.u32()
		p := d.bytes()
		if d.err != nil {
			return nil, d.err
		}
		frames = append(frames, seqFrame{seq, p})
	}
	if n == 0 || d.i != len(raw) {
		return nil, errUnit
	}
	return frames, nil
}

// datagram is one datagram read and checked: only the fields of its type are set.
type datagram struct {
	typ         byte
	token       uint64
	epoch       uint16
	seq, newest uint32 // a fragment's unit, or an ack's applied and newest
	flags       uint8
	idx, count  uint16
	chunk       []byte // aliases the read buffer
}

// parseDatagram checks a datagram from the network; ok is false for anything malformed.
func parseDatagram(b []byte) (m datagram, ok bool) {
	if len(b) < udpHdr || b[0] != udpMagic0 || b[1] != udpMagic1 {
		return m, false
	}
	m.typ = b[2]
	d := &dec{b: b, i: udpHdr}
	u64 := func() uint64 { lo, hi := d.u32(), d.u32(); return uint64(hi)<<32 | uint64(lo) }
	switch m.typ {
	case dgHello, dgHelloAck:
		m.token = u64()
	case dgAck:
		m.token, m.epoch, m.seq, m.newest, m.flags = u64(), d.u16(), d.u32(), d.u32(), d.u8()
	case dgFrag:
		m.epoch, m.seq, m.idx, m.count = d.u16(), d.u32(), d.u16(), d.u16()
		if d.err != nil || m.count == 0 || m.count > maxFrags || m.idx >= m.count || len(b) == d.i {
			return m, false
		}
		m.chunk = b[d.i:]
		return m, len(m.chunk) <= fragData
	default:
		return m, false
	}
	return m, d.err == nil && d.i == len(b)
}

func helloDatagram(typ byte, token uint64) []byte {
	return binary.LittleEndian.AppendUint64([]byte{udpMagic0, udpMagic1, typ}, token)
}

func ackDatagram(token uint64, epoch uint16, applied, newest uint32, flags uint8) []byte {
	b := binary.LittleEndian.AppendUint64([]byte{udpMagic0, udpMagic1, dgAck}, token)
	b = binary.LittleEndian.AppendUint16(b, epoch)
	b = binary.LittleEndian.AppendUint32(b, applied)
	b = binary.LittleEndian.AppendUint32(b, newest)
	return append(b, flags)
}

// reassembler puts units back together from their fragments. It keeps a few units at a time:
// one that has waited while maxPartial newer ones started has lost a fragment for good.
type reassembler struct {
	parts []*partial
}

const maxPartial = 6

type partial struct {
	epoch  uint16
	seq    uint32
	chunks [][]byte
	got    int
}

// add takes one fragment and returns its unit once all of the unit's fragments are in.
func (r *reassembler) add(m datagram) []byte {
	if m.count == 1 {
		return append([]byte(nil), m.chunk...)
	}
	var pt *partial
	for _, q := range r.parts {
		if q.epoch == m.epoch && q.seq == m.seq {
			pt = q
			break
		}
	}
	if pt == nil {
		pt = &partial{epoch: m.epoch, seq: m.seq, chunks: make([][]byte, m.count)}
		r.parts = append(r.parts, pt)
		if len(r.parts) > maxPartial {
			r.parts = r.parts[1:]
		}
	}
	if int(m.idx) >= len(pt.chunks) || pt.chunks[m.idx] != nil {
		return nil // a count that changed, or a duplicate
	}
	pt.chunks[m.idx] = append([]byte(nil), m.chunk...)
	pt.got++
	if pt.got < len(pt.chunks) {
		return nil
	}
	r.drop(pt)
	return bytes.Join(pt.chunks, nil)
}

func (r *reassembler) drop(pt *partial) {
	for i, q := range r.parts {
		if q == pt {
			r.parts = append(r.parts[:i], r.parts[i+1:]...)
			return
		}
	}
}

// forget drops the partial units no newer than seq, or all of them.
func (r *reassembler) forget(all bool, seq uint32) {
	keep := r.parts[:0]
	for _, q := range r.parts {
		if !all && q.seq > seq {
			keep = append(keep, q)
		}
	}
	r.parts = keep
}
