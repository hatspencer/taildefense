package ui

import "sync/atomic"

// Captured output.
//
// A command's output normally goes to the terminal, and the animated surfaces here write
// directly to stdout with cursor movement because that is the only way to redraw a block in
// place. When a caller runs a command in this process to collect its output — `taildefense board`
// rendering a section into the dashboard, `td doctor` collecting a check's lines — those
// writes bypass the collection and
// land on the real terminal, out of order with everything around them and mixed into a
// transcript that is supposed to be one command's.
//
// This is the in-process twin of TAILDEFENSE_SHELL=1, which solves exactly the same problem
// for a command run as a child of `taildefense shell`. Same rule, second mechanism: an environment
// variable cannot be set for a function call in the same process, and a boolean cannot be set
// for a child process.
//
// It suppresses the redraws and leaves everything else alone: a captured run still prints its
// findings, still colours them, and still writes its final still frame. What it does not do is
// move the cursor, because the cursor does not belong to it.
var captured atomic.Bool

// SetCaptured marks output as being collected by a caller in this process. Callers must
// restore it, so a command that runs another does not leave the flag set for the rest of the
// process.
func SetCaptured(on bool) { captured.Store(on) }

// Captured reports whether output is being collected in this process.
func Captured() bool { return captured.Load() }
