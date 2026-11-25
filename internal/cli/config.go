package cli

import (
	"fmt"
	"io"
	"strings"

	"taildefense/internal/config"
	"taildefense/internal/ui"
)

// Config is `td config [key [value]]`: every setting with its source, one setting's value,
// or a new value written to the file. `td config KEY --reset` returns a key to its default,
// as an empty value does for a key whose default is nothing (slack_token, slack_channel). A
// secret key's value is shown masked everywhere here.
//
// The prefs passed in are the ones in force for this run, flags included, so `td config
// --port 9000` shows the flag winning, which is the honest answer.
func Config(w io.Writer, prefs *config.Prefs, args []string) int {
	p := ui.New(w)
	switch len(args) {
	case 0:
		path, _ := config.Path()
		p.Step("td config")
		rows := [][]string{}
		for _, v := range prefs.All() {
			src := string(v.Source)
			if v.Source == config.SourceEnv {
				src += " " + v.Key.Env
			}
			value := ui.StyleCyan.Render(v.Key.Show(v.Value))
			if v.Value == "" {
				value = ui.StyleDim.Render("—") // nothing set, as the Slack keys are by default
			}
			rows = append(rows, []string{
				ui.StyleBold.Render(strings.ToLower(v.Key.Name)), value,
				ui.StyleDim.Render(src), ui.StyleDim.Render(v.Key.Help),
			})
		}
		p.Raw(ui.Table(rows, "  "))
		p.Plain("")
		p.Note("file %s", tilde(path))
		p.Note("set with: td config KEY VALUE   ·   default again: td config KEY --reset")
		if prefs.Err != nil {
			p.Warn("%v", prefs.Err)
		}
		return 0
	case 1:
		k, ok := config.Lookup(args[0])
		if !ok {
			ui.Errorf("unknown setting %q; settings: %s", args[0], strings.Join(config.KeyNames(), ", "))
			return 2
		}
		// A secret is masked here too: what it is for is the prefs file, not a terminal.
		fmt.Fprintln(w, k.Show(prefs.Get(k.Name).Value))
		return 0
	case 2:
		k, ok := config.Lookup(args[0])
		if !ok {
			ui.Errorf("unknown setting %q; settings: %s", args[0], strings.Join(config.KeyNames(), ", "))
			return 2
		}
		key := strings.ToLower(k.Name)
		if args[1] == "--reset" || args[1] == "--unset" {
			if err := config.Unset(k.Name); err != nil {
				p.Fail("%v", err)
				return 1
			}
			p.OK("%s is back to its default", key)
			return 0
		}
		v, err := config.Set(k.Name, args[1])
		if err != nil {
			ui.Errorf("%s: %v", key, err)
			return 2
		}
		if v == "" {
			p.OK("%s is cleared", key)
		} else {
			p.OK("%s = %s", key, ui.StyleCyan.Render(k.Show(v)))
		}
		if cur := prefs.Get(k.Name); cur.Source == config.SourceEnv || cur.Source == config.SourceFlag {
			p.Warn("%s still overrides it in this shell", envOrFlag(cur))
		}
		return 0
	}
	ui.Errorf("td config takes at most a key and a value  (try: td help)")
	return 2
}

func envOrFlag(v config.Value) string {
	if v.Source == config.SourceEnv {
		return v.Key.Env
	}
	return "--" + strings.ToLower(v.Key.Name)
}
