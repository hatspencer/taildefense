// Package tailnet is what taildefense needs from the local Tailscale: this machine's tailnet
// address to listen on, the peers to look for games on, and who is on the other end of a
// connection. It drives the tailscale CLI, the same way microwill does, rather than embedding
// a tailnet node: the machine is already on the tailnet, and the CLI is the stable interface.
package tailnet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

// EnvTailscale overrides the tailscale executable.
const EnvTailscale = "TAILDEFENSE_TAILSCALE"

// macAppCLI is where the Mac App Store and standalone builds keep the CLI when it is not on PATH.
const macAppCLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

// Self is this machine on its tailnet.
type Self struct {
	Binary  string   `json:"binary"`
	Running bool     `json:"running"`
	State   string   `json:"state"`
	DNSName string   `json:"dnsName"`
	Host    string   `json:"host"`
	IPs     []string `json:"ips"`
	Login   string   `json:"login"`
	Name    string   `json:"name"`
	Tailnet string   `json:"tailnet"`
	Version string   `json:"version"`
}

// Peer is another machine on the tailnet.
type Peer struct {
	Host    string   `json:"host"`
	DNSName string   `json:"dnsName"`
	IPs     []string `json:"ips"`
	OS      string   `json:"os"`
	Online  bool     `json:"online"`
	Login   string   `json:"login"`
}

// Addr is the peer's first IPv4 tailnet address, or its first address.
func (p Peer) Addr() string {
	for _, ip := range p.IPs {
		if !strings.Contains(ip, ":") {
			return ip
		}
	}
	if len(p.IPs) > 0 {
		return p.IPs[0]
	}
	return ""
}

// Binary finds the tailscale CLI.
func Binary() (string, error) {
	if v := os.Getenv(EnvTailscale); v != "" {
		return v, nil
	}
	if p, err := exec.LookPath("tailscale"); err == nil {
		return p, nil
	}
	if fi, err := os.Stat(macAppCLI); err == nil && !fi.IsDir() {
		return macAppCLI, nil
	}
	return "", errors.New("tailscale CLI not found: install Tailscale, or set " + EnvTailscale)
}

func run(ctx context.Context, args ...string) ([]byte, error) {
	bin, err := Binary()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, args...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return out, fmt.Errorf("tailscale %s: %s", strings.Join(args, " "), strings.TrimSpace(string(ee.Stderr)))
		}
		return out, fmt.Errorf("tailscale %s: %v", strings.Join(args, " "), err)
	}
	return out, nil
}

type statusJSON struct {
	Version        string
	BackendState   string
	CurrentTailnet *struct{ Name string }
	Self           *nodeJSON
	User           map[string]struct {
		LoginName   string
		DisplayName string
	}
	Peer map[string]nodeJSON
}

type nodeJSON struct {
	HostName     string
	DNSName      string
	TailscaleIPs []string
	OS           string
	Online       bool
	UserID       int64
}

// Status reads `tailscale status --json`: this machine and its peers.
func Status(ctx context.Context) (Self, []Peer, error) {
	var s Self
	bin, err := Binary()
	if err != nil {
		return s, nil, err
	}
	s.Binary = bin
	out, err := run(ctx, "status", "--json")
	if err != nil && len(out) == 0 {
		return s, nil, err
	}
	var st statusJSON
	if jerr := json.Unmarshal(out, &st); jerr != nil {
		if err != nil {
			return s, nil, err
		}
		return s, nil, fmt.Errorf("tailscale status: %v", jerr)
	}
	s.State = st.BackendState
	s.Running = st.BackendState == "Running"
	s.Version = st.Version
	if st.CurrentTailnet != nil {
		s.Tailnet = st.CurrentTailnet.Name
	}
	login := func(uid int64) (string, string) {
		u, ok := st.User[strconv.FormatInt(uid, 10)]
		if !ok {
			return "", ""
		}
		return u.LoginName, u.DisplayName
	}
	if st.Self != nil {
		s.DNSName = strings.TrimSuffix(st.Self.DNSName, ".")
		s.Host = st.Self.HostName
		s.IPs = st.Self.TailscaleIPs
		s.Login, s.Name = login(st.Self.UserID)
	}
	var peers []Peer
	for _, p := range st.Peer {
		l, _ := login(p.UserID)
		peers = append(peers, Peer{Host: p.HostName, DNSName: strings.TrimSuffix(p.DNSName, "."), IPs: p.TailscaleIPs, OS: p.OS, Online: p.Online, Login: l})
	}
	sort.Slice(peers, func(i, j int) bool { return peers[i].Host < peers[j].Host })
	return s, peers, nil
}

// IPv4 is this machine's tailnet IPv4 address, or "".
func (s Self) IPv4() string {
	for _, ip := range s.IPs {
		if !strings.Contains(ip, ":") {
			return ip
		}
	}
	return ""
}

// Identity is who a connection belongs to.
type Identity struct {
	Login string // stable: the reconnect key
	Name  string // display name
	Host  string // their machine
}

// Whois asks tailscaled who is behind a remote address.
func Whois(ctx context.Context, addr string) (Identity, error) {
	out, err := run(ctx, "whois", "--json", addr)
	if err != nil {
		return Identity{}, err
	}
	var w struct {
		Node *struct {
			Name     string
			Hostinfo *struct{ Hostname string }
		}
		UserProfile *struct {
			LoginName   string
			DisplayName string
		}
	}
	if err := json.Unmarshal(out, &w); err != nil {
		return Identity{}, fmt.Errorf("tailscale whois: %v", err)
	}
	var id Identity
	if w.UserProfile != nil {
		id.Login, id.Name = w.UserProfile.LoginName, w.UserProfile.DisplayName
	}
	if w.Node != nil {
		id.Host = strings.SplitN(w.Node.Name, ".", 2)[0]
		if w.Node.Hostinfo != nil && w.Node.Hostinfo.Hostname != "" {
			id.Host = w.Node.Hostinfo.Hostname
		}
	}
	if id.Login == "" {
		return id, errors.New("tailscale whois: no user for " + addr)
	}
	// Tagged devices share one login; tell their players apart by machine.
	if strings.HasPrefix(id.Login, "tagged-devices") && id.Host != "" {
		id.Login = id.Host + "@" + id.Login
	}
	return id, nil
}

// IsTailnetIP reports whether an address is in Tailscale's CGNAT or ULA range.
func IsTailnetIP(ip net.IP) bool {
	if ip4 := ip.To4(); ip4 != nil {
		return ip4[0] == 100 && ip4[1]&0xc0 == 64
	}
	_, ula, _ := net.ParseCIDR("fd7a:115c:a1e0::/48")
	return ula.Contains(ip)
}
