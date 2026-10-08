package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"taildefense/internal/ui"
)

// lineInput is a one-line text field. Hand written rather than taken from bubbles because the
// launcher needs exactly this much editing (type, move, delete) and the module list stays
// the handful of terminal libraries the rest of the family uses.
type lineInput struct {
	r   []rune
	pos int
	max int
}

func (l *lineInput) set(s string) {
	l.r = []rune(s)
	l.pos = len(l.r)
}

func (l *lineInput) value() string { return strings.TrimSpace(string(l.r)) }

// key applies an editing key and reports whether it was one.
func (l *lineInput) key(k tea.KeyMsg) bool {
	switch k.Type {
	case tea.KeyRunes, tea.KeySpace:
		for _, c := range k.Runes {
			if c < 0x20 || (l.max > 0 && len(l.r) >= l.max) {
				continue
			}
			l.r = append(l.r[:l.pos], append([]rune{c}, l.r[l.pos:]...)...)
			l.pos++
		}
	case tea.KeyBackspace:
		if l.pos > 0 {
			l.r = append(l.r[:l.pos-1], l.r[l.pos:]...)
			l.pos--
		}
	case tea.KeyDelete:
		if l.pos < len(l.r) {
			l.r = append(l.r[:l.pos], l.r[l.pos+1:]...)
		}
	case tea.KeyLeft:
		if l.pos > 0 {
			l.pos--
		}
	case tea.KeyRight:
		if l.pos < len(l.r) {
			l.pos++
		}
	case tea.KeyHome, tea.KeyCtrlA:
		l.pos = 0
	case tea.KeyEnd, tea.KeyCtrlE:
		l.pos = len(l.r)
	case tea.KeyCtrlU:
		l.r, l.pos = l.r[:0], 0
	default:
		return false
	}
	return true
}

// view draws the text with the cursor as a reversed cell.
func (l *lineInput) view() string {
	before := string(l.r[:l.pos])
	at, after := " ", ""
	if l.pos < len(l.r) {
		at, after = string(l.r[l.pos]), string(l.r[l.pos+1:])
	}
	return before + ui.StyleSelected.Render(at) + after
}
