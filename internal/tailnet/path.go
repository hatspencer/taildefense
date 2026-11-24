package tailnet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// How packets reach a peer. A DERP relay adds tens of milliseconds over a direct path, which
// is the difference between a game that feels local and one that lags, so players are told.
const (
	PathDirect    = "direct"     // UDP straight to the peer
	PathDERP      = "derp"       // through a Tailscale DERP server
	PathPeerRelay = "peer-relay" // through another node of the tailnet acting as a relay
	PathIdle      = "idle"       // no traffic lately, so no path chosen yet
	PathLocal     = "local"      // this machine
)

// path classifies a peer from status. Relay is the peer's home DERP and is set even when the
// traffic goes direct, so CurAddr decides first; a DERP path counts only while Active,
// because an idle peer reports no CurAddr whichever way it would go.
func (n nodeJSON) path() (string, string) {
	switch {
	case n.CurAddr != "":
		return PathDirect, n.CurAddr
	case n.PeerRelay != "":
		return PathPeerRelay, n.PeerRelay
	case n.Relay != "" && n.Active:
		return PathDERP, n.Relay
	}
	return PathIdle, ""
}

// PathLabel is a path as a few words for a table: "direct", "DERP fra", "relay", "local", or
// "" when unknown or idle.
func PathLabel(path, via string) string {
	switch path {
	case PathDirect, PathLocal:
		return path
	case PathDERP:
		return strings.TrimSpace("DERP " + via)
	case PathPeerRelay:
		return "relay"
	}
	return ""
}

// PathTo is how packets reach ip right now, from one status read: cheap enough to ask every
// few seconds, and it sends nothing itself. Loopback and this machine's own addresses are
// PathLocal.
func PathTo(ctx context.Context, ip string) (path, via string, err error) {
	if a := net.ParseIP(ip); a != nil && a.IsLoopback() {
		return PathLocal, "", nil
	}
	self, peers, err := Status(ctx)
	if err != nil {
		return "", "", err
	}
	path, via, ok := pathIn(self, peers, ip)
	if !ok {
		return "", "", errors.New("no tailnet peer has address " + ip)
	}
	return path, via, nil
}

func pathIn(self Self, peers []Peer, ip string) (string, string, bool) {
	if a := net.ParseIP(ip); a != nil && a.IsLoopback() {
		return PathLocal, "", true
	}
	for _, s := range self.IPs {
		if s == ip {
			return PathLocal, "", true
		}
	}
	for _, p := range peers {
		for _, a := range p.IPs {
			if a == ip {
				return p.Path, p.Via, true
			}
		}
	}
	return "", "", false
}

// PeerPath is PathTo against a status already read, for callers that hold one.
func PeerPath(self Self, peers []Peer, ip string) (path, via string, ok bool) {
	return pathIn(self, peers, ip)
}

// NetReport is what `tailscale netcheck` found about this machine's network: whether direct
// paths to friends are likely, and how far the nearest DERP is.
type NetReport struct {
	UDP bool // outbound UDP works; without it every path is DERP
	// MappingVariesByDestIP is a hard NAT: each destination sees another public port, so two
	// such machines rarely meet directly. Nil when netcheck could not tell.
	MappingVariesByDestIP *bool
	// UPnP, PMP and PCP are the router protocols tailscale can open a port with. Nil is unknown.
	UPnP, PMP, PCP *bool
	PreferredDERP  int                   // region ID, 0 when none answered
	RegionLatency  map[int]time.Duration // by region ID
}

// PreferredLatency is the round trip to the preferred DERP region, 0 when unknown.
func (r NetReport) PreferredLatency() time.Duration {
	return r.RegionLatency[r.PreferredDERP]
}

// Netcheck runs `tailscale netcheck`, which probes STUN and every DERP region and so takes a
// few seconds.
func Netcheck(ctx context.Context) (NetReport, error) {
	out, err := runFor(ctx, 20*time.Second, "netcheck", "--format=json")
	if err != nil && len(out) == 0 {
		return NetReport{}, err
	}
	r, jerr := parseNetcheck(out)
	if jerr != nil {
		if err != nil {
			return NetReport{}, err
		}
		return NetReport{}, fmt.Errorf("tailscale netcheck: %v", jerr)
	}
	return r, nil
}

// optBool is tailscale's opt.Bool: true, false, or unset, written as a JSON bool, null, or
// in older versions a string.
type optBool struct{ v *bool }

func (o *optBool) UnmarshalJSON(b []byte) error {
	switch strings.Trim(string(b), `"`) {
	case "true":
		t := true
		o.v = &t
	case "false":
		f := false
		o.v = &f
	default:
		o.v = nil
	}
	return nil
}

func parseNetcheck(out []byte) (NetReport, error) {
	// Netcheck may print a line of progress before the document.
	if i := strings.IndexByte(string(out), '{'); i > 0 {
		out = out[i:]
	}
	var j struct {
		UDP                   bool
		MappingVariesByDestIP optBool
		UPnP, PMP, PCP        optBool
		PreferredDERP         int
		RegionLatency         map[string]int64 // nanoseconds
	}
	if err := json.Unmarshal(out, &j); err != nil {
		return NetReport{}, err
	}
	r := NetReport{UDP: j.UDP, MappingVariesByDestIP: j.MappingVariesByDestIP.v, UPnP: j.UPnP.v, PMP: j.PMP.v, PCP: j.PCP.v,
		PreferredDERP: j.PreferredDERP, RegionLatency: map[int]time.Duration{}}
	for k, ns := range j.RegionLatency {
		if id, err := strconv.Atoi(k); err == nil {
			r.RegionLatency[id] = time.Duration(ns)
		}
	}
	return r, nil
}
