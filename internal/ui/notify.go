package ui

import (
	"os"
	"strings"

	"taildefense/internal/platform"
)

// Desktop notifications.
//
// A promote across a dozen rules, or a daily job, runs for a minute or two,
// which is exactly long enough to switch to something else and forget to come back. The
// terminal can say when it is done: an OSC 9 sequence is a notification in iTerm2,
// WezTerm, ghostty, kitty and Windows Terminal, and OSC 777 is the same thing in rxvt and
// the terminals that copied it. Both are emitted, because a terminal ignores the one it
// does not know, and neither draws a cell, so a frame that carries one measures the same
// as a frame that does not.
//
// No daemon, no dependency, nothing left running: it is a few bytes on stdout, which is
// the only kind of notification a static binary with no runtime dependency can send.
//
// It is gated three ways. It needs a terminal, because a sequence written into a file or
// a pipe is garbage in a transcript. TAILDEFENSE_NO_NOTIFY=1 turns it off for one command,
// and `td config notify off` turns it off for every command, the same pair the other
// chrome switches have.
//
// Inside a `taildefense shell` pane the child's stdout is a pseudo-terminal, so the sequence is
// emitted — and the pane's sanitiser would drop it, since every OSC but a hyperlink is
// scribbling the session cannot allow. The session looks for these two before it
// sanitises and forwards them to the real terminal itself. That is why a notification
// from `taildefense watch` run in a tab still reaches the desktop.

// EnvNoNotify disables desktop notifications for one process.
const EnvNoNotify = "TAILDEFENSE_NO_NOTIFY"

// notifyPref is the remembered choice: `td config notify off` turns notifications off
// for every run, the environment variable above turns them off for one.
var notifyPref = true

// SetNotify records whether notifications are wanted. The dispatcher calls it from the
// preferences file at startup; the shell calls it again when a command run inside the
// session changes the file.
func SetNotify(on bool) { notifyPref = on }

// NotifySetting reports the remembered choice alone, ignoring the terminal and the
// environment, for `td config notify` to display.
func NotifySetting() bool { return notifyPref }

// NotifyEnabled reports whether a notification may be sent from this process.
func NotifyEnabled() bool {
	if !notifyPref || os.Getenv(EnvNoNotify) != "" {
		return false
	}
	return platform.IsTTY()
}

// NotifySequence is the bytes a notification is made of, for the shell to forward and
// for a test to recognise. Empty title and body give an empty string, so a caller that
// has nothing to say sends nothing.
func NotifySequence(title, body string) string {
	title, body = oscSafe(title), oscSafe(body)
	if title == "" && body == "" {
		return ""
	}
	text := title
	if body != "" {
		if text != "" {
			text += ": "
		}
		text += body
	}
	// OSC 9 takes one string; OSC 777 takes a title and a body separated by semicolons,
	// which is why the semicolon is stripped from both above rather than escaped: there
	// is no escape for it in either protocol.
	return "\x1b]9;" + text + "\a" + "\x1b]777;notify;" + title + ";" + body + "\a"
}

// IsNotifySequence reports whether s begins with one of the two notification sequences,
// and how long that sequence is. The shell uses it to find a child's notifications in
// the output it is about to sanitise.
func IsNotifySequence(s string) (n int, ok bool) {
	if !strings.HasPrefix(s, "\x1b]9;") && !strings.HasPrefix(s, "\x1b]777;") {
		return 0, false
	}
	return oscEnd(s)
}

// oscEnd is the length of the OSC sequence at the front of s, which is terminated by BEL
// or by ST (ESC \); ok is false when it never ends.
func oscEnd(s string) (n int, ok bool) {
	for i := 2; i < len(s); i++ {
		if s[i] == '\a' {
			return i + 1, true
		}
		if s[i] == '\x1b' && i+1 < len(s) && s[i+1] == '\\' {
			return i + 2, true
		}
	}
	return 0, false
}

// oscSafe flattens a string for use inside an OSC: control characters end the sequence
// and a semicolon is a field separator in OSC 777, so both become spaces.
func oscSafe(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == ';' || r < 0x20 || r == 0x7f:
			b.WriteByte(' ')
		default:
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}
