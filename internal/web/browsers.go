package web

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"taildefense/internal/config"
)

// Browser is an installed browser td can start the game in, full screen, as an app window
// of its own: no tabs, no address bar, the whole screen for the game.
type Browser struct {
	ID   string // what the BROWSER setting and the launch links call it: chrome, firefox
	Name string // for people: Google Chrome
	Path string // the executable
	kind string // chromium, firefox or safari
}

// Fullscreen reports whether td can start this browser full screen; Safari only opens a tab.
func (b Browser) Fullscreen() bool { return b.kind != "safari" }

type candidate struct {
	id, name, kind string
	linux          []string // names on PATH, then absolute paths (snap, flatpak exports)
	mac            string   // the app bundle's executable, under /Applications
}

// candidates is every browser td knows, best for the game first: the Chromium family has
// WebGPU and an app mode, Firefox a kiosk mode, Safari neither.
var candidates = []candidate{
	{"chrome", "Google Chrome", "chromium", []string{"google-chrome-stable", "google-chrome", "/var/lib/flatpak/exports/bin/com.google.Chrome"},
		"Google Chrome.app/Contents/MacOS/Google Chrome"},
	{"chromium", "Chromium", "chromium", []string{"chromium", "chromium-browser", "/snap/bin/chromium", "/var/lib/flatpak/exports/bin/org.chromium.Chromium"},
		"Chromium.app/Contents/MacOS/Chromium"},
	{"brave", "Brave", "chromium", []string{"brave-browser", "brave", "/var/lib/flatpak/exports/bin/com.brave.Browser"},
		"Brave Browser.app/Contents/MacOS/Brave Browser"},
	{"edge", "Microsoft Edge", "chromium", []string{"microsoft-edge-stable", "microsoft-edge", "/var/lib/flatpak/exports/bin/com.microsoft.Edge"},
		"Microsoft Edge.app/Contents/MacOS/Microsoft Edge"},
	{"vivaldi", "Vivaldi", "chromium", []string{"vivaldi-stable", "vivaldi"}, "Vivaldi.app/Contents/MacOS/Vivaldi"},
	{"firefox", "Firefox", "firefox", []string{"firefox", "/snap/bin/firefox", "/var/lib/flatpak/exports/bin/org.mozilla.firefox"},
		"Firefox.app/Contents/MacOS/firefox"},
	{"safari", "Safari", "safari", nil, "Safari.app/Contents/MacOS/Safari"},
}

// Browsers lists the browsers installed here, best for the game first.
func Browsers() []Browser {
	var out []Browser
	home, _ := os.UserHomeDir()
	for _, c := range candidates {
		var path string
		if runtime.GOOS == "darwin" {
			for _, dir := range []string{"/Applications", filepath.Join(home, "Applications"), "/System/Applications", "/System/Cryptexes/App/System/Applications"} {
				if p := filepath.Join(dir, c.mac); c.mac != "" && isExec(p) {
					path = p
					break
				}
			}
		} else {
			for _, n := range c.linux {
				if filepath.IsAbs(n) {
					if isExec(n) {
						path = n
						break
					}
				} else if p, err := exec.LookPath(n); err == nil {
					path = p
					break
				}
			}
		}
		if path != "" {
			out = append(out, Browser{ID: c.id, Name: c.name, Path: path, kind: c.kind})
		}
	}
	return out
}

func isExec(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0
}

// FindBrowser is the installed browser with an id, if there is one.
func FindBrowser(id string) (Browser, bool) {
	id = strings.ToLower(strings.TrimSpace(id))
	for _, b := range Browsers() {
		if b.ID == id {
			return b, true
		}
	}
	return Browser{}, false
}

// IsBrowserID reports whether a BROWSER setting names a browser td knows, installed or not.
func IsBrowserID(s string) bool {
	s = strings.ToLower(strings.TrimSpace(s))
	for _, c := range candidates {
		if c.id == s {
			return true
		}
	}
	return false
}

// args is the command line that starts the game in b. Each browser gets a profile of its
// own under td's config directory: the flags only take when the profile is not already open
// in someone's everyday browser, it keeps the game's settings between games, and the window
// can be closed when the game ends without touching anything else.
func (b Browser) args(url string) ([]string, error) {
	switch b.kind {
	case "safari":
		return []string{"open", "-a", "Safari", url}, nil
	}
	dir, err := config.Dir()
	if err != nil {
		return nil, err
	}
	profile := filepath.Join(dir, "browser", b.ID)
	if err := os.MkdirAll(profile, 0o700); err != nil {
		return nil, err
	}
	if b.kind == "firefox" {
		if err := firefoxPrefs(profile); err != nil {
			return nil, err
		}
		return []string{b.Path, "-new-instance", "-profile", profile, "-kiosk", url}, nil
	}
	return []string{b.Path,
		"--user-data-dir=" + profile,
		"--app=" + url,
		"--start-fullscreen",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate,MediaRouter",
		// The game draws on the GPU and must keep up with the host even unfocused.
		"--ignore-gpu-blocklist",
		"--enable-gpu-rasterization",
		"--disable-background-timer-throttling",
		"--disable-renderer-backgrounding",
		"--disable-backgrounding-occluded-windows",
	}, nil
}

// firefoxPrefs quiets a fresh Firefox profile: no welcome tour, no default browser
// question, no full screen warning, the GPU used.
func firefoxPrefs(profile string) error {
	prefs := `user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("full-screen-api.warning.timeout", 0);
user_pref("layers.acceleration.force-enabled", true);
user_pref("webgl.force-enabled", true);
`
	return os.WriteFile(filepath.Join(profile, "user.js"), []byte(prefs), 0o600)
}

// launcher starts browsers for one game and closes the windows it started when the game
// is over.
type launcher struct {
	mu    sync.Mutex
	procs []*os.Process
}

// launch starts the game in b.
func (l *launcher) launch(b Browser, url string) error {
	argv, err := b.args(url)
	if err != nil {
		return err
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", b.Name, err)
	}
	go func() { _ = cmd.Wait() }()
	if b.kind != "safari" { // `open` is gone at once, and Safari is the player's own
		l.mu.Lock()
		l.procs = append(l.procs, cmd.Process)
		l.mu.Unlock()
	}
	return nil
}

// close asks every window td started to close.
func (l *launcher) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, p := range l.procs {
		_ = p.Signal(syscall.SIGTERM)
	}
	l.procs = nil
}

// errNoneInstalled is auto finding no browser it knows.
var errNoneInstalled = errors.New("no browser td knows is installed")

// open opens the game the way the BROWSER setting says and describes where:
//
//	auto     the best installed browser, full screen; the system's browser when none is
//	default  the system's browser, an ordinary tab
//	chrome…  that browser, full screen
//	none     nothing (ErrNoBrowser)
//	other    a command, run with the URL as its last argument
func (l *launcher) open(setting, url string) (string, error) {
	switch s := strings.ToLower(strings.TrimSpace(setting)); {
	case s == config.BrowserAuto:
		for _, b := range Browsers() {
			if err := l.launch(b, url); err == nil {
				return describe(b), nil
			}
		}
		if err := Open(config.BrowserDefault, url); err != nil {
			return "", errors.Join(errNoneInstalled, err)
		}
		return "your browser", nil
	case IsBrowserID(s):
		b, ok := FindBrowser(s)
		if !ok {
			return "", fmt.Errorf("%s is not installed here", s)
		}
		return describe(b), l.launch(b, url)
	}
	if err := Open(setting, url); err != nil {
		return "", err
	}
	if setting == config.BrowserDefault {
		return "your browser", nil
	}
	return strings.Fields(setting)[0], nil
}

func describe(b Browser) string {
	if b.Fullscreen() {
		return b.Name + ", full screen"
	}
	return b.Name
}

// closeSoon closes the started windows after a moment, long enough to read why the game
// ended.
func (l *launcher) closeSoon(d time.Duration) {
	l.mu.Lock()
	n := len(l.procs)
	l.mu.Unlock()
	if n == 0 {
		return
	}
	time.Sleep(d)
	l.close()
}
