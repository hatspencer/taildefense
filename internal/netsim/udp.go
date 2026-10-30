package netsim

import (
	"container/heap"
	"errors"
	"net"
	"sync"
	"time"
)

// UDPProxy forwards datagrams on loopback to a target through an impaired path. Unlike the
// TCP proxy its losses are real drops, and with Reorder its jitter may reorder. Each client
// address is a session with its own socket to the target, so replies find their way back.
type UDPProxy struct {
	pc       *net.UDPConn
	target   *net.UDPAddr
	up, down Profile
	seed     uint64

	done chan struct{}
	once sync.Once
	wg   sync.WaitGroup

	mu       sync.Mutex
	sessions map[string]*session
}

type session struct {
	t     *net.UDPConn
	up    *shaper // used by the proxy's read loop only
	upQ   *timeQueue
	downQ *timeQueue
}

// ListenUDP starts a UDP proxy on 127.0.0.1 at a free port in front of target. The same seed
// and the same datagrams in the same order give the same drops and delays.
func ListenUDP(target string, up, down Profile, seed uint64) (*UDPProxy, error) {
	ta, err := net.ResolveUDPAddr("udp", target)
	if err != nil {
		return nil, err
	}
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return nil, err
	}
	p := &UDPProxy{pc: pc, target: ta, up: up, down: down, seed: seed,
		done: make(chan struct{}), sessions: map[string]*session{}}
	p.wg.Add(1)
	go p.read()
	return p, nil
}

// Addr is where to send instead of the target.
func (p *UDPProxy) Addr() string { return p.pc.LocalAddr().String() }

// Close stops forwarding, drops whatever is still in flight and waits for its goroutines.
func (p *UDPProxy) Close() error {
	var err error
	p.once.Do(func() {
		close(p.done)
		err = p.pc.Close()
		p.mu.Lock()
		for _, s := range p.sessions {
			s.t.Close()
		}
		p.mu.Unlock()
		p.wg.Wait()
	})
	return err
}

func (p *UDPProxy) read() {
	defer p.wg.Done()
	n := uint64(0)
	b := make([]byte, 64<<10)
	for {
		k, from, err := p.pc.ReadFromUDP(b)
		if err != nil {
			return
		}
		key := from.String()
		p.mu.Lock()
		s := p.sessions[key]
		p.mu.Unlock()
		if s == nil {
			if s = p.open(from, n); s == nil {
				continue
			}
			n++
		}
		if at, ok := s.up.datagram(time.Now(), k); ok {
			s.upQ.push(at, append([]byte(nil), b[:k]...))
		}
	}
}

// open starts a session for a new client address: a socket to the target, its reader and
// the two queues that release datagrams on time.
func (p *UDPProxy) open(from *net.UDPAddr, n uint64) *session {
	t, err := net.DialUDP("udp", nil, p.target)
	if err != nil {
		return nil
	}
	s := &session{t: t, up: newShaper(p.up, p.seed, 2*n),
		upQ: newTimeQueue(), downQ: newTimeQueue()}
	p.mu.Lock()
	select {
	case <-p.done:
		p.mu.Unlock()
		t.Close()
		return nil
	default:
	}
	p.sessions[from.String()] = s
	p.mu.Unlock()
	down := newShaper(p.down, p.seed, 2*n+1)
	p.wg.Add(3)
	go func() {
		defer p.wg.Done()
		s.upQ.run(p.done, func(b []byte) { _, _ = t.Write(b) })
	}()
	go func() {
		defer p.wg.Done()
		s.downQ.run(p.done, func(b []byte) { _, _ = p.pc.WriteToUDP(b, from) })
	}()
	go func() {
		defer p.wg.Done()
		b := make([]byte, 64<<10)
		for {
			k, err := t.Read(b)
			if err != nil {
				// A refused port on loopback surfaces here as an error of its own; only a closed
				// socket ends the session.
				if errors.Is(err, net.ErrClosed) {
					return
				}
				continue
			}
			if at, ok := down.datagram(time.Now(), k); ok {
				s.downQ.push(at, append([]byte(nil), b[:k]...))
			}
		}
	}()
	return s
}

// timeQueue releases datagrams in order of their release time, ties in order of arrival, so
// a direction without Reorder (whose times only grow) keeps its order exactly.
type timeQueue struct {
	mu   sync.Mutex
	h    dgHeap
	seq  uint64
	wake chan struct{}
}

type datagram struct {
	at  time.Time
	seq uint64
	b   []byte
}

func newTimeQueue() *timeQueue { return &timeQueue{wake: make(chan struct{}, 1)} }

func (q *timeQueue) push(at time.Time, b []byte) {
	q.mu.Lock()
	heap.Push(&q.h, datagram{at, q.seq, b})
	q.seq++
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// run delivers until done closes. It wakes on every push, since a reordered datagram may be
// due before the one it was waiting for.
func (q *timeQueue) run(done <-chan struct{}, deliver func([]byte)) {
	tm := time.NewTimer(time.Hour)
	defer tm.Stop()
	for {
		q.mu.Lock()
		var wait time.Duration = -1
		var due [][]byte
		now := time.Now()
		for q.h.Len() > 0 {
			if d := q.h[0].at.Sub(now); d > 0 {
				wait = d
				break
			}
			due = append(due, heap.Pop(&q.h).(datagram).b)
		}
		q.mu.Unlock()
		for _, b := range due {
			deliver(b)
		}
		if len(due) > 0 {
			continue
		}
		if wait < 0 {
			wait = time.Hour
		}
		tm.Reset(wait)
		select {
		case <-done:
			return
		case <-q.wake:
			if !tm.Stop() {
				select {
				case <-tm.C:
				default:
				}
			}
		case <-tm.C:
		}
	}
}

type dgHeap []datagram

func (h dgHeap) Len() int { return len(h) }
func (h dgHeap) Less(i, j int) bool {
	if !h[i].at.Equal(h[j].at) {
		return h[i].at.Before(h[j].at)
	}
	return h[i].seq < h[j].seq
}
func (h dgHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *dgHeap) Push(x any)   { *h = append(*h, x.(datagram)) }
func (h *dgHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}
