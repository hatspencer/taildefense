package ui

import (
	"io"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"

	"taildefense/internal/platform"
)

// Cascading tables.
//
// A listing arrives as a waterfall: each row lands hot in the scene ramp and is overwritten in
// place by its settled self a beat later, top to bottom. The settled rows are the exact bytes
// the still path prints, and each row is finished before the next starts, so a cascade that is
// interrupted leaves a shorter table, never a garbled one.
//
// It draws from the closing budget and is capped per table, because a listing is the result
// the person asked for and holding it back is the opposite of decoration.

const (
	// cascadeRowDelay is the beat between rows.
	cascadeRowDelay = 11 * time.Millisecond
	// cascadeMaxRows is how many rows animate; the rest of a long table prints at once.
	cascadeMaxRows = 12
)

// cascade prints table, a block of newline-terminated rows, as a cascade where it may.
func (p *Printer) cascade(table string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	w := p.dest()
	rows := strings.SplitAfter(table, "\n")
	if len(rows) > 0 && rows[len(rows)-1] == "" {
		rows = rows[:len(rows)-1]
	}
	n := min(len(rows), cascadeMaxRows)
	if n < 2 || w != io.Writer(os.Stdout) || !sceneOK(w, 1) || !cascadeFits(rows[:n]) {
		io.WriteString(w, table)
		return
	}
	got := takeBudget(closingBudget, time.Duration(n)*cascadeRowDelay)
	if got == 0 {
		io.WriteString(w, table)
		return
	}
	delay := got / time.Duration(n)
	hideCursor(w)
	defer showCursor(w)
	for i, row := range rows {
		if i >= n {
			io.WriteString(w, strings.Join(rows[i:], ""))
			break
		}
		settled := strings.TrimSuffix(row, "\n")
		io.WriteString(w, "\r"+heat(1).Render(ansi.Strip(settled))+"\x1b[K")
		time.Sleep(delay)
		io.WriteString(w, "\r"+settled+"\x1b[K\n")
	}
}

// cascadeFits reports whether every row fits on one terminal line. A wrapped row is two lines,
// and the carriage return that overwrites it would land on the second.
func cascadeFits(rows []string) bool {
	cols := platform.TermCols()
	for _, r := range rows {
		if ansi.StringWidth(strings.TrimSuffix(r, "\n")) >= cols {
			return false
		}
	}
	return true
}
