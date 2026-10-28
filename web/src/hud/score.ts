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

// How far from the generator a creep counts as one of those that brought it down, in tiles.
const AT_CORE = 7;

// The report's story in one line: what broke through and what stood at the generator when it
// fell, or when the Huey left and who was left behind. Read off the last frame the page has,
// so the creeps are the ones it saw there.
export function ending(wd: Welcome, f: Frame): string {
  const v = verdict(f);
  if (v.evac) {
    const left: string[] = [];
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      if (!p.aboard && p.flags & PF_CONNECTED) left.push(p.name);
    }
    if (!left.length) return `The Huey lifted off after wave ${f.best} with everyone aboard.`;
    return `The Huey lifted off after wave ${f.best}; ${list(left)} ${left.length === 1 ? 'was' : 'were'} left behind.`;
  }
  const wave = f.wave;
  const ax = (wd.affixes ?? []).filter((_, i) => f.affix & (1 << i));
  const head = `Wave ${wave}${ax.length ? ` (${ax.join(', ')})` : ''} broke through.`;
  const n = new Map<number, number>();
  const cx = wd.core.x, cy = wd.core.y;
  for (let i = 0; i < f.nCreeps; i++) {
    const dx = f.cX[i] - cx, dy = f.cY[i] - cy;
    if (dx * dx + dy * dy <= AT_CORE * AT_CORE) n.set(f.cKind[i], (n.get(f.cKind[i]) ?? 0) + 1);
  }
  if (!n.size) return head;
  const kinds = [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, c]) => `${c} ${plural(wd.creeps[k]?.name ?? 'creep', c)}`);
  return `${head} At the generator when it fell: ${list(kinds)}.`;
}

function plural(s: string, n: number): string { return n === 1 || s.endsWith('s') ? s : `${s}s`; }
function list(a: string[]): string { return a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`; }

// A standout of the game, for the report's citations: MVP first, then the jobs done best.
export interface Award { title: string; why: string; row: ScoreRow }

// The citations, one per job, each to whoever did it most, and only for what was done at all.
// A survivor gets at most two, so a team of several does not read as one player's report.
export function awards(rows: ScoreRow[]): Award[] {
  const out: Award[] = [];
  const got = new Map<number, number>();
  const best = (v: (r: ScoreRow) => number) => rows.reduce<ScoreRow | null>((b, r) => (v(r) > (b ? v(b) : 0) ? r : b), null);
  const give = (title: string, v: (r: ScoreRow) => number, why: (r: ScoreRow) => string) => {
    const r = best(v);
    if (!r || (got.get(r.p.id) ?? 0) >= 2) return;
    got.set(r.p.id, (got.get(r.p.id) ?? 0) + 1);
    out.push({ title, why: why(r), row: r });
  };
  // MVP: kills, with damage dealt to break a tie.
  give('MVP', (r) => r.p.kills + r.p.damage / 1e9, (r) => `${r0(r.p.kills)} kills · ${r0(r.p.damage)} damage`);
  give('Medic', (r) => r.p.revives, (r) => `${r.p.revives} ${r.p.revives === 1 ? 'teammate' : 'teammates'} revived`);
  give('Engineer', (r) => r.p.built, (r) => `${r.p.built} built`);
  give('Turret boss', (r) => r.p.turret, (r) => `${r0(r.p.turret)} damage by turrets`);
  give('Boss hunter', (r) => r.p.bosses, (r) => `${r.p.bosses} ${r.p.bosses === 1 ? 'boss' : 'bosses'} killed`);
  give('Scavenger', (r) => r.p.searched, (r) => `${r.p.searched} sites searched`);
  return out.slice(0, 4);
}

function r0(n: number): string { return Math.floor(n).toLocaleString('en-US'); }

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
          { v: p.kills, label: 'kills' }, { v: p.damage, label: 'damage' }, { v: p.turret, label: 'turret dmg' },
          { v: p.bosses, label: 'bosses' }, { v: p.taken, label: 'taken', bad: true }, { v: p.downs, label: 'downs', bad: true },
          { v: p.revives, label: 'revives' }, { v: p.built, label: 'built' }, { v: p.searched, label: 'searched' },
        ],
        chips,
      };
    });
}
