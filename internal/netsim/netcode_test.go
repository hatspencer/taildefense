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
// the same profile (commands, acks and echoes stay on the impaired TCP path either way). A
// last pair plays a phone's hotspot: a relayed 130 ms round trip, losses in bursts, and the
// link gone both ways for 2 s a quarter of the way in; its UDP row should show the frames
// back on UDP after the outage (two switches after the first) and gaps outside the outage
// no longer than a burst makes them. It
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
	d := time.Duration(secs) * time.Second
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
	fmt.Fprintf(&table, "%-9s %5s %-4s %7s %8s %8s %8s %8s %7s %8s %8s %6s %6s\n",
		"path", "loss", "via", "frames", "gap p50", "gap p99", "gap max", "max out", ">100ms", "rtt p50", "rtt p99", "on udp", "switch")
	row := func(path, loss string, p netsim.Profile, udp bool) {
		m := measure(t, p, udp, d)
		fmt.Fprintf(&table, "%-9s %5s %-4s %7d %8s %8s %8s %8s %7d %8s %8s %5.0f%% %6d\n",
			path, loss, m.via, len(m.gaps)+1,
			ms(pct(m.gaps, 50)), ms(pct(m.gaps, 99)), ms(pct(m.gaps, 100)), ms(m.maxOut), m.stalls,
			ms(pct(m.rtts, 50)), ms(pct(m.rtts, 99)), 100*m.onUDP, m.switches)
	}
	for _, path := range paths {
		for _, loss := range []float64{0, 0.01, 0.03} {
			for _, udp := range []bool{false, true} {
				row(path.name, fmt.Sprintf("%.0f%%", 100*loss), netsim.Profile{Delay: path.delay, Jitter: path.jitter, Loss: loss}, udp)
			}
		}
	}
	for _, udp := range []bool{false, true} {
		// The outage is set when the case starts, so it is a quarter of the way into each.
		row("hotspot", "burst", hotspot(time.Now().Add(d/4)), udp)
	}
	fmt.Fprintf(&table, "max out: the longest gap that does not overlap an outage; on udp: the share of the\n"+
		"case the frames came over UDP; switch: how often they moved between UDP and TCP\n")
	t.Log(table.String())
}

// hotspot is a phone's hotspot behind a carrier's NAT as a relayed path sees it: 65±20 ms each
// way, half a percent lost at the best of times and bursts of about five packets of which
// half are lost about every hundred packets, and from at on nothing at all for 2 s.
func hotspot(at time.Time) netsim.Profile {
	return netsim.Profile{Delay: 65 * time.Millisecond, Jitter: 20 * time.Millisecond, Loss: 0.005,
		Burst:   &netsim.Burst{Enter: 0.01, Leave: 0.2, Loss: 0.5},
		Outages: []netsim.Outage{{From: at, To: at.Add(2 * time.Second)}}}
}

type measured struct {
	gaps, rtts []time.Duration
	stalls     int
	maxOut     time.Duration // the longest gap that does not overlap an outage
	via        string        // how the frames came at the end, "udp" or "tcp"
	onUDP      float64       // the share of the case they came over UDP
	switches   int           // how often they moved between UDP and TCP
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
	inOutage := func(from, to time.Time) bool {
		for _, o := range p.Outages {
			if from.Before(o.To) && to.After(o.From) {
				return true
			}
		}
		return false
	}
	// The transport is looked at on every ping, ten times a second.
	samples, onUDP, was := 0, 0, ""
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
					if !inOutage(last, now) {
						m.maxOut = max(m.maxOut, gap)
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
			via, _, _ := strings.Cut(c.Transport(), " ")
			samples++
			if via == "udp" {
				onUDP++
			}
			if was != "" && via != was {
				m.switches++
			}
			was = via
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
			m.via, _, _ = strings.Cut(c.Transport(), " ")
			if samples > 0 {
				m.onUDP = float64(onUDP) / float64(samples)
			}
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
