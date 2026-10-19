import { EvacStage, PF_ALIVE, PF_CONNECTED, Phase, type Frame, type Player, type Welcome } from '../protocol';
import { cssHex, playerColor } from '../scene/util';
import { readLook } from '../scene/look';

// What the scoreboard says about one survivor, for the Tab window, the field report and the
// screenshot of it alike.
export interface ScoreRow {
  p: Player;
  you: boolean;
  away: boolean;
  down: boolean; // down and waiting, while the game is still on
  aboard: boolean; // got aboard the evac Huey
  behind: boolean; // still here when the evac Huey left without them
  arch: string;
  color: string;
  nums: { v: number; label: string; bad?: boolean }[];
  // Guns (the one in hand held), gear, abilities (ab) and medkits.
  chips: { text: string; title: string; lv: string; held?: boolean; ab?: boolean }[];
}

// How the game ended, for the field report and its picture: overrun, or the evac Huey gone
// with out of the n survivors still in the game aboard.
export interface Verdict { evac: boolean; ok: boolean; stamp: string; head: string; out: number; n: number }

export function verdict(f: Frame): Verdict {
  let n = 0, out = 0;
  for (let i = 0; i < f.nPlayers; i++) {
    const p = f.players[i];
    if (p.aboard) out++;
    if (p.aboard || p.flags & PF_CONNECTED) n++;
  }
  const evac = f.evac === EvacStage.Gone, ok = evac && out > 0;
  const head = !evac ? 'The generator has fallen'
    : !out ? 'The Huey left without anyone'
    : out === n ? `Out on the Huey after ${f.best} waves` : `${out} of ${n} got out after ${f.best} waves`;
  return { evac, ok, stamp: !evac ? 'Overrun' : ok ? 'Extracted' : 'Left behind', head, out, n };
}

// The survivors, best first, those still here before those who left.
export function scoreRows(wd: Welcome, f: Frame): ScoreRow[] {
  const nt = wd.tracks.length;
  return f.players.slice(0, f.nPlayers)
    .sort((a, b) => (b.flags & PF_CONNECTED) - (a.flags & PF_CONNECTED) || b.kills - a.kills || b.damage - a.damage)
    .map((p) => {
      const chips: ScoreRow['chips'] = [];
      wd.weapons.forEach((w, k) => {
        if (!(p.owned & (1 << k))) return;
        let lv = 0;
        for (let t = 0; t < nt; t++) lv += p.levels[k * nt + t];
        chips.push({ text: w.short, title: `${w.name}${lv ? `, ${lv} upgrades` : ''}`, lv: lv ? `+${lv}` : '', held: k === p.cur });
      });
      wd.gear.forEach((d, i) => { if (p.gear[i]) chips.push({ text: d.name, title: d.name, lv: String(p.gear[i]) }); });
      wd.abilities.forEach((d, i) => { if (p.abLevel[i]) chips.push({ text: d.name, title: d.name, lv: String(p.abLevel[i]), ab: true }); });
      if (p.medkits) chips.push({ text: 'Medkit', title: 'medkits carried', lv: `×${p.medkits}` });
      return {
        p, you: p.id === wd.you, away: !(p.flags & PF_CONNECTED),
        down: !(p.flags & PF_ALIVE) && f.phase !== Phase.Over && !p.aboard,
        aboard: p.aboard, behind: !p.aboard && f.evac === EvacStage.Gone && (p.flags & PF_CONNECTED) !== 0,
        arch: readLook(p.look).arch.name, color: cssHex(playerColor(p.id)),
        nums: [
          { v: p.kills, label: 'kills' }, { v: p.damage, label: 'damage' }, { v: p.turret, label: 'by turrets' },
          { v: p.bosses, label: 'bosses' }, { v: p.taken, label: 'taken', bad: true }, { v: p.downs, label: 'downs', bad: true },
          { v: p.revives, label: 'revives' }, { v: p.built, label: 'built' }, { v: p.searched, label: 'searched' },
        ],
        chips,
      };
    });
}
