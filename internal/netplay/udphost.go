package netplay

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"time"

	"taildefense/internal/game"
)

// udpTimeout is how long a player's frames go over UDP with nothing coming back before the
// host takes the path for broken and sends them over TCP again.
const udpTimeout = 1500 * time.Millisecond

// udpHistory is how many deltas before its own a unit may repeat.
const udpHistory = 2

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
	if p == nil || p.gone || p.udpDead {
		return
	}
	switch in.m.typ {
	case dgHello:
		if in.sock != p.ln || !sameIP(in.from, p.conn.RemoteAddr()) {
			return
		}
		if !p.udpOn {
			p.udpAddr = in.from
		}
		if in.from == p.udpAddr {
			_, _ = s.udps[p.ln].WriteToUDPAddrPort(helloDatagram(dgHelloAck, p.udpTok), in.from)
		}
	case dgAck:
		if !p.udpOn || in.from != p.udpAddr {
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
		if p.seqFrames && p.udpAddr.IsValid() && !p.udpDead && !p.udpOn {
			p.udpOn, p.udpAck = true, now
			s.cfg.Log("%s gets frames over UDP at %s", p.name, p.udpAddr)
		}
	case MsgResync:
		s.askKey(p, now)
	}
}

// askKey sends a player a keyframe on the next tick, unless one went out too lately to have
// arrived yet: a want sent before it came is no reason for another.
func (s *Server) askKey(p *peer, now time.Time) {
	if p.needKey || now.Sub(p.keyAt) < max(2*p.srtt, 3*time.Second/game.TickRate) {
		return
	}
	p.needKey, p.dropKey = true, true
}

// udpFallback puts a player's frames back on TCP, with a keyframe since datagrams were lost.
func (s *Server) udpFallback(p *peer, why string) {
	p.udpOn, p.udpDead = false, true
	p.needKey = true
	s.cfg.Log("%s gets frames over TCP again: %s", p.name, why)
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
	budget := max(fragData, 2*len(best))
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
	for _, dg := range dgs {
		// A full socket buffer loses the datagram, which the client recovers from as from
		// any other loss.
		_, _ = pc.WriteToUDPAddrPort(dg, p.udpAddr)
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
