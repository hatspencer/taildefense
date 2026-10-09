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
	"strings"
	"sync"
	"time"

	tea "github.com/charmbracelet/bubbletea"

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
	ActionRestart            // re-exec the installed td after an update
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
// A background update started by one launcher keeps going while a game is played, and the
// next launcher shows how it ended, so the state lives here under a lock rather than in a
// model that is gone by then.
type Session struct {
	Updater *cli.AutoUpdater // nil when td is not installed

	mu         sync.Mutex
	update     cli.SelfUpdate
	checked    bool
	self       tailnet.Self
	tailErr    error
	tailLoaded bool
}

// NewSession starts a session. u may be nil.
func NewSession(u *cli.AutoUpdater) *Session {
	return &Session{Updater: u, update: cli.SelfUpdate{State: cli.UpdateUnknown}}
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
}

type screen int

const (
	screenMenu screen = iota
	screenJoin
	screenSettings
)

type menuItem int

const (
	itemHost menuItem = iota
	itemJoin
	itemSettings
	itemUpdate
	itemRestart
	itemQuit
)

var itemLabels = map[menuItem]string{
	itemHost: "Host a game", itemJoin: "Join a game", itemSettings: "Settings",
	itemUpdate: "Update td now", itemRestart: "Restart into the new td", itemQuit: "Quit",
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
	cursor int // menu
	action Action
	notice string
	bad    bool // notice is an error

	// join
	games    []cli.LsGame
	scanned  bool
	scanning bool
	scanGen  int
	scanAt   time.Time
	jcursor  int
	typing   bool
	addr     lineInput

	// settings
	scursor int
	editing bool
	field   lineInput

	ticking bool
	splash  bool // the boot splash is playing
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
	rescanMsg   struct{ gen int }
	fgUpdateMsg struct{ err error }
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
	return m
}

// Run shows the launcher until the player picks something, and returns what.
func Run(o Options) (Action, error) {
	m := newModel(o)
	final, err := tea.NewProgram(m, tea.WithAltScreen()).Run()
	if err != nil {
		return Action{Kind: ActionQuit}, err
	}
	if fm, ok := final.(*Model); ok {
		return fm.action, nil
	}
	return Action{Kind: ActionQuit}, nil
}

func (m *Model) Init() tea.Cmd {
	cmds := []tea.Cmd{m.loadTailnet()}
	if m.sess.Updater != nil {
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

// checkSelf asks whether td is behind main and, when autoupdate allows, updates in the
// background. The update goroutine writes the session, not the model, so the result
// survives this launcher closing for a game.
func (m *Model) checkSelf() tea.Cmd {
	sess, u := m.sess, m.sess.Updater
	return func() tea.Msg {
		s := u.Check()
		sess.setUpdate(s)
		if u.ShouldStart(s) {
			s.State = cli.UpdateUpdating
			sess.setUpdate(s)
			go func() { sess.setUpdate(u.Run(s)) }()
		}
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

// animating is whether anything on screen moves: a spinner while looking for games or while
// an update runs. An idle launcher sends no frames.
func (m *Model) animating() bool {
	return m.splash || m.scanning || m.sess.Update().State == cli.UpdateUpdating
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
	items := []menuItem{itemHost, itemJoin, itemSettings}
	switch st := m.sess.Update().State; {
	case st == cli.UpdateUpdated:
		items = append(items, itemRestart)
	case st == cli.UpdateBehind || st == cli.UpdateFailed || m.updateOffered():
		items = append(items, itemUpdate)
	}
	return append(items, itemQuit)
}

// updateOffered is a last game that ended because the host runs another protocol.
func (m *Model) updateOffered() bool {
	return m.o.Last != nil && cli.NeedsUpdate(m.o.Last.Err) && m.sess.Update().State != cli.UpdateUpdated
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
	case tailnetMsg, selfMsg:
		return m, m.ensureTick()
	case scanMsg:
		if msg.gen != m.scanGen {
			return m, nil
		}
		m.scanning, m.scanned, m.scanAt = false, true, time.Now()
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
		if m.sess.Updater != nil {
			after = m.sess.Updater.Updated(before)
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
	case tea.KeyMsg:
		return m.key(msg)
	}
	return m, nil
}

func (m *Model) key(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if k.Type == tea.KeyCtrlC {
		return m.quit(Action{Kind: ActionQuit})
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
	switch k.String() {
	case "?":
		m.help = true
		return m, nil
	case "u":
		st := m.sess.Update().State
		if st != cli.UpdateUpdating && st != cli.UpdateUpdated {
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
	}
	return m.menuKey(k)
}

func (m *Model) foregroundUpdate() tea.Cmd {
	m.notice = ""
	return tea.ExecProcess(cli.ForegroundUpdate(), func(err error) tea.Msg { return fgUpdateMsg{err} })
}

func (m *Model) menuKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	items := m.menu()
	switch k.String() {
	case "up", "k":
		m.cursor = (m.cursor + len(items) - 1) % len(items)
	case "down", "j", "tab":
		m.cursor = (m.cursor + 1) % len(items)
	case "q", "esc":
		return m.quit(Action{Kind: ActionQuit})
	case "left", "right", "h", "l":
		if m.cursor < len(items) && items[m.cursor] == itemHost {
			m.cycleDifficulty(k.String() == "right" || k.String() == "l")
		}
	case "enter", " ":
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

func (m *Model) joinKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	rows := len(m.games) + 1 // the address row is last
	switch k.String() {
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
	case "enter", " ":
		if m.jcursor >= len(m.games) {
			m.typing = true
			return m, nil
		}
		return m.quit(Action{Kind: ActionJoin, Addr: m.games[m.jcursor].Addr})
	}
	return m, nil
}

func (m *Model) typeAddr(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.Type {
	case tea.KeyEsc:
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

func (m *Model) settingsKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	n := len(config.Keys)
	switch k.String() {
	case "up", "k":
		m.scursor = (m.scursor + n - 1) % n
	case "down", "j", "tab":
		m.scursor = (m.scursor + 1) % n
	case "q", "esc":
		m.screen = screenMenu
	case "enter", " ":
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

func (m *Model) editSetting(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.Type {
	case tea.KeyEsc:
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
	if key.Name == config.KeyAutoUpdate && m.sess.Updater != nil {
		m.sess.Updater.Enabled = m.prefs.AutoUpdate()
	}
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

func short(h string) string {
	if len(h) > 7 {
		return h[:7]
	}
	return h
}
