package tui

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"

	"taildefense/internal/cli"
	"taildefense/internal/config"
	"taildefense/internal/netplay"
	"taildefense/internal/tailnet"
	"taildefense/internal/ui"
	"taildefense/internal/web"
)

// View draws the launcher from the window size every frame. Every line is cut to the width
// and the frame to the height at the end, so no screen can wrap however narrow the window.
func (m *Model) View() string {
	w, h := max(m.width, 20), max(m.height, 6)
	elapsed := m.now.Sub(m.started)
	if m.splash && elapsed < SplashFor && splashFits(w, h) {
		return splashView(w, h, elapsed.Seconds())
	}

	head := m.header(w, h)
	var body []string
	switch {
	case m.help:
		body = m.helpView()
	case m.screen == screenJoin:
		body = m.joinView(elapsed, h-len(head)-3)
	case m.screen == screenSettings:
		body = m.settingsView()
	case m.screen == screenChangelog:
		body = m.changelogView(elapsed, h-len(head)-1)
	case m.screen == screenDoctor:
		body = m.doctorView(elapsed, h-len(head)-1)
	default:
		body = m.menuView(w)
	}
	foot := m.footer()

	room := h - len(head) - len(foot)
	if len(body) > room {
		body = body[:max(room, 0)]
	}
	lines := append(head, body...)
	for len(lines) < h-len(foot) {
		lines = append(lines, "")
	}
	lines = append(lines, foot...)
	if len(lines) > h {
		lines = lines[:h]
	}
	for i, l := range lines {
		lines[i] = ansi.Truncate(l, w, "…")
	}
	return strings.Join(lines, "\n")
}

const gutter = "  "

func (m *Model) header(w, h int) []string {
	var out []string
	if brickMarkFits(w, h) {
		// The splash's own wordmark, as it settles, when the window has room for it.
		out = append(out, "")
		out = append(out, brickMarkRows(len(gutter))...)
		out = append(out, gutter+ui.StyleDim.Render("co-op wave defense over your tailnet"))
	} else if h >= 20 {
		rows := ui.WordmarkLarge()
		if w < ui.WordmarkWidth(rows)+2 {
			rows = ui.WordmarkSmall()
		}
		out = append(out, "")
		for _, r := range rows {
			out = append(out, ui.StyleBrand.Render(r))
		}
		out = append(out, gutter+ui.StyleDim.Render("co-op wave defense over your tailnet"))
	} else {
		out = append(out, gutter+ui.StyleBrand.Render("TAIL DEFENSE")+ui.StyleDim.Render("  co-op wave defense over your tailnet"))
	}
	out = append(out, "", gutter+m.versionLine(), gutter+m.tailnetLine())
	if m.o.Last != nil {
		out = append(out, gutter+m.lastLine())
		if m.updateOffered() {
			out = append(out, gutter+ui.StyleYellow.Render("the host runs another td: press u to update now"))
		}
	}
	return append(out, "")
}

func (m *Model) versionLine() string {
	s := m.sess.Update()
	line := ui.StyleDim.Render("td " + m.o.Version)
	if m.o.Date != "" {
		line += ui.StyleDim.Render(" · " + m.o.Date)
	}
	text := s.Text()
	switch s.State {
	case cli.UpdateUpdating:
		line += "  " + ui.StyleCyan.Render(spinner(m.now.Sub(m.started))+" "+text)
	case cli.UpdateUpdated:
		line += "  " + ui.StyleGreen.Render("✔ "+text) + ui.StyleDim.Render(" · R restart now")
	case cli.UpdateBehind:
		line += "  " + ui.StyleYellow.Render(text) + ui.StyleDim.Render(" · u update")
	case cli.UpdateFailed:
		line += "  " + ui.StyleRed.Render(text)
	case cli.UpdateCurrent:
		line += "  " + ui.StyleDim.Render("up to date")
	default:
		if text != "" {
			line += "  " + ui.StyleDim.Render(text)
		}
	}
	return line
}

func (m *Model) tailnetLine() string {
	self, err, loaded := m.sess.tailnet()
	switch {
	case !loaded:
		return ui.StyleDim.Render("○ asking tailscale…")
	case err != nil:
		return ui.StyleYellow.Render("○ tailscale not available") + ui.StyleDim.Render(" · games stay on this machine · td doctor")
	case !self.Running:
		return ui.StyleYellow.Render("○ tailscale not running") + ui.StyleDim.Render(" · tailscale up lets friends join")
	}
	return ui.StyleGreen.Render("● ") + ui.StyleBold.Render(self.Host) + "  " + self.IPv4() + "  " + ui.StyleDim.Render(self.Login)
}

func (m *Model) lastLine() string {
	l := m.o.Last
	where := "the game"
	if l.Kind == ActionJoin && l.Addr != "" {
		where = l.Addr
	}
	if l.Err != nil {
		verb := "could not join " + where
		switch l.Kind {
		case ActionHost:
			verb = "could not host"
		case ActionRestart:
			verb = "could not restart"
		}
		return ui.StyleRed.Render("✘ "+verb+": ") + oneLine(l.Err.Error())
	}
	return ui.StyleAccent.Render("▸ ") + ResultText(l.Result)
}

// ResultText is how a finished game reads: "held out 12 waves · 3456 kills · left".
func ResultText(r web.Result) string {
	waves := r.Wave
	if r.Best > 0 {
		waves = r.Best
	}
	s := fmt.Sprintf("held out %s · %s", plural(waves, "wave"), plural(int(r.Kills), "kill"))
	if r.Reason != "" {
		s += ui.StyleDim.Render(" · " + oneLine(r.Reason))
	}
	return s
}

func (m *Model) menuView(w int) []string {
	var out []string
	items := m.menu()
	if m.cursor >= len(items) {
		m.cursor = len(items) - 1
	}
	for i, it := range items {
		label := itemLabels[it]
		if it == itemUpdate && m.updateWaiting() {
			label = "Update td now"
		}
		if it == itemHost {
			label += "  ‹ " + m.prefs.Difficulty().String() + " ›"
			if m.prefs.Fog() {
				label += "  fog of war"
			}
		}
		desc := m.itemHint(it)
		if i == m.cursor {
			out = append(out, gutter+ui.StyleAccent.Render("▶ ")+ui.StyleBold.Render(label)+"  "+ui.StyleDim.Render(desc))
		} else {
			out = append(out, gutter+"  "+label)
		}
	}
	if m.notice != "" {
		out = append(out, "", gutter+m.noticeText())
	}
	if n := m.whatsNew(); n != nil {
		out = append(out, "", gutter+ui.StyleBold.Render(n.Head))
		for _, c := range n.Changes {
			out = append(out, gutter+"  "+ui.StyleCyan.Render(c[0])+"  "+c[1])
		}
		if n.More > 0 {
			out = append(out, gutter+"  "+ui.StyleDim.Render(fmt.Sprintf("+ %d more", n.More)))
		}
	}
	return out
}

func (m *Model) itemHint(it menuItem) string {
	switch it {
	case itemHost:
		if cmd, ok := m.joinCommand(); ok {
			return "←/→ difficulty · f fog of war · y copies: " + cmd
		}
		return fmt.Sprintf("←/→ difficulty · f fog of war · on port %d, this machine only until tailscale is up", m.prefs.Port())
	case itemJoin:
		return "find games on your tailnet, or type an address"
	case itemSettings:
		return "name " + m.prefs.Name() + " · port " + fmt.Sprint(m.prefs.Port()) + " · browser " + m.prefs.Browser()
	case itemUpdate:
		switch st := m.sess.Update(); {
		case st.State == cli.UpdateUpdating:
			return "updating in the background already"
		case st.State == cli.UpdateFollowing:
			return "td update on the branch you follow, then back here"
		case m.updateWaiting():
			return "a newer td is out · td update, then back here"
		}
		return "td update: gets and installs a newer td if there is one, then back here"
	case itemChangelog:
		return "the latest commits, and which of them this td is"
	case itemDoctor:
		return "check tailscale, the browser and what updates need"
	case itemRestart:
		return "start the updated td in place of this one"
	}
	return ""
}

func (m *Model) noticeText() string {
	if m.bad {
		return ui.StyleRed.Render(m.notice)
	}
	return ui.StyleGreen.Render(m.notice)
}

func (m *Model) joinView(elapsed time.Duration, room int) []string {
	title := ui.StyleBold.Render("Join a game")
	switch {
	case m.scanning:
		title += "  " + ui.StyleCyan.Render(spinner(elapsed)+" looking on port "+fmt.Sprint(m.prefs.Port()))
	case m.scanned:
		title += "  " + ui.StyleDim.Render(fmt.Sprintf("%s found · again in a few seconds · r now", plural(len(m.games), "game")))
	}
	out := []string{gutter + title, ""}

	rows := make([]string, 0, len(m.games)+1)
	incompatible := false
	for i, g := range m.games {
		mark := "  "
		if i == m.jcursor && !m.typing {
			mark = ui.StyleAccent.Render("▶ ")
		}
		ver := ui.StyleDim.Render(g.Version)
		if !g.Compatible {
			ver = ui.StyleYellow.Render(g.Version + " ✗")
			incompatible = true
		}
		owner, _, _ := strings.Cut(g.Owner, "@")
		rows = append(rows, fmt.Sprintf("%s%s%s  %s  %s  %s  %s  %s", gutter, mark,
			ui.StyleBold.Render(pad(g.Peer, 18)), pad(owner, 10),
			pad(fmt.Sprintf("%d/%d", len(g.Players), g.Max), 5), pad(cli.WaveText(g.Wave, g.Phase), 15),
			pad(fmt.Sprintf("%dms", g.PingMs), 6), ver))
	}
	if m.scanned && len(m.games) == 0 && !m.scanning {
		rows = append(rows, gutter+"  "+ui.StyleDim.Render("no games on the tailnet yet; host one, or ask a friend to"))
	}
	addrRow := gutter + "  " + ui.StyleDim.Render("enter address…")
	if m.typing {
		addrRow = gutter + ui.StyleAccent.Render("▶ ") + "address: " + m.addr.view() + ui.StyleDim.Render("  host, host:port or IP · enter joins · esc")
	} else if m.jcursor >= len(m.games) {
		addrRow = gutter + ui.StyleAccent.Render("▶ ") + ui.StyleBold.Render("enter address…")
	}
	rows = append(rows, addrRow)

	// Keep the selected row in view when the list is longer than the window.
	if room = room - len(out) - 2; room < 1 {
		room = 1
	}
	if len(rows) > room {
		start := min(max(m.jcursor-room/2, 0), len(rows)-room)
		rows = rows[start : start+room]
	}
	out = append(out, rows...)
	if incompatible {
		out = append(out, "", gutter+ui.StyleYellow.Render("✗ another td: host and players must run the same one; td update on both (u here)"))
	}
	if m.notice != "" {
		out = append(out, "", gutter+m.noticeText())
	}
	return out
}

// changelogView lists the latest commits on the branch td follows: those newer than this td
// bright, this td's own marked, the ones it already has dimmed. room is the lines it has.
func (m *Model) changelogView(elapsed time.Duration, room int) []string {
	c, err, reading := m.sess.changelog()
	title := ui.StyleBold.Render("Changelog")
	if reading {
		title += "  " + ui.StyleCyan.Render(spinner(elapsed)+" reading the latest commits")
	} else if c != nil {
		title += "  " + ui.StyleDim.Render(fmt.Sprintf("latest %s on %s", plural(len(c.Commits), "commit"), c.Source))
	}
	out := []string{gutter + title, ""}
	switch {
	case err != nil && !reading:
		return append(out, gutter+ui.StyleRed.Render("✘ could not read the changelog: ")+oneLine(err.Error()),
			gutter+ui.StyleDim.Render("r tries again"))
	case c == nil:
		return out
	}

	ver := m.o.Version
	switch {
	case c.Local == 0:
		out = append(out, gutter+ui.StyleGreen.Render("✔ td "+ver+" is the latest"))
	case c.Local > 0:
		out = append(out, gutter+ui.StyleYellow.Render(fmt.Sprintf("td %s is %s behind", ver, plural(c.Local, "commit")))+
			ui.StyleDim.Render(" · u update"))
	default:
		out = append(out, gutter+ui.StyleYellow.Render("td "+m.o.Version+" is not among these")+
			ui.StyleDim.Render(" · older than all of them, or built from elsewhere"))
	}
	out = append(out, "")

	rows := make([]string, len(c.Commits))
	for i, e := range c.Commits {
		date := ui.StyleDim.Render(e.Date)
		switch {
		case i == c.Local:
			rows[i] = gutter + ui.StyleGreen.Render("▶ ") + ui.StyleGreen.Render(e.Hash) + "  " + date + "  " +
				ui.StyleBold.Render(e.Subject) + "  " + ui.StyleGreen.Render("◀ this td")
		case c.Local >= 0 && i > c.Local:
			rows[i] = gutter + "  " + ui.StyleDim.Render(e.Hash+"  "+e.Date+"  "+e.Subject)
		default:
			rows[i] = gutter + "  " + ui.StyleYellow.Render(e.Hash) + "  " + date + "  " + e.Subject
		}
	}
	// Open with this td's own commit in view, then scroll from there.
	shown := max(room-len(out)-1, 1)
	if m.lscroll < 0 {
		m.lscroll = 0
		if c.Local >= shown {
			m.lscroll = c.Local - shown/2
		}
	}
	m.lscroll = min(m.lscroll, max(len(rows)-shown, 0))
	end := min(m.lscroll+shown, len(rows))
	out = append(out, rows[m.lscroll:end]...)
	if m.lscroll > 0 || end < len(rows) {
		out = append(out, gutter+"  "+ui.StyleDim.Render(fmt.Sprintf("%d–%d of %d", m.lscroll+1, end, len(rows))))
	}
	return out
}

// doctorView shows td doctor's report, scrolled to dscroll. room is the lines it has.
func (m *Model) doctorView(elapsed time.Duration, room int) []string {
	lines, ok, running := m.sess.doctor()
	title := ui.StyleBold.Render("Doctor")
	switch {
	case running:
		title += "  " + ui.StyleCyan.Render(spinner(elapsed)+" checking this machine")
	case lines != nil && ok:
		title += "  " + ui.StyleGreen.Render("✔ ready to host and join")
	case lines != nil:
		title += "  " + ui.StyleYellow.Render("friends cannot join until the failures are fixed")
	}
	out := []string{gutter + title, ""}
	if lines == nil {
		return out
	}
	shown := max(room-len(out)-1, 1)
	m.dscroll = min(m.dscroll, max(len(lines)-shown, 0))
	end := min(m.dscroll+shown, len(lines))
	out = append(out, lines[m.dscroll:end]...)
	if m.dscroll > 0 || end < len(lines) {
		out = append(out, gutter+"  "+ui.StyleDim.Render(fmt.Sprintf("%d–%d of %d", m.dscroll+1, end, len(lines))))
	}
	return out
}

func (m *Model) settingsView() []string {
	out := []string{gutter + ui.StyleBold.Render("Settings") + "  " + ui.StyleDim.Render("saved to "+prefsPath()), ""}
	for i, k := range config.Keys {
		v := m.prefs.Get(k.Name)
		mark := "  "
		if i == m.scursor {
			mark = ui.StyleAccent.Render("▶ ")
		}
		value := ui.StyleCyan.Render(v.Value)
		if i == m.scursor && m.editing {
			value = m.field.view()
		}
		src := string(v.Source)
		if v.Source == config.SourceEnv {
			src = k.Env + " overrides"
		}
		out = append(out, fmt.Sprintf("%s%s%s %s  %s", gutter, mark, ui.StyleBold.Render(pad(strings.ToLower(k.Name), 11)),
			value, ui.StyleDim.Render("("+src+")")))
		if i == m.scursor {
			out = append(out, gutter+"    "+ui.StyleDim.Render(k.Help))
		}
	}
	if m.notice != "" {
		out = append(out, "", gutter+m.noticeText())
	}
	return out
}

func (m *Model) helpView() []string {
	out := []string{gutter + ui.StyleBold.Render("Keys") + "  " + ui.StyleDim.Render("any key closes"), ""}
	rows := [][]string{}
	for _, k := range Keys {
		rows = append(rows, []string{ui.StyleCyan.Render(k.Keys), k.Help, ui.StyleDim.Render(k.Group)})
	}
	for _, l := range strings.Split(strings.TrimRight(ui.Table(rows, gutter), "\n"), "\n") {
		out = append(out, l)
	}
	return out
}

func (m *Model) footer() []string {
	var keys string
	switch {
	case m.typing || m.editing:
		keys = "enter save · esc cancel"
	case m.help:
		keys = "any key closes"
	case m.screen == screenJoin:
		keys = "↑↓ move · enter join · a address · r rescan · esc back · ? help"
	case m.screen == screenSettings:
		keys = "↑↓ move · enter edit · esc back · ? help"
	case m.screen == screenChangelog:
		keys = "↑↓ scroll · r read again · esc back · ? help"
	case m.screen == screenDoctor:
		keys = "↑↓ scroll · r check again · esc back · ? help"
	default:
		keys = "↑↓ move · enter choose · q quit · ? help"
	}
	return []string{gutter + ui.StyleDim.Render(keys)}
}

func spinner(elapsed time.Duration) string {
	if !ui.AnimEnabled() {
		return "…"
	}
	return ui.Spinner(elapsed)
}

func pad(s string, w int) string {
	s = ansi.Truncate(s, w, "…")
	if n := w - ansi.StringWidth(s); n > 0 {
		return s + strings.Repeat(" ", n)
	}
	return s
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

func oneLine(s string) string { return strings.Join(strings.Fields(ansi.Strip(s)), " ") }

func prefsPath() string {
	p, err := config.Path()
	if err != nil {
		return "the prefs file"
	}
	return p
}

// Screen names Frame takes.
const (
	FrameMenu      = "menu"
	FrameJoin      = "join"
	FrameSettings  = "settings"
	FrameHelp      = "help"
	FrameChangelog = "changelog"
	FrameDoctor    = "doctor"
	FrameSplash    = "splash"
)

// Frame renders one launcher frame without a terminal, from synthetic data: a tailnet, two
// games (one on another protocol) and a finished game. It runs nothing and asks nothing, so
// it is what tests and `td frame` measure and screenshot.
func Frame(o Options, width, height int, view string) string {
	if o.Session == nil {
		o.Session = NewSession(nil)
		o.Session.setTailnet(tailnet.Self{Running: true, Host: "box", DNSName: "box.tail1234.ts.net",
			IPs: []string{"100.64.0.7"}, Login: "ada@example.com", Name: "Ada Lovelace"}, nil)
		o.Session.setUpdate(cli.SelfUpdate{State: cli.UpdateUpdated, Version: "abc1234", After: "def5678"})
	}
	if o.Version == "" {
		o.Version = "abc1234"
	}
	if o.Last == nil {
		o.Last = &Outcome{Kind: ActionJoin, Addr: "pal", Err: errors.New("this host runs game protocol 2 and you run 1; whoever is older: td update")}
	}
	m := newModel(o)
	m.width, m.height = width, height
	m.scanned = true
	m.games = []cli.LsGame{
		cli.GameOf(netplay.Found{Info: netplay.Info{Proto: netplay.Proto, Version: "abc1234", Host: "pal", Owner: "bob@example.com",
			Players: []string{"bob", "eve"}, Max: 4, Wave: 7, Phase: "fight"}, Addr: "100.64.0.9:7787", Peer: "pal", RTT: 14 * time.Millisecond}),
		cli.GameOf(netplay.Found{Info: netplay.Info{Proto: netplay.Proto + 1, Version: "fff0000", Host: "attic-server-with-a-long-name", Owner: "carol@example.com",
			Max: 4, Phase: "build"}, Addr: "100.64.0.12:7787", Peer: "attic-server-with-a-long-name", RTT: 41 * time.Millisecond}),
	}
	switch view {
	case FrameJoin:
		m.screen = screenJoin
	case FrameSettings:
		m.screen = screenSettings
	case FrameHelp:
		m.help = true
	case FrameChangelog:
		m.screen, m.lscroll = screenChangelog, -1
		if l, _, _ := m.sess.changelog(); l == nil {
			log := &cli.Changelog{Source: "main", Local: 3}
			for i := range 24 {
				log.Commits = append(log.Commits, cli.Commit{Hash: fmt.Sprintf("%07x", 0xabc1234+(i+1)*4099),
					Date: "2026-10-" + fmt.Sprintf("%02d", 28-i), Subject: fmt.Sprintf("The %d-th change, said in one line", 24-i)})
			}
			log.Commits[3].Hash = o.Version
			m.sess.setChangelog(log, nil)
		}
	case FrameDoctor:
		m.screen = screenDoctor
		if l, _, _ := m.sess.doctor(); l == nil {
			var b strings.Builder
			p := ui.New(&b)
			p.Pass("tailscale 100.64.0.7  box  ada@example.com")
			p.Detail("2 peers online on example.com; friends join you with: td join box")
			p.Warn("browser: none td knows is installed; the game opens in the system's browser")
			p.Pass("container engine podman, for td update")
			p.Pass("git, for td update")
			p.Info("autoupdate on (default)")
			p.Plain("")
			p.OK("ready: td opens the launcher, td host starts a game")
			m.sess.setDoctor(strings.Split(strings.TrimRight(b.String(), "\n"), "\n"), true)
		}
	case FrameSplash:
		at := o.SplashAt
		if at <= 0 {
			at = 1200 * time.Millisecond
		}
		m.splash, m.now = true, m.started.Add(at)
	}
	return m.View()
}
