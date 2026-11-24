package ui

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// The clipboard.
//
// The launcher copies the command a guest runs to join a game, which is otherwise retyped
// off a screen.
//
// It is done two ways at once. OSC 52 asks the terminal itself, which is the only way
// that works over ssh and inside tmux, and the terminal emulators people here use all
// honour it. A clipboard tool on the machine is asked as well, because a terminal that
// ignores OSC 52 ignores it silently, and "copied" followed by an empty paste is the
// worst outcome. Whichever of the two works, works; both working puts the same text
// there twice, which is invisible.
//
// The launcher sends the sequence as a Bubble Tea command (tea.SetClipboard), so the program
// writes it between frames, and calls RunClipboardTool beside it.

// RunClipboardTool hands the text to the first clipboard program that exists.
//
// Wayland first, since on a Wayland session xclip talks to XWayland's clipboard, which
// is not the one the rest of the desktop pastes from. Bounded by a timeout: a tool with
// no display to talk to should fail at once, and one that hangs instead must not hold a
// goroutine forever.
func RunClipboardTool(text string) {
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
