package cli

import (
	"io"

	"taildefense/internal/ui"
)

// GameKey is one binding of the game in the browser.
type GameKey struct {
	Group string // what the player is doing
	Keys  string
	Does  string
}

// GameKeys is every key and button the browser client binds, a group's rows together, in the
// order `td keys` and the launcher's Keys screen show them. The client binds them in
// web/src/input.ts (keyboard and mouse), web/src/camera.ts (wheel and middle button) and
// web/src/hud/minimap.ts (the map); a key changed there is changed here too, and in the
// README's table. Each row fits an 80-column terminal beside the widest keys.
var GameKeys = []GameKey{
	{"moving", "W A S D", "walk, the way the view faces"},
	{"moving", "Space hold", "sprint, while stamina (the blue bar) lasts"},
	{"moving", "E twice", "walk to the nearest loot site in sight"},
	{"moving", "N twice", "walk back to the generator"},
	{"moving", "right-click map", "walk there, on the big map or the minimap"},

	{"fighting", "Q", "the weapon's ultimate, once its meter is full"},
	{"fighting", "Shift", "grenade: aim, then left-click; Esc puts it away"},
	{"fighting", "F", "dash at the cursor; a blade's weapon art"},
	{"fighting", "V", "airstrike at the cursor"},
	{"fighting", "R", "reload now"},
	{"fighting", "1", "medkit: heals over a few seconds"},
	{"fighting", "2-7", "pistol, shotgun, SMG, rifle, minigun, launcher"},
	{"fighting", "0 8 9", "crowbar, katana, greatsword, once you have them"},
	{"fighting", "right-click", "on a creep: focus fire on it"},
	{"fighting", "J", "taunt: every creep nearby comes for you"},

	{"using", "E", "revive, pick up, search, repair, shop or board"},
	{"using", "G hold", "drop the weapon in hand for a teammate"},
	{"using", "C", "armory: weapons, gear, abilities"},

	{"building", "B", "build bar: 1-0 and [ pick what to place"},
	{"building", "left-click", "place; or select a building, creep or player"},
	{"building", "X", "turn the catapult pit being placed"},
	{"building", "U", "upgrade the selected structure"},
	{"building", "Delete twice", "sell the selected structure (Backspace too)"},
	{"building", "H twice", "rebuild what fell and repair the rest"},
	{"building", "T", "select and look at the next turret"},
	{"building", "Y", "ready for the next wave"},

	{"camera", "wheel", "zoom"},
	{"camera", "middle-drag", "rotate the view"},
	{"camera", "Alt+wheel", "rotate the view"},
	{"camera", "arrows, edges", "look around; walking brings the view back"},
	{"camera", "Space tap", "back to your hero; twice locks the view to it"},
	{"camera", "N hold", "look at the generator"},
	{"camera", "M", "big map, and back"},
	{"camera", "compass click", "turn the view north up"},

	{"team", "Alt+click", "ping a spot for the team"},
	{"team", "Z", "ping mode: the next left-click pings"},
	{"team", "Enter", "chat; Tab in the chat adds where you are"},
	{"team", "Tab hold", "scoreboard; give a teammate gold there"},
	{"team", "P", "pause or resume, for everyone"},

	{"screen", "Esc", "cancel or close a window, else the menu"},
	{"screen", "F10", "the menu"},
	{"screen", "F1 ?", "the controls"},
	{"screen", "F3", "performance readout"},
	{"screen", "F4", "pixel view on or off"},
	{"screen", "F11", "full screen"},
}

// GameKeyRows is GameKeys as table rows, styled: the group named once, on its first row.
// Plain text where colour is off.
func GameKeyRows() [][]string {
	rows := make([][]string, 0, len(GameKeys))
	last := ""
	for _, k := range GameKeys {
		g := ""
		if k.Group != last {
			g, last = k.Group, k.Group
		}
		rows = append(rows, []string{ui.StyleDim.Render(g), ui.StyleCyan.Render(k.Keys), k.Does})
	}
	return rows
}

// Keys is `td keys`: the game's keys, as one aligned table.
func Keys(w io.Writer) int {
	p := ui.New(w)
	p.Step("td keys: the game, in the browser")
	p.Raw(ui.Table(GameKeyRows(), "  "))
	p.Plain("")
	p.Note("the launcher's own keys: ? in td")
	return 0
}
