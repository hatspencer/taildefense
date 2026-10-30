package netsim

import (
	"net"
	"sync"
	"time"
)

// Proxy is a TCP proxy on loopback that forwards every connection to a target through an
// impaired path, up (client to target) and down (target to client) shaped on their own.
type Proxy struct {
	ln       net.Listener
	target   string
	up, down Profile
	seed     uint64

	done chan struct{}
	once sync.Once
	wg   sync.WaitGroup

	mu    sync.Mutex
	conns map[net.Conn]struct{}
	n     uint64
}

// chunk is one read from a connection and when the far end may have it.
type chunk struct {
	b  []byte
	at time.Time
}

// queued bounds a direction's backlog in reads, so a capped link pushes back on its sender
// instead of buffering without end.
const queued = 256

// Listen starts a proxy on 127.0.0.1 at a free port in front of target. The same seed gives
// the same jitter and losses read for read; how the kernel splits a stream into reads is
// still up to timing.
func Listen(target string, up, down Profile, seed uint64) (*Proxy, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	p := &Proxy{ln: ln, target: target, up: up, down: down, seed: seed,
		done: make(chan struct{}), conns: map[net.Conn]struct{}{}}
	p.wg.Add(1)
	go p.accept()
	return p, nil
}

// Addr is where to connect instead of the target.
func (p *Proxy) Addr() string { return p.ln.Addr().String() }

// Close stops accepting, cuts every connection and waits for its goroutines.
func (p *Proxy) Close() error {
	var err error
	p.once.Do(func() {
		close(p.done)
		err = p.ln.Close()
		p.mu.Lock()
		for c := range p.conns {
			c.Close()
		}
		p.mu.Unlock()
		p.wg.Wait()
	})
	return err
}

// track records c so Close can cut it; false when the proxy is already closing.
func (p *Proxy) track(c net.Conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	select {
	case <-p.done:
		return false
	default:
	}
	p.conns[c] = struct{}{}
	return true
}

func (p *Proxy) untrack(c net.Conn) {
	p.mu.Lock()
	delete(p.conns, c)
	p.mu.Unlock()
}

func (p *Proxy) accept() {
	defer p.wg.Done()
	for {
		c, err := p.ln.Accept()
		if err != nil {
			return
		}
		p.mu.Lock()
		n := p.n
		p.n++
		p.mu.Unlock()
		p.wg.Add(1)
		go p.serve(c, n)
	}
}

// serve forwards one connection. Each gets its own pair of random streams so a second
// connection does not shift the losses of the first.
func (p *Proxy) serve(c net.Conn, n uint64) {
	defer p.wg.Done()
	if !p.track(c) {
		c.Close()
		return
	}
	defer p.untrack(c)
	t, err := net.DialTimeout("tcp", p.target, 5*time.Second)
	if err != nil {
		c.Close()
		return
	}
	if !p.track(t) {
		c.Close()
		t.Close()
		return
	}
	defer p.untrack(t)
	dead := make(chan struct{})
	var once sync.Once
	kill := func() {
		once.Do(func() {
			close(dead)
			c.Close()
			t.Close()
		})
	}
	var pipes sync.WaitGroup
	pipes.Add(2)
	go func() {
		defer pipes.Done()
		p.pipe(c, t, newShaper(p.up, p.seed, 2*n), dead, kill)
	}()
	go func() {
		defer pipes.Done()
		p.pipe(t, c, newShaper(p.down, p.seed, 2*n+1), dead, kill)
	}()
	pipes.Wait()
	kill()
}

// pipe carries src to dst, each read released at its scheduled time. A clean end of src is
// passed on as a half close, so either side can finish sending and still hear the other.
func (p *Proxy) pipe(src, dst net.Conn, s *shaper, dead <-chan struct{}, kill func()) {
	q := make(chan chunk, queued)
	go func() {
		defer close(q)
		for {
			b := make([]byte, 32<<10)
			n, err := src.Read(b)
			if n > 0 {
				select {
				case q <- chunk{b[:n], s.stream(time.Now(), n)}:
				case <-dead:
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	stop := merge(dead, p.done)
	for ch := range q {
		if !sleepUntil(ch.at, stop) {
			kill()
			break
		}
		if _, err := dst.Write(ch.b); err != nil {
			kill()
			break
		}
	}
	for range q {
		// Drain so the reader is never left blocked on a direction that died.
	}
	if tc, ok := dst.(*net.TCPConn); ok {
		_ = tc.CloseWrite()
	}
}

// merge closes its result when either a or b closes.
func merge(a, b <-chan struct{}) <-chan struct{} {
	out := make(chan struct{})
	go func() {
		select {
		case <-a:
		case <-b:
		}
		close(out)
	}()
	return out
}
