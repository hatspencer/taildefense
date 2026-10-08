package ui

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"taildefense/internal/platform"
)

// The clipboard.
//
// Two things put text on it. The shell's mouse selection, which copies whatever was
// dragged over, and a command that produces one obvious value, which copies it: the next
// thing the board URL does is get pasted into a browser, and a rule's target into a
// chat, and retyping a long path off a screen is how a command ends up on the wrong file.
//
// It is done two ways at once. OSC 52 asks the terminal itself, which is the only way
// that works over ssh and inside tmux, and the terminal emulators people here use all
// honour it. A clipboard tool on the machine is asked as well, because a terminal that
// ignores OSC 52 ignores it silently, and "copied" followed by an empty paste is the
// worst outcome. Whichever of the two works, works; both working puts the same text
// there twice, which is invisible.
//
// The sequence is written straight to stdout rather than through Bubble Tea, which has
// no clipboard command in this version; one write of one complete sequence, so it cannot
// land inside a frame. Inside a `taildefense shell` pane the child's stdout is a pseudo-terminal
// and the pane's sanitiser would drop the sequence with every other OSC, so the session
// picks it out first and forwards it to the real terminal, exactly as it does a desktop
// notification.
//
// The copy is gated the way the notification is: it needs a terminal, because
// an escape sequence in a redirected transcript is garbage; TAILDEFENSE_NO_CLIPBOARD=1
// turns it off for one command, and `td config clipboard off` for every command.
// Someone who keeps something on their clipboard while running bets should not have it
// replaced. The selection copy is not gated: dragging over text is the request.

// EnvNoClipboard disables the copy for one process.
const EnvNoClipboard = "TAILDEFENSE_NO_CLIPBOARD"

// clipboardPref is the remembered choice: `td config clipboard off` turns the
// copy off for every run, the environment variable above for one.
var clipboardPref = true

// SetClipboard records whether a command copies its one obvious value. The dispatcher calls
// it from the preferences file at startup; the shell calls it again when a command run
// inside the session changes the file.
func SetClipboard(on bool) { clipboardPref = on }

// ClipboardEnabled reports whether a command may copy a value from this process.
func ClipboardEnabled() bool {
	if !clipboardPref || os.Getenv(EnvNoClipboard) != "" {
		return false
	}
	return platform.IsTTY()
}

// CopyValue puts a command's one obvious result on the clipboard, when that is wanted, and
// reports whether it did so the caller can say so. Best-effort: nothing depends on the
// clipboard, so nothing here can fail the command.
func CopyValue(value string) bool {
	if value == "" || !ClipboardEnabled() {
		return false
	}
	CopyToClipboard(value)
	return true
}

// CopyToClipboard puts text on the clipboard, both ways, unconditionally.
func CopyToClipboard(text string) {
	_, _ = os.Stdout.WriteString(ClipboardSequence(text))
	runClipboardTool(text)
}

// ClipboardSequence is the OSC 52 write: ESC ] 52 ; c ; base64 BEL.
func ClipboardSequence(text string) string {
	return "\x1b]52;c;" + base64.StdEncoding.EncodeToString([]byte(text)) + "\a"
}

// IsClipboardSequence reports whether s begins with an OSC 52 sequence, and how long it
// is. The shell uses it to find a child's clipboard writes in the output it is about to
// sanitise.
func IsClipboardSequence(s string) (n int, ok bool) {
	if !strings.HasPrefix(s, "\x1b]52;") {
		return 0, false
	}
	return oscEnd(s)
}

// runClipboardTool hands the text to the first clipboard program that exists.
//
// Wayland first, since on a Wayland session xclip talks to XWayland's clipboard, which
// is not the one the rest of the desktop pastes from. Bounded by a timeout: a tool with
// no display to talk to should fail at once, and one that hangs instead must not hold a
// goroutine forever.
func runClipboardTool(text string) {
	for _, tool := range clipboardTools() {
		path, err := exec.LookPath(tool[0])
		if err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		cmd := exec.CommandContext(ctx, path, tool[1:]...)
		cmd.Stdin = strings.NewReader(text)
		err = cmd.Run()
		cancel()
		if err == nil {
			return
		}
	}
}

// clipboardTools is the candidates for this platform, in the order to try them.
func clipboardTools() [][]string {
	switch runtime.GOOS {
	case "darwin":
		return [][]string{{"pbcopy"}}
	case "windows":
		return [][]string{{"clip.exe"}}
	}
	tools := [][]string{
		{"xclip", "-selection", "clipboard", "-in"},
		{"xsel", "--clipboard", "--input"},
		{"clip.exe"}, // WSL
	}
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		tools = append([][]string{{"wl-copy"}}, tools...)
	}
	return tools
}
