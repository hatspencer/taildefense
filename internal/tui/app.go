// Package tui is td's launcher: the screen a bare `td` opens, to host a game, find one on the
// tailnet, or change settings.
//
// The launcher never runs the game itself. It returns an Action and exits; main runs the
// game, which plays in the browser while the terminal says where and how to stop it, and
// then opens the launcher again with the Outcome.
package tui

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"taildefense/internal/cli"
	"taildefense/internal/config"
	"taildefense/internal/game"
	"taildefense/internal/tailnet"
	"taildefense/internal/ui"
	"taildefense/internal/web"
)

// ActionKind is what the launcher asks main to do.
type ActionKind int

const (
	ActionQuit    ActionKind = iota
	ActionHost               // host a game on the PORT setting and play it
	ActionJoin               // join Addr
	ActionRestart            // re-exec the installed td after the player's update
)

// Action is the launcher's answer.
type Action struct {
	Kind ActionKind
	Addr string // ActionJoin: host, host:port or IP
}

// Outcome is how the last game went, shown when the launcher opens again.
type Outcome struct {
	Kind   ActionKind // ActionHost or ActionJoin
	Addr   string
	Result web.Result
	Err    error
}

// Session is what outlives one launcher run: the tailnet answer and td's own update state.
// The check for a newer td runs once per session and may answer after a launcher has closed
// for a game, so the state lives here under a lock rather than in a model gone by then.
type Session struct {
	Checker *cli.UpdateChecker // nil when td is not installed

	mu         sync.Mutex
	update     cli.SelfUpdate
	checked    bool
	self       tailnet.Self
	tailErr    error
	tailLoaded bool
	// The changelog, read once a launcher first opens it and again on r.
	log        *cli.Changelog
	logErr     error
	logLoading bool
	// td doctor's report, as lines, run each time the doctor screen opens.
	doc        []string
	docOK      bool
	docRunning bool
}

// NewSession starts a session. u may be nil.
func NewSession(u *cli.UpdateChecker) *Session {
	return &Session{Checker: u, update: cli.SelfUpdate{State: cli.UpdateUnknown}}
}

func (s *Session) Update() cli.SelfUpdate {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.update
}

func (s *Session) setUpdate(u cli.SelfUpdate) {
	s.mu.Lock()
	s.update = u
	s.mu.Unlock()
}

func (s *Session) tailnet() (tailnet.Self, error, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.self, s.tailErr, s.tailLoaded
}

func (s *Session) setTailnet(self tailnet.Self, err error) {
	s.mu.Lock()
	s.self, s.tailErr, s.tailLoaded = self, err, true
	s.mu.Unlock()
}

func (s *Session) changelog() (*cli.Changelog, error, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.log, s.logErr, s.logLoading
}

func (s *Session) setChangelog(c *cli.Changelog, err error) {
	s.mu.Lock()
	s.log, s.logErr, s.logLoading = c, err, false
	s.mu.Unlock()
}

// startChangelog marks the changelog as being read, and reports false when it already is.
func (s *Session) startChangelog() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.logLoading {
		return false
	}
	s.logLoading = true
	return true
}

func (s *Session) doctor() ([]string, bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.doc, s.docOK, s.docRunning
}

func (s *Session) setDoctor(lines []string, ok bool) {
	s.mu.Lock()
	s.doc, s.docOK, s.docRunning = lines, ok, false
	s.mu.Unlock()
}

// startDoctor marks the checks as running, and reports false when they already are.
func (s *Session) startDoctor() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.docRunning {
		return false
	}
	s.docRunning = true
	return true
}

// Options are one launcher run.
type Options struct {
	Version string
	Date    string // the commit's date, shown beside the version
	Prefs   *config.Prefs
	Session *Session
	Last    *Outcome
	// NoSplash skips the boot splash, which otherwise plays on the first launcher only.
	NoSplash bool
	// SplashAt is the moment of the splash Frame draws for FrameSplash.
	SplashAt time.Duration
	// Context ends the launcher when it is done, as a quit; nil for none.
	Context context.Context
}

type screen int

const (
	screenMenu screen = iota
	screenJoin
	screenSettings
	screenChangelog
	screenDoctor
	screenKeys
)

type menuItem int

const (
	itemHost menuItem = iota
	itemJoin
	itemSettings
	itemKeys
	itemChangelog
	itemDoctor
	itemScreenshots
	itemUpdate
	itemRestart
	itemQuit
)

var itemLabels = map[menuItem]string{
	itemHost: "Host a game", itemJoin: "Join a game", itemSettings: "Settings", itemKeys: "Keys",
	itemChangelog: "Changelog", itemDoctor: "Doctor", itemScreenshots: "Screenshots",
	itemUpdate: "Check for updates", itemRestart: "Restart into the new td", itemQuit: "Quit",
}

// rescanEvery is how often the join screen looks again on its own.
const rescanEvery = 5 * time.Second

// Model is the launcher.
type Model struct {
	o       Options
	sess    *Session
	prefs   *config.Prefs
	width   int
	height  int
	started time.Time
	now     time.Time

	screen screen
	help   bool
	// What the last update brought, while there is something to say (whatsNew).
	news    *cli.News
	newsFor string
	cursor  int // menu
	action  Action
	notice  string
	bad     bool // notice is an error

	// join
	games    []cli.LsGame
	scanned  bool
	scanning bool
	scanGen  int
	jcursor  int
	typing   bool
	addr     lineInput

	// changelog: the first row shown, -1 until the list first draws, to open on this td's own
	lscroll int
	// doctor: the first row shown
	dscroll int
	// keys: the first row shown
	kscroll int

	// settings
	scursor int
	editing bool
	field   lineInput

	ticking bool
	splash  bool // the boot splash is playing

	// markCursor is set while View draws, so a field being typed in leaves its cursor to the
	// terminal (input.go).
	markCursor bool
}

// internal messages
type (
	tickMsg    time.Time
	tailnetMsg struct{}
	selfMsg    struct{}
	scanMsg    struct {
		gen int
		res cli.LsResult
	}
	rescanMsg    struct{ gen int }
	changelogMsg struct{}
	doctorMsg    struct{}
	fgUpdateMsg  struct{ err error }
)

func newModel(o Options) *Model {
	if o.Session == nil {
		o.Session = NewSession(nil)
	}
	if o.Prefs == nil {
		o.Prefs = config.Load()
	}
	now := time.Now()
	m := &Model{o: o, sess: o.Session, prefs: o.Prefs, width: 80, height: 24, started: now, now: now}
	m.splash = !o.NoSplash && o.Last == nil && ui.Motion()
	m.addr.max = 255
	m.field.max = 64
	// The first launch of a freshly updated td says what came with it, once.
	if n, ok := cli.LastNews(); ok && !n.Seen && cli.SameCommit(n.To, o.Version) {
		m.news = &n
		cli.NewsSeen()
	}
	return m
}

// whatsNew is the update news to show: a launch's own (newModel), or, once an update this
// launcher ran has installed, what that one brought.
func (m *Model) whatsNew() *cli.News {
	st := m.sess.Update()
	if st.State == cli.UpdateUpdated && st.After != "" && st.After != m.newsFor {
		m.newsFor = st.After
		if n, ok := cli.LastNews(); ok && cli.SameCommit(n.To, st.After) {
			m.news = &n
		}
	}
	return m.news
}

// ErrInterrupted is a launcher ended from outside: an interrupt signal, or its Context done.
var ErrInterrupted = errors.New("interrupted")

// Run shows the launcher until the player picks something, and returns what.
func Run(o Options) (Action, error) {
	m := newModel(o)
	// The profile is the one every line outside the launcher was printed with, decided once
	// in ui.InitColor, so the two cannot disagree about what the terminal shows.
	opts := []tea.ProgramOption{tea.WithColorProfile(ui.Profile())}
	if o.Context != nil {
		opts = append(opts, tea.WithContext(o.Context))
	}
	// The launcher titles the window, and the program blanks the title when it ends: there is
	// no portable way to put the old one back. Terminals that keep a stack of titles (xterm,
	// VTE, kitty, iTerm2) get theirs back from it; the rest ignore both sequences.
	io.WriteString(os.Stdout, ansi.WindowOp(pushTitle, 0))
	final, err := tea.NewProgram(m, opts...).Run()
	io.WriteString(os.Stdout, ansi.WindowOp(popTitle, 0))
	// The program hands the terminal's own colours back when it ends; whatever prints next
	// still belongs to the theme.
	ui.PaintTerminal()
	if err != nil {
		return Action{Kind: ActionQuit}, runErr(err)
	}
	if fm, ok := final.(*Model); ok {
		return fm.action, nil
	}
	return Action{Kind: ActionQuit}, nil
}

// runErr is how a program that ended in err ended: ErrInterrupted for an interrupt signal or
// a done Context, which are a quit nobody needs told about, and err itself for anything else,
// a recovered panic included (Bubble Tea reports one as killed as well).
func runErr(err error) error {
	switch {
	case errors.Is(err, tea.ErrProgramPanic):
		return err
	case errors.Is(err, tea.ErrInterrupted), errors.Is(err, tea.ErrProgramKilled):
		return ErrInterrupted
	}
	return err
}

func (m *Model) Init() tea.Cmd {
	cmds := []tea.Cmd{m.loadTailnet()}
	if m.sess.Checker != nil {
		m.sess.mu.Lock()
		first := !m.sess.checked
		m.sess.checked = true
		m.sess.mu.Unlock()
		if first {
			cmds = append(cmds, m.checkSelf())
		}
	}
	cmds = append(cmds, m.ensureTick())
	return tea.Batch(cmds...)
}

func (m *Model) loadTailnet() tea.Cmd {
	sess := m.sess
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		self, _, err := tailnet.Status(ctx)
		sess.setTailnet(self, err)
		return tailnetMsg{}
	}
}

// checkSelf asks whether a newer td is out, off the launcher's start, and only says so: the
// update is the player's to start (u, or Update td now). It writes the session, not the model,
// so the answer survives this launcher closing for a game.
func (m *Model) checkSelf() tea.Cmd {
	sess, u := m.sess, m.sess.Checker
	return func() tea.Msg {
		sess.setUpdate(u.Check())
		return selfMsg{}
	}
}

func (m *Model) scan() tea.Cmd {
	m.scanGen++
	m.scanning = true
	gen, port := m.scanGen, m.prefs.Port()
	sess := m.sess
	return tea.Batch(func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		res, self := cli.Scan(ctx, port)
		var err error
		if res.Tailnet.Error != "" {
			err = errors.New(res.Tailnet.Error)
		}
		sess.setTailnet(self, err)
		return scanMsg{gen: gen, res: res}
	}, m.ensureTick())
}

// animating is whether anything on screen moves: a spinner while looking for games, reading
// the changelog or running the doctor. An idle launcher sends no frames.
func (m *Model) animating() bool {
	_, _, reading := m.sess.changelog()
	_, _, checking := m.sess.doctor()
	return m.splash || m.scanning || reading || checking
}

func (m *Model) ensureTick() tea.Cmd {
	if m.ticking || !m.animating() {
		return nil
	}
	m.ticking = true
	every := ui.TickInterval()
	if m.splash {
		every = splashTick
	}
	return tea.Tick(every, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m *Model) menu() []menuItem {
	items := []menuItem{itemHost, itemJoin, itemSettings, itemKeys, itemChangelog, itemDoctor, itemScreenshots}
	if m.sess.Update().State == cli.UpdateUpdated {
		items = append(items, itemRestart)
	} else {
		items = append(items, itemUpdate) // always there: it says whether one is waiting
	}
	return append(items, itemQuit)
}

// updateOffered is a last game that ended because the host runs another protocol.
// updateWaiting is whether an update is known to be there to install.
func (m *Model) updateWaiting() bool {
	st := m.sess.Update().State
	return st == cli.UpdateBehind || m.updateOffered()
}

func (m *Model) updateOffered() bool {
	return m.o.Last != nil && cli.NeedsUpdate(m.o.Last.Err) && m.sess.Update().State != cli.UpdateUpdated
}

// joinCommand is what a friend types to join this machine's game, once tailscale is up.
func (m *Model) joinCommand() (string, bool) {
	self, err, loaded := m.sess.tailnet()
	if !loaded || err != nil || !self.Running || self.IPv4() == "" {
		return "", false
	}
	host, _, _ := strings.Cut(self.DNSName, ".")
	if host == "" {
		host = self.Host
	}
	return cli.JoinCommand(host, m.prefs.Port()), true
}

func (m *Model) say(bad bool, format string, a ...any) {
	m.notice, m.bad = fmt.Sprintf(format, a...), bad
}

func (m *Model) quit(a Action) (tea.Model, tea.Cmd) {
	m.action = a
	return m, tea.Quit
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		if !splashFits(m.width, m.height) {
			m.splash = false // too small to play; straight to the menu
		}
		return m, nil
	case tickMsg:
		m.now = time.Time(msg)
		m.ticking = false
		if m.splash && m.now.Sub(m.started) >= SplashFor {
			m.splash = false
		}
		return m, m.ensureTick()
	case tailnetMsg, selfMsg, changelogMsg, doctorMsg:
		return m, m.ensureTick()
	case scanMsg:
		if msg.gen != m.scanGen {
			return m, nil
		}
		m.scanning, m.scanned = false, true
		m.games = msg.res.Games
		if m.jcursor > len(m.games) {
			m.jcursor = len(m.games)
		}
		gen := msg.gen
		return m, tea.Tick(rescanEvery, func(time.Time) tea.Msg { return rescanMsg{gen} })
	case rescanMsg:
		if msg.gen == m.scanGen && m.screen == screenJoin && !m.scanning {
			return m, m.scan()
		}
		return m, nil
	case fgUpdateMsg:
		before := m.sess.Update()
		var after cli.SelfUpdate
		if m.sess.Checker != nil {
			after = m.sess.Checker.Updated(before)
		} else {
			after = cli.ForegroundUpdated(before)
		}
		m.sess.setUpdate(after)
		switch {
		case after.State == cli.UpdateUpdated:
			m.say(false, "updated: press R to restart into %s", short(after.After))
		case msg.err != nil:
			m.say(true, "td update failed: %v", msg.err)
		default:
			m.say(false, "td update installed nothing new")
		}
		return m, nil
	case tea.ResumeMsg:
		// Back from ctrl+z: the program has put the screen, the modes and the theme's colours
		// back and asks for the size itself; the clock and the spinners pick up from now.
		m.now = time.Now()
		return m, m.ensureTick()
	case tea.KeyPressMsg:
		return m.key(msg)
	case tea.PasteMsg:
		return m.paste(msg.Content), nil
	}
	return m, nil
}

// paste is text from the clipboard. It is typing where something is being typed, and
// otherwise does what any key does to the splash and the help: closes them. Nowhere is it a
// command, so a pasted "q" never quits.
func (m *Model) paste(s string) tea.Model {
	switch {
	case m.splash:
		m.splash = false
	case m.typing:
		m.addr.insert(s)
	case m.editing:
		m.field.insert(s)
	case m.help:
		m.help = false
	}
	return m
}

// keyName is the key as the screens below match it. Enter is enter whatever is held with it:
// a terminal that reports keys in full says shift+enter where an older one says enter, and a
// choice that works on one has to work on the other.
//
// A chord is named with its modifiers. String gives a key's text when it has any, and a
// terminal that reports keys in full can give ctrl+k or alt+q the text of the letter, which
// would then move the cursor or quit.
func keyName(k tea.KeyPressMsg) string {
	if k.Code == tea.KeyEnter {
		return "enter"
	}
	if k.Mod&chordMods != 0 {
		return k.Keystroke()
	}
	return k.String()
}

// chordMods are the modifiers that make a key a chord rather than a letter; shift only picks
// the letter.
const chordMods = tea.ModCtrl | tea.ModAlt | tea.ModMeta | tea.ModHyper | tea.ModSuper

// XTWINOPS operations: push the window and icon titles on the terminal's stack, pop them.
const (
	pushTitle = 22
	popTitle  = 23
)

func (m *Model) key(k tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if k.Code == 'c' && k.Mod.Contains(tea.ModCtrl) {
		return m.quit(Action{Kind: ActionQuit})
	}
	// ctrl+z is a key in raw mode, not the terminal's stop; the program hands the terminal
	// back, stops td, and takes the terminal again on fg. Nothing is lost: a check for a newer
	// td still under way stops with td and goes on with it.
	if k.Code == 'z' && k.Mod.Contains(tea.ModCtrl) {
		return m, tea.Suspend
	}
	// Any key skips the splash, and does nothing else.
	if m.splash {
		m.splash = false
		return m, nil
	}
	if m.typing {
		return m.typeAddr(k)
	}
	if m.editing {
		return m.editSetting(k)
	}
	if m.help {
		m.help = false
		return m, nil
	}
	switch keyName(k) {
	case "?":
		m.help = true
		return m, nil
	case "u":
		if m.sess.Update().State != cli.UpdateUpdated {
			return m, m.foregroundUpdate()
		}
	case "R":
		if m.sess.Update().State == cli.UpdateUpdated {
			return m.quit(Action{Kind: ActionRestart})
		}
	}
	switch m.screen {
	case screenJoin:
		return m.joinKey(k)
	case screenSettings:
		return m.settingsKey(k)
	case screenChangelog:
		return m.changelogKey(k)
	case screenDoctor:
		return m.doctorKey(k)
	case screenKeys:
		return m.keysKey(k)
	}
	return m.menuKey(k)
}

// copyText puts text on the clipboard both ways: through the terminal, which the program
// writes between frames, and through a clipboard tool on this machine; see ui/clipboard.go.
func copyText(text string) tea.Cmd {
	return tea.Batch(tea.SetClipboard(text), func() tea.Msg {
		clipboardTool(text)
		return nil
	})
}

// clipboardTool is ui.RunClipboardTool, swapped by a test that must not reach the real one.
var clipboardTool = ui.RunClipboardTool

func (m *Model) foregroundUpdate() tea.Cmd {
	m.notice = ""
	return tea.ExecProcess(cli.ForegroundUpdate(), func(err error) tea.Msg { return fgUpdateMsg{err} })
}

func (m *Model) menuKey(k tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	items := m.menu()
	switch keyName(k) {
	case "up", "k":
		m.cursor = (m.cursor + len(items) - 1) % len(items)
	case "down", "j", "tab":
		m.cursor = (m.cursor + 1) % len(items)
	case "q", "esc":
		return m.quit(Action{Kind: ActionQuit})
	case "left", "right", "h", "l":
		if m.cursor < len(items) && items[m.cursor] == itemHost {
			m.cycleDifficulty(keyName(k) == "right" || keyName(k) == "l")
		}
	case "y":
		if m.cursor < len(items) && items[m.cursor] == itemHost {
			if cmd, ok := m.joinCommand(); ok {
				m.say(false, "copied: %s", cmd)
				return m, copyText(cmd)
			}
		}
	case "f":
		if m.cursor < len(items) && items[m.cursor] == itemHost {
			key, _ := config.Lookup(config.KeyFog)
			m.save(key, map[bool]string{false: "on", true: "off"}[m.prefs.Fog()])
			m.notice = ""
		}
	case "w":
		if m.cursor < len(items) && items[m.cursor] == itemHost {
			m.cycleWaves()
		}
	case "m":
		if m.cursor < len(items) && items[m.cursor] == itemHost {
			key, _ := config.Lookup(config.KeyMode)
			m.save(key, game.Mode((int(m.prefs.Mode())+1)%int(game.NumModes)).String())
			m.notice = ""
		}
	case "enter", "space":
		if m.cursor >= len(items) {
			m.cursor = 0
		}
		switch items[m.cursor] {
		case itemHost:
			return m.quit(Action{Kind: ActionHost})
		case itemJoin:
			m.screen, m.jcursor, m.notice = screenJoin, 0, ""
			return m, m.scan()
		case itemSettings:
			m.screen, m.notice = screenSettings, ""
		case itemKeys:
			m.screen, m.notice, m.kscroll = screenKeys, "", 0
		case itemChangelog:
			m.screen, m.notice, m.lscroll = screenChangelog, "", -1
			if c, err, _ := m.sess.changelog(); c == nil && err == nil {
				return m, m.readChangelog()
			}
		case itemDoctor:
			m.screen, m.notice, m.dscroll = screenDoctor, "", 0
			return m, m.runDoctor()
		case itemScreenshots:
			if dir, err := web.OpenScreenshots(); err != nil {
				m.say(true, "screenshots: %v", err)
			} else {
				m.say(false, "opened %s", dir)
			}
		case itemUpdate:
			return m, m.foregroundUpdate()
		case itemRestart:
			return m.quit(Action{Kind: ActionRestart})
		case itemQuit:
			return m.quit(Action{Kind: ActionQuit})
		}
	}
	return m, nil
}

func (m *Model) joinKey(k tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	rows := len(m.games) + 1 // the address row is last
	switch keyName(k) {
	case "up", "k":
		m.jcursor = (m.jcursor + rows - 1) % rows
	case "down", "j", "tab":
		m.jcursor = (m.jcursor + 1) % rows
	case "r":
		return m, m.scan()
	case "a":
		m.jcursor, m.typing = len(m.games), true
	case "q", "esc":
		m.screen = screenMenu
		m.scanGen++ // stops the rescan loop
		m.scanning = false
	case "enter", "space":
		if m.jcursor >= len(m.games) {
			m.typing = true
			return m, nil
		}
		return m.quit(Action{Kind: ActionJoin, Addr: m.games[m.jcursor].Addr})
	}
	return m, nil
}

// readChangelog fetches the changelog into the session, so a later launcher opens it at once.
func (m *Model) readChangelog() tea.Cmd {
	sess := m.sess
	if !sess.startChangelog() {
		return nil
	}
	return tea.Batch(func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		c, err := cli.ReadChangelog(ctx)
		if err != nil {
			sess.setChangelog(nil, err)
		} else {
			sess.setChangelog(&c, nil)
		}
		return changelogMsg{}
	}, m.ensureTick())
}

func (m *Model) changelogKey(k tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch keyName(k) {
	case "up", "k":
		m.lscroll = max(m.lscroll-1, 0)
	case "down", "j", "tab":
		m.lscroll++ // the view stops it at the end
	case "pgup":
		m.lscroll = max(m.lscroll-10, 0)
	case "pgdown":
		m.lscroll += 10
	case "home", "g":
		m.lscroll = 0
	case "r":
		m.lscroll = -1
		return m, m.readChangelog()
	case "q", "esc":
		m.screen = screenMenu
	}
	return m, nil
}

// runDoctor runs td doctor's checks into the session; tailscale may take seconds to answer.
func (m *Model) runDoctor() tea.Cmd {
	sess := m.sess
	if !sess.startDoctor() {
		return nil
	}
	return tea.Batch(func() tea.Msg {
		var b strings.Builder
		code := cli.DoctorReport(ui.New(&b))
		sess.setDoctor(strings.Split(strings.TrimRight(b.String(), "\n"), "\n"), code == 0)
		return doctorMsg{}
	}, m.ensureTick())
}

func (m *Model) doctorKey(k tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch keyName(k) {
	case "up", "k":
		m.dscroll = max(m.dscroll-1, 0)
	case "down", "j", "tab":
		m.dscroll++ // the view stops it at the end
	case "pgup":
		m.dscroll = max(m.dscroll-10, 0)
	case "pgdown":
		m.dscroll += 10
	case "home", "g":
		m.dscroll = 0
	case "r":
		return m, m.runDoctor()
	case "q", "esc":
		m.screen = screenMenu
	}
	return m, nil
}

// keysKey scrolls the game's keys; the view stops it at the end.
func (m *Model) keysKey(k tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch keyName(k) {
	case "up", "k":
		m.kscroll = max(m.kscroll-1, 0)
	case "down", "j", "tab":
		m.kscroll++
	case "pgup":
		m.kscroll = max(m.kscroll-10, 0)
	case "pgdown":
		m.kscroll += 10
	case "home", "g":
		m.kscroll = 0
	case "q", "esc":
		m.screen = screenMenu
	}
	return m, nil
}

func (m *Model) typeAddr(k tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch k.Code {
	case tea.KeyEscape:
		m.typing = false
		return m, nil
	case tea.KeyEnter:
		a := m.addr.value()
		if a == "" {
			m.typing = false
			return m, nil
		}
		if strings.ContainsAny(a, " \t") {
			m.say(true, "%q is not an address", a)
			return m, nil
		}
		return m.quit(Action{Kind: ActionJoin, Addr: a})
	}
	m.addr.key(k)
	return m, nil
}

func (m *Model) settingsKey(k tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	n := len(config.Keys)
	switch keyName(k) {
	case "up", "k":
		m.scursor = (m.scursor + n - 1) % n
	case "down", "j", "tab":
		m.scursor = (m.scursor + 1) % n
	case "q", "esc":
		m.screen = screenMenu
	case "enter", "space":
		key := config.Keys[m.scursor]
		if key.Bool {
			next := "on"
			if config.ParseOnOff(m.prefs.Get(key.Name).Value, true) {
				next = "off"
			}
			m.save(key, next)
			return m, nil
		}
		m.editing = true
		m.field.set(m.prefs.Get(key.Name).Value)
	}
	return m, nil
}

func (m *Model) editSetting(k tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch k.Code {
	case tea.KeyEscape:
		m.editing = false
		return m, nil
	case tea.KeyEnter:
		if m.save(config.Keys[m.scursor], m.field.value()) {
			m.editing = false
		}
		return m, nil
	}
	m.field.key(k)
	return m, nil
}

// save writes one setting and reloads the prefs, keeping the field open on a refusal so the
// value can be fixed rather than retyped.
func (m *Model) save(key config.Key, raw string) bool {
	v, err := config.Set(key.Name, raw)
	if err != nil {
		m.say(true, "%s: %v", strings.ToLower(key.Name), err)
		return false
	}
	m.prefs.Reload()
	m.say(false, "saved %s = %s", strings.ToLower(key.Name), v)
	if cur := m.prefs.Get(key.Name); cur.Source == config.SourceEnv {
		m.say(true, "saved %s = %s, but %s overrides it in this shell", strings.ToLower(key.Name), v, cur.Key.Env)
	} else if cur.Source == config.SourceFlag {
		m.say(true, "saved %s = %s, but --%s overrides it for this run", strings.ToLower(key.Name), v, strings.ToLower(key.Name))
	}
	return true
}

// cycleDifficulty steps the difficulty games are hosted at and remembers it, so the next
// game starts at the same one with a single enter.
func (m *Model) cycleDifficulty(up bool) {
	d := int(m.prefs.Difficulty())
	n := int(game.NumDifficulties)
	if up {
		d = (d + 1) % n
	} else {
		d = (d + n - 1) % n
	}
	key, _ := config.Lookup(config.KeyDifficulty)
	m.save(key, game.Difficulty(d).String())
	m.notice = ""
}

// cycleWaves steps how long the games hosted are, 20, 30 or 40 waves or endless, and
// remembers it.
func (m *Model) cycleWaves() {
	cur, i := m.prefs.Waves(), 0
	for j, v := range game.LastWaves {
		if v == cur {
			i = j
		}
	}
	key, _ := config.Lookup(config.KeyWaves)
	m.save(key, config.FormatWaves(game.LastWaves[(i+1)%len(game.LastWaves)]))
	m.notice = ""
}

func short(h string) string {
	if len(h) > 7 {
		return h[:7]
	}
	return h
}
