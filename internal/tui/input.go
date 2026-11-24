package tui

import (
	"strings"

	tea "charm.land/bubbletea/v2"

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

// insert types s at the cursor, dropping control characters and whatever is over the limit.
// Typed text and a paste both arrive here.
func (l *lineInput) insert(s string) {
	for _, c := range s {
		if c < 0x20 || c == 0x7f || (l.max > 0 && len(l.r) >= l.max) {
			continue
		}
		l.r = append(l.r[:l.pos], append([]rune{c}, l.r[l.pos:]...)...)
		l.pos++
	}
}

// key applies an editing key and reports whether it was one.
//
// Ctrl chords are matched first and on the modifier, because a terminal that reports keys in
// full gives ctrl+a a Text of its own on some layouts; everything else that carries text is
// typing.
func (l *lineInput) key(k tea.KeyPressMsg) bool {
	if k.Mod.Contains(tea.ModCtrl) {
		switch k.Code {
		case 'a':
			l.pos = 0
		case 'e':
			l.pos = len(l.r)
		case 'u':
			l.r, l.pos = l.r[:0], 0
		default:
			return false
		}
		return true
	}
	if k.Text != "" {
		l.insert(k.Text)
		return true
	}
	switch k.Code {
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
	case tea.KeyHome:
		l.pos = 0
	case tea.KeyEnd:
		l.pos = len(l.r)
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
