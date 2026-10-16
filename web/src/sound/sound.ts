import * as THREE from 'three/webgpu';
import {
  BlastKind, CF_ASLEEP, MAX_CREEPS, CF_STRIKE, EffectKind, Phase, PF_ALIVE, PF_ARMORY, PF_CONNECTED, PF_HURT, PF_RELOADING,
  PingKind, TRACER_HELI, TRACER_SHARD, type Player, TURRET_TRACKS,
} from '../protocol';
import { K_CANNON, K_CORE, K_GUN, K_MISSILE, K_SNIPER, K_TESLA } from '../scene/structs';
import type { Game } from '../state';
import { type Loop, type Placed, Synth } from './synth';

// What the game sounds like: reads each frame as it arrives (the shots, blasts and deaths of
// that tick, and what changed since the last one) and plays it, placed round the point the
// camera looks at. Nothing here is sent by the host; every sound is the page's own reading
// of a frame, so the protocol carries no audio.

const GUN = ['pistol', 'shotgun', 'smg', 'rifle', 'minigun', 'rocket', 'crowbar'];
const MINIGUN = 4;
const TURRET: Record<number, string> = { [K_GUN]: 'turretGun', [K_CANNON]: 'cannon', [K_TESLA]: 'tesla', [K_SNIPER]: 'sniper', [K_MISSILE]: 'pod' };
// How loud each is at the listener, and how many of it one tick may play.
const LOUD: Record<string, number> = {
  pistol: 0.75, shotgun: 1, smg: 0.6, rifle: 1, minigun: 0.5, rocket: 0.8, missile: 0.45, crowbar: 0.6,
  turretGun: 0.5, cannon: 0.95, tesla: 0.5, sniper: 0.95, pod: 0.4, doorGun: 0.7,
  spit: 0.5, boneThrow: 0.5, boneLand: 0.45, dash: 0.6,
};
const CAP: Record<string, number> = { minigun: 6, smg: 5, turretGun: 5 };
// The creeps' own sounds, which thin out as more of them are awake within earshot.
const CREEPY = new Set(['spit', 'boneThrow', 'boneLand', 'dash']);
// Awake creeps in earshot at which they start thinning, and at which they are thinnest.
const CROWD0 = 6, CROWD1 = 30;
// Creep kinds that throw rather than strike: their blows are tracers.
const THROWS = new Set([4, 6]);
const BIG = new Set([3, 5, 7]);
// A tick, in seconds: the events of one frame are spread over it so fast fire is a stream,
// not a burst twenty times a second.
const TICK = 0.05;
const AHEAD = 0.03;
// Footsteps: how loud a survivor's, a creep's and a big one's are, and how many of the dead
// may step in one tick. Steps are the first sounds let go when many are playing.
const STEP = 0.11, CREEP_STEP = 0.08, BIG_STEP = 0.22, CREEP_STEPS = 2, STEP_BUSY = 0.8;

interface Shot { x: number; y: number; vol: number; extra?: number; p?: Placed }

export class Sound {
  readonly synth: Synth;
  private cam: THREE.Camera | null = null;
  private lx = 0; private ly = 0; private dist = 30;
  private v = new THREE.Vector3();
  private primed = false;
  // The last frame's state that changes are read against.
  private phase = -1; private secs = -1; private coreHp = -1;
  private pFlags = new Uint8Array(256); private pCur = new Uint8Array(256); private pHeal = new Float32Array(256);
  private pStun = new Uint8Array(256); private pBuys = new Int32Array(256); private pUps = new Int32Array(256);
  private sAlive = new Uint8Array(256); private sKind = new Uint8Array(256); private sLevel = new Int32Array(256);
  private sHpFrac = new Float32Array(256); private nStructs = 0;
  private effects = new Map<string, { kind: number; x: number; y: number; x0: number; y0: number }>();
  private last = new Map<string, number>();
  private groanDue = 0;
  // Ground covered since the last footstep, and where each was last seen (and in which frame).
  private serial = 0;
  private pWalk = new Float32Array(256); private pSx = new Float32Array(256); private pSy = new Float32Array(256);
  private pSeen = new Uint32Array(256);
  private cWalk = new Float32Array(MAX_CREEPS); private cSx = new Float32Array(MAX_CREEPS); private cSy = new Float32Array(MAX_CREEPS);
  private cSeen = new Uint32Array(MAX_CREEPS);
  // The Huey's rotor, a fire, and each player's minigun spinning.
  private rotor: Loop | null = null;
  private fire: Loop | null = null;
  private spins = new Map<number, { loop: Loop; until: number; rate: number }>();

  constructor(volume: number) {
    this.synth = new Synth(volume);
    const unlock = () => this.synth.gesture();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  // A new game: what was known of the last is dropped, and the first frame is only read.
  reset(): void {
    this.primed = false;
    this.effects.clear();
    this.rotor?.stop(); this.rotor = null;
    this.fire?.stop(); this.fire = null;
    for (const s of this.spins.values()) s.loop.stop();
    this.spins.clear();
  }

  // listen puts the ears where the camera looks; called every drawn frame, it also moves the
  // loops along with what makes them.
  listen(game: Game, cam: THREE.Camera, x: number, y: number, dist: number): void {
    this.cam = cam; this.lx = x; this.ly = y; this.dist = dist;
    if (!this.synth.ready || !game.welcome) return;
    const f = game.cur, paused = f.pausedBy >= 0, now = this.synth.now;
    // The rotor follows the Huey in.
    let heli: Placed | null = null;
    let fire: Placed | null = null, fires = 0;
    for (let i = 0; i < f.nEffects; i++) {
      const k = f.eKind[i];
      if (k === EffectKind.Drop) {
        const total = f.eTotal[i], left = f.eLeft[i];
        const u = total > 30 ? Math.min(1, Math.max(0, (total - left) / (total - 30))) : 1;
        const e = u * u * (3 - 2 * u);
        heli = this.place(f.eX0[i] + (f.eX[i] - f.eX0[i]) * e, f.eY0[i] + (f.eY[i] - f.eY0[i]) * e, 0.9, 3);
      } else if (k === EffectKind.Napalm) {
        const p = this.place(f.eX[i], f.eY[i], 0.5, 1.2);
        if (p) { fires++; if (!fire || p.vol > fire.vol) fire = p; }
      }
    }
    this.rotor = this.keep(this.rotor, 'rotor', paused ? null : heli);
    if (fire) fire.vol *= Math.min(1.6, 1 + 0.2 * (fires - 1));
    this.fire = this.keep(this.fire, 'fire', paused ? null : fire);
    for (const [id, s] of this.spins) {
      const p = game.cur.player(id);
      const on = !paused && now < s.until;
      s.rate += ((on ? 1 : 0.25) - s.rate) * (on ? 0.12 : 0.04);
      const at = p ? this.place(p.x, p.y, 0.32 * Math.min(1, (s.rate - 0.25) / 0.5 + 0.15), 1) : null;
      if (!at || (!on && s.rate < 0.3)) { s.loop.stop(); this.spins.delete(id); continue; }
      s.loop.set(at, s.rate);
    }
  }

  private keep(l: Loop | null, name: string, p: Placed | null): Loop | null {
    if (!p) { l?.stop(); return null; }
    l ??= this.synth.loop(name);
    l?.set(p);
    return l;
  }

  // place is how a sound at (x, y) reaches the ears: quieter and darker with distance, panned
  // by where it is on screen. reach stretches the distance it carries (thunder, the bell).
  // null when it is too far off to hear.
  place(x: number, y: number, loud: number, reach = 1): Placed | null {
    const ref = (7 + this.dist * 0.3) * reach;
    const d = Math.hypot(x - this.lx, y - this.ly);
    if (d > ref * 7) return null;
    // Zoomed far out, the whole map is quieter: the ears go up with the camera.
    const zoom = 1 - 0.35 * Math.min(1, Math.max(0, (this.dist - 12) / 63));
    const vol = loud * zoom / (1 + Math.pow(d / ref, 1.4));
    let pan = 0;
    if (this.cam) {
      this.v.set(x, 0.5, y).project(this.cam);
      pan = Math.max(-1, Math.min(1, this.v.x)) * 0.7;
    }
    return { vol, pan, far: Math.min(1, d / (ref * 5)) };
  }

  // Sounds that are not anywhere: the game's own, the radio, and what happens to you.
  private flat(loud: number): Placed { return { vol: loud, pan: 0, far: 0 }; }

  // once lets a sound play at most every gap seconds, by key.
  private once(key: string, gap: number): boolean {
    const now = performance.now() / 1000, at = this.last.get(key) ?? -1e9;
    if (now - at < gap) return false;
    this.last.set(key, now);
    return true;
  }

  ui(name: string, loud = 0.5, gap = 0.25): void {
    if (this.once('ui:' + name, gap)) this.synth.play(name, this.flat(loud), 0, 1, true);
  }

  onFrame(game: Game): void {
    const wd = game.welcome;
    if (!wd) return;
    const f = game.cur;
    if (!this.primed) { this.remember(game); this.primed = true; return; }
    if (!this.synth.ready) { this.remember(game); return; }
    const t0 = this.synth.now + AHEAD;

    // The dead within earshot: how many are awake, and whose blows land. The more there are,
    // the fewer of their sounds are played: a horde is heard as a horde from a few voices,
    // and every one of them heard at once only tires the ear.
    const strikes: Shot[] = [];
    let near = 0;
    const hear = (7 + this.dist * 0.3) * 1.6;
    for (let i = 0; i < f.nCreeps; i++) {
      const x = f.cX[i], y = f.cY[i], dx = x - this.lx, dy = y - this.ly;
      if (dx * dx + dy * dy > hear * hear) continue;
      if (!(f.cFlags[i] & CF_ASLEEP)) near++;
      if (f.cFlags[i] & CF_STRIKE && !THROWS.has(f.cKind[i])) strikes.push({ x, y, vol: -(dx * dx + dy * dy), extra: f.cKind[i] });
    }
    const crowd = Math.min(1, Math.max(0, (near - CROWD0) / (CROWD1 - CROWD0)));

    // Shots: grouped by sound, the nearest few of each played, spread across the tick.
    const groups = new Map<string, Shot[]>();
    const add = (name: string, x: number, y: number, extra?: number) => {
      const p = this.place(x, y, LOUD[name] ?? 0.6, name === 'cannon' || name === 'sniper' || name === 'rifle' ? 1.6 : 1.2);
      if (!p) return;
      let g = groups.get(name);
      if (!g) groups.set(name, g = []);
      g.push({ x, y, vol: p.vol, extra, p });
    };
    for (let i = 0; i < f.nTracers; i++) {
      const k = f.tKind[i], x0 = f.tX0[i], y0 = f.tY0[i], x1 = f.tX1[i], y1 = f.tY1[i];
      if (k === TRACER_HELI) add('doorGun', x0, y0);
      else if (k === TRACER_SHARD) { add('boneThrow', x0, y0); add('boneLand', x1, y1, 0.2 + Math.hypot(x1 - x0, y1 - y0) * 0.01); }
      else if (k === 33) add('dash', x0, y0);
      else if (k >= 32) add('spit', x0, y0);
      else if (k >= 16) { const n = TURRET[k - 16]; if (n) add(n, x0, y0); }
      else if (k === 5) {
        const s = game.structAtTile(Math.floor(x0), Math.floor(y0));
        add(s >= 0 && f.sKind[s] === K_MISSILE ? 'missile' : 'rocket', x0, y0);
      } else if (GUN[k]) {
        add(GUN[k], x0, y0);
        if (k === MINIGUN) this.spinning(f.players, f.nPlayers, x0, y0);
      }
    }
    for (const [name, list] of groups) {
      const cap = CREEPY.has(name) ? Math.max(1, Math.round(3 - 2 * crowd)) : CAP[name] ?? 4;
      list.sort((a, b) => b.vol - a.vol);
      const n = Math.min(cap, list.length);
      // More than are played: the ones played stand in for the rest, a little louder.
      const more = list.length > n ? 1 + 0.18 * Math.log2(list.length / n) : 1;
      for (let j = 0; j < n; j++) {
        const s = list[j], p = { ...s.p!, vol: s.vol * more };
        const at = t0 + (s.extra ?? (j / n) * TICK + Math.random() * 0.008);
        this.synth.play(name, p, at);
      }
    }

    // Blasts.
    let loot = false;
    for (let i = 0; i < f.nBlasts; i++) {
      const x = f.bX[i], y = f.bY[i], r = f.bR[i];
      const at = (name: string, loud: number, reach = 1.5, rate = 1) => {
        const p = this.place(x, y, loud, reach);
        if (p) this.synth.play(name, p, t0 + Math.random() * 0.02, rate);
      };
      switch (f.bKind[i]) {
        case BlastKind.Explosion: at(r < 1.6 ? 'explosionS' : r < 3 ? 'explosion' : 'explosionL', 1.2, 2.2); break;
        case BlastKind.Airstrike: at('explosionL', 1.4, 2.5, 0.96); break;
        case BlastKind.Frost: at('frost', 0.5); break;
        case BlastKind.Concussion: at('concussion', 1, 1.8); break;
        case BlastKind.Loot: loot = true; at(r <= 1.01 ? 'jackpot' : 'lootFound', 0.7); break;
        case BlastKind.Ambush: at('ambush', 1, 2); break;
        case BlastKind.Taunt: at('shout_' + this.voiceOf(f.players, f.nPlayers, x, y), 0.9); break;
        case BlastKind.Lightning: at('thunder', 1.3, 8); break;
        case BlastKind.Revived: at('revived_' + this.voiceOf(f.players, f.nPlayers, x, y), 0.7); break;
        case BlastKind.GuardsWake: if (this.once('alert', 2)) at('alert', 0.75, 1.6); break;
        case BlastKind.Bell: at('bell', 1, 12); break;
        case BlastKind.Bile: at('bile', 0.9, 1.6); break;
      }
    }

    // Deaths: the big ones always, then the nearest few.
    const deaths: Shot[] = [];
    for (let i = 0; i < f.nDeaths; i++) {
      const k = f.dKind[i], big = BIG.has(k);
      const p = this.place(f.dX[i], f.dY[i], big ? 1.1 : 0.55, big ? 2 : 1);
      if (p) deaths.push({ x: f.dX[i], y: f.dY[i], vol: p.vol + (big ? 10 : 0), extra: k });
    }
    deaths.sort((a, b) => b.vol - a.vol);
    for (let j = 0; j < Math.min(4 - Math.round(2 * crowd), deaths.length); j++) {
      const d = deaths[j], k = d.extra!, big = BIG.has(k);
      const p = this.place(d.x, d.y, big ? 1.1 : 0.55, big ? 2 : 1)!;
      this.synth.play('death' + k, p, t0 + Math.random() * TICK);
    }

    // Blows landing, and the groaning of the dead nearby.
    strikes.sort((a, b) => b.vol - a.vol);
    for (let j = 0; j < Math.min(crowd > 0.5 ? 1 : 2, strikes.length); j++) {
      const s = strikes[j], big = BIG.has(s.extra!);
      const p = this.place(s.x, s.y, big ? 0.9 : 0.5);
      if (p) this.synth.play(big ? 'strikeBig' : 'strike', p, t0 + Math.random() * TICK);
    }
    this.groan(game, near, hear, crowd);
    this.steps(game, t0, hear, crowd);

    this.effectSounds(game, t0);
    this.playerSounds(game, loot);
    this.structSounds(game);
    this.gameSounds(game);
    this.remember(game);
  }

  // A groan now and then from one of the dead within earshot: more of them, more often, but a
  // crowd groans no more than about once a second.
  private groan(game: Game, near: number, hear: number, crowd: number): void {
    const now = performance.now() / 1000;
    if (near === 0 || now < this.groanDue) return;
    const f = game.cur;
    // Pick one at random among those near enough: a few tries are plenty.
    for (let k = 0; k < 12; k++) {
      const i = Math.floor(Math.random() * f.nCreeps);
      const dx = f.cX[i] - this.lx, dy = f.cY[i] - this.ly;
      if (dx * dx + dy * dy > hear * hear || f.cFlags[i] & CF_ASLEEP) continue;
      const kind = f.cKind[i], big = BIG.has(kind);
      const p = this.place(f.cX[i], f.cY[i], big ? 0.8 : 0.42);
      if (p) this.synth.play('groan' + kind, p);
      break;
    }
    const rate = Math.min(2.4 - 1.4 * crowd, 0.3 * Math.sqrt(near));
    this.groanDue = now + (0.5 + Math.random()) / rate;
  }

  // Footsteps, one for every step's length of ground covered: a survivor's step lengthens
  // with speed as the legs do, a creep's with its size. Only the nearest of the dead are
  // heard stepping, fewer in a crowd, and none of it when the mix is busy.
  private steps(game: Game, t0: number, hear: number, crowd: number): void {
    const f = game.cur, n = ++this.serial, quiet = this.synth.busy < STEP_BUSY;
    // The share of the tick at which a step falls, from what is left over past it.
    const walk = (acc: Float32Array, id: number, d: number, len: number): number => {
      acc[id] += d;
      if (acc[id] < len) return -1;
      acc[id] = Math.min(acc[id] - len, len * 0.5);
      return Math.max(0, 1 - acc[id] / d);
    };
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i], id = p.id;
      const d = Math.hypot(p.x - this.pSx[id], p.y - this.pSy[id]), seen = this.pSeen[id] === n - 1;
      this.pSx[id] = p.x; this.pSy[id] = p.y; this.pSeen[id] = n;
      // A dash covers a metre in a tick and has a sound of its own.
      if (!seen || d > 0.9 || !(p.flags & PF_ALIVE) || !(p.flags & PF_CONNECTED)) { this.pWalk[id] = Math.random() * 0.4; continue; }
      const u = walk(this.pWalk, id, d, Math.min(1.3, Math.max(0.36, 0.3 + 0.11 * d / TICK)));
      if (u < 0 || !quiet) continue;
      const q = this.place(p.x, p.y, STEP);
      if (q) this.synth.play('step', q, t0 + u * TICK);
    }
    const heard: { x: number; y: number; near: number; u: number; big: boolean }[] = [];
    const creeps = game.welcome!.creeps;
    for (let i = 0; i < f.nCreeps; i++) {
      const id = f.cId[i], x = f.cX[i], y = f.cY[i], dx = x - this.lx, dy = y - this.ly;
      if (dx * dx + dy * dy > hear * hear || f.cFlags[i] & CF_ASLEEP) continue;
      const d = Math.hypot(x - this.cSx[id], y - this.cSy[id]), seen = this.cSeen[id] === n - 1;
      this.cSx[id] = x; this.cSy[id] = y; this.cSeen[id] = n;
      const k = f.cKind[i], len = 0.3 + (creeps[k]?.radius ?? 0.45) * 0.8;
      if (!seen || d > 1) { this.cWalk[id] = Math.random() * len; continue; }
      const u = walk(this.cWalk, id, d, len);
      if (u >= 0) heard.push({ x, y, near: -(dx * dx + dy * dy) + (BIG.has(k) ? 1e4 : 0), u, big: BIG.has(k) });
    }
    if (!quiet) return;
    // The big ones first: their tread is heard over the rest.
    heard.sort((a, b) => b.near - a.near);
    for (let j = 0; j < Math.min(Math.round(CREEP_STEPS - crowd), heard.length); j++) {
      const s = heard[j];
      const q = this.place(s.x, s.y, s.big ? BIG_STEP : CREEP_STEP, s.big ? 1.4 : 1);
      if (q) this.synth.play(s.big ? 'bigStep' : 'creepStep', q, t0 + s.u * TICK);
    }
  }

  private spinning(ps: Player[], n: number, x: number, y: number): void {
    for (let i = 0; i < n; i++) {
      const p = ps[i];
      if (p.cur !== MINIGUN || Math.abs(p.x - x) > 1.5 || Math.abs(p.y - y) > 1.5) continue;
      let s = this.spins.get(p.id);
      if (!s) {
        const loop = this.synth.loop('spin');
        if (!loop) return;
        this.spins.set(p.id, s = { loop, until: 0, rate: 0.3 });
      }
      s.until = this.synth.now + 0.25;
      return;
    }
  }

  // Whose voice a shout or a gasp at (x, y) is: the nearest survivor's, a man's or a woman's
  // by how they look (androgynous ones by their id).
  private voiceOf(ps: Player[], n: number, x: number, y: number): 'm' | 'f' {
    let best: Player | null = null, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.hypot(ps[i].x - x, ps[i].y - y); if (d < bd) { bd = d; best = ps[i]; } }
    return best ? voice(best) : 'm';
  }

  private effectSounds(game: Game, t0: number): void {
    const f = game.cur, seen = new Set<string>();
    for (let i = 0; i < f.nEffects; i++) {
      const kind = f.eKind[i], x0 = f.eX0[i], y0 = f.eY0[i], x = f.eX[i], y = f.eY[i];
      const key = `${kind}:${Math.round(x0 * 8)}:${Math.round(y0 * 8)}:${Math.round(x * 8)}:${Math.round(y * 8)}`;
      seen.add(key);
      if (this.effects.has(key)) continue;
      this.effects.set(key, { kind, x, y, x0, y0 });
      const at = (name: string, px: number, py: number, loud: number, reach = 1.4, t = t0) => {
        const p = this.place(px, py, loud, reach);
        if (p) this.synth.play(name, p, t);
      };
      switch (kind) {
        case EffectKind.Grenade: at('grenade', x0, y0, 0.6); break;
        case EffectKind.Napalm: at('ignite', x, y, 0.9, 1.6); break;
        // The jets are timed to be right overhead as the bombs land.
        case EffectKind.AirTarget: at('jets', x, y, 1, 5, t0 + Math.max(0, f.eLeft[i] / 10 - 2.2)); break;
        case EffectKind.Slam: at('groan3', x0, y0, 1, 1.8); break;
        case EffectKind.Bile: at('retch', x0, y0, 0.8, 1.6); break;
        case EffectKind.Acid: at('sizzle', x, y, 0.5); break;
      }
    }
    for (const [key, e] of this.effects) {
      if (seen.has(key)) continue;
      this.effects.delete(key);
      const p = (loud: number, reach = 1.6) => this.place(e.x, e.y, loud, reach);
      if (e.kind === EffectKind.Slam) { const q = p(1.1, 2); if (q) this.synth.play('slam', q, t0); }
      if (e.kind === EffectKind.Drop) { const q = p(0.9); if (q) this.synth.play('crateLand', q, t0); }
    }
  }

  private playerSounds(game: Game, loot: boolean): void {
    const f = game.cur, me = game.welcome!.you;
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i], id = p.id, was = this.pFlags[id], mine = id === me;
      if (!(p.flags & PF_CONNECTED)) continue;
      const g = voice(p);
      const here = (loud: number) => mine ? this.flat(loud) : this.place(p.x, p.y, loud * 0.8);
      if (p.flags & PF_HURT && !(was & PF_HURT) && p.flags & PF_ALIVE && this.once('hurt' + id, 0.45)) {
        const q = here(0.75); if (q) this.synth.play('hurt_' + g, q);
      }
      if (was & PF_ALIVE && !(p.flags & PF_ALIVE)) { const q = here(0.9); if (q) this.synth.play('down_' + g, q, 0, 1, mine); }
      if (!mine) continue;
      // Yours only: the gun in your hands, the kit on your back, the money in your pocket.
      const alive = (p.flags & PF_ALIVE) !== 0;
      if (alive && p.cur !== this.pCur[id]) this.synth.play('switch', this.flat(0.5));
      else if (alive && p.cur < 6) {
        if (p.flags & PF_RELOADING && !(was & PF_RELOADING)) this.synth.play('reload' + p.cur, this.flat(0.55));
        if (!(p.flags & PF_RELOADING) && was & PF_RELOADING) this.synth.play('reloaded' + p.cur, this.flat(0.6));
      }
      if (p.heal > 0 && this.pHeal[id] <= 0) this.synth.play('medkit', this.flat(0.55));
      if (p.stunned && !this.pStun[id]) this.synth.play('tinnitus', this.flat(0.5), 0, 1, true);
      const ups = upgrades(p), buys = purchases(p);
      if (p.flags & PF_ARMORY && !loot) {
        if (ups > this.pUps[id]) this.synth.play('upgrade', this.flat(0.55));
        else if (buys > this.pBuys[id]) this.synth.play('coins', this.flat(0.55));
      }
    }
  }

  private structSounds(game: Game): void {
    const f = game.cur;
    for (let i = 0; i < f.nStructs; i++) {
      const cx = f.sX[i] + f.sW[i] / 2, cy = f.sY[i] + f.sH[i] / 2;
      const was = i < this.nStructs && this.sAlive[i] && this.sKind[i] === f.sKind[i];
      if (f.sAlive[i] && !was) { const p = this.place(cx, cy, 0.6); if (p) this.synth.play('hammer', p); }
      else if (f.sAlive[i] && level(f.sLevel[i], f.sLv, i) > this.sLevel[i]) { const p = this.place(cx, cy, 0.55); if (p) this.synth.play('upgrade', p); }
      else if (!f.sAlive[i] && i < this.nStructs && this.sAlive[i]) {
        // Sold whole, or knocked down: one that went at a quarter of its health or more was sold.
        const p = this.place(cx, cy, this.sHpFrac[i] > 0.25 ? 0.5 : 0.85, 1.5);
        if (p) this.synth.play(this.sHpFrac[i] > 0.25 ? 'coins' : 'crumble', p);
      }
      if (f.sAlive[i] && f.sKind[i] === K_CORE) {
        const hp = f.sHp[i];
        if (this.coreHp >= 0 && hp < this.coreHp && f.phase === Phase.Wave && this.once('klaxon', 7)) this.synth.play('klaxon', this.flat(0.35), 0, 1, true);
        this.coreHp = hp;
      }
    }
  }

  private gameSounds(game: Game): void {
    const f = game.cur;
    let sirens = false;
    if (this.phase >= 0 && f.phase !== this.phase) {
      sirens = true;
      const s = f.phase === Phase.Wave ? 'sirenWave' : f.phase === Phase.Over ? 'sirenOver' : this.phase === Phase.Wave ? 'sirenClear' : '';
      if (s) this.synth.play(s, this.flat(s === 'sirenClear' ? 0.4 : 0.5), 0, 1, true);
    }
    if (f.phase === Phase.Build && f.pausedBy < 0) {
      const secs = Math.ceil(f.phaseLeft / 10);
      if (secs !== this.secs && secs >= 1 && secs <= 3) this.synth.play('beep', this.flat(0.4), 0, 1, true);
      this.secs = secs;
    } else this.secs = -1;
    for (const n of f.notes) {
      if (n.level === 3) this.ui('radio_chat', 0.45, 0.3);
      else if (!sirens && n.level === 1) this.ui('radio_good', 0.4, 0.6);
      else if (!sirens && n.level === 2) this.ui('radio_bad', 0.45, 0.6);
    }
    for (const g of f.pings) {
      const name = g.kind === PingKind.Danger ? 'radio_danger' : g.kind === PingKind.Loot ? 'radio_loot' : g.kind === PingKind.Defend ? 'radio_defend' : 'radio_here';
      this.ui(name, 0.45, 0.2);
    }
  }

  private remember(game: Game): void {
    const f = game.cur;
    this.phase = f.phase;
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i], id = p.id;
      this.pFlags[id] = p.flags; this.pCur[id] = p.cur; this.pHeal[id] = p.heal; this.pStun[id] = p.stunned ? 1 : 0;
      this.pBuys[id] = purchases(p); this.pUps[id] = upgrades(p);
    }
    this.nStructs = f.nStructs;
    for (let i = 0; i < f.nStructs; i++) {
      this.sAlive[i] = f.sAlive[i]; this.sKind[i] = f.sKind[i]; this.sLevel[i] = level(f.sLevel[i], f.sLv, i);
      this.sHpFrac[i] = f.sHp[i] / Math.max(1, f.sMaxHp[i]);
    }
    this.effects.clear();
    for (let i = 0; i < f.nEffects; i++) {
      const key = `${f.eKind[i]}:${Math.round(f.eX0[i] * 8)}:${Math.round(f.eY0[i] * 8)}:${Math.round(f.eX[i] * 8)}:${Math.round(f.eY[i] * 8)}`;
      this.effects.set(key, { kind: f.eKind[i], x: f.eX[i], y: f.eY[i], x0: f.eX0[i], y0: f.eY0[i] });
    }
  }
}

// A survivor's voice from their look: body 0 a man's, 1 a woman's, else by their id.
function voice(p: Player): 'm' | 'f' {
  const body = (p.look >> 7) & 3;
  return body === 0 ? 'm' : body === 1 ? 'f' : p.id % 2 ? 'f' : 'm';
}

// Everything a survivor has bought, as one count that only goes up with buying.
function purchases(p: Player): number {
  let n = p.medkits;
  for (let w = p.owned; w; w &= w - 1) n++;
  for (let i = 0; i < 4; i++) n += p.gear[i] + p.abLevel[i];
  return n;
}
function upgrades(p: Player): number {
  let n = 0;
  for (let i = 0; i < p.levels.length; i++) n += p.levels[i];
  return n;
}
function level(lv: number, tracks: Uint8Array, i: number): number {
  let n = lv;
  for (let k = 0; k < TURRET_TRACKS; k++) n += tracks[i * TURRET_TRACKS + k];
  return n;
}
