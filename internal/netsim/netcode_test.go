package netsim_test

import (
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"taildefense/internal/game"
	"taildefense/internal/netplay"
	"taildefense/internal/netsim"
)

// TestNetcode plays a real host to a client through the impairment proxy for a matrix of
// delays and losses, and tables what a player would feel: how evenly frames arrive, how often
// they stop for longer than 100 ms (three ticks), and how long a command takes there and
// back. Each case runs twice, frames over TCP and frames over UDP through the UDP proxy with
// the same profile (commands, acks and echoes stay on the impaired TCP path either way). It
// takes minutes, so it runs only with TD_NETSIM=1 (./build.sh netsim); TD_NETSIM_SECS sets how
// long each case plays, 10 by default.
func TestNetcode(t *testing.T) {
	if os.Getenv("TD_NETSIM") == "" {
		t.Skip("set TD_NETSIM=1 to measure the netcode under bad networks (./build.sh netsim)")
	}
	secs := 10
	if v, err := strconv.Atoi(os.Getenv("TD_NETSIM_SECS")); err == nil && v > 0 {
		secs = v
	}
	paths := []struct {
		name          string
		delay, jitter time.Duration
	}{
		{"0ms", 0, 0},
		{"40±10ms", 40 * time.Millisecond, 10 * time.Millisecond},
		{"120±30ms", 120 * time.Millisecond, 30 * time.Millisecond},
	}
	var table strings.Builder
	fmt.Fprintf(&table, "\n%d s a case, delay and loss each way, frames due every %v\n", secs, time.Second/game.TickRate)
	fmt.Fprintf(&table, "%-9s %5s %-4s %7s %8s %8s %8s %7s %8s %8s\n",
		"path", "loss", "via", "frames", "gap p50", "gap p99", "gap max", ">100ms", "rtt p50", "rtt p99")
	for _, path := range paths {
		for _, loss := range []float64{0, 0.01, 0.03} {
			for _, udp := range []bool{false, true} {
				p := netsim.Profile{Delay: path.delay, Jitter: path.jitter, Loss: loss}
				m := measure(t, p, udp, time.Duration(secs)*time.Second)
				fmt.Fprintf(&table, "%-9s %4.0f%% %-4s %7d %8s %8s %8s %7d %8s %8s\n",
					path.name, 100*loss, m.via, len(m.gaps)+1,
					ms(pct(m.gaps, 50)), ms(pct(m.gaps, 99)), ms(pct(m.gaps, 100)), m.stalls,
					ms(pct(m.rtts, 50)), ms(pct(m.rtts, 99)))
			}
		}
	}
	t.Log(table.String())
}

type measured struct {
	gaps, rtts []time.Duration
	stalls     int
	via        string // how the frames came at the end
}

// measure plays one case: a fresh host, a proxy shaping both directions with p, and a client
// that steers and pings the way a player's page would. With udp the client asks for frames
// over UDP and its datagrams go through a UDP proxy with the same profile; the host listens
// for UDP on its TCP port.
func measure(t *testing.T, p netsim.Profile, udp bool, d time.Duration) measured {
	t.Helper()
	s, err := netplay.Listen(netplay.ServerConfig{Addrs: []string{"127.0.0.1:0"}, Seed: 3,
		Version: "test", Host: "box", LocalLogin: "me", LocalName: "me"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	px, err := netsim.Listen(s.Addrs()[0], p, p, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer px.Close()
	h := netplay.Hello{Name: "tester", Version: "test", UDP: udp}
	if udp {
		ux, err := netsim.ListenUDP(s.Addrs()[0], p, p, 1)
		if err != nil {
			t.Fatal(err)
		}
		defer ux.Close()
		h.UDPVia = ux.Addr()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, wel, err := netplay.Dial(ctx, px.Addr(), h)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	r := netplay.NewReplica(wel.W, wel.H, wel.Terrain, wel.You, wel.Seed)

	var m measured
	var last time.Time
	ping := time.NewTicker(100 * time.Millisecond)
	defer ping.Stop()
	end := time.After(d)
	angle := uint8(0)
	for {
		select {
		case msg, ok := <-c.Msgs():
			if !ok {
				t.Fatal("the host went away")
			}
			if msg.Err != nil {
				t.Fatal(msg.Err)
			}
			now := time.Now()
			switch msg.Type {
			case netplay.MsgFrame:
				if err := r.Apply(msg.Payload); err != nil {
					t.Fatal(err)
				}
				if !last.IsZero() {
					gap := now.Sub(last)
					m.gaps = append(m.gaps, gap)
					if gap > 100*time.Millisecond {
						m.stalls++
					}
				}
				last = now
			case netplay.MsgEcho:
				if len(msg.Payload) == 8 {
					sent := time.Unix(0, int64(binary.BigEndian.Uint64(msg.Payload)))
					m.rtts = append(m.rtts, now.Sub(sent))
				}
			}
		case <-ping.C:
			// A ping a tick behind a steer, as a held key sends input while the page measures.
			angle += 8
			if err := c.Send(netplay.Cmd{Op: netplay.OpSteer, A: angle, B: 1}); err != nil {
				t.Fatal(err)
			}
			if err := c.Echo(binary.BigEndian.AppendUint64(nil, uint64(time.Now().UnixNano()))); err != nil {
				t.Fatal(err)
			}
		case <-end:
			if !r.Synced {
				t.Fatalf("%+v: the replica never synced", p)
			}
			m.via = c.Transport()
			return m
		}
	}
}

// pct is the q-th percentile of v, 100 its maximum.
func pct(v []time.Duration, q int) time.Duration {
	if len(v) == 0 {
		return 0
	}
	s := slices.Clone(v)
	slices.Sort(s)
	return s[min(len(s)-1, len(s)*q/100)]
}

func ms(d time.Duration) string {
	return strconv.FormatFloat(float64(d)/float64(time.Millisecond), 'f', 0, 64) + "ms"
}
