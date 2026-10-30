package netplay

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"time"

	"taildefense/internal/game"
)

// udpTimeoutMin is the shortest a player's frames go over UDP with nothing coming back before
// the host takes the path for broken and sends them over TCP again.
const udpTimeoutMin = 1500 * time.Millisecond

// udpTimeout is that wait for a player whose datagrams take srtt there and back. A relayed
// link, a phone's hotspot through a carrier's NAT, can take a few hundred milliseconds a round
// trip and hold a burst of them in a queue; four round trips with nothing back says the path
// is gone, where a fixed wait would take a slow path for a dead one.
func udpTimeout(srtt time.Duration) time.Duration {
	return max(udpTimeoutMin, 4*srtt)
}

// udpHoldMin and udpHoldMax bound how long after a fallback the host leaves a player's
// hellos unanswered, so a link that comes and goes is not switched back and forth every
// second. The first fallback holds nothing: it is most often an outage, a phone's hotspot
// gone for a moment, through most of which the timeout ran already, and the frames should
// be back on UDP as soon as it ends. Each further fallback in a row holds twice as long,
// from udpHoldMin up to udpHoldMax, and a path that held for udpSettled starts the count again.
const (
	udpHoldMin = time.Second
	udpHoldMax = 10 * time.Second
	udpSettled = 30 * time.Second
)

// udpHold is how long the host waits after the n-th fallback in a row before it answers the
// player's hello again.
func udpHold(n int) time.Duration {
	if n <= 1 {
		return 0
	}
	d := udpHoldMin
	for i := 2; i < n && d < udpHoldMax; i++ {
		d *= 2
	}
	return min(d, udpHoldMax)
}

// udpHistory is how many deltas before its own a unit may repeat.
const udpHistory = 2

// udpKeyFrags is the most datagrams a keyframe goes over UDP in; a bigger one goes over TCP.
const udpKeyFrags = 8

// udpWriteWait is the longest the tick loop waits on a player's UDP socket in a tick.
const udpWriteWait = 5 * time.Millisecond

// udpIn is a datagram a host's UDP socket read, for the tick loop.
type udpIn struct {
	sock int // which listener's socket
	from netip.AddrPort
	m    datagram
}

// listenUDP opens a UDP socket on every TCP listener's address, the same addresses and ports,
// so UDP is had on exactly what the host was told to listen on (the tailnet, never 0.0.0.0).
// A socket that cannot be had leaves that listener's players on TCP.
func (s *Server) listenUDP() {
	s.udps = make([]*net.UDPConn, len(s.lns))
	if s.cfg.NoUDP || udpDisabled() {
		return
	}
	for i, ln := range s.lns {
		ta, ok := ln.Addr().(*net.TCPAddr)
		if !ok {
			continue
		}
		pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: ta.IP, Port: ta.Port, Zone: ta.Zone})
		if err != nil {
			s.cfg.Log("no UDP on %s, frames go over TCP: %v", ta, err)
			continue
		}
		s.udps[i] = pc
		s.wg.Add(1)
		go s.udpLoop(i, pc)
	}
}

func (s *Server) udpLoop(i int, pc *net.UDPConn) {
	defer s.wg.Done()
	buf := make([]byte, 2048)
	for {
		n, from, err := pc.ReadFromUDPAddrPort(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		m, ok := parseDatagram(buf[:n])
		if !ok || (m.typ != dgHello && m.typ != dgAck) {
			continue
		}
		// A token never given out is dropped here, so a flood of strangers' datagrams cannot
		// crowd the players' out of udpCh.
		if _, known := s.toks.Load(m.token); !known {
			continue
		}
		// The tick loop may be busy; a datagram dropped here is like one lost on the way.
		select {
		case s.udpCh <- udpIn{i, from, m}:
		default:
		}
	}
}

// offerUDP gives a player who asked for UDP a token and the port, right behind its welcome.
func (s *Server) offerUDP(p *peer) {
	pc := s.udps[p.ln]
	if !p.wantUDP || pc == nil {
		return
	}
	var t [8]byte
	for p.udpTok == 0 || s.byTok[p.udpTok] != nil {
		_, _ = rand.Read(t[:])
		p.udpTok = binary.LittleEndian.Uint64(t[:])
	}
	s.byTok[p.udpTok] = p
	s.toks.Store(p.udpTok, struct{}{})
	p.seqFrames = true
	o := udpOffer{Port: uint16(pc.LocalAddr().(*net.UDPAddr).Port), Token: p.udpTok, Epoch: s.epoch}
	p.out <- outMsg{MsgUDP, o.encode()}
}

// sameIP reports whether a datagram came from the machine at the far end of the TCP
// connection: the tailnet said who that is, and a token alone must not make anyone else them.
func sameIP(from netip.AddrPort, tcp net.Addr) bool {
	ta, ok := tcp.(*net.TCPAddr)
	if !ok {
		return false
	}
	ip, ok := netip.AddrFromSlice(ta.IP)
	return ok && ip.Unmap() == from.Addr().Unmap()
}

// udpDatagram takes a hello or an ack from a player's socket.
func (s *Server) udpDatagram(in udpIn, now time.Time) {
	p := s.byTok[in.m.token]
	if p == nil || p.gone {
		return
	}
	switch in.m.typ {
	case dgHello:
		if in.sock != p.ln || !sameIP(in.from, p.conn.RemoteAddr()) {
			return
		}
		// Fallen back lately: no answer yet, so the player keeps its frames on TCP a while.
		if !p.udpOn && now.Before(p.udpHoldTo) {
			return
		}
		// A NAT may give the player's socket another port mid-game; its hello, from the same
		// machine with the same token, moves the frames there before the old port's silence
		// would put them on TCP.
		if p.udpOn && in.from != p.udpAddr && p.udpAddr.IsValid() {
			s.cfg.Log("%s's UDP moved from %s to %s", p.name, p.udpAddr, in.from)
		}
		p.udpAddr = in.from
		if !p.udpOn {
			p.udpHelloAt = now
		}
		pc := s.udps[p.ln]
		// The socket keeps the deadline of the last frame sent on it, long past by now.
		_ = pc.SetWriteDeadline(time.Now().Add(udpWriteWait))
		_, _ = pc.WriteToUDPAddrPort(helloDatagram(dgHelloAck, p.udpTok), in.from)
	case dgAck:
		if in.sock != p.ln || in.from != p.udpAddr {
			return
		}
		// An ack while the frames go over TCP confirms the answer to a hello, as MsgUDPOK
		// does: the client sends both on the answer, and this one does not wait behind a TCP
		// backlog the outage left. It names the newest frame from before the fallback, no
		// round trip to time.
		if !p.udpOn {
			s.udpUp(p, now)
			return
		}
		p.udpAck = now
		if e := s.sentAt[in.m.newest%uint32(len(s.sentAt))]; e.seq == in.m.newest && !e.at.IsZero() {
			rtt := now.Sub(e.at)
			if p.srtt == 0 {
				p.srtt = rtt
			} else {
				p.srtt += (rtt - p.srtt) / 8
			}
		}
		// A want from before the restart is for a map the player is about to leave.
		if in.m.flags&ackWantKey != 0 && in.m.epoch == s.epoch {
			s.askKey(p, now)
		}
	}
}

// control takes MsgUDPOK and MsgResync from a player's TCP connection.
func (s *Server) control(p *peer, typ byte, now time.Time) {
	if p.gone {
		return
	}
	switch typ {
	case MsgUDPOK:
		s.udpUp(p, now)
	case MsgResync:
		s.askKey(p, now)
	}
}

// udpUp puts a player's frames on UDP, which a client confirmed by answering a hello.
func (s *Server) udpUp(p *peer, now time.Time) {
	// Only a hello answered since the hold ended counts: a confirmation, or an ack, from
	// before the fallback may arrive after it, and says nothing of the path now.
	if !p.seqFrames || !p.udpAddr.IsValid() || p.udpOn || now.Before(p.udpHoldTo) ||
		p.udpHelloAt.IsZero() || p.udpHelloAt.Before(p.udpHoldTo) {
		return
	}
	p.udpOn, p.udpAck, p.udpSince = true, now, now
	// Back from TCP, the first datagram is a keyframe: frames still queued on the TCP
	// connection come behind it and are dropped as old, so no delta goes on a base the
	// player does not have.
	if p.udpFalls > 0 {
		p.needKey = true
	}
	s.cfg.Log("%s gets frames over UDP at %s", p.name, p.udpAddr)
}

// askKey sends a player a keyframe on the next tick, unless one went out too lately to have
// arrived yet: a want sent before it came is no reason for another.
func (s *Server) askKey(p *peer, now time.Time) {
	if p.needKey || now.Sub(p.keyAt) < max(2*p.srtt, 3*time.Second/game.TickRate) {
		return
	}
	p.needKey, p.dropKey = true, true
}

// checkUDP puts a player's frames on TCP once nothing has come back over UDP for longer than
// the path's round trip makes plausible.
func (s *Server) checkUDP(p *peer, now time.Time) {
	if wait := udpTimeout(p.srtt); p.udpOn && now.Sub(p.udpAck) > wait {
		s.udpFallback(p, now, fmt.Sprintf("nothing back over UDP for %v", wait.Round(time.Millisecond)))
	}
}

// udpFallback puts a player's frames back on TCP, with a keyframe since datagrams were lost.
// The token and the binding stay: the player's hellos go on, and once the hold is over the
// host answers one and the frames come back to UDP.
func (s *Server) udpFallback(p *peer, now time.Time, why string) {
	if now.Sub(p.udpSince) >= udpSettled {
		p.udpFalls = 0
	}
	p.udpFalls++
	hold := udpHold(p.udpFalls)
	p.udpOn, p.udpHoldTo = false, now.Add(hold)
	p.needKey = true
	again := "at once"
	if hold > 0 {
		again = "in " + hold.String()
	}
	s.cfg.Log("%s gets frames over TCP again: %s; UDP is tried again %s", p.name, why, again)
}

// udpFrames builds this tick's datagrams lazily, once for every player on UDP: the keyframe's
// and the delta's, which repeats the deltas before it while that no more than doubles it.
type udpFrames struct {
	s          *Server
	seq        uint32
	delta, key func() []byte
	dDgs, kDgs [][]byte
}

func (u *udpFrames) deltaDgs() [][]byte {
	if u.dDgs != nil {
		return u.dDgs
	}
	s := u.s
	cur := seqFrame{u.seq, u.delta()}
	frames := []seqFrame{cur}
	best := s.packer.pack(frames)
	// Repeats may fill out a lone datagram or double it; a unit already in pieces takes them
	// only while they add no piece, since every piece is another chance to lose the unit.
	budget := max(fragData, 2*len(best))
	if n := (len(best) + fragData - 1) / fragData; n > 1 {
		budget = min(2*len(best), n*fragData)
	}
	for i := len(s.hist) - 1; i >= 0; i-- {
		h := s.hist[i]
		if h.seq != frames[0].seq-1 {
			break
		}
		frames = append([]seqFrame{h}, frames...)
		unit := s.packer.pack(frames)
		if len(unit) > budget {
			break
		}
		best = unit
	}
	u.dDgs = fragment(s.epoch, u.seq, best)
	return u.dDgs
}

func (u *udpFrames) keyDgs() [][]byte {
	if u.kDgs == nil {
		u.kDgs = fragment(u.s.epoch, u.seq, u.s.packer.pack([]seqFrame{{u.seq, u.key()}}))
	}
	return u.kDgs
}

// sendUDP sends a player its frame of this tick as datagrams; false if it cannot go that way.
func (s *Server) sendUDP(p *peer, dgs [][]byte) bool {
	if len(dgs) == 0 {
		return false
	}
	pc := s.udps[p.ln]
	// The tick loop must not wait on a socket: past the deadline the rest of the frame is
	// lost, which the client recovers from as from any other loss.
	_ = pc.SetWriteDeadline(time.Now().Add(udpWriteWait))
	for _, dg := range dgs {
		if _, err := pc.WriteToUDPAddrPort(dg, p.udpAddr); errors.Is(err, os.ErrDeadlineExceeded) {
			break
		}
	}
	return true
}

// remember keeps this tick's delta for the units after it to repeat.
func (s *Server) remember(seq uint32, delta []byte) {
	if len(s.hist) == udpHistory {
		s.hist = append(s.hist[:0], s.hist[1:]...)
	}
	s.hist = append(s.hist, seqFrame{seq, append([]byte(nil), delta...)})
}
