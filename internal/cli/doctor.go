package cli

import (
	"context"
	"io"
	"os/exec"
	"strings"
	"time"

	"taildefense/internal/config"
	"taildefense/internal/install"
	"taildefense/internal/netplay"
	"taildefense/internal/platform"
	"taildefense/internal/tailnet"
	"taildefense/internal/ui"
	"taildefense/internal/version"
	"taildefense/internal/web"
)

// Doctor checks what td needs on this machine: tailscale to find and reach friends, a
// browser to play in, and the pieces `td update` uses. Exit 1 when tailscale cannot
// be used, because then the game is single-machine only; everything else is a warning, since
// the game still runs without it.
func Doctor(w io.Writer) int {
	p := ui.New(w)
	p.Banner("")
	p.Step("td doctor")
	checkTailscale(p)
	checkBrowser(p)
	checkUpdates(p)
	p.Plain("")
	if n := p.Failures(); n > 0 {
		p.Fail("%s to fix before friends can join: games are this machine only until then", plural(n, "thing"))
		return 1
	}
	p.OK("ready: td opens the launcher, td host starts a game")
	return 0
}

func checkTailscale(p *ui.Printer) {
	bin, err := tailnet.Binary()
	if err != nil {
		p.Fail("tailscale: %v", err)
		p.Detail("install it from https://tailscale.com/download, then: tailscale up")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	self, peers, err := tailnetStatus(ctx)
	if err != nil {
		p.Fail("tailscale at %s does not answer: %s", tilde(bin), oneLine(err.Error()))
		p.Detail("is tailscaled running? start it, then: tailscale up")
		return
	}
	if !self.Running {
		state := self.State
		if state == "" {
			state = "not running"
		}
		p.Fail("tailscale is %s", strings.ToLower(state))
		p.Detail("connect with: tailscale up")
		return
	}
	ip := self.IPv4()
	if ip == "" {
		p.Fail("tailscale is up but this machine has no tailnet IPv4 address")
		return
	}
	online := 0
	for _, pe := range peers {
		if pe.Online {
			online++
		}
	}
	p.Pass("tailscale %s  %s  %s", ip, ui.StyleBold.Render(self.Host), ui.StyleDim.Render(self.Login))
	p.Detail("%s online on %s; friends join you with: %s", plural(online, "peer"), orDash(self.Tailnet),
		JoinCommand(shortHost(self, self.Host), netplay.DefaultPort))
}

func checkBrowser(p *ui.Printer) {
	setting := config.Load().Browser()
	found := web.Browsers()
	var names []string
	for _, b := range found {
		n := b.Name
		if !b.Fullscreen() {
			n += " (windowed)"
		}
		names = append(names, n)
	}
	switch {
	case setting == config.BrowserNone:
		p.Info("browser: none; td prints the game's links to open yourself")
	case setting == config.BrowserAuto && len(found) > 0:
		p.Pass("browser: %s, full screen in a window of its own", found[0].Name)
	case setting == config.BrowserAuto:
		p.Warn("browser: none td knows is installed; the game opens in the system's browser")
	case web.IsBrowserID(setting):
		if b, ok := web.FindBrowser(setting); ok {
			p.Pass("browser: %s, full screen", b.Name)
		} else {
			p.Warn("browser: %s is not installed; td will print the game's links instead", setting)
		}
	default:
		argv := web.Opener(setting)
		if path, err := exec.LookPath(argv[0]); err == nil {
			p.Pass("browser opens with %s", tilde(path))
		} else {
			p.Warn("browser: %s is not installed; td will print the game's links instead", argv[0])
		}
	}
	if len(names) > 0 {
		p.Detail("installed: %s; td config browser auto, default or one of them", strings.Join(names, ", "))
	}
	p.Detail("the game runs on WebGPU where the browser has it, WebGL 2 elsewhere")
}

func checkUpdates(p *ui.Printer) {
	if engine, ok := platform.ContainerEngine(); ok {
		p.Pass("container engine %s, for td update", engine)
	} else {
		p.Warn("no container engine answers: td update builds in Docker or Podman")
	}
	if _, err := exec.LookPath("git"); err == nil {
		p.Pass("git, for td update")
	} else {
		p.Warn("git is not installed: td update clones with it")
	}
	paths, err := install.Resolve()
	switch {
	case err != nil:
		p.Warn("install: %v", err)
	case install.IsInstalled():
		line := "installed " + tilde(paths.BinaryPath()) + " at " + version.Current()
		if b := paths.Branch(); b != "" {
			line += ", following " + b
		}
		p.Pass("%s", line)
		if !install.InPath(paths.BinDir) {
			p.Warn("%s is not on your PATH", tilde(paths.BinDir))
		}
	default:
		p.Info("not installed, running from %s; install with: td install", tilde(install.Root()))
	}
	prefs := config.Load()
	if prefs.Err != nil {
		p.Warn("preferences: %v", prefs.Err)
	}
	au := prefs.Get(config.KeyAutoUpdate)
	p.Info("autoupdate %s (%s)", au.Value, au.Source)
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}
