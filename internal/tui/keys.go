package tui

// KeyHelp is one row of the help screen.
type KeyHelp struct {
	Keys  string
	Help  string
	Group string
}

// Keys is every binding, in the order the help screen shows them, a group's rows together.
// Update dispatches on the same keys; a binding added there without a row here is a binding
// nobody finds. Short enough each to sit on one line of an 80-column terminal.
var Keys = []KeyHelp{
	{"↑↓ k j tab", "move", "everywhere"},
	{"enter", "choose", "everywhere"},
	{"esc q", "back; quit from the menu", "everywhere"},
	{"?", "this help", "everywhere"},
	{"u", "td update now, when one waits or a host asks", "everywhere"},
	{"R", "restart into the new td after an update", "everywhere"},
	{"ctrl+c", "quit", "everywhere"},
	{"← →", "the difficulty to host at", "host"},
	{"w", "how long: 20, 30 or 40 waves, or endless", "host"},
	{"f", "fog of war on or off", "host"},
	{"y", "copy the command friends join with", "host"},
	{"r", "look again now (it does every 5 s)", "join"},
	{"a", "type an address: host, host:port or IP", "join"},
	{"↑↓ pgup pgdn", "scroll", "changelog"},
	{"r", "read the changelog again", "changelog"},
	{"r", "run the checks again", "doctor"},
	{"enter", "edit a setting, or flip an on/off one", "settings"},
	{"esc", "cancel an edit", "settings"},
}
