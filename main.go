// taildefense: co-op wave defense in the browser, hosted and joined over your tailnet.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"taildefense/internal/cli"
	"taildefense/internal/config"
	"taildefense/internal/netplay"
	"taildefense/internal/platform"
	"taildefense/internal/tui"
	"taildefense/internal/ui"
	"taildefense/internal/version"
	"taildefense/internal/web"
)

const usage = `td: co-op wave defense in your browser, over your tailnet

usage:
  td                             the launcher: host, join, settings
  td host [--port N] [--seed S] [--name NAME] [--difficulty D]
                                 host a game and play it in the browser
  td join HOST[:PORT] [--name NAME]             join a friend's game in the browser
  td serve [--port N] [--seed S] [--difficulty D]
                                 a dedicated game with no player of its own, until ctrl+c
  td ls [--json] [--port N]      the games on your tailnet
  td doctor                      check tailscale, the browser and what updates need
  td config [KEY [VALUE]]        show, read or set name, port, difficulty, browser, autoupdate
                                 (td config KEY --reset returns one to its default)
  td frame [--width W] [--height H] [--view menu|join|settings|help|splash] [--at S]
                                 render one launcher frame from demo data (--at: seconds
                                 into the splash)
  td bench [--wave N] [--players P] [--seconds S] [--seed S]
                                 a late, busy wave (12, 4 players) timed: sim, encode, relay
  td install [-f]                install this binary to ~/.taildefense, linked from ~/.local/bin
  td update [-f] [-b BRANCH]     clone, build in a container, reinstall
  td version [--offline] [--json]  this build, its source, whether an update waits

flags:
  --port N         game port, default 7787 (or TAILDEFENSE_PORT, td config port)
  --name NAME      your name in the game (or TAILDEFENSE_NAME, td config name)
  --difficulty D   easy, normal (the default), hard or brutal, for games you host
                   (or TAILDEFENSE_DIFFICULTY, td config difficulty)
  --no-browser     print the game's URL instead of opening it (td config browser none)
  --seed S         the map seed when hosting; 0 picks one
  --theme NAME     colour theme for the launcher and output (or TAILDEFENSE_THEME)
  --no-splash      skip the launcher's boot animation
  --no-anim        no animation
  --no-color       no colour

update flags:
  -f, --force      reinstall from main even when up to date, forgetting a followed branch
  -b, --branch B   install branch B and keep following it
`

type opts struct {
	json, force, offline, noAnim, noColor bool
	noSplash                              bool
	at                                    float64
	launcherFrame, noBrowser              bool
	port, width, height                   int
	wave, seconds, players                int
	seed                                  uint64
	name, theme, view, difficulty         string
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	cmd := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	var uo cli.UpdateOptions
	if cmd == "update" {
		var err error
		if uo, err = cli.ParseUpdateArgs(args); err != nil {
			ui.Errorf("%v", err)
			return 2
		}
		args = nil
	}

	var o opts
	fs := flag.NewFlagSet("td", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	fs.BoolVar(&o.json, "json", false, "")
	fs.BoolVar(&o.force, "f", false, "")
	fs.BoolVar(&o.force, "force", false, "")
	fs.BoolVar(&o.offline, "offline", false, "")
	fs.BoolVar(&o.noAnim, "no-anim", false, "")
	fs.BoolVar(&o.noColor, "no-color", false, "")
	fs.BoolVar(&o.noSplash, "no-splash", false, "")
	fs.Float64Var(&o.at, "at", 0, "")
	fs.IntVar(&o.port, "port", 0, "")
	fs.IntVar(&o.width, "width", 0, "")
	fs.IntVar(&o.height, "height", 0, "")
	fs.IntVar(&o.wave, "wave", 0, "")
	fs.IntVar(&o.seconds, "seconds", 0, "")
	fs.IntVar(&o.players, "players", 0, "")
	fs.BoolVar(&o.noBrowser, "no-browser", false, "")
	fs.BoolVar(&o.launcherFrame, "launcher", false, "")
	fs.Uint64Var(&o.seed, "seed", 0, "")
	fs.StringVar(&o.name, "name", "", "")
	fs.StringVar(&o.difficulty, "difficulty", "", "")
	fs.StringVar(&o.theme, "theme", os.Getenv("TAILDEFENSE_THEME"), "")
	fs.StringVar(&o.view, "view", tui.FrameMenu, "")

	// Flags and words may come in any order (td join box --name ada), so parse up to each
	// word, keep it, and carry on. `td config KEY --reset` keeps its one flag-shaped word.
	var pos []string
	for {
		if cmd == "config" && len(args) > 0 && (args[0] == "--reset" || args[0] == "--unset") {
			pos, args = append(pos, args[0]), args[1:]
			continue
		}
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return 0
			}
			return 2
		}
		args = fs.Args()
		if len(args) == 0 {
			break
		}
		pos, args = append(pos, args[0]), args[1:]
	}

	if cmd == "frame" {
		// A frame is a picture of the launcher, so it is drawn as a terminal would show it.
		defer platform.SetTTYForTest(true)()
		defer platform.SetStdinTTYForTest(true)()
		if !o.noColor && os.Getenv("NO_COLOR") == "" {
			os.Setenv(ui.EnvForceColor, "1")
		}
		if os.Getenv(ui.EnvColorProfile) == "" {
			os.Setenv(ui.EnvColorProfile, "truecolor")
		}
		if os.Getenv(ui.EnvDarkBackground) == "" {
			os.Setenv(ui.EnvDarkBackground, "1")
		}
	}
	if o.theme != "" {
		if err := ui.SetTheme(o.theme); err != nil {
			ui.Errorf("%v", err)
			return 2
		}
	}
	if o.noAnim {
		ui.SetAnimate(false)
	}
	ui.InitColor(o.noColor)

	prefs := config.Load()
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	if o.noBrowser {
		if err := prefs.Override(config.KeyBrowser, config.BrowserNone); err != nil {
			ui.Errorf("%v", err)
			return 2
		}
	}
	for flagName, key := range map[string]string{"port": config.KeyPort, "name": config.KeyName, "difficulty": config.KeyDifficulty} {
		if set[flagName] {
			if err := prefs.Override(key, fs.Lookup(flagName).Value.String()); err != nil {
				ui.Errorf("%v", err)
				return 2
			}
		}
	}
	if o.json && cmd != "ls" && cmd != "version" {
		ui.Errorf("--json is for td ls and td version only")
		return 2
	}
	takesWords := map[string]int{"join": 1, "config": 2}
	if n := takesWords[cmd]; len(pos) > n {
		ui.Errorf("unexpected %q  (try: td help)", strings.Join(pos[n:], " "))
		return 2
	}

	switch cmd {
	case "", "launch":
		return launcher(prefs, o.noSplash)
	case "host":
		return hostCmd(prefs, o.seed)
	case "join":
		if len(pos) == 0 {
			ui.Errorf("td join needs a host: td join HOST[:PORT]  (td ls lists the games)")
			return 2
		}
		return joinCmd(prefs, pos[0])
	case "serve":
		if news, how := cli.Outdated(prefs.AutoUpdate(), 2*time.Second); news != "" {
			p := ui.New(os.Stdout)
			p.Warn("%s", news)
			p.Detail("%s", how)
		}
		return cli.Serve(os.Stdout, cli.HostOptions{Port: prefs.Port(), Seed: o.seed, Diff: prefs.Difficulty(), Name: prefs.Name(), Version: version.Current()})
	case "ls":
		if o.json {
			ui.SetJSON(true)
		}
		return cli.Ls(os.Stdout, cli.LsOptions{Port: prefs.Port(), JSON: o.json})
	case "doctor":
		return cli.Doctor(os.Stdout)
	case "config":
		return cli.Config(os.Stdout, prefs, pos)
	case "frame":
		w, h := o.width, o.height
		if w <= 0 {
			w = 160
		}
		if h <= 0 {
			h = 48
		}
		fmt.Println(tui.Frame(tui.Options{Prefs: prefs, SplashAt: time.Duration(o.at * float64(time.Second))}, w, h, o.view))
		return 0
	case "bench":
		return cli.Bench(os.Stderr, cli.BenchOptions{Wave: o.wave, Players: o.players, Seconds: o.seconds, Seed: o.seed})
	case "install":
		return cli.Install(os.Stdout, o.force)
	case "update":
		return cli.Update(os.Stdout, uo)
	case "version":
		return cli.PrintVersion(os.Stdout, cli.VersionOptions{Offline: o.offline, JSON: o.json})
	case "help":
		fmt.Print(usage)
		return 0
	}
	ui.Errorf("unknown command %q  (try: td help)", cmd)
	return 2
}

// launcher shows the launcher, runs what it picks, and shows it again with how that went,
// until the player quits. The game plays in the browser; meanwhile the terminal says where
// it is and that ctrl+c ends it.
func launcher(prefs *config.Prefs, noSplash bool) int {
	if !platform.CanHostFullscreen() {
		ui.Errorf("the launcher needs an interactive terminal; without one: td ls, td host or td join HOST")
		return 1
	}
	sess := tui.NewSession(cli.NewAutoUpdater(prefs.AutoUpdate()))
	var last *tui.Outcome
	for {
		act, err := tui.Run(tui.Options{Version: version.Current(), Date: version.Date(), Prefs: prefs, Session: sess, Last: last, NoSplash: noSplash})
		if err != nil {
			ui.Errorf("%v", err)
			return 1
		}
		p := ui.New(os.Stdout)
		switch act.Kind {
		case tui.ActionQuit:
			return 0
		case tui.ActionRestart:
			// Returns only when the exec failed; otherwise this process is the new td now.
			err := cli.Restart(os.Args[1:])
			last = &tui.Outcome{Kind: tui.ActionRestart, Err: err}
		case tui.ActionHost:
			res, err := hostAndPlay(p, prefs, 0)
			last = &tui.Outcome{Kind: tui.ActionHost, Result: res, Err: err}
		case tui.ActionJoin:
			res, err := play(p, prefs, web.Options{Addr: act.Addr, Host: act.Addr})
			last = &tui.Outcome{Kind: tui.ActionJoin, Addr: act.Addr, Result: res, Err: err}
		}
		prefs.Reload()
	}
}

// play joins a game and serves it to the browser until the player leaves, the host goes, or
// ctrl+c. The terminal only says where the game is.
func play(p *ui.Printer, prefs *config.Prefs, o web.Options) (web.Result, error) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	o.Name, o.Version = prefs.Name(), version.Current()
	o.Browser = prefs.Browser()
	if o.Browser == config.BrowserNone {
		o.Browser = ""
	}
	if news, how := cli.Outdated(prefs.AutoUpdate(), 2*time.Second); news != "" {
		p.Warn("%s", news)
		p.Detail("%s", how)
		o.Notice = news + " · " + how
	}
	o.Ready = func(pg web.Page) {
		switch {
		case pg.Opened != "":
			p.OK("the game is open in %s", pg.Opened)
		case pg.OpenErr != nil:
			p.Warn("could not open a browser: %v", pg.OpenErr)
		}
		// Clickable in the terminal: each starts the game full screen in that browser.
		var links []string
		for _, l := range pg.Links {
			links = append(links, ui.Link(l.URL, l.Browser.Name))
		}
		links = append(links, ui.Link(pg.URL, "any browser"))
		if pg.Opened == "" {
			p.OK("open the game: %s", strings.Join(links, "  ·  "))
		} else {
			p.Detail("open it again: %s", strings.Join(links, "  ·  "))
		}
		if o.Hosting {
			p.Note("ctrl+c here, or Leave in the game, ends it for everyone")
		} else {
			p.Note("ctrl+c here, or Leave in the game, to leave")
		}
	}
	return web.Run(ctx, o)
}

// hostAndPlay starts a host and plays it in the browser over loopback, and stops the host
// when the player leaves: a game hosted from a laptop lasts as long as its host plays.
func hostAndPlay(p *ui.Printer, prefs *config.Prefs, seed uint64) (web.Result, error) {
	srv, plan, err := cli.StartHost(context.Background(), cli.HostOptions{
		Port: prefs.Port(), Seed: seed, Diff: prefs.Difficulty(), Name: prefs.Name(), Version: version.Current(),
	}, nil)
	for _, n := range plan.Notes {
		p.Warn("%s", n)
	}
	if err != nil {
		return web.Result{}, err
	}
	defer srv.Close()
	if plan.Hint != "" {
		p.OK("friends join with: %s", ui.StyleBold.Render(plan.Hint))
	}
	addr := ""
	for _, a := range srv.Addrs() {
		if strings.HasPrefix(a, "127.0.0.1:") || addr == "" {
			addr = a
		}
	}
	return play(p, prefs, web.Options{Addr: addr, Host: plan.Config.Host, Hosting: true, Hint: plan.Hint,
		Status: cli.HostStatus(srv, plan)})
}

func hostCmd(prefs *config.Prefs, seed uint64) int {
	p := ui.New(os.Stdout)
	res, err := hostAndPlay(p, prefs, seed)
	return report(p, res, err, "")
}

func joinCmd(prefs *config.Prefs, addr string) int {
	p := ui.New(os.Stdout)
	res, err := play(p, prefs, web.Options{Addr: addr, Host: addr})
	return report(p, res, err, addr)
}

// report prints how a game from the command line ended.
func report(p *ui.Printer, res web.Result, err error, addr string) int {
	if err != nil {
		if addr != "" {
			ui.Errorf("could not join %s: %v", addr, err)
		} else {
			ui.Errorf("%v", err)
		}
		var rej *netplay.RejectError
		if netplay.IsVersionMismatch(err) {
			ui.Hint("td version shows which td a machine runs")
		} else if cli.NeedsUpdate(err) {
			ui.Hint("update with: td update")
		} else if !errors.As(err, &rej) && addr != "" {
			ui.Hint("is a game hosted there? td ls lists the games on your tailnet")
		}
		return 1
	}
	p.OK("%s", tui.ResultText(res))
	return 0
}
