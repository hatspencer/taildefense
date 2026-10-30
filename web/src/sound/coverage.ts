import {
  BlastKind, CF_ASLEEP, CX_ARMOURED, CX_FRENZY, CX_SAPPER, CX_SPLITTER, K_CANNON, K_GATE, K_GUN, K_MINE, K_PYLON, K_SNIPER,
  K_SPIKES, K_TAR, K_VENT, MAX_CREEPS, TRACER_ARC, TRACER_NAPALM, TRACER_ULT,
} from '../protocol';
import type { Game } from '../state';
import type { Sound } from './sound';
import { type Loop, type Placed, Prio } from './synth';

// The sounds of what came after the first sound pass: the traps, the generator's tiers and its
// Overload, the pylon, gates, the turrets' evolutions and the waves' affixes. Like sound.ts it
// reads each frame against the last and plays what changed; nothing here is sent by the host.
// Sound calls onFrame with a frame to play, then remember with every frame.

// A rocket's tracer starting within this of where one ended last tick is the same rocket
// flying on, not a new one leaving its tube.
const FLYING = 0.35;
// The least time between two of each, alone and in the thick of a crowd.
const SPIKE_GAP0 = 0.12, SPIKE_GAP1 = 0.3, TAR_GAP = 0.22, RICO_GAP0 = 0.08, RICO_GAP1 = 0.22;
// How loud the pylon's buzz and the sapper's fuse are at most.
const PYLON = 0.1, FUSE = 0.32;
// After the siren, the Overload's capacitors charging up for the wave, a little later.
const READY_AFTER = 2.5;
// The evolutions that sound unlike the turret they came from, by kind and branch.
const EVOLVED: Record<number, [string?, string?]> = { [K_GUN]: ['gatling', 'penetrator'], [K_CANNON]: ['mortar'], [K_SNIPER]: [undefined, 'antiMat'] };
// Traps: laid flat, and their own sounds when they go.
const FLOOR = new Set([K_SPIKES, K_TAR, K_VENT, K_MINE]);

// Plays name at (x, y), loud at most, carrying reach, at context time t: what was heard, or null.
type At = (name: string, x: number, y: number, loud: number, reach?: number, t?: number, prio?: Prio, rate?: number) => Placed | null;

export class Coverage {
  private last = new Map<string, number>();
  // The last frame's, read against.
  private ends: number[] = []; private seenEnds: number[] = [];
  private nS = 0;
  private sAlive = new Uint8Array(256); private sKind = new Uint8Array(256); private sOpen = new Uint8Array(256); private sEvo = new Uint8Array(256);
  private tier = -1; private tierPaid = -1; private ready = false; private phase = -1;
  private cSeen = new Uint32Array(MAX_CREEPS); private cHp = new Uint8Array(MAX_CREEPS); private cFx = new Uint8Array(MAX_CREEPS);
  private cTrap = new Int16Array(MAX_CREEPS).fill(-1);
  private splitters: { id: number; x: number; y: number }[] = [];
  private fuse: Loop | null = null;
  private pylon: Loop | null = null;

  constructor(private s: Sound) {}

  reset(): void {
    this.fuse?.stop(); this.fuse = null;
    this.pylon?.stop(); this.pylon = null;
    this.ends = []; this.splitters = []; this.nS = 0; this.tier = -1; this.tierPaid = -1; this.ready = false; this.phase = -1;
    this.cSeen.fill(0); this.cTrap.fill(-1);
  }

  // owns says the trap kinds whose going is played here rather than as sold or knocked down.
  owns(kind: number): boolean { return FLOOR.has(kind); }

  // fresh says whether a rocket's tracer (x0, y0) is one leaving, not one flying on: every
  // tick of a rocket's flight is a tracer, and only its first is a launch.
  fresh(x0: number, y0: number): boolean {
    const e = this.ends;
    for (let i = 0; i < e.length; i += 2) if (Math.abs(e[i] - x0) < FLYING && Math.abs(e[i + 1] - y0) < FLYING) return false;
    return true;
  }

  // turret is the sound of a turret's shot from (x0, y0) when its evolution sounds unlike it.
  turret(game: Game, kind: number, x0: number, y0: number): string | undefined {
    const s = game.structAtTile(Math.floor(x0), Math.floor(y0));
    if (s < 0 || game.cur.sKind[s] !== kind) return undefined;
    const e = game.cur.sEvo[s];
    return e ? EVOLVED[kind]?.[e - 1] : undefined;
  }

  onFrame(game: Game, t0: number, crowd: number, hear: number): void {
    const f = game.cur, paused = f.pausedBy >= 0, ears = this.s.ears;
    const at: At = (name, x, y, loud, reach = 1.4, t = t0, prio, rate = 1) => {
      const p = this.s.place(x, y, loud, reach);
      if (p) this.s.synth.play(name, p, t, rate, prio);
      return p;
    };

    // Napalm leaving the tube burns as it goes; the arc web crackles once a strike.
    let arc = -1, arcD = Infinity;
    for (let i = 0; i < f.nTracers; i++) {
      const k = f.tKind[i], x0 = f.tX0[i], y0 = f.tY0[i];
      if (k === TRACER_NAPALM && this.fresh(x0, y0)) at('napalmFlight', x0, y0, 0.55, 1.3, t0 + 0.02);
      else if (k === TRACER_ARC) {
        const d = Math.hypot(x0 - ears.x, y0 - ears.y);
        if (d < arcD) { arcD = d; arc = i; }
      }
    }
    if (arc >= 0 && arcD < hear * 1.3 && this.once('arc', 0.12)) at('arcWeb', f.tX0[arc], f.tY0[arc], 0.5, 1.2, t0 + Math.random() * 0.02);

    for (let i = 0; i < f.nBlasts; i++) {
      const x = f.bX[i], y = f.bY[i];
      switch (f.bKind[i]) {
        case BlastKind.Flame: at('flameVent', x, y, 0.75, 1.5, t0 + Math.random() * 0.02); break;
        case BlastKind.Napalm: at('napalmBurst', x, y, 0.85, 1.8, t0 + 0.01); break;
        case BlastKind.Landed: at('touchdown', x, y, 0.8, 2); break;
        case BlastKind.Overload:
          at('overload', x, y, 1.3, 4, t0, Prio.Heavy);
          this.s.synth.duckWorld(2, 0.8);
          break;
      }
    }

    this.structs(game, t0, at);
    this.generator(game, t0, at);
    this.creeps(game, t0, crowd, hear, at);
    if (paused) { this.fuse?.stop(); this.fuse = null; }
    this.pylonLoop(game, paused);
  }

  // Gates swinging, turrets evolving, pylons switched on, traps going off or wearing out.
  private structs(game: Game, t0: number, at: At): void {
    const f = game.cur;
    for (let i = 0; i < f.nStructs && i < this.nS; i++) {
      if (f.sKind[i] !== this.sKind[i]) continue;
      const cx = f.sX[i] + f.sW[i] / 2, cy = f.sY[i] + f.sH[i] / 2, k = f.sKind[i];
      const alive = f.sAlive[i], was = this.sAlive[i];
      if (alive && was) {
        if (k === K_GATE && f.sOpen[i] !== this.sOpen[i]) at(f.sOpen[i] ? 'gateOpen' : 'gateShut', cx, cy, 0.6);
        if (f.sEvo[i] && !this.sEvo[i]) at('evolve', cx, cy, 0.7, 1.6);
      } else if (alive && !was && k === K_PYLON) at('pylonOn', cx, cy, 0.5, 1.2, t0 + 0.4);
      else if (!alive && was && FLOOR.has(k)) {
        // Sold whole: coins. Gone a ghost: the mine went off, the spikes wore through, the rest broke.
        if (!f.sGhost[i]) at('coins', cx, cy, 0.5, 1.5);
        else if (k === K_MINE) at('mine', cx, cy, 0.9, 2, t0, Prio.Heavy);
        else at(k === K_SPIKES ? 'spikesBreak' : 'crumble', cx, cy, 0.6, 1.5);
      }
    }
    // A pylon built where nothing stood before (a new slot) switches on too.
    for (let i = this.nS; i < f.nStructs; i++) {
      if (f.sAlive[i] && f.sKind[i] === K_PYLON) at('pylonOn', f.sX[i] + 0.5, f.sY[i] + 0.5, 0.5, 1.2, t0 + 0.4);
    }
  }

  // The generator: paid into, going up a tier, and its Overload charging for the wave.
  private generator(game: Game, t0: number, at: At): void {
    const f = game.cur, c = game.welcome!.core, x = c.x + 0.5, y = c.y + 0.5;
    if (this.tier >= 0 && f.tier > this.tier) at('tierUp', x, y, 1, 3, t0, Prio.Heavy);
    else if (this.tierPaid >= 0 && f.tier === this.tier && f.tierPaid > this.tierPaid) at('payIn', x, y, 0.6, 2);
    if (f.overloadReady && !this.ready && this.phase >= 0) {
      at('overloadReady', x, y, 0.6, 2.5, t0 + (f.phase !== this.phase ? READY_AFTER : 0));
    }
  }

  // The creeps: stepping onto the traps, rounds glancing off the armoured, one losing patience
  // with the maze, a splitter bursting, a sapper's fuse burning.
  private creeps(game: Game, t0: number, crowd: number, hear: number, at: At): void {
    const f = game.cur, prev = game.frames - 1, ex = this.s.ears.x, ey = this.s.ears.y, h2 = hear * hear * 1.7;
    let spike = -1, spikeD = Infinity, tarI = -1, tarD = Infinity, rico = -1, ricoD = Infinity, fren = -1, frenD = Infinity, sap = -1, sapD = Infinity;
    for (let i = 0; i < f.nCreeps; i++) {
      const id = f.cId[i], x = f.cX[i], y = f.cY[i], dx = x - ex, dy = y - ey, d = dx * dx + dy * dy;
      if (d > h2) continue;
      const known = this.cSeen[id] === prev, fx = f.cFx[i];
      if (known) {
        const s = game.structAtTile(Math.floor(x), Math.floor(y));
        const trap = s >= 0 && (f.sKind[s] === K_SPIKES || f.sKind[s] === K_TAR) ? s : -1;
        if (trap >= 0 && trap !== this.cTrap[id]) {
          if (f.sKind[trap] === K_SPIKES) { if (d < spikeD) { spikeD = d; spike = i; } } else if (d < tarD) { tarD = d; tarI = i; }
        }
        if (fx & CX_ARMOURED && f.cHp[i] < this.cHp[id] && d < ricoD) { ricoD = d; rico = i; }
        if (fx & CX_FRENZY && !(this.cFx[id] & CX_FRENZY) && d < frenD) { frenD = d; fren = i; }
      }
      if (fx & CX_SAPPER && !(f.cFlags[i] & CF_ASLEEP) && d < sapD) { sapD = d; sap = i; }
    }
    // Spread over the tick the frame covers, so a crowd's sounds do not all start at once.
    const tick = 1 / (game.welcome?.tickRate || 20);
    const spread = () => t0 + Math.random() * tick;
    if (spike >= 0 && this.once('spikes', SPIKE_GAP0 + (SPIKE_GAP1 - SPIKE_GAP0) * crowd)) at('spikes', f.cX[spike], f.cY[spike], 0.5, 1, spread(), Prio.Texture);
    if (tarI >= 0 && this.once('tar', TAR_GAP)) at('tar', f.cX[tarI], f.cY[tarI], 0.45, 1, spread(), Prio.Texture);
    if (rico >= 0 && this.once('rico', RICO_GAP0 + (RICO_GAP1 - RICO_GAP0) * crowd)) at('ricochet', f.cX[rico], f.cY[rico], 0.35, 1, spread(), Prio.Texture);
    if (fren >= 0 && this.once('frenzy', 0.6)) at('frenzy', f.cX[fren], f.cY[fren], 0.6, 1.4, spread());

    // A splitter seen last tick, gone now (not into the dark) with a death where it stood.
    for (const sp of this.splitters) {
      if (game.indexById[sp.id] >= 0 || game.hiddenAt[sp.id] === game.frames) continue;
      let near = false;
      for (let j = 0; j < f.nDeaths && !near; j++) near = Math.abs(f.dX[j] - sp.x) < 1.2 && Math.abs(f.dY[j] - sp.y) < 1.2;
      if (near && this.once('split', 0.15)) at('splitBurst', sp.x, sp.y, 0.6, 1.3, spread());
    }

    // The nearest sapper's fuse, a loop that follows it.
    const p = sap >= 0 ? this.s.place(f.cX[sap], f.cY[sap], FUSE, 0.8) : null;
    if (!p) { this.fuse?.stop(); this.fuse = null; } else {
      this.fuse ??= this.s.synth.loop('fuse');
      this.fuse?.set(p, 0.95 + 0.1 * Math.random());
    }
  }

  // The nearest pylon buzzing, quietly: it is always on, so it is heard close by or not at all.
  private pylonLoop(game: Game, paused: boolean): void {
    const f = game.cur;
    let best: Placed | null = null;
    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sAlive[i] || f.sKind[i] !== K_PYLON) continue;
      const p = this.s.place(f.sX[i] + 0.5, f.sY[i] + 0.5, PYLON, 0.45);
      if (p && (!best || p.vol > best.vol)) best = p;
    }
    if (!best || paused) { this.pylon?.stop(); this.pylon = null; return; }
    this.pylon ??= this.s.synth.loop('pylon');
    this.pylon?.set(best);
  }

  remember(game: Game): void {
    const f = game.cur, n = game.frames;
    this.phase = f.phase; this.tier = f.tier; this.tierPaid = f.tierPaid; this.ready = f.overloadReady;
    this.nS = Math.min(f.nStructs, 256);
    for (let i = 0; i < this.nS; i++) {
      this.sAlive[i] = f.sAlive[i]; this.sKind[i] = f.sKind[i]; this.sOpen[i] = f.sOpen[i]; this.sEvo[i] = f.sEvo[i];
    }
    this.splitters.length = 0;
    for (let i = 0; i < f.nCreeps; i++) {
      const id = f.cId[i];
      this.cSeen[id] = n; this.cHp[id] = f.cHp[i]; this.cFx[id] = f.cFx[i];
      const s = game.structAtTile(Math.floor(f.cX[i]), Math.floor(f.cY[i]));
      this.cTrap[id] = s >= 0 && FLOOR.has(f.sKind[s]) ? s : -1;
      if (f.cFx[i] & CX_SPLITTER) this.splitters.push({ id, x: f.cX[i], y: f.cY[i] });
    }
    // Where this tick's rockets got to, for the next tick's to be told apart from new ones.
    const e = this.seenEnds;
    e.length = 0;
    for (let i = 0; i < f.nTracers; i++) {
      const k = f.tKind[i];
      if (k === 5 || k === 5 + TRACER_ULT || k === TRACER_NAPALM) e.push(f.tX1[i], f.tY1[i]);
    }
    this.seenEnds = this.ends; this.ends = e;
  }

  private once(key: string, gap: number): boolean {
    const now = performance.now() / 1000, t = this.last.get(key) ?? -1e9;
    if (now - t < gap) return false;
    this.last.set(key, now);
    return true;
  }
}
