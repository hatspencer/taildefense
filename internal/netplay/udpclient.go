package netplay

import (
	"errors"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"time"
)

// frameFlow is a client's order on numbered frames from both paths. It hands on a keyframe
// newer than what it has, and a delta only on top of the frame before it; deltas ahead of a
// hole wait a little for it, for a datagram can be overtaken, and then it wants a keyframe.
// It also holds back an ack until the frame it names is handed on, since the ack comes over
// TCP and its frame may still be in a datagram. What it hands on is in out, in order.
type frameFlow struct {
	epoch   uint16
	valid   bool   // a keyframe of this epoch has been handed on
	last    uint32 // the seq of the last frame handed on
	tick    uint32 // and its game tick
	pending map[uint32][]byte
	held    []Msg // acks waiting for their frame
	wantKey bool
	viaUDP  bool   // the last frame handed on came as a datagram
	udpN    uint64 // how many frames handed on came as datagrams
	out     []Msg
}

// reorderSlack is how many frames past a hole may arrive before the hole is taken as lost.
const reorderSlack = 2

// maxPending bounds the deltas kept waiting for a hole to fill.
const maxPending = 32

func (f *frameFlow) frame(seq uint32, p []byte, udp bool) {
	if len(p) == 0 || (f.valid && seq <= f.last) {
		return
	}
	if p[0]&frameKey != 0 {
		f.valid, f.wantKey = true, false
		f.hand(seq, p, udp)
		for s := range f.pending {
			if s <= seq {
				delete(f.pending, s)
			}
		}
		f.drain()
		return
	}
	if f.valid && seq == f.last+1 {
		f.hand(seq, p, udp)
		f.drain()
		return
	}
	if f.pending == nil {
		f.pending = map[uint32][]byte{}
	}
	f.pending[seq] = p
	if len(f.pending) > maxPending {
		delete(f.pending, slices.Min(keys(f.pending)))
	}
	if !f.valid || slices.Max(keys(f.pending)) >= f.last+1+reorderSlack {
		f.wantKey = true
	}
}

func keys(m map[uint32][]byte) []uint32 {
	k := make([]uint32, 0, len(m))
	for s := range m {
		k = append(k, s)
	}
	return k
}

// drain hands on the waiting deltas that now follow.
func (f *frameFlow) drain() {
	for {
		p, ok := f.pending[f.last+1]
		if !ok {
			break
		}
		delete(f.pending, f.last+1)
		f.hand(f.last+1, p, f.viaUDP)
	}
	if len(f.pending) == 0 {
		f.wantKey = false
	}
}

func (f *frameFlow) hand(seq uint32, p []byte, udp bool) {
	f.last, f.viaUDP = seq, udp
	if udp {
		f.udpN++
	}
	if t, ok := frameTick(p); ok {
		f.tick = t
	}
	f.out = append(f.out, Msg{Type: MsgFrame, Payload: p})
	keep := f.held[:0]
	for _, m := range f.held {
		if a, err := DecodeAck(m.Payload); err != nil || a.Tick <= f.tick {
			f.out = append(f.out, m)
		} else {
			keep = append(keep, m)
		}
	}
	f.held = keep
}

// ack hands on an ack whose frame is out, and holds any other.
func (f *frameFlow) ack(m Msg) {
	if a, err := DecodeAck(m.Payload); err == nil && f.valid && a.Tick <= f.tick && len(f.held) == 0 {
		f.out = append(f.out, m)
		return
	}
	f.held = append(f.held, m)
	if len(f.held) > 64 {
		f.out = append(f.out, f.held[0])
		f.held = f.held[1:]
	}
}

// welcome starts a new epoch: the host restarted, and nothing numbered before applies.
// Held acks are of the old game and go out ahead of the welcome.
func (f *frameFlow) welcome(m Msg) {
	f.out = append(f.out, f.held...)
	f.out = append(f.out, m)
	f.held = nil
	f.epoch++
	f.valid, f.wantKey, f.tick = false, false, 0
	clear(f.pending)
}

// applied is the seq to tell the host as applied.
func (f *frameFlow) applied() uint32 {
	if !f.valid {
		return noSeq
	}
	return f.last
}

// resyncEvery is how often a client still missing a keyframe asks again over TCP.
const resyncEvery = 500 * time.Millisecond

// A client says hello over UDP whenever nothing has come from the host that way for
// udpQuiet, which is ten ticks of frames: before the first answer, after the host put its
// frames on TCP, and when a NAT gave its socket a new port the host does not know yet. It
// says it every helloEvery for helloFor after the quiet began and every helloSlow after
// that, for as long as it plays: an 11 byte datagram a second costs nothing, and a phone's
// hotspot that dropped out for a few seconds gets its frames back on UDP when it returns.
const (
	udpQuiet   = 300 * time.Millisecond
	helloEvery = 200 * time.Millisecond
	helloFor   = 5 * time.Second
	helloSlow  = time.Second
)

// startUDP opens the client's socket to the host's UDP port, reads it into the client's
// events, and says hello whenever the host has gone quiet on it.
func (c *Client) startUDP(o udpOffer) {
	target := c.udpVia
	if target == "" {
		ap, err := netip.ParseAddrPort(c.conn.RemoteAddr().String())
		if err != nil {
			return
		}
		target = net.JoinHostPort(ap.Addr().Unmap().String(), strconv.Itoa(int(o.Port)))
	}
	ua, err := net.ResolveUDPAddr("udp", target)
	if err != nil {
		return
	}
	uc, err := net.DialUDP("udp", nil, ua)
	if err != nil {
		return
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		uc.Close()
		return
	}
	c.udp = uc
	c.mu.Unlock()
	c.token = o.Token
	c.udpOffered.Store(time.Now().UnixNano())
	go func() {
		buf := make([]byte, 2048)
		for {
			n, err := uc.Read(buf)
			if err != nil {
				if isClosed(err) {
					return
				}
				continue // an ICMP refusal surfaces as a read error; the hello goes on
			}
			m, ok := parseDatagram(buf[:n])
			if !ok {
				continue
			}
			if m.chunk != nil {
				m.chunk = append([]byte(nil), m.chunk...)
			}
			// Never block on a busy client: a datagram dropped here is one lost on the way.
			select {
			case c.ev <- event{dg: &m}:
			default:
			}
		}
	}()
	go c.helloLoop(uc, helloDatagram(dgHello, o.Token))
}

// helloLoop says hello while the host is quiet on UDP, until the client closes.
func (c *Client) helloLoop(uc *net.UDPConn, hello []byte) {
	t := time.NewTicker(helloEvery)
	defer t.Stop()
	var quiet, sent time.Time
	for {
		now := time.Now()
		if h := c.udpHeard.Load(); h != 0 && now.Sub(time.Unix(0, h)) <= udpQuiet {
			quiet = time.Time{}
		} else {
			if quiet.IsZero() {
				quiet = now
			}
			every := helloSlow
			if now.Sub(quiet) < helloFor {
				every = helloEvery
			}
			// Half a hello early still counts, so the ticker's own jitter does not skip one.
			if now.Sub(sent) >= every-helloEvery/2 {
				_, _ = uc.Write(hello)
				sent = now
			}
		}
		select {
		case <-t.C:
		case <-c.done:
			return
		}
	}
}

func isClosed(err error) bool { return errors.Is(err, net.ErrClosed) }

// datagram takes one datagram from the host.
func (c *Client) datagram(m datagram) {
	f := &c.flow
	switch m.typ {
	case dgHelloAck:
		if m.token != c.token {
			return
		}
		// Datagrams get through both ways: the host may send frames this way (again). The
		// client says so over both paths, an ack datagram being there first when TCP is
		// still catching up after an outage. It says hello only while the host is quiet on
		// UDP, so these go out at most once a hello, and a host that has the frames on UDP
		// already takes no notice.
		c.udpHeard.Store(time.Now().UnixNano())
		c.udpAnswered.Store(true)
		c.ackUDP()
		_ = c.writeTCP(MsgUDPOK, nil)
	case dgFrag:
		c.udpHeard.Store(time.Now().UnixNano())
		if m.epoch != f.epoch || (f.valid && m.seq <= f.last) {
			return
		}
		unit := c.parts.add(m)
		if unit == nil {
			return
		}
		frames, err := unpack(unit)
		if err != nil {
			return
		}
		for _, fr := range frames {
			f.frame(fr.seq, fr.p, true)
		}
		// Before anything is applied every partial unit may be the keyframe waited for.
		if f.valid {
			c.parts.forget(false, f.last)
		}
		c.newest = max(c.newest, m.seq)
		c.ackUDP()
	}
}

// ackUDP tells the host over UDP what this client has applied and, through the seq of the
// newest unit, lets it time the round trip and know the path still works.
func (c *Client) ackUDP() {
	if c.udp == nil {
		return
	}
	var flags uint8
	if c.flow.wantKey {
		flags |= ackWantKey
	}
	_, _ = c.udp.Write(ackDatagram(c.token, c.flow.epoch, c.flow.applied(), c.newest, flags))
}

// askKey asks over TCP for a keyframe while one is wanted, at most every resyncEvery.
func (c *Client) askKey() {
	if !c.flow.wantKey || time.Since(c.askedKey) < resyncEvery {
		return
	}
	c.askedKey = time.Now()
	_ = c.writeTCP(MsgResync, nil)
}
