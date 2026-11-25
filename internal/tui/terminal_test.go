package tui

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// before is the frame's row y up to column x, as it reads on screen.
func before(content string, x, y int) string {
	lines := strings.Split(content, "\n")
	if y < 0 || y >= len(lines) {
		return ""
	}
	return ansi.Cut(lines[y], 0, x)
}

// A field being typed in puts the terminal's own cursor where the next letter goes, and the
// frame itself carries neither the mark nor a drawn cursor.
func TestTheAddressFieldShowsTheTerminalsCursor(t *testing.T) {
	m := menuModel(t)
	m.screen, m.typing, m.width, m.height = screenJoin, true, 100, 30
	for _, r := range "pal" {
		send(m, typed(r))
	}
	v := m.View()
	if v.Cursor == nil {
		t.Fatal("no cursor while typing an address")
	}
	if v.Cursor.Shape != tea.CursorBar || v.Cursor.Color != nil {
		t.Errorf("cursor shape %v colour %v, want a bar in the terminal's own colour", v.Cursor.Shape, v.Cursor.Color)
	}
	if got := ansi.Strip(before(v.Content, v.Cursor.X, v.Cursor.Y)); !strings.HasSuffix(got, "address: pal") {
		t.Errorf("the cursor stands after %q, want after the address typed", got)
	}
	if strings.Contains(v.Content, cursorMark) || strings.Contains(v.Content, "\x1b_") {
		t.Errorf("the mark is left in the frame: %q", v.Content)
	}

	// It follows the editing keys.
	send(m, tea.KeyPressMsg{Code: tea.KeyLeft})
	v = m.View()
	if got := ansi.Strip(before(v.Content, v.Cursor.X, v.Cursor.Y)); !strings.HasSuffix(got, "address: pa") {
		t.Errorf("after left the cursor stands after %q", got)
	}

	// The still frame keeps its cell, for td frame and the golden frames.
	if f := m.frame(); strings.Contains(f, cursorMark) || !strings.Contains(ansi.Strip(f), "address: pal") {
		t.Errorf("still frame: %q", ansi.Strip(f))
	}
}

func TestASettingBeingEditedShowsTheCursor(t *testing.T) {
	m := menuModel(t)
	m.screen = screenSettings
	send(m, keyEnter) // the name, a text setting
	if !m.editing {
		t.Fatal("enter did not open the setting")
	}
	m.field.set("Ada")
	v := m.View()
	if v.Cursor == nil {
		t.Fatal("no cursor while editing a setting")
	}
	if got := ansi.Strip(before(v.Content, v.Cursor.X, v.Cursor.Y)); !strings.HasSuffix(got, "Ada") {
		t.Errorf("the cursor stands after %q", got)
	}
	send(m, keyEsc)
	if v := m.View(); v.Cursor != nil {
		t.Errorf("cursor still shown at %v after the edit closed", v.Cursor.Position)
	}
}

// A field cut off at the window's edge has no cell for the cursor, so there is none rather
// than one on the "…" or past the edge.
func TestNoCursorPastTheEdge(t *testing.T) {
	m := menuModel(t)
	m.screen, m.typing, m.width, m.height = screenJoin, true, 30, 20
	send(m, tea.PasteMsg{Content: strings.Repeat("a", 60)})
	if v := m.View(); v.Cursor != nil {
		t.Errorf("cursor at %v in a 30-column window", v.Cursor.Position)
	}
	// Home brings it back into view.
	send(m, tea.KeyPressMsg{Code: tea.KeyHome})
	v := m.View()
	if v.Cursor == nil || v.Cursor.X >= 29 {
		t.Fatalf("cursor after home: %+v", v.Cursor)
	}
	if got := ansi.Strip(before(v.Content, v.Cursor.X, v.Cursor.Y)); !strings.HasSuffix(got, "address: ") {
		t.Errorf("after home the cursor stands after %q", got)
	}
}

// The window is titled with the screen, on every frame.
func TestTheWindowTitleNamesTheScreen(t *testing.T) {
	m := menuModel(t)
	for _, c := range []struct {
		set  func()
		want string
	}{
		{func() {}, "td"},
		{func() { m.screen = screenJoin }, "td · join a game"},
		{func() { m.screen = screenSettings }, "td · settings"},
		{func() { m.screen = screenChangelog }, "td · changelog"},
		{func() { m.screen = screenDoctor }, "td · doctor"},
		{func() { m.screen = screenKeys }, "td · game keys"},
		{func() { m.help = true }, "td · keys"},
	} {
		c.set()
		if got := m.View().WindowTitle; got != c.want {
			t.Errorf("title %q, want %q", got, c.want)
		}
	}
}

func TestCtrlZSuspendsFromAnywhere(t *testing.T) {
	ctrlZ := tea.KeyPressMsg{Code: 'z', Mod: tea.ModCtrl}
	for name, set := range map[string]func(m *Model){
		"menu":    func(*Model) {},
		"typing":  func(m *Model) { m.screen, m.typing = screenJoin, true },
		"editing": func(m *Model) { m.screen, m.editing = screenSettings, true },
		"splash":  func(m *Model) { m.splash = true },
	} {
		m := menuModel(t)
		set(m)
		cmd := send(m, ctrlZ)
		if cmd == nil {
			t.Errorf("%s: ctrl+z did nothing", name)
			continue
		}
		if _, ok := cmd().(tea.SuspendMsg); !ok {
			t.Errorf("%s: ctrl+z gave %T, want a suspend", name, cmd())
		}
		if m.action.Kind != ActionQuit || m.typing != (name == "typing") {
			t.Errorf("%s: ctrl+z changed the launcher", name)
		}
	}
	// A z typed is a z.
	m := menuModel(t)
	m.screen, m.typing = screenJoin, true
	send(m, typed('z'))
	if m.addr.value() != "z" {
		t.Errorf("typed z gave %q", m.addr.value())
	}
}

func TestResumePicksUpTheClock(t *testing.T) {
	m := menuModel(t)
	m.scanning = true // something moves, so a tick is due
	m.ticking = false
	if cmd := send(m, tea.ResumeMsg{}); cmd == nil {
		t.Error("no tick after resuming with a spinner on screen")
	}
	if !m.ticking {
		t.Error("resume started no tick")
	}
	// A tick already pending is not doubled.
	if cmd := send(m, tea.ResumeMsg{}); cmd != nil {
		t.Error("resume started a second tick chain")
	}
}

// A chord that carries the letter's text, as a terminal reporting keys in full can send, is
// not the letter.
func TestAChordIsNotItsLetter(t *testing.T) {
	m := menuModel(t)
	for _, k := range []tea.KeyPressMsg{
		{Code: 'j', Mod: tea.ModCtrl, Text: "j"},
		{Code: 'j', Mod: tea.ModAlt, Text: "j"},
		{Code: 'q', Mod: tea.ModAlt, Text: "q"},
		{Code: 'q', Mod: tea.ModSuper, Text: "q"},
	} {
		if cmd := send(m, k); quits(cmd) || m.cursor != 0 {
			t.Errorf("%s acted as its letter: cursor %d, quit %v", k.Keystroke(), m.cursor, quits(cmd))
		}
	}
	// Shift only picks the letter.
	if got := keyName(keyUpperR); got != "R" {
		t.Errorf("shift+r is %q, want R", got)
	}
}

// Every frame declares the terminal's modes: no mouse reporting, a title, the cursor only
// while something is typed.
func TestEveryFrameDeclaresTheModes(t *testing.T) {
	m := menuModel(t)
	m.splash, m.width, m.height = true, 120, 40
	for _, f := range []struct {
		name   string
		set    func()
		cursor bool
	}{
		{"splash", func() {}, false},
		{"menu", func() { m.splash = false }, false},
		{"join", func() { m.screen = screenJoin }, false},
		{"typing", func() { m.typing = true }, true},
		{"tiny", func() { m.width, m.height = 8, 3 }, false},
		{"settings", func() { m.typing, m.screen, m.width, m.height = false, screenSettings, 80, 24 }, false},
	} {
		f.set()
		v := m.View()
		if v.MouseMode != tea.MouseModeNone {
			t.Errorf("%s: mouse mode %v", f.name, v.MouseMode)
		}
		if v.WindowTitle == "" {
			t.Errorf("%s: no title", f.name)
		}
		if (v.Cursor != nil) != f.cursor {
			t.Errorf("%s: cursor %v, want shown %v", f.name, v.Cursor, f.cursor)
		}
	}
}

func TestInterruptedIsAQuietQuit(t *testing.T) {
	for _, c := range []struct {
		err  error
		want error
	}{
		{tea.ErrInterrupted, ErrInterrupted},
		{fmt.Errorf("%w: %w", tea.ErrProgramKilled, errors.New("context canceled")), ErrInterrupted},
		{fmt.Errorf("%w: %w", tea.ErrProgramKilled, tea.ErrProgramPanic), tea.ErrProgramPanic},
		{errors.New("tty gone"), nil},
	} {
		got := runErr(c.err)
		switch {
		case c.want == nil && errors.Is(got, ErrInterrupted):
			t.Errorf("%v reads as interrupted", c.err)
		case c.want != nil && !errors.Is(got, c.want):
			t.Errorf("%v gave %v, want %v", c.err, got, c.want)
		}
	}
}
