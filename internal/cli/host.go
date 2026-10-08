package cli

import (
	"context"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"taildefense/internal/config"
	"taildefense/internal/netplay"
	"taildefense/internal/tailnet"
)

// EnvListen replaces the addresses a host listens on, as a comma separated list of host or
// host:port. For a machine whose tailnet address the CLI does not report, or a test on a LAN.
const EnvListen = "TAILDEFENSE_LISTEN"

// tailnetStatus is tailnet.Status, a variable so tests can stand in for tailscale.
var tailnetStatus = tailnet.Status

// HostOptions are how a game is hosted.
type HostOptions struct {
	Port    int    // 0 is netplay.DefaultPort
	Seed    uint64 // 0 picks one from the clock
	Name    string // the hosting player's name; "" is the tailnet first name
	Version string // this build, shown to everyone who probes the game
}

// HostPlan is a host worked out from the tailnet before anything listens: the server's
// configuration, the command friends type, and what the person hosting should know.
type HostPlan struct {
	Config netplay.ServerConfig
	// Hint is the command a friend runs to join, "td join box". Empty when nobody but this
	// machine can reach the game.
	Hint string
	// Notes are things worth saying before the game starts, such as tailscale being down.
	Notes []string
	// Self is this machine on the tailnet, zero when tailscale did not answer.
	Self tailnet.Self
}

// HostConfig works out where and as whom to host.
//
// It listens on this machine's tailnet IPv4 address and on loopback, and nowhere else. Never
// 0.0.0.0: the game has no authentication of its own, it relies on the tailnet saying who
// is connecting, so an address the tailnet does not cover must not accept anyone. Loopback
// is there for the host's own player and for `td ls` on this machine.
func HostConfig(ctx context.Context, o HostOptions) (HostPlan, error) {
	return hostConfig(ctx, tailnetStatus, o)
}

func hostConfig(ctx context.Context, status func(context.Context) (tailnet.Self, []tailnet.Peer, error), o HostOptions) (HostPlan, error) {
	if o.Port == 0 {
		o.Port = netplay.DefaultPort
	}
	if o.Port < 1 || o.Port > 65535 {
		return HostPlan{}, fmt.Errorf("port %d is out of range", o.Port)
	}
	seed := o.Seed
	if seed == 0 {
		seed = uint64(time.Now().UnixNano())
	}
	port := strconv.Itoa(o.Port)

	var plan HostPlan
	self, _, err := status(ctx)
	up := err == nil && self.Running && self.IPv4() != ""
	if err == nil {
		plan.Self = self
	}

	var addrs []string
	if env := strings.TrimSpace(os.Getenv(EnvListen)); env != "" {
		for _, a := range strings.Split(env, ",") {
			if a = strings.TrimSpace(a); a == "" {
				continue
			}
			if _, _, err := net.SplitHostPort(a); err != nil {
				a = net.JoinHostPort(strings.Trim(a, "[]"), port)
			}
			addrs = append(addrs, a)
		}
		if len(addrs) == 0 {
			return HostPlan{}, fmt.Errorf("%s names no address", EnvListen)
		}
		plan.Notes = append(plan.Notes, fmt.Sprintf("listening where %s says: %s", EnvListen, strings.Join(addrs, ", ")))
	} else {
		if up {
			addrs = append(addrs, net.JoinHostPort(self.IPv4(), port))
		}
		addrs = append(addrs, net.JoinHostPort("127.0.0.1", port))
	}

	switch {
	case err != nil:
		plan.Notes = append(plan.Notes, "tailscale did not answer, so only this machine can join: "+oneLine(err.Error()))
	case !self.Running:
		state := self.State
		if state == "" {
			state = "not running"
		}
		plan.Notes = append(plan.Notes, "tailscale is "+strings.ToLower(state)+", so only this machine can join; start it with: tailscale up")
	case self.IPv4() == "":
		plan.Notes = append(plan.Notes, "this machine has no tailnet IPv4 address, so only it can join")
	}

	login := self.Login
	if login == "" {
		login = config.LocalUser() + "@local"
	}
	name := strings.TrimSpace(o.Name)
	if name == "" {
		if f := strings.Fields(self.Name); len(f) > 0 {
			name = f[0]
		} else {
			name = config.LocalUser()
		}
	}
	host := self.Host
	if host == "" {
		host, _ = os.Hostname()
	}

	plan.Config = netplay.ServerConfig{
		Addrs:      addrs,
		Seed:       seed,
		Version:    o.Version,
		Host:       host,
		Owner:      login,
		LocalLogin: login,
		LocalName:  name,
		Whois:      tailnet.Whois,
	}
	if up || os.Getenv(EnvListen) != "" {
		plan.Hint = JoinCommand(shortHost(self, host), o.Port)
	}
	return plan, nil
}

// JoinCommand is what a friend types: the MagicDNS short name, with the port only when it is
// not the default.
func JoinCommand(host string, port int) string {
	if port != 0 && port != netplay.DefaultPort {
		return "td join " + net.JoinHostPort(host, strconv.Itoa(port))
	}
	return "td join " + host
}

// shortHost is the first label of the MagicDNS name, which is what resolves on every other
// machine of the tailnet; the OS host name is only a fallback, it may differ.
func shortHost(self tailnet.Self, fallback string) string {
	if h, _, _ := strings.Cut(self.DNSName, "."); h != "" {
		return h
	}
	if self.Host != "" {
		return self.Host
	}
	return fallback
}

// StartHost works out a host and starts listening. The caller closes the server.
func StartHost(ctx context.Context, o HostOptions, log func(string, ...any)) (*netplay.Server, HostPlan, error) {
	plan, err := HostConfig(ctx, o)
	if err != nil {
		return nil, plan, err
	}
	plan.Config.Log = log
	srv, err := netplay.Listen(plan.Config)
	if err != nil {
		if strings.Contains(err.Error(), "address already in use") {
			return nil, plan, fmt.Errorf("%v: is a game already hosted here? td ls shows it; td host --port N picks another port", err)
		}
		return nil, plan, err
	}
	return srv, plan, nil
}

// HostStatus is the HUD line for the person hosting: who can join and how many have.
func HostStatus(srv *netplay.Server, plan HostPlan) func() string {
	return func() string {
		in := srv.Info()
		s := fmt.Sprintf("hosting · %d/%d", len(in.Players), in.Max)
		if plan.Hint != "" {
			s += " · friends: " + plan.Hint
		} else {
			s += " · this machine only"
		}
		return s
	}
}
