package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"taildefense/internal/config"
	"taildefense/internal/netplay"
	"taildefense/internal/tailnet"
	"taildefense/internal/version"
)

func upTailnet(context.Context) (tailnet.Self, []tailnet.Peer, error) {
	return tailnet.Self{
		Running: true, State: "Running", DNSName: "box.tail1234.ts.net", Host: "Box-Laptop",
		IPs: []string{"100.64.0.7", "fd7a:115c:a1e0::7"}, Login: "ada@example.com", Name: "Ada Lovelace",
	}, []tailnet.Peer{{Host: "pal", IPs: []string{"100.64.0.9"}, Online: true}, {Host: "gone", IPs: []string{"100.64.0.10"}}}, nil
}

func downTailnet(context.Context) (tailnet.Self, []tailnet.Peer, error) {
	return tailnet.Self{State: "Stopped"}, nil, nil
}

func noTailscale(context.Context) (tailnet.Self, []tailnet.Peer, error) {
	return tailnet.Self{}, nil, errors.New("tailscale CLI not found")
}

func TestDefaultPortsAgree(t *testing.T) {
	if config.DefaultPort != netplay.DefaultPort {
		t.Fatalf("config.DefaultPort %d != netplay.DefaultPort %d", config.DefaultPort, netplay.DefaultPort)
	}
}

func TestHostListensOnTheTailnetAndLoopbackOnly(t *testing.T) {
	t.Setenv(EnvListen, "")
	plan, err := hostConfig(context.Background(), upTailnet, HostOptions{Port: 7787, Version: "abc1234"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"100.64.0.7:7787", "127.0.0.1:7787"}
	if !reflect.DeepEqual(plan.Config.Addrs, want) {
		t.Errorf("addrs %v, want %v", plan.Config.Addrs, want)
	}
	for _, a := range plan.Config.Addrs {
		if strings.HasPrefix(a, "0.0.0.0") || strings.HasPrefix(a, ":") || strings.HasPrefix(a, "[::]") {
			t.Errorf("listening on every interface: %s", a)
		}
	}
	c := plan.Config
	if c.LocalLogin != "ada@example.com" || c.Owner != "ada@example.com" || c.LocalName != "Ada" || c.Host != "Box-Laptop" {
		t.Errorf("identity: %+v", c)
	}
	if c.Seed == 0 || c.Whois == nil || c.Version != "abc1234" {
		t.Errorf("seed %d whois %v version %q", c.Seed, c.Whois != nil, c.Version)
	}
	if plan.Hint != "td join box" {
		t.Errorf("hint %q: the MagicDNS short name, not the OS host name", plan.Hint)
	}
	if len(plan.Notes) != 0 {
		t.Errorf("notes on a healthy tailnet: %v", plan.Notes)
	}
}

func TestHostWithoutTailscaleIsLoopbackOnly(t *testing.T) {
	t.Setenv(EnvListen, "")
	t.Setenv("USER", "dan")
	for name, status := range map[string]func(context.Context) (tailnet.Self, []tailnet.Peer, error){
		"stopped": downTailnet, "missing": noTailscale,
	} {
		plan, err := hostConfig(context.Background(), status, HostOptions{Port: 9000, Seed: 42})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !reflect.DeepEqual(plan.Config.Addrs, []string{"127.0.0.1:9000"}) {
			t.Errorf("%s: addrs %v", name, plan.Config.Addrs)
		}
		if plan.Hint != "" || len(plan.Notes) == 0 || !strings.Contains(plan.Notes[0], "only this machine") {
			t.Errorf("%s: hint %q notes %v", name, plan.Hint, plan.Notes)
		}
		if plan.Config.LocalLogin != "dan@local" || plan.Config.LocalName != "dan" || plan.Config.Seed != 42 {
			t.Errorf("%s: %+v", name, plan.Config)
		}
	}
}

func TestListenOverride(t *testing.T) {
	t.Setenv(EnvListen, "192.168.1.5, 10.0.0.2:8000 ,")
	plan, err := hostConfig(context.Background(), upTailnet, HostOptions{Port: 7790, Name: "Grace"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"192.168.1.5:7790", "10.0.0.2:8000"}; !reflect.DeepEqual(plan.Config.Addrs, want) {
		t.Errorf("addrs %v, want %v", plan.Config.Addrs, want)
	}
	if plan.Config.LocalName != "Grace" {
		t.Errorf("an explicit name must win: %q", plan.Config.LocalName)
	}
	if plan.Hint != "td join box:7790" {
		t.Errorf("hint %q", plan.Hint)
	}
}

func TestLsJSONShape(t *testing.T) {
	isolate(t)
	tailnetStatus = upTailnet
	discover = func(_ context.Context, self tailnet.Self, peers []tailnet.Peer, port int) []netplay.Found {
		if port != 7787 || len(peers) != 2 {
			t.Errorf("discover asked port %d with %d peers", port, len(peers))
		}
		return []netplay.Found{
			{Info: netplay.Info{Proto: netplay.Proto, Version: version.Current(), Host: "pal", Owner: "bob@x", Players: []string{"bob"}, Max: 4, Wave: 3, Phase: "fight"},
				Addr: "100.64.0.9:7787", Peer: "pal", RTT: 12 * time.Millisecond},
			{Info: netplay.Info{Proto: netplay.Proto + 1, Version: "fff0000", Host: "box", Max: 4},
				Addr: "127.0.0.1:7787", Peer: "box (this machine)"},
			{Info: netplay.Info{Proto: netplay.Proto, Version: "fff0000", Host: "attic", Max: 4},
				Addr: "100.64.0.7:7787", Peer: "attic"},
		}
	}
	t.Cleanup(func() { tailnetStatus, discover = tailnet.Status, netplay.Discover })

	var b bytes.Buffer
	if code := Ls(&b, LsOptions{Port: 7787, JSON: true}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	var doc map[string]any
	if err := json.Unmarshal(b.Bytes(), &doc); err != nil {
		t.Fatalf("%v: %s", err, b.String())
	}
	keys := func(m map[string]any) []string {
		var out []string
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	if got := keys(doc); !reflect.DeepEqual(got, []string{"games", "port", "proto", "tailnet"}) {
		t.Errorf("top level keys %v", got)
	}
	games := doc["games"].([]any)
	if len(games) != 3 {
		t.Fatalf("games %v", games)
	}
	g0 := games[0].(map[string]any)
	want := []string{"addr", "compatible", "host", "max", "owner", "peer", "phase", "pingMs", "players", "proto", "version", "wave"}
	if got := keys(g0); !reflect.DeepEqual(got, want) {
		t.Errorf("game keys %v, want %v", got, want)
	}
	if g0["compatible"] != true || g0["pingMs"] != float64(12) {
		t.Errorf("game 0: %v", g0)
	}
	g1 := games[1].(map[string]any)
	if g1["compatible"] != false {
		t.Errorf("another protocol must be incompatible: %v", g1)
	}
	if g2 := games[2].(map[string]any); g2["compatible"] != false {
		t.Errorf("another td on the same protocol must be incompatible: %v", g2)
	}
	if p, ok := g1["players"].([]any); !ok || len(p) != 0 {
		t.Errorf("no players must be [], not null: %v", g1["players"])
	}
	tn := doc["tailnet"].(map[string]any)
	if tn["running"] != true || tn["ip"] != "100.64.0.7" || tn["peersOnline"] != float64(1) {
		t.Errorf("tailnet %v", tn)
	}
}

func TestLsWithoutTailscaleStillAsksThisMachine(t *testing.T) {
	isolate(t)
	tailnetStatus = noTailscale
	asked := false
	discover = func(_ context.Context, _ tailnet.Self, peers []tailnet.Peer, _ int) []netplay.Found {
		asked = true
		if len(peers) != 0 {
			t.Errorf("peers without tailscale: %v", peers)
		}
		return nil
	}
	t.Cleanup(func() { tailnetStatus, discover = tailnet.Status, netplay.Discover })
	var b bytes.Buffer
	if code := Ls(&b, LsOptions{JSON: true}); code != 0 || !asked {
		t.Fatalf("exit %d asked %v", code, asked)
	}
	var res LsResult
	if err := json.Unmarshal(b.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Tailnet.Running || res.Tailnet.Error == "" || res.Games == nil || res.Port != netplay.DefaultPort {
		t.Errorf("got %+v", res)
	}
}

func TestConfigCommandShowsGetsAndSets(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(config.EnvConfigDir, dir)
	t.Setenv("TAILDEFENSE_PORT", "")
	t.Setenv("TAILDEFENSE_BROWSER", "firefox")
	config.TailnetName = func() string { return "" }

	var b bytes.Buffer
	if code := Config(&b, config.Load(), []string{"port", "8100"}); code != 0 {
		t.Fatalf("set exit %d: %s", code, b.String())
	}
	if body, _ := os.ReadFile(filepath.Join(dir, config.File)); !strings.Contains(string(body), "PORT=8100") {
		t.Errorf("file: %s", body)
	}
	b.Reset()
	if code := Config(&b, config.Load(), []string{"PORT"}); code != 0 || strings.TrimSpace(b.String()) != "8100" {
		t.Errorf("get: %d %q", code, b.String())
	}
	b.Reset()
	if code := Config(&b, config.Load(), nil); code != 0 {
		t.Fatalf("show exit %d", code)
	}
	out := b.String()
	for _, want := range []string{"name", "port", "8100", "file", "browser", "firefox", "env TAILDEFENSE_BROWSER", "autoupdate", "default"} {
		if !strings.Contains(out, want) {
			t.Errorf("show lacks %q:\n%s", want, out)
		}
	}
	if code := Config(&b, config.Load(), []string{"browser", "a\nb"}); code != 2 {
		t.Errorf("a bad value must be a usage error, got %d", code)
	}
	if code := Config(&b, config.Load(), []string{"port", "--reset"}); code != 0 {
		t.Errorf("reset exit %d", code)
	}
	if v := config.Load().Get(config.KeyPort); v.Source != config.SourceDefault {
		t.Errorf("after reset: %+v", v)
	}
}

func TestNeedsUpdate(t *testing.T) {
	for _, c := range []struct {
		err  error
		want bool
	}{
		{nil, false},
		{&netplay.RejectError{Reason: "this host runs game protocol 2 (taildefense abc) and you run 1 (taildefense def); whoever is older: taildefense update"}, true},
		{&netplay.RejectError{Reason: "the game is full"}, false},
		{errors.New("dial tcp: connection refused"), false},
	} {
		if got := NeedsUpdate(c.err); got != c.want {
			t.Errorf("%v: got %v", c.err, got)
		}
	}
}
