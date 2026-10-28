import { CF_ASLEEP, CF_GUARD, K_CORE, Phase } from '../protocol';
import type { Game } from '../state';
import type { Sound } from './sound';
import { type Loop, type Placed, Prio } from './synth';

// What a wave sounds like from inside the walls before and between its blows: the horde far off,
// a war horn as it starts, the bosses' roars and tread, and the generator failing. Read from
// each frame like the rest; all of it held back so a long game doesn't tire the ear: the horde a
// bed under the fight that gives way as the fight fills the mix, the roars and the alarm spaced
// out, nothing repeated tick on tick.

// The horde: how far off a creep is at half weight, how many weighted creeps fill it, how loud
// it is at most, and how much a creep still to come (or out in the dark) weighs.
const HORDE_R = 32, HORDE_FILL = 22, HORDE = 0.26, UNSEEN = 0.12;
// The horn: how far out on its side it blows, and how long after the siren.
const HORN_OUT = 60, HORN_AFTER = 2.2;
// The bosses (abomination, broodmother, goliath): a roar on sight and every so often after,
// never two within ROAR_GAP; a tread every stride's length.
const BOSS = new Set([5, 7, 10]);
const ROAR_GAP = 7, ROAR_EVERY = 14, STRIDE = 1.6;
// The generator: sparks below SPARK of its health, burning below BURN; the alarm as it passes
// each of ALARM, and again every ALARM_GAP seconds while under the second.
const SPARK = 0.5, BURN = 0.3, ALARM = [0.5, 0.25, 0.1], ALARM_GAP = 20, CRACKLE = 0.22;

export class Ambience {
  private phase = -1; private from = 0;
  private horde: [Loop | null, Loop | null] = [null, null]; private hv = 0;
  private bosses = new Map<number, { x: number; y: number; walk: number; due: number }>();
  private crackle: Loop | null = null;
  private coreFrac = -1; private passed = 0; private alarmAt = -1e9; private sparkDue = 0;
  private last = new Map<string, number>();

  constructor(private s: Sound) {}

  reset(): void {
    for (const l of this.horde) l?.stop();
    this.horde = [null, null]; this.hv = 0;
    this.crackle?.stop(); this.crackle = null;
    this.bosses.clear();
    this.phase = -1; this.coreFrac = -1; this.passed = 0;
  }

  onFrame(game: Game, t0: number, crowd: number): void {
    const f = game.cur, paused = f.pausedBy >= 0;
    this.hordeBed(game, crowd, paused);
    this.horn(game, t0);
    this.boss(game, t0);
    this.generator(game, t0, paused);
    this.phase = f.phase;
    if (f.phase === Phase.Build && f.nextFrom) this.from = f.nextFrom;
  }

  // The horde heard as one thing from far off: every creep of the wave awake, weighted by how
  // near it is, with the ones still to come and those out in the dark weighing as far ones. It
  // swells as a big wave comes in, from the side it comes from, and steps back as the fight
  // round the listener fills the mix: then the dead are heard one by one instead.
  private hordeBed(game: Game, crowd: number, paused: boolean): void {
    const f = game.cur, ears = this.s.ears;
    let sum = 0, vis = 0, sx = 0, sy = 0, seen = 0;
    if (f.phase === Phase.Wave || f.phase === Phase.Evac) {
      for (let i = 0; i < f.nCreeps; i++) {
        if (f.cFlags[i] & (CF_ASLEEP | CF_GUARD)) continue;
        seen++;
        const x = f.cX[i], y = f.cY[i], d = Math.hypot(x - ears.x, y - ears.y), u = d / HORDE_R;
        const w = 1 / (1 + u * u);
        vis += w; sx += x * w; sy += y * w;
      }
      sum = vis + UNSEEN * Math.max(0, Math.min(400, f.left - seen));
    }
    const fill = 1 - Math.exp(-sum / HORDE_FILL);
    const target = paused ? 0 : HORDE * fill * (1 - 0.45 * crowd) * (1 - 0.4 * Math.min(1, this.s.synth.busy * 1.5));
    this.hv += (target - this.hv) * (target > this.hv ? 0.04 : 0.025);
    if (this.hv < 0.004) { for (const l of this.horde) l?.stop(); this.horde = [null, null]; return; }
    // Where it is: the weighted middle of what is seen, or the side the wave was said to come
    // from; always somewhat far, so it is dark and mostly reverb.
    let p: Placed | null = null;
    if (vis > 0) p = this.s.place(sx / vis, sy / vis, 1, 40);
    if (!p) p = this.side(game, this.from, 1);
    const pan = p?.pan ?? 0, far = Math.max(0.55, p?.far ?? 0.7);
    for (let k = 0; k < 2; k++) {
      this.horde[k] ??= this.s.synth.loop('horde');
      this.horde[k]?.set({ vol: this.hv * (k ? 0.7 : 1), pan: Math.max(-1, Math.min(1, pan + (k ? 0.35 : -0.35))), far }, (k ? 0.93 : 1) * (1 - 0.04 * fill));
    }
  }

  // A war horn from the side the wave comes from, as the siren goes: the dead's answer to it. A
  // boss wave's is two horns, deeper.
  private horn(game: Game, t0: number): void {
    const f = game.cur;
    if (this.phase < 0 || f.phase === this.phase || f.phase !== Phase.Wave || !this.once('horn', 20)) return;
    const boss = f.wave % 10 === 0;
    const p = this.side(game, this.from, boss ? 0.95 : 0.75);
    if (p) this.s.synth.play(boss ? 'warHornBoss' : 'warHorn', p, t0 + HORN_AFTER, 1, Prio.Heavy);
  }

  // A point out on one of the compass sides in bits (east first, round by south), picked at
  // random among them, placed far: or overhead and far when none is said.
  private side(game: Game, bits: number, loud: number): Placed | null {
    const sides: number[] = [];
    for (let i = 0; i < 8; i++) if (bits & (1 << i)) sides.push(i);
    const c = game.welcome!.core;
    if (!sides.length) return { vol: loud * 0.7, pan: 0, far: 0.7 };
    const a = sides[Math.floor(Math.random() * sides.length)] * Math.PI / 4;
    const p = this.s.place(c.x + Math.cos(a) * HORN_OUT, c.y + Math.sin(a) * HORN_OUT, loud, 12);
    return p ? { ...p, far: Math.max(p.far, 0.6) } : { vol: loud * 0.5, pan: 0, far: 0.8 };
  }

  // The bosses: a roar when one is first heard and every fourteen seconds or so after, and the
  // ground thumping under every stride, both carrying far past the other creeps' sounds.
  private boss(game: Game, t0: number): void {
    const f = game.cur, now = performance.now() / 1000;
    for (let i = 0; i < f.nCreeps; i++) {
      const k = f.cKind[i];
      if (!BOSS.has(k) || f.cFlags[i] & CF_ASLEEP) continue;
      const id = f.cId[i], x = f.cX[i], y = f.cY[i];
      let b = this.bosses.get(id);
      if (!b) {
        this.bosses.set(id, b = { x, y, walk: 0, due: now + ROAR_EVERY * (0.8 + 0.5 * Math.random()) });
        if (this.once('roar', ROAR_GAP)) this.play('roar' + k, x, y, 1.1, 5, t0, Prio.Heavy);
        continue;
      }
      const d = Math.hypot(x - b.x, y - b.y);
      b.x = x; b.y = y;
      if (d < 1.5) b.walk += d;
      if (b.walk >= STRIDE) {
        b.walk -= STRIDE;
        this.play('bossStep', x, y, 0.5, 3.5, t0 + Math.random() * 0.04, Prio.Normal);
      }
      if (now >= b.due && this.once('roar', ROAR_GAP)) {
        b.due = now + ROAR_EVERY * (0.8 + 0.5 * Math.random());
        this.play('roar' + k, x, y, 1, 4, t0, Prio.Heavy);
      }
    }
    for (const id of this.bosses.keys()) if (game.indexById[id] < 0 && game.hiddenAt[id] !== game.frames) this.bosses.delete(id);
  }

  // The generator failing: sparks, more often the worse it is; burning wiring under that; and
  // an alarm unlike the klaxon of a hit, as it passes each mark down and now and then while it
  // is nearly gone. Repaired past a mark, the mark is armed again.
  private generator(game: Game, t0: number, paused: boolean): void {
    const f = game.cur, c = game.welcome!.core, x = c.x + 0.5, y = c.y + 0.5;
    let frac = -1;
    for (let i = 0; i < f.nStructs; i++) if (f.sAlive[i] && f.sKind[i] === K_CORE) { frac = f.sHp[i] / Math.max(1, f.sMaxHp[i]); break; }
    const live = frac >= 0 && f.phase !== Phase.Over && !paused;
    const now = performance.now() / 1000;
    if (live && frac < SPARK && now >= this.sparkDue) {
      this.sparkDue = now + (0.7 + 4 * frac / SPARK) * (0.6 + 0.8 * Math.random()) * (f.phase === Phase.Wave ? 1 : 2.5);
      this.play('sparks', x + (Math.random() - 0.5) * 1.5, y + (Math.random() - 0.5) * 1.5, 0.5, 1.2, t0 + Math.random() * 0.05, Prio.Normal);
    }
    const burn = live && frac < BURN ? this.s.place(x, y, CRACKLE * Math.sqrt(1 - frac / BURN) + 0.05, 0.9) : null;
    if (!burn) { this.crackle?.stop(); this.crackle = null; } else {
      this.crackle ??= this.s.synth.loop('coreCrackle');
      this.crackle?.set(burn);
    }
    if (frac >= 0 && this.coreFrac >= 0) {
      for (let k = 0; k < ALARM.length; k++) {
        const bit = 1 << k;
        if (frac < ALARM[k] && this.coreFrac >= ALARM[k] && !(this.passed & bit)) { this.passed |= bit; this.alarm(now); }
        else if (frac > ALARM[k] + 0.1) this.passed &= ~bit;
      }
      if (live && f.phase === Phase.Wave && frac < ALARM[1] && now - this.alarmAt > ALARM_GAP) this.alarm(now);
    }
    this.coreFrac = frac;
  }

  private alarm(now: number): void {
    if (now - this.alarmAt < 3) return;
    this.alarmAt = now;
    this.s.synth.play('coreAlarm', { vol: 0.32, pan: 0, far: 0 }, 0, 1, Prio.Cue);
    this.s.synth.duckWorld(2.5, 1.2);
  }

  private play(name: string, x: number, y: number, loud: number, reach: number, t: number, prio?: Prio): void {
    const p = this.s.place(x, y, loud, reach);
    if (p) this.s.synth.play(name, p, t, 1, prio);
  }

  private once(key: string, gap: number): boolean {
    const now = performance.now() / 1000, t = this.last.get(key) ?? -1e9;
    if (now - t < gap) return false;
    this.last.set(key, now);
    return true;
  }
}
