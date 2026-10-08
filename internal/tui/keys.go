package tui

// KeyHelp is one row of the help screen.
type KeyHelp struct {
	Keys  string
	Help  string
	Group string
}

// Keys is every binding, in the order the help screen shows them. Update dispatches on the
// same keys; a binding added there without a row here is a binding nobody finds.
var Keys = []KeyHelp{
	{"↑↓ k j", "move", "everywhere"},
	{"enter", "choose", "everywhere"},
	{"esc q", "back; quit from the menu", "everywhere"},
	{"?", "this help", "everywhere"},
	{"u", "run td update now, when one is waiting or a host asked for it", "everywhere"},
	{"R", "restart into the new td after an update", "everywhere"},
	{"r", "look for games again now (it also does every 5 s)", "join"},
	{"a", "type an address: host, host:port or a tailnet IP", "join"},
	{"enter", "edit a setting, or flip an on/off one", "settings"},
	{"esc", "cancel an edit", "settings"},
	{"ctrl+c", "quit", "everywhere"},
}
