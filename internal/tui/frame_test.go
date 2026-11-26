package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"taildefense/internal/cli"
	"taildefense/internal/config"
	"taildefense/internal/web"
)

// isolate keeps the prefs the frame reads away from the real ~/.config.
func isolate(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv(config.EnvConfigDir, dir)
	t.Setenv("TAILDEFENSE_PREFIX", dir)
	t.Setenv("USER", "tester")
	for _, k := range config.Keys {
		t.Setenv(k.Env, "")
	}
	config.TailnetName = func() string { return "" }
}

func TestEveryScreenFitsTheWindow(t *testing.T) {
	isolate(t)
	for _, view := range []string{FrameMenu, FrameJoin, FrameSettings, FrameChangelog, FrameDoctor, FrameKeys, FrameHelp, FrameSplash} {
		for _, size := range [][2]int{{80, 24}, {160, 48}, {80, 12}, {40, 20}} {
			out := Frame(Options{}, size[0], size[1], view)
			lines := strings.Split(out, "\n")
			if len(lines) != size[1] {
				t.Errorf("%s %dx%d: %d lines", view, size[0], size[1], len(lines))
			}
			for i, l := range lines {
				if w := ansi.StringWidth(l); w > size[0] {
					t.Errorf("%s %dx%d line %d is %d wide: %q", view, size[0], size[1], i, w, ansi.Strip(l))
				}
			}
		}
	}
}

func TestFramesSayWhatMatters(t *testing.T) {
	isolate(t)
	menu := ansi.Strip(Frame(Options{}, 160, 48, FrameMenu))
	for _, want := range []string{"Host a game", "Join a game", "Settings", "Quit", "td join box", "restart", "100.64.0.7"} {
		if !strings.Contains(menu, want) {
			t.Errorf("menu lacks %q:\n%s", want, menu)
		}
	}
	// A refusal over the protocol offers the update when none is already installed.
	sess := NewSession(nil)
	sess.setUpdate(cli.SelfUpdate{State: cli.UpdateCurrent, Version: "abc1234"})
	if got := ansi.Strip(Frame(Options{Session: sess}, 80, 24, FrameMenu)); !strings.Contains(got, "press u to update") || !strings.Contains(got, "Update td now") {
		t.Errorf("no update offer:\n%s", got)
	}
	// Up to date, the menu still offers to look for one.
	m := newModel(Options{Session: NewSession(nil), NoSplash: true})
	m.sess.setUpdate(cli.SelfUpdate{State: cli.UpdateCurrent, Version: "abc1234"})
	if got := ansi.Strip(strings.Join(m.menuView(80), "\n")); !strings.Contains(got, "Check for updates") {
		t.Errorf("no update item when current:\n%s", got)
	}
	// Behind main, the launcher says a newer td is out and how to get it, and offers the
	// update; it starts nothing itself.
	m.sess.setUpdate(cli.SelfUpdate{State: cli.UpdateBehind, Version: "abc1234", Remote: "def5678abcdef"})
	if got := ansi.Strip(m.versionLine()); !strings.Contains(got, "a newer td is out: abc1234 → def5678 · td update installs it") || !strings.Contains(got, "press u") {
		t.Errorf("no notice when behind: %q", got)
	}
	if got := ansi.Strip(strings.Join(m.menuView(80), "\n")); !strings.Contains(got, "Update td now") {
		t.Errorf("no update item when behind:\n%s", got)
	}
	if m.animating() {
		t.Error("a notice is not an update running")
	}
	// Pinned, it says only that.
	m.sess.setUpdate(cli.SelfUpdate{State: cli.UpdatePinned, Version: "abc1234", Pin: "abc1234" + strings.Repeat("0", 33)})
	if got := ansi.Strip(m.versionLine()); strings.Contains(got, "newer") || !strings.Contains(got, "pinned to abc1234") {
		t.Errorf("pinned: %q", got)
	}
	join := ansi.Strip(Frame(Options{}, 80, 24, FrameJoin))
	for _, want := range []string{"pal", "2/4", "wave 7", "14ms", "✗", "enter address"} {
		if !strings.Contains(join, want) {
			t.Errorf("join lacks %q:\n%s", want, join)
		}
	}
	log := ansi.Strip(Frame(Options{}, 80, 24, FrameChangelog))
	for _, want := range []string{"Changelog", "latest 24 commits on main", "3 commits behind", "abc1234", "◀ this td", "of 24"} {
		if !strings.Contains(log, want) {
			t.Errorf("changelog lacks %q:\n%s", want, log)
		}
	}
	doc := ansi.Strip(Frame(Options{}, 80, 24, FrameDoctor))
	for _, want := range []string{"Doctor", "ready to host and join", "tailscale 100.64.0.7", "r check again"} {
		if !strings.Contains(doc, want) {
			t.Errorf("doctor lacks %q:\n%s", want, doc)
		}
	}
	keys := ansi.Strip(Frame(Options{}, 80, 24, FrameKeys))
	for _, want := range []string{"the game's keys", "moving", "W A S D", "walk, the way the view faces", "of ", "esc back"} {
		if !strings.Contains(keys, want) {
			t.Errorf("keys lacks %q:\n%s", want, keys)
		}
	}
	// Scrolled to the end, the last binding shows.
	km := newModel(Options{Session: NewSession(nil), NoSplash: true})
	km.width, km.height, km.screen, km.kscroll = 80, 24, screenKeys, 1000
	last := cli.GameKeys[len(cli.GameKeys)-1]
	if got := ansi.Strip(km.frame()); !strings.Contains(got, last.Does) {
		t.Errorf("scrolled to the end, keys lacks %q:\n%s", last.Does, got)
	}
	set := ansi.Strip(Frame(Options{}, 80, 24, FrameSettings))
	for _, want := range []string{"name", "tester", "port", "7787", "browser"} {
		if !strings.Contains(set, want) {
			t.Errorf("settings lacks %q:\n%s", want, set)
		}
	}
}

func TestResultText(t *testing.T) {
	got := ansi.Strip(ResultText(web.Result{Wave: 13, Best: 12, Kills: 3456, Reason: "left"}))
	if got != "held out 12 waves · 3456 kills · left" {
		t.Errorf("got %q", got)
	}
}
