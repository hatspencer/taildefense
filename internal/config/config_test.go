package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// isolate points every path at a scratch directory and clears the overrides, so a test
// never reads or writes the real ~/.config/taildefense.
func isolate(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv(EnvConfigDir, filepath.Join(dir, "cfg"))
	t.Setenv("USER", "tester")
	for _, k := range Keys {
		t.Setenv(k.Env, "")
	}
	TailnetName = func() string { return "" }
	return filepath.Join(dir, "cfg")
}

func TestDirFollowsXDGThenHome(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv(EnvConfigDir, "")
	t.Setenv("XDG_CONFIG_HOME", "")
	if d, _ := Dir(); d != filepath.Join(dir, ".config", "taildefense") {
		t.Errorf("home default: %s", d)
	}
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "xdg"))
	if d, _ := Dir(); d != filepath.Join(dir, "xdg", "taildefense") {
		t.Errorf("xdg: %s", d)
	}
	t.Setenv(EnvConfigDir, filepath.Join(dir, "own"))
	if d, _ := Dir(); d != filepath.Join(dir, "own") {
		t.Errorf("override: %s", d)
	}
}

func TestDefaultsWithNoFile(t *testing.T) {
	isolate(t)
	p := Load()
	if p.Err != nil {
		t.Fatal(p.Err)
	}
	if p.Port() != DefaultPort || p.Browser() != BrowserAuto {
		t.Errorf("defaults: port %d browser %q", p.Port(), p.Browser())
	}
	if !p.Reticle() || p.ReticleSize() != DefaultReticleSize {
		t.Errorf("defaults: reticle %v size %d", p.Reticle(), p.ReticleSize())
	}
	for _, v := range p.All() {
		if v.Source != SourceDefault {
			t.Errorf("%s from %s, want default", v.Key.Name, v.Source)
		}
	}
}

func TestPrecedenceFlagEnvFileDefault(t *testing.T) {
	cfg := isolate(t)
	if err := os.MkdirAll(cfg, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "# comment\nPORT=8000\nBROWSER = firefox\nNAME=\"Ada Lovelace\"\nFUTURE=kept\n"
	if err := os.WriteFile(filepath.Join(cfg, File), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	p := Load()
	if p.Port() != 8000 || p.Get(KeyPort).Source != SourceFile {
		t.Errorf("file port: %+v", p.Get(KeyPort))
	}
	if p.Browser() != "firefox" || p.Name() != "Ada Lovelace" {
		t.Errorf("file values: browser %q name %q", p.Browser(), p.Name())
	}

	t.Setenv("TAILDEFENSE_PORT", "9000")
	t.Setenv("TAILDEFENSE_BROWSER", "a\nb") // not a command: the file's value stands
	p = Load()
	if p.Port() != 9000 || p.Get(KeyPort).Source != SourceEnv {
		t.Errorf("env port: %+v", p.Get(KeyPort))
	}
	if p.Browser() != "firefox" || p.Get(KeyBrowser).Source != SourceFile {
		t.Errorf("a bad env value must not win: %+v", p.Get(KeyBrowser))
	}

	if err := p.Override("port", "9100"); err != nil {
		t.Fatal(err)
	}
	if p.Port() != 9100 || p.Get(KeyPort).Source != SourceFlag {
		t.Errorf("flag port: %+v", p.Get(KeyPort))
	}
	if err := p.Override("port", "0"); err == nil {
		t.Error("port 0 accepted")
	}
}

// An older td wrote AUTOUPDATE. It reads as nothing at all, and the next write drops it.
func TestTheRetiredAutoupdateKeyIsReadQuietlyAndDropped(t *testing.T) {
	cfg := isolate(t)
	os.MkdirAll(cfg, 0o755)
	os.WriteFile(filepath.Join(cfg, File), []byte("AUTOUPDATE=off\nPORT=8000\nFUTURE=kept\n"), 0o644)
	t.Setenv("TAILDEFENSE_NO_AUTOUPDATE", "1")
	p := Load()
	if p.Err != nil || p.Port() != 8000 {
		t.Fatalf("err %v port %d", p.Err, p.Port())
	}
	for _, v := range p.All() {
		if strings.EqualFold(v.Key.Name, "autoupdate") {
			t.Errorf("AUTOUPDATE is still a setting: %+v", v)
		}
	}
	if _, err := Set("name", "Ada"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(cfg, File))
	if s := string(b); strings.Contains(s, "AUTOUPDATE") || !strings.Contains(s, "FUTURE=kept\n") || !strings.Contains(s, "PORT=8000\n") {
		t.Errorf("after a write:\n%s", s)
	}
}

func TestATypoKeepsTheDefault(t *testing.T) {
	cfg := isolate(t)
	os.MkdirAll(cfg, 0o755)
	os.WriteFile(filepath.Join(cfg, File), []byte("PORT=http\nRETICLE=of\nRETICLE_SIZE=1000\n"), 0o644)
	p := Load()
	if p.Port() != DefaultPort {
		t.Errorf("typos changed values: port %d", p.Port())
	}
	if !p.Reticle() || p.ReticleSize() != DefaultReticleSize {
		t.Errorf("typos changed values: reticle %v size %d", p.Reticle(), p.ReticleSize())
	}
}

func TestOnOffVocabulary(t *testing.T) {
	for in, want := range map[string]bool{"on": true, "YES": true, "true": true, "1": true, "off": false, "No": false, "false": false, "0": false} {
		if got := ParseOnOff(in, !want); got != want {
			t.Errorf("%q: got %v", in, got)
		}
	}
	if !ParseOnOff("maybe", true) || ParseOnOff("maybe", false) {
		t.Error("an unknown word must be the fallback")
	}
}

func TestSetWritesAndKeepsOtherKeys(t *testing.T) {
	cfg := isolate(t)
	os.MkdirAll(cfg, 0o755)
	os.WriteFile(filepath.Join(cfg, File), []byte("FUTURE=kept\n"), 0o644)
	if v, err := Set("fog", "no"); err != nil || v != "off" {
		t.Fatalf("set: %q %v", v, err)
	}
	if _, err := Set("browser", "a\nb"); err == nil {
		t.Error("a two-line browser accepted")
	}
	if _, err := Set("colour", "red"); err == nil || !strings.Contains(err.Error(), "name, port, difficulty, fog, waves, mode, volume, music, reticle, reticle_size, browser, slack_token, slack_channel") {
		t.Errorf("unknown key: %v", err)
	}
	if v, err := Set("difficulty", "HARD"); err != nil || v != "hard" {
		t.Errorf("difficulty: %q %v", v, err)
	}
	if _, err := Set("difficulty", "nightmare"); err == nil {
		t.Error("a nonsense difficulty accepted")
	}
	for in, want := range map[string]string{"40": "40", " 100% ": "100", "0": "0", "off": "0", "on": "70"} {
		if v, err := Set("volume", in); err != nil || v != want {
			t.Errorf("volume %q: %q %v, want %q", in, v, err, want)
		}
	}
	for _, in := range []string{"101", "-1", "loud"} {
		if _, err := Set("volume", in); err == nil {
			t.Errorf("volume %q accepted", in)
		}
		if _, err := Set("music", in); err == nil {
			t.Errorf("music %q accepted", in)
		}
	}
	for in, want := range map[string]string{"35": "35", "0": "0", "off": "0", "on": "50"} {
		if v, err := Set("music", in); err != nil || v != want {
			t.Errorf("music %q: %q %v, want %q", in, v, err, want)
		}
	}
	for in, want := range map[string]string{"off": "off", "NO": "off", "on": "on", "1": "on"} {
		if v, err := Set("reticle", in); err != nil || v != want {
			t.Errorf("reticle %q: %q %v, want %q", in, v, err, want)
		}
	}
	if _, err := Set("reticle", "big"); err == nil {
		t.Error("reticle \"big\" accepted")
	}
	for in, want := range map[string]string{"50": "50", " 150% ": "150", "300": "300", "100": "100"} {
		if v, err := Set("reticle_size", in); err != nil || v != want {
			t.Errorf("reticle_size %q: %q %v, want %q", in, v, err, want)
		}
	}
	for _, in := range []string{"49", "301", "0", "-100", "off", "huge"} {
		if _, err := Set("reticle_size", in); err == nil {
			t.Errorf("reticle_size %q accepted", in)
		}
	}
	if _, err := Set("name", "  Grace   Hopper "); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(cfg, File))
	s := string(b)
	for _, want := range []string{"FOG=off\n", "NAME=Grace Hopper\n", "FUTURE=kept\n"} {
		if !strings.Contains(s, want) {
			t.Errorf("file lacks %q:\n%s", want, s)
		}
	}
	// The file was written 0644 above, as an older td wrote it; any write tightens it.
	if fi, _ := os.Stat(filepath.Join(cfg, File)); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v, want 0600", fi.Mode().Perm())
	}
	if err := Unset("name"); err != nil {
		t.Fatal(err)
	}
	if p := Load(); p.Get(KeyName).Source != SourceDefault || p.Name() != "tester" {
		t.Errorf("after unset: %+v", p.Get(KeyName))
	}
	leftovers, _ := filepath.Glob(filepath.Join(cfg, ".prefs-*"))
	if len(leftovers) > 0 {
		t.Errorf("temp files left: %v", leftovers)
	}
}

func TestSlackKeysParse(t *testing.T) {
	isolate(t)
	tok := "xoxb-1234567890-abcdefghijkl-a1b2"
	for in, want := range map[string]string{tok: tok, "  " + tok + "\n": tok, "": "", "   ": ""} {
		if got, err := parseSlackToken(in); err != nil || got != want {
			t.Errorf("token %q: %q %v, want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"xoxp-1234-5678", "xapp-1-abc", "xoxb-", "xoxb-12 34", "xoxb-12\t34", "token"} {
		if _, err := parseSlackToken(in); err == nil || !strings.Contains(err.Error(), "xoxb-") {
			t.Errorf("token %q: %v, want a refusal naming xoxb-", in, err)
		}
	}
	for in, want := range map[string]string{
		"C0123ABCD": "C0123ABCD", " G0123ABCDE ": "G0123ABCDE", "D012345678": "D012345678",
		"td-games": "#td-games", "#td-games": "#td-games", "C0123": "#C0123", "c0123abcd": "#c0123abcd",
		"general": "#general", "": "",
	} {
		if got, err := parseSlackChannel(in); err != nil || got != want {
			t.Errorf("channel %q: %q %v, want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"#", "td games", "#a#b", "##x"} {
		if _, err := parseSlackChannel(in); err == nil {
			t.Errorf("channel %q accepted", in)
		}
	}
}

func TestSlackOnlyWithBoth(t *testing.T) {
	cfg := isolate(t)
	tok := "xoxb-1234567890-abcdefghijkl-a1b2"
	if _, _, on := Load().Slack(); on {
		t.Error("on with nothing set")
	}
	if _, err := Set("slack_token", tok); err != nil {
		t.Fatal(err)
	}
	if got, _, on := Load().Slack(); on || got != tok {
		t.Errorf("token only: %q %v", got, on)
	}
	if _, err := Set("slack_channel", "td-games"); err != nil {
		t.Fatal(err)
	}
	if got, ch, on := Load().Slack(); !on || got != tok || ch != "#td-games" {
		t.Errorf("both: %q %q %v", got, ch, on)
	}
	if fi, _ := os.Stat(filepath.Join(cfg, File)); fi.Mode().Perm() != 0o600 {
		t.Errorf("a file holding a token is %v, want 0600", fi.Mode().Perm())
	}
	// An empty value clears a key whose default is nothing, as --reset does, and leaves no
	// blank line behind.
	if v, err := Set("slack_token", " "); err != nil || v != "" {
		t.Fatalf("clear: %q %v", v, err)
	}
	if b, _ := os.ReadFile(filepath.Join(cfg, File)); strings.Contains(string(b), "SLACK_TOKEN") {
		t.Errorf("a cleared token is still in the file:\n%s", b)
	}
	p := Load()
	if _, _, on := p.Slack(); on || p.Get(KeySlackToken).Source != SourceDefault {
		t.Errorf("after clearing: %+v", p.Get(KeySlackToken))
	}
	t.Setenv("TAILDEFENSE_SLACK_TOKEN", tok)
	t.Setenv("TAILDEFENSE_SLACK_CHANNEL", "C0123ABCD")
	if got, ch, on := Load().Slack(); !on || got != tok || ch != "C0123ABCD" {
		t.Errorf("from the environment: %q %q %v", got, ch, on)
	}
}

func TestShowMasksOnlySecrets(t *testing.T) {
	tk, _ := Lookup(KeySlackToken)
	ch, _ := Lookup(KeySlackChannel)
	if !tk.Secret || ch.Secret {
		t.Fatalf("secret: token %v channel %v", tk.Secret, ch.Secret)
	}
	for _, k := range Keys {
		if k.Secret != (k.Name == KeySlackToken) {
			t.Errorf("%s secret %v", k.Name, k.Secret)
		}
	}
	tok := "xoxb-1234567890-abcdefghijkl-a1b2"
	if got := tk.Show(tok); got != "xoxb-…a1b2" {
		t.Errorf("masked %q", got)
	}
	if got := tk.Show(""); got != "" {
		t.Errorf("empty masked to %q", got)
	}
	if got := tk.Show("xoxb-abc"); got != "********" {
		t.Errorf("a short secret shows %q", got)
	}
	if got := ch.Show("#td-games"); got != "#td-games" {
		t.Errorf("a plain key masked: %q", got)
	}
}

func TestDefaultNamePrefersTheTailnetFirstName(t *testing.T) {
	isolate(t)
	if n := resolveName(func() string { return "Ada Lovelace" }); n != "Ada" {
		t.Errorf("got %q", n)
	}
	if n := resolveName(func() string { return "" }); n != "tester" {
		t.Errorf("fallback: %q", n)
	}
}
