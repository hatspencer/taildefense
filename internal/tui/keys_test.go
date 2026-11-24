package tui

import (
	"reflect"
	"testing"

	tea "charm.land/bubbletea/v2"

	"taildefense/internal/cli"
	"taildefense/internal/config"
	"taildefense/internal/tailnet"
)

// Keys as Bubble Tea's decoder delivers them, on a terminal that reports keys in full as well
// as on one that does not.
var (
	keyEnter      = tea.KeyPressMsg{Code: tea.KeyEnter}
	keyShiftEnter = tea.KeyPressMsg{Code: tea.KeyEnter, Mod: tea.ModShift}
	keySpace      = tea.KeyPressMsg{Code: tea.KeySpace, Text: " "}
	keyTab        = tea.KeyPressMsg{Code: tea.KeyTab}
	keyShiftTab   = tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift}
	keyEsc        = tea.KeyPressMsg{Code: tea.KeyEscape}
	keyCtrlC      = tea.KeyPressMsg{Code: 'c', Mod: tea.ModCtrl}
	keyCtrlU      = tea.KeyPressMsg{Code: 'u', Mod: tea.ModCtrl}
	keyUpperR     = tea.KeyPressMsg{Code: 'r', ShiftedCode: 'R', Mod: tea.ModShift, Text: "R"}
)

func typed(r rune) tea.KeyPressMsg { return tea.KeyPressMsg{Code: r, Text: string(r)} }

// menuModel is the launcher on its menu, past the splash, with a tailnet to copy from.
func menuModel(t *testing.T) *Model {
	t.Helper()
	isolate(t)
	sess := NewSession(nil)
	sess.setTailnet(tailnet.Self{Running: true, Host: "box", DNSName: "box.tail1234.ts.net", IPs: []string{"100.64.0.7"}}, nil)
	return newModel(Options{Session: sess, NoSplash: true})
}

func send(m *Model, msg tea.Msg) tea.Cmd {
	_, cmd := m.Update(msg)
	return cmd
}

// quits reports whether cmd is tea.Quit, without running anything else it might be.
func quits(cmd tea.Cmd) bool {
	return cmd != nil && reflect.ValueOf(cmd).Pointer() == reflect.ValueOf(tea.Quit).Pointer()
}

func TestEnterChoosesWhateverIsHeldWithIt(t *testing.T) {
	for name, k := range map[string]tea.KeyPressMsg{"enter": keyEnter, "shift+enter": keyShiftEnter, "space": keySpace} {
		m := menuModel(t)
		if cmd := send(m, k); !quits(cmd) || m.action.Kind != ActionHost {
			t.Errorf("%s on Host a game: action %v, quit %v", name, m.action.Kind, quits(cmd))
		}
	}
	// Space chooses on the settings screen too, and flips an on/off setting.
	m := menuModel(t)
	m.screen = screenSettings
	for i, k := range config.Keys {
		if k.Bool {
			m.scursor = i
			break
		}
	}
	send(m, keySpace)
	if m.notice == "" || m.bad {
		t.Errorf("space on an on/off setting saved nothing: %q", m.notice)
	}
}

func TestTabMovesAndShiftTabDoesNot(t *testing.T) {
	m := menuModel(t)
	send(m, keyTab)
	if m.cursor != 1 {
		t.Fatalf("tab: cursor %d, want 1", m.cursor)
	}
	// shift+tab arrives as tab with shift held; it was never bound, and must not act as tab.
	send(m, keyShiftTab)
	if m.cursor != 1 {
		t.Errorf("shift+tab moved the cursor to %d", m.cursor)
	}
}

func TestUppercaseRRestartsAfterAnUpdate(t *testing.T) {
	m := menuModel(t)
	m.sess.setUpdate(cli.SelfUpdate{State: cli.UpdateUpdated, Version: "abc1234", After: "def5678"})
	if cmd := send(m, keyUpperR); !quits(cmd) || m.action.Kind != ActionRestart {
		t.Errorf("R: action %v, quit %v", m.action.Kind, quits(cmd))
	}
}

func TestCtrlCQuitsFromAnywhere(t *testing.T) {
	m := menuModel(t)
	m.screen, m.typing = screenJoin, true
	if cmd := send(m, keyCtrlC); !quits(cmd) || m.action.Kind != ActionQuit {
		t.Errorf("ctrl+c while typing: action %v, quit %v", m.action.Kind, quits(cmd))
	}
}

// A release is not a press: a terminal that reports both must not have every key act twice,
// or act on letting go.
func TestAKeyReleaseDoesNothing(t *testing.T) {
	m := menuModel(t)
	for _, k := range []tea.Key{{Code: 'q', Text: "q"}, {Code: tea.KeyEnter}, {Code: tea.KeyTab}} {
		if cmd := send(m, tea.KeyReleaseMsg(k)); cmd != nil || m.cursor != 0 || m.screen != screenMenu {
			t.Errorf("release of %q acted: cursor %d, screen %v", k.String(), m.cursor, m.screen)
		}
	}
}

func TestTypingAnAddress(t *testing.T) {
	m := menuModel(t)
	m.screen = screenJoin
	send(m, typed('a'))
	if !m.typing {
		t.Fatal("a did not open the address field")
	}
	for _, r := range "pal" {
		send(m, typed(r))
	}
	send(m, typed('Q')) // typing, not a command
	send(m, keyCtrlU)
	for _, r := range "box:7787" {
		send(m, typed(r))
	}
	if cmd := send(m, keyShiftEnter); !quits(cmd) || m.action != (Action{Kind: ActionJoin, Addr: "box:7787"}) {
		t.Errorf("got %+v, quit %v", m.action, quits(cmd))
	}
}

func TestPasteIsTypingWhereSomethingIsTyped(t *testing.T) {
	m := menuModel(t)
	m.screen, m.typing = screenJoin, true
	send(m, tea.PasteMsg{Content: "100.64.0.9:7787\n"})
	if got := m.addr.value(); got != "100.64.0.9:7787" {
		t.Errorf("address after paste = %q", got)
	}

	m = menuModel(t)
	m.screen = screenSettings
	send(m, keyEnter) // the first setting is the name, a text one
	if !m.editing {
		t.Fatal("enter did not open the setting")
	}
	m.field.set("")
	send(m, tea.PasteMsg{Content: "Ada"})
	if got := m.field.value(); got != "Ada" {
		t.Errorf("setting after paste = %q", got)
	}
}

func TestPasteElsewhereIsNotACommand(t *testing.T) {
	m := menuModel(t)
	for _, s := range []string{"q", "R", "\r", " ", "?"} {
		if cmd := send(m, tea.PasteMsg{Content: s}); cmd != nil || m.help || m.cursor != 0 || m.screen != screenMenu {
			t.Errorf("paste %q acted: help %v, cursor %d", s, m.help, m.cursor)
		}
	}
	// Like any key, it closes the help.
	m.help = true
	send(m, tea.PasteMsg{Content: "x"})
	if m.help {
		t.Error("paste left the help open")
	}
}

func TestYCopiesTheJoinCommand(t *testing.T) {
	m := menuModel(t)
	var got []string
	old := clipboardTool
	clipboardTool = func(s string) { got = append(got, s) }
	t.Cleanup(func() { clipboardTool = old })
	cmd := send(m, typed('y'))
	if cmd == nil {
		t.Fatal("y returned no command")
	}
	want, _ := m.joinCommand()
	if m.notice != "copied: "+want {
		t.Errorf("notice %q", m.notice)
	}
	batch, ok := cmd().(tea.BatchMsg)
	if !ok || len(batch) != 2 {
		t.Fatalf("y's command is %T, want the terminal's copy and the tool's together", cmd())
	}
	for _, c := range batch {
		c()
	}
	if len(got) != 1 || got[0] != want {
		t.Errorf("clipboard tool got %q, want %q", got, want)
	}
}

// The alternate screen is declared with every frame: one that left it out would drop the
// launcher back onto the shell's screen mid-run.
func TestEveryFrameDeclaresTheAltScreen(t *testing.T) {
	m := menuModel(t)
	m.splash, m.width, m.height = true, 120, 40
	frames := map[string]func(){
		"splash": func() {},
		"menu":   func() { m.splash = false },
		"help":   func() { m.help = true },
		"tiny":   func() { m.help, m.width, m.height = false, 8, 3 },
		"join":   func() { m.screen, m.width, m.height = screenJoin, 80, 24 },
	}
	for _, name := range []string{"splash", "menu", "help", "tiny", "join"} {
		frames[name]()
		v := m.View()
		if !v.AltScreen {
			t.Errorf("%s: no alt screen", name)
		}
		if v.Content == "" {
			t.Errorf("%s: empty frame", name)
		}
		// Nothing painted the terminal here, so the frame leaves its colours alone.
		if v.BackgroundColor != nil || v.ForegroundColor != nil {
			t.Errorf("%s: declares colours %v/%v with nothing painted", name, v.BackgroundColor, v.ForegroundColor)
		}
	}
}
