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
	for _, view := range []string{FrameMenu, FrameJoin, FrameSettings, FrameHelp, FrameSplash} {
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
	join := ansi.Strip(Frame(Options{}, 80, 24, FrameJoin))
	for _, want := range []string{"pal", "2/4", "wave 7", "14ms", "✗", "enter address"} {
		if !strings.Contains(join, want) {
			t.Errorf("join lacks %q:\n%s", want, join)
		}
	}
	set := ansi.Strip(Frame(Options{}, 80, 24, FrameSettings))
	for _, want := range []string{"name", "tester", "port", "7787", "browser", "autoupdate"} {
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
