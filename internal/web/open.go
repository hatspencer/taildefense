package web

import (
	"errors"
	"os/exec"
	"runtime"
	"strings"

	"taildefense/internal/config"
)

// Opener is the command that opens a URL for a BROWSER setting, nil for none.
func Opener(setting string) []string {
	switch setting {
	case config.BrowserNone:
		return nil
	case "", config.BrowserDefault, config.BrowserAuto:
		if runtime.GOOS == "darwin" {
			return []string{"open"}
		}
		return []string{"xdg-open"}
	}
	return strings.Fields(setting)
}

// ErrNoBrowser is returned when the setting says not to open one.
var ErrNoBrowser = errors.New("no browser is set to open")

// Open opens url with the BROWSER setting and does not wait for the browser to close.
func Open(setting, url string) error {
	argv := Opener(setting)
	if len(argv) == 0 {
		return ErrNoBrowser
	}
	cmd := exec.Command(argv[0], append(argv[1:], url)...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
