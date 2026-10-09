// Package config is what td remembers about a player between runs: the name shown to the
// others, the port games are hosted and looked for on, the frame rate, and whether td keeps
// itself current in the background.
//
// One table of keys drives showing, reading and writing them, so `td config`, the launcher's
// settings screen and the code that reads a value can never disagree about what a key is
// called, what it accepts or what it defaults to.
//
// Precedence, the same everywhere in this family of tools: flag > environment > file >
// default. The file is KEY=VALUE at ${TAILDEFENSE_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/
// taildefense}/prefs, the XDG path on macOS too, so there is one documented place on both.
package config

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"taildefense/internal/game"
	"taildefense/internal/tailnet"
)

// EnvConfigDir overrides the directory the prefs file lives in.
const EnvConfigDir = "TAILDEFENSE_CONFIG_DIR"

// File is the prefs file's name inside the config directory.
const File = "prefs"

// The keys, as they are written in the file and typed after `td config`.
const (
	KeyName       = "NAME"
	KeyPort       = "PORT"
	KeyBrowser    = "BROWSER"
	KeyAutoUpdate = "AUTOUPDATE"
	KeyDifficulty = "DIFFICULTY"
	KeyFog        = "FOG"
)

// DefaultPort is netplay.DefaultPort, repeated here so the prefs do not import the network
// code. A test pins the two together.
const DefaultPort = 7787

// BROWSER values with a meaning of their own; anything else is a command, run with the
// game's URL as its last argument.
const (
	BrowserAuto    = "auto"    // the best browser installed, full screen as an app window
	BrowserDefault = "default" // the system's: open on macOS, xdg-open elsewhere
	BrowserNone    = "none"    // open nothing, print the URL
)

// Source is where a value in force came from. `td config` prints it, because a value nobody
// can account for is what sends someone editing the wrong file.
type Source string

const (
	SourceDefault Source = "default"
	SourceFile    Source = "file"
	SourceEnv     Source = "env"
	SourceFlag    Source = "flag"
)

// Key is one remembered setting.
type Key struct {
	Name string // the file key, upper case
	Env  string // the one-process override
	Help string // one line for `td config` and the settings screen
	// Parse normalises a typed value, or says why it is not one. The same function checks
	// `td config KEY VALUE` and reads the file, so a value the command refuses is also one the
	// file cannot smuggle in.
	Parse func(string) (string, error)
	// Default is the value with nothing set anywhere. A function, because NAME's default asks
	// tailscale, and that should happen only when someone actually needs the name.
	Default func() string
	// Bool marks an on/off key, which the settings screen toggles rather than edits.
	Bool bool
}

// Keys is every setting, in the order they are shown.
var Keys = []Key{
	{Name: KeyName, Env: "TAILDEFENSE_NAME", Help: "your name in games, as the others see it",
		Parse: parseName, Default: func() string { return DefaultName() }},
	{Name: KeyPort, Env: "TAILDEFENSE_PORT", Help: "port games are hosted and looked for on",
		Parse: parsePort, Default: func() string { return strconv.Itoa(DefaultPort) }},
	{Name: KeyDifficulty, Env: "TAILDEFENSE_DIFFICULTY", Help: "how hard the games you host are: easy, normal, hard or brutal",
		Parse: parseDifficulty, Default: func() string { return strings.ToLower(game.DefaultDifficulty.String()) }},
	{Name: KeyFog, Env: "TAILDEFENSE_FOG", Help: "fog of war in the games you host: only what the team can see is shown",
		Parse: parseOnOff, Default: func() string { return "off" }, Bool: true},
	{Name: KeyBrowser, Env: "TAILDEFENSE_BROWSER", Help: "what opens the game: auto (best browser, full screen), default, chrome, firefox…, none or a command",
		Parse: parseBrowser, Default: func() string { return BrowserAuto }},
	{Name: KeyAutoUpdate, Env: "TAILDEFENSE_NO_AUTOUPDATE", Help: "update td in the background when main moves on",
		Parse: parseOnOff, Default: func() string { return "on" }, Bool: true},
}

// Lookup finds a key by name, in any case.
func Lookup(name string) (Key, bool) {
	name = strings.ToUpper(strings.TrimSpace(name))
	for _, k := range Keys {
		if k.Name == name {
			return k, true
		}
	}
	return Key{}, false
}

// KeyNames lists the keys in lower case, the way they are typed.
func KeyNames() []string {
	out := make([]string, len(Keys))
	for i, k := range Keys {
		out[i] = strings.ToLower(k.Name)
	}
	return out
}

// Dir is the config directory: TAILDEFENSE_CONFIG_DIR, else $XDG_CONFIG_HOME/taildefense,
// else ~/.config/taildefense.
func Dir() (string, error) {
	if v := os.Getenv(EnvConfigDir); v != "" {
		return v, nil
	}
	if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
		return filepath.Join(v, "taildefense"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "taildefense"), nil
}

// Path is the prefs file.
func Path() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, File), nil
}

// Value is one setting in force.
type Value struct {
	Key    Key
	Value  string
	Source Source
}

// Prefs is every setting in force for this process.
type Prefs struct {
	values map[string]Value
	// Err is a file that exists but could not be read. The values are still usable (they are
	// the defaults and the environment), because refusing to start a game over a broken
	// prefs file has its priorities wrong; `td config` shows it so it can be fixed.
	Err error
}

// Load reads the file and the environment over the defaults. A missing file is the
// defaults, not an error: most machines never write one. A value that does not parse keeps
// the layer below it, so a typo never silently turns a feature off.
func Load() *Prefs {
	p := &Prefs{values: map[string]Value{}}
	file, err := readFile()
	p.Err = err
	for _, k := range Keys {
		v := Value{Key: k, Source: SourceDefault}
		if raw, ok := file[k.Name]; ok {
			if n, err := k.Parse(raw); err == nil {
				v.Value, v.Source = n, SourceFile
			}
		}
		if n, ok := envValue(k); ok {
			v.Value, v.Source = n, SourceEnv
		}
		p.values[k.Name] = v
	}
	return p
}

// envValue reads a key's override. AUTOUPDATE's variable is a negative, the shape every
// NO_ variable in this family has: set to anything true, autoupdate is off for this run.
func envValue(k Key) (string, bool) {
	raw, ok := os.LookupEnv(k.Env)
	if !ok || strings.TrimSpace(raw) == "" {
		return "", false
	}
	if k.Name == KeyAutoUpdate {
		if ParseOnOff(raw, false) {
			return "off", true
		}
		return "", false
	}
	n, err := k.Parse(raw)
	if err != nil {
		return "", false
	}
	return n, true
}

// Override sets a value from a command-line flag, for this process only.
func (p *Prefs) Override(name, raw string) error {
	k, ok := Lookup(name)
	if !ok {
		return unknownKey(name)
	}
	n, err := k.Parse(raw)
	if err != nil {
		return fmt.Errorf("--%s: %v", strings.ToLower(k.Name), err)
	}
	p.values[k.Name] = Value{Key: k, Value: n, Source: SourceFlag}
	return nil
}

// Reload reads the file and the environment again after a change, keeping the values flags
// gave this process: a flag still wins over a setting saved from the launcher.
func (p *Prefs) Reload() {
	n := Load()
	for name, v := range p.values {
		if v.Source == SourceFlag {
			n.values[name] = v
		}
	}
	p.values, p.Err = n.values, n.Err
}

// Get is a setting in force with its source. A default is resolved here, on first use.
func (p *Prefs) Get(name string) Value {
	k, _ := Lookup(name)
	v, ok := p.values[k.Name]
	if !ok {
		v = Value{Key: k, Source: SourceDefault}
	}
	if v.Source == SourceDefault && v.Value == "" && k.Default != nil {
		v.Value = k.Default()
		p.values[k.Name] = v
	}
	return v
}

// All is every setting, in table order.
func (p *Prefs) All() []Value {
	out := make([]Value, 0, len(Keys))
	for _, k := range Keys {
		out = append(out, p.Get(k.Name))
	}
	return out
}

// Name is the player's name.
func (p *Prefs) Name() string { return p.Get(KeyName).Value }

// Port is the game port.
func (p *Prefs) Port() int {
	n, _ := strconv.Atoi(p.Get(KeyPort).Value)
	if n <= 0 {
		return DefaultPort
	}
	return n
}

// Browser is what opens the game page: BrowserDefault, BrowserNone or a command.
func (p *Prefs) Browser() string { return p.Get(KeyBrowser).Value }

// Difficulty is what games are hosted at.
func (p *Prefs) Difficulty() game.Difficulty {
	d, _ := game.ParseDifficulty(p.Get(KeyDifficulty).Value)
	return d
}

// Fog is whether games are hosted with fog of war.
func (p *Prefs) Fog() bool { return ParseOnOff(p.Get(KeyFog).Value, false) }

// AutoUpdate is whether td may update itself in the background.
func (p *Prefs) AutoUpdate() bool { return ParseOnOff(p.Get(KeyAutoUpdate).Value, true) }

// Set validates a value and writes it to the file. It returns the normalised value.
func Set(name, raw string) (string, error) {
	k, ok := Lookup(name)
	if !ok {
		return "", unknownKey(name)
	}
	n, err := k.Parse(raw)
	if err != nil {
		return "", err
	}
	file, err := readFile()
	if err != nil {
		return "", err
	}
	file[k.Name] = n
	return n, writeFile(file)
}

// Unset removes a key from the file, so the default applies again.
func Unset(name string) error {
	k, ok := Lookup(name)
	if !ok {
		return unknownKey(name)
	}
	file, err := readFile()
	if err != nil {
		return err
	}
	delete(file, k.Name)
	return writeFile(file)
}

func unknownKey(name string) error {
	return fmt.Errorf("unknown setting %q; settings: %s", name, strings.Join(KeyNames(), ", "))
}

// readFile reads the raw KEY=VALUE pairs. Unknown keys are kept, so a newer td's setting
// survives an older td writing the file.
func readFile() (map[string]string, error) {
	out := map[string]string{}
	path, err := Path()
	if err != nil {
		return out, err
	}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return out, fmt.Errorf("cannot read %s: %w", path, err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out[strings.ToUpper(strings.TrimSpace(key))] = trimQuotes(strings.TrimSpace(value))
	}
	if err := sc.Err(); err != nil {
		return out, fmt.Errorf("cannot read %s: %w", path, err)
	}
	return out, nil
}

// writeFile writes the whole file through a temporary file and a rename: a file half written
// by an interrupted command would be read as a broken one on every run afterwards. Mode 644,
// nothing in it is secret.
func writeFile(values map[string]string) error {
	path, err := Path()
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var b strings.Builder
	b.WriteString("# td preferences. Change with: td config KEY VALUE, or the launcher's settings.\n")
	known := map[string]bool{}
	for _, k := range Keys {
		known[k.Name] = true
		if v, ok := values[k.Name]; ok {
			fmt.Fprintf(&b, "%s=%s\n", k.Name, v)
		}
	}
	var rest []string
	for k := range values {
		if !known[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	for _, k := range rest {
		fmt.Fprintf(&b, "%s=%s\n", k, values[k])
	}
	tmp, err := os.CreateTemp(dir, ".prefs-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(b.String()); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func trimQuotes(s string) string {
	if len(s) >= 2 && (s[0] == '"' || s[0] == '\'') && s[len(s)-1] == s[0] {
		return s[1 : len(s)-1]
	}
	return s
}

// maxName is the longest name kept. The host shortens names further for its HUD; this only
// stops a pasted paragraph from becoming somebody's name.
const maxName = 24

func parseName(s string) (string, error) {
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", fmt.Errorf("a name cannot be empty")
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("a name cannot hold control characters")
		}
	}
	if r := []rune(s); len(r) > maxName {
		s = string(r[:maxName])
	}
	return s, nil
}

func parseDifficulty(s string) (string, error) {
	d, err := game.ParseDifficulty(s)
	if err != nil {
		return "", err
	}
	return strings.ToLower(d.String()), nil
}

func parsePort(s string) (string, error) {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil || n < 1 || n > 65535 {
		return "", fmt.Errorf("%q is not a port: 1 to 65535", s)
	}
	return strconv.Itoa(n), nil
}

func parseBrowser(s string) (string, error) {
	s = strings.TrimSpace(s)
	switch strings.ToLower(s) {
	case "", BrowserAuto, "fullscreen":
		return BrowserAuto, nil
	case BrowserDefault, "system":
		return BrowserDefault, nil
	case BrowserNone, "off", "no":
		return BrowserNone, nil
	}
	if strings.ContainsAny(s, "\n\r") {
		return "", fmt.Errorf("%q is not a command", s)
	}
	return s, nil
}

func parseOnOff(s string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "on", "yes", "true", "1":
		return "on", nil
	case "off", "no", "false", "0":
		return "off", nil
	}
	return "", fmt.Errorf("%q is not on or off", s)
}

// ParseOnOff reads a switch the way people type one: on/off, yes/no, true/false, 1/0.
// Anything else is the fallback, so a hand-edited file with a typo keeps the default rather
// than silently turning something off.
func ParseOnOff(s string, fallback bool) bool {
	v, err := parseOnOff(s)
	if err != nil {
		return fallback
	}
	return v == "on"
}

// TailnetName is asked for the default NAME: the tailnet display name of this machine's
// user. A variable so tests answer without running tailscale.
var TailnetName = func() string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	self, _, err := tailnet.Status(ctx)
	if err != nil {
		return ""
	}
	return self.Name
}

var (
	nameOnce    sync.Once
	defaultName string
)

// DefaultName is the first word of the tailnet display name, else the login name of the
// user running td, else "player". Asked once per process.
func DefaultName() string {
	nameOnce.Do(func() { defaultName = resolveName(TailnetName) })
	return defaultName
}

func resolveName(fromTailnet func() string) string {
	if f := strings.Fields(fromTailnet()); len(f) > 0 {
		if n, err := parseName(f[0]); err == nil {
			return n
		}
	}
	return LocalUser()
}

// LocalUser is $USER, else the account name, else "player".
func LocalUser() string {
	if v := strings.TrimSpace(os.Getenv("USER")); v != "" {
		return v
	}
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	return "player"
}
