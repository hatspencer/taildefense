package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"

	"taildefense/internal/netplay"
	"taildefense/internal/tailnet"
	"taildefense/internal/ui"
	"taildefense/internal/version"
)

// discover is netplay.Discover, a variable so tests list games without probing anything.
var discover = netplay.Discover

// LsOptions are what `td ls` takes.
type LsOptions struct {
	Port int
	JSON bool
}

// LsGame is one game in `td ls --json`. Its own type rather than netplay.Found, so the
// document's shape is decided here and a field added to the wire protocol does not appear in
// a script's input unannounced.
type LsGame struct {
	Addr       string   `json:"addr"`
	Peer       string   `json:"peer"`
	Host       string   `json:"host"`
	Owner      string   `json:"owner"`
	Players    []string `json:"players"`
	Max        int      `json:"max"`
	Wave       int      `json:"wave"`
	Phase      string   `json:"phase"`
	Version    string   `json:"version"`
	Proto      int      `json:"proto"`
	Compatible bool     `json:"compatible"`
	PingMs     int64    `json:"pingMs"`
	Started    int64    `json:"started,omitempty"`
}

// LsResult is the whole `td ls --json` document.
type LsResult struct {
	Tailnet LsTailnet `json:"tailnet"`
	Port    int       `json:"port"`
	Proto   int       `json:"proto"`
	Games   []LsGame  `json:"games"`
}

// LsTailnet is this machine as tailscale reported it.
type LsTailnet struct {
	Running bool   `json:"running"`
	Host    string `json:"host,omitempty"`
	IP      string `json:"ip,omitempty"`
	Login   string `json:"login,omitempty"`
	Peers   int    `json:"peersOnline"`
	Error   string `json:"error,omitempty"`
}

// Scan asks tailscale for the peers and probes each for a game. Without tailscale it still
// probes this machine, so a game hosted here is found either way.
func Scan(ctx context.Context, port int) (LsResult, tailnet.Self) {
	if port == 0 {
		port = netplay.DefaultPort
	}
	res := LsResult{Port: port, Proto: netplay.Proto, Games: []LsGame{}}
	self, peers, err := tailnetStatus(ctx)
	if err != nil {
		res.Tailnet.Error = oneLine(err.Error())
		peers = nil
	} else if !self.Running {
		peers = nil
	}
	res.Tailnet.Running = err == nil && self.Running
	res.Tailnet.Host, res.Tailnet.IP, res.Tailnet.Login = self.Host, self.IPv4(), self.Login
	for _, p := range peers {
		if p.Online {
			res.Tailnet.Peers++
		}
	}
	for _, f := range discover(ctx, self, peers, port) {
		res.Games = append(res.Games, GameOf(f))
	}
	return res, self
}

// GameOf is a discovered game as `td ls` and the launcher show it.
func GameOf(f netplay.Found) LsGame {
	players := f.Players
	if players == nil {
		players = []string{}
	}
	return LsGame{
		Addr: f.Addr, Peer: f.Peer, Host: f.Host, Owner: f.Owner, Players: players, Max: f.Max,
		Wave: f.Wave, Phase: f.Phase, Version: f.Version, Proto: f.Proto,
		Compatible: f.Proto == netplay.Proto && netplay.SameVersion(f.Version, version.Current()), PingMs: f.RTT.Milliseconds(), Started: f.Started,
	}
}

// Ls prints the games on the tailnet, as a table or as a JSON document. Finding none is not a
// failure: it is the normal answer on a quiet evening.
func Ls(w io.Writer, o LsOptions) int {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var prog *ui.Progress
	if !o.JSON {
		prog = ui.StartProgress("looking for games on the tailnet")
	}
	res, _ := Scan(ctx, o.Port)
	if prog != nil {
		prog.Stop()
	}
	if o.JSON {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		if err := enc.Encode(res); err != nil {
			return 1
		}
		return 0
	}
	p := ui.New(w)
	switch {
	case res.Tailnet.Error != "":
		p.Warn("tailscale: %s", res.Tailnet.Error)
		p.Detail("only this machine was asked")
	case !res.Tailnet.Running:
		p.Warn("tailscale is not running; only this machine was asked")
	default:
		p.Info("asked %s on port %d", plural(res.Tailnet.Peers+1, "machine"), res.Port)
	}
	if len(res.Games) == 0 {
		p.Note("no games found; start one with: td host")
		return 0
	}
	rows := [][]string{{
		ui.StyleDim.Render("PEER"), ui.StyleDim.Render("OWNER"), ui.StyleDim.Render("PLAYERS"),
		ui.StyleDim.Render("WAVE"), ui.StyleDim.Render("VERSION"), ui.StyleDim.Render("PING"),
		ui.StyleDim.Render("JOIN"),
	}}
	incompatible := false
	for _, g := range res.Games {
		ver := g.Version
		if !g.Compatible {
			ver = ui.StyleYellow.Render(ver + " ✗")
			incompatible = true
		}
		rows = append(rows, []string{
			ui.StyleBold.Render(g.Peer), g.Owner, fmt.Sprintf("%d/%d", len(g.Players), g.Max),
			WaveText(g.Wave, g.Phase), ver, fmt.Sprintf("%dms", g.PingMs),
			ui.StyleCyan.Render("td join " + joinTarget(g)),
		})
	}
	p.Raw(ui.Table(rows, "  "))
	if incompatible {
		p.Warn("✗ runs another td: host and players must run the same one; run td update on both machines")
	}
	return 0
}

// WaveText is "wave 7 · fight", or the phase alone before the first wave.
func WaveText(wave int, phase string) string {
	switch {
	case wave <= 0 && phase == "":
		return "—"
	case wave <= 0:
		return phase
	case phase == "":
		return fmt.Sprintf("wave %d", wave)
	}
	return fmt.Sprintf("wave %d · %s", wave, phase)
}

// joinTarget is the shortest address that joins a game: the tailnet IP alone on the
// default port. The IP rather than the peer's name, because the name tailscale reports is the
// machine's own host name, which MagicDNS may have had to change.
func joinTarget(g LsGame) string {
	host, port, err := net.SplitHostPort(g.Addr)
	if err != nil || port != strconv.Itoa(netplay.DefaultPort) {
		return g.Addr
	}
	return host
}
