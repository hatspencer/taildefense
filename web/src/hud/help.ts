// The controls window's text, grouped by what the player is doing, one short line a key.
// The first steps say the few that matter on a first game; this says them all.

type Row = [keys: string, what: string];
const k = (...ks: string[]) => ks.map((s) => `<kbd>${s}</kbd>`).join(' ');

export const HELP: { title: string; rows: Row[] }[] = [
  {
    title: 'Move and fight',
    rows: [
      [k('W', 'A', 'S', 'D'), 'walk, the way the view faces; you shoot the nearest creep on your own'],
      [`${k('Space')} hold`, 'sprint, while stamina (the blue bar) lasts'],
      [k('Q'), "the weapon's ultimate, once fighting has filled its meter"],
      [k('Shift', 'F', 'V'), 'grenade (click to throw), dash, airstrike at the cursor: bought at the armory'],
      [`${k('2')}–${k('7')} ${k('0')}`, 'equip an owned weapon; 0 is the crowbar, on brutal'],
      [k('R'), 'reload now'],
      [k('1'), 'medkit: heals over a few seconds unless a hit cuts it short'],
      ['Right-click', 'focus fire on a creep'],
      [k('J'), 'taunt: every creep nearby comes for you'],
    ],
  },
  {
    title: 'Use and loot',
    rows: [
      [k('E'), 'use what is beside you: revive a downed teammate, pick up a weapon, search loot, repair, shop'],
      [`${k('E')} twice`, 'walk to the nearest loot site'],
      [`${k('G')} hold`, 'drop the weapon in hand for a teammate'],
      [k('C'), 'armory: weapons, gear, abilities'],
    ],
  },
  {
    title: 'Build, between waves',
    rows: [
      [k('B'), `build bar: ${k('1')}–${k('8')} walls and turrets, ${k('9')} ${k('0')} ${k('-')} ${k('=')} traps, ${k('[')} pylon; click to place`],
      ['Left-click', 'select a structure, creep or survivor'],
      [`${k('U')} · ${k('Del')} twice`, 'upgrade · sell the selected structure'],
      [`${k('H')} twice`, 'rebuild what was destroyed and repair the rest'],
      [k('T'), 'the next turret, selected'],
      [k('Y'), 'ready for the next wave'],
    ],
  },
  {
    title: 'Camera and map',
    rows: [
      ['Wheel', 'zoom · Alt+wheel or middle-drag rotates'],
      ['Arrows · screen edge', 'look around; walking brings the view back'],
      [`${k('Space')} tap`, 'back to you · twice: lock the view to you'],
      [`${k('N')} hold`, 'look at the generator · twice: walk back to it'],
      [k('M'), 'big map; click to look, right-click to walk there'],
      ['Compass', 'click it to turn north up'],
    ],
  },
  {
    title: 'Team',
    rows: [
      [`${k('Alt')}+click · ${k('Z')}`, 'ping a spot for the team'],
      [k('Enter'), `chat · ${k('Tab')} in the chat adds where you are`],
      [`${k('Tab')} hold`, 'scoreboard; its buttons give a teammate gold'],
      [k('P'), 'pause or resume, for everyone'],
    ],
  },
  {
    title: 'Screen',
    rows: [
      [`${k('F10')} · ${k('Esc')}`, 'menu (Esc first closes a window or cancels)'],
      [k('F1'), 'this list'],
      [k('F3'), 'performance readout'],
      [k('F4'), 'pixel view on or off'],
      [k('F11'), 'full screen'],
    ],
  },
];

export function helpHTML(): string {
  const groups = HELP.map((g) => `<section><h3>${g.title}</h3><dl>${g.rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl></section>`).join('');
  return `<h2><span class="tape">Controls</span><button class="x">Close <kbd>Esc</kbd></button></h2><div class="groups">${groups}</div>`
    + '<div class="muted foot">A controller moves through the windows: d-pad or stick, A to press, B to go back, Start for the menu.</div>';
}
