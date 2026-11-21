import {
  Art, ART_TIME, BlastKind, CROWBAR, EffectKind, FISSURE_EVERY, GREAT, OWNED_BREAKER, OWNED_TEMPERED, TRACER_HELI, TRACER_SPLIT, TRACER_HOMERUN, TRACER_HOMERUN_ROUND, K_TESLA, KATANA, OWNED_DUAL, OWNED_DUAL_KATANA, TRACER_FLASH, TRACER_FOLLOW, TRACER_GREAT,
  TRACER_KATANA, TRACER_MOON, THROW_FLIGHT, TRACER_ARC, TRACER_NAPALM, CF_ASLEEP, CF_BURNING, CF_GUARD, CF_STRIKE, CF_WINDUP, Emote, Order, PF_ALIVE, PF_CONNECTED, PF_FIRING, PF_HURT, PF_MOVING, PF_RELOADING, Player,
} from './protocol';
import type { Game } from './state';

// #lab: the animation bench. Each creep kind in a row, one column per state (walking back and
// forth, idle, attacking, hit, burning, asleep, dying), and the survivors beside them, each
// showing a pose: walking a circle while aiming one way (so strafing and backpedalling show),
// sprinting, kneeling to search and to revive, reloading, taunting and down, firing dual
// pistols, and caught and thrown by a mauler, each at its own health so the HUD's portraits
// show every state; then the legendaries: the katana's combo, a pair of katanas, Flash Draw,
// the greatsword's combo, Skyfall, the evolved blades (Moonlit Edge, the greatsword's
// follow-through), the crowbar's Home Run, plain and Bonebreaker's, and Worldsplitter: a
// tempered greatsword raised and slammed down, the shockwave going out every way, the ground it
// cracks erupting, and Worldbreaker detonating it as it closes. Past them, the turret evolutions' shots ('fx'): a napalm missile flying
// and bursting, and an arc web striking a knot of points. Past those ('huey'), a supply Huey
// hovering with its door gunner sweeping the ground around it. It takes the demo's world over after
// its first frame and stops it, then poses everything itself.

const COLS = ['walk', 'idle', 'attack', 'hit', 'burn', 'sleep', 'die'] as const;
const DX = 3.2, DY = 3.6;

export class Lab {
  private x0: number; private y0: number;
  private t0 = performance.now();
  private tick = 0;
  private last = 0;
  // Player poses, by player slot.
  private poses = ['circle', 'sprint', 'loot', 'revive', 'reload', 'taunt', 'down', 'shoot', 'dual', 'thrown',
    'katana', 'katanas', 'flash', 'great', 'skyfall', 'evolved', 'homerun', 'bonebreaker', 'worldsplitter'];
  // The swing counter each legendary pose last showed, to cut a tracer when it moves.
  private swung: number[] = [];
  // Worldsplitter's moments already sent (the cut, each burst, the detonation), by name, with
  // the cycle they were sent in.
  private split = new Map<string, number>();

  // gun, when 0 or more, puts that weapon in every survivor's hands (#lab=h&gun=6).
  constructor(private game: Game, cx: number, cy: number, private gun = -1) {
    this.x0 = cx - 3 * DX;
    this.y0 = cy + 9;
  }

  // Where to look: the whole bench, or one creep row (0..10), or the survivors ('h'), or one
  // of them ('h0'..'h18'), or the crowbar's Home Run ('crowbar'), or Worldsplitter
  // ('worldsplitter'), or the turret shots ('fx').
  center(at = ''): [number, number] {
    if (at === 'fx') return [this.fx() + 4.5, this.y0 + 2.5];
    if (at === 'huey') return [this.fx() + 22, this.y0 - 2]; // north of it, as the Huey is up in the air
    if (/^h\d+$/.test(at)) return this.spot(Number(at.slice(1)));
    if (at === 'crowbar') { const [x, y] = this.spot(16); return [x + 1.7, y]; }
    if (at === 'worldsplitter') return this.spot(18);
    if (at === 'h') return [this.x0 + COLS.length * DX + 4.2, this.y0 + 1.5 * DY];
    if (at === 'legend') return [this.x0 + COLS.length * DX + 4.2, this.y0 + 6 * DY];
    if (at !== '' && !Number.isNaN(Number(at))) return [this.x0 + 3 * DX, this.y0 + Number(at) * DY];
    return [this.x0 + 3 * DX + 3, this.y0 + 2.5 * DY];
  }

  // Where survivor pose i stands: two to a row beside the creeps, and the crowbar's two (16 and
  // 17) out in the open to the right, clear of the trees further down, and Worldsplitter's (18)
  // below them, its shockwave and cracks all round it.
  private spot(i: number): [number, number] {
    const hx = this.x0 + COLS.length * DX + 2.5;
    if (i === 18) return [hx + 7.5, this.y0 + 4 * DY];
    if (i >= 16) return [hx + 7.5 + (i % 2) * 3.4, this.y0 + 2 * DY];
    return [hx + (i % 2) * 3.4, this.y0 + Math.floor(i / 2) * DY];
  }

  // The left edge of the turret shots, past the survivors.
  private fx(): number { return this.x0 + COLS.length * DX + 11; }

  // Poses everything for this moment, and reports whether a new frame came with it: its
  // tracers and blasts are the turret shots, for the effects to spawn.
  step(now: number): boolean {
    const g = this.game, f = g.cur, wd = g.welcome!;
    const t = (now - this.t0) / 1000;
    // A new frame at the welcome's tick rate, for what keys off frames (the dead).
    let fresh = false;
    if (now - this.last >= 1000 / (wd.tickRate || 20)) { this.last = now; g.frames++; this.tick++; fresh = true; }
    const kinds = wd.creeps.length;
    let n = 0;
    for (let k = 0; k < kinds; k++) {
      const def = wd.creeps[k];
      const rate = def.rate ?? 1, windup = def.windup ?? 0.4;
      for (let c = 0; c < COLS.length; c++) {
        const col = COLS[c];
        const id = 100 + k * 16 + c;
        const x = this.x0 + c * DX, y = this.y0 + k * DY;
        let px = x, py = y, fl = 0, heading = Math.PI / 2;
        if (col === 'walk') {
          // Back and forth over 2.4 tiles at the kind's speed.
          const span = 2.4, period = (2 * span) / def.speed;
          const u = (t % period) / period;
          const along = u < 0.5 ? u * 2 : 2 - u * 2;
          px = x - 1.2 + along * span;
          heading = u < 0.5 ? 0 : Math.PI;
        } else if (col === 'attack') {
          const u = t % (1 / rate);
          const left = 1 / rate - u;
          if (left <= windup) fl |= CF_WINDUP;
          if (u < 0.05) fl |= CF_STRIKE;
        } else if (col === 'hit') {
          if (t % 1.1 < 0.02) g.flashUntil[id] = now + 90;
        } else if (col === 'burn') fl |= CF_BURNING;
        else if (col === 'sleep') fl |= CF_ASLEEP | CF_GUARD;
        else if (col === 'die' && t % 4.5 > 1.2) continue;
        f.cId[n] = id; f.cKind[n] = k; f.cFlags[n] = fl; f.cFx[n] = 0; f.cTarget[n] = col === 'attack' ? 128 + 32 : 255;
        f.cHp[n] = col === 'hit' ? 200 : 255;
        f.cX[n] = px; f.cY[n] = py;
        g.rx[n] = px; g.ry[n] = py; g.heading[id] = heading;
        g.indexById[id] = n;
        n++;
      }
    }
    f.nCreeps = n;
    f.nBlasts = 0; f.nTracers = 0; f.nDeaths = 0; f.nEffects = 0;

    // The survivors, to the right of the creeps.
    while (f.players.length < this.poses.length) f.players.push(new Player());
    f.nPlayers = this.poses.length;
    for (let i = 0; i < this.poses.length; i++) {
      const p = f.players[i], pose = this.poses[i];
      // Health varies so the portraits show their wounds; the sprinter has a medkit working.
      p.id = i; p.look = (i * 2654435761) >>> 0; p.cur = this.gun >= 0 ? this.gun : i % 6; p.hp = [80, 50, 55, 80, 22, 80, 0, 45, 70, 35, 90, 75, 60, 85, 65, 95, 70, 88, 100][i]; p.maxHp = 100;
      p.heal = pose === 'sprint' ? 5 : 0;
      p.flags = PF_CONNECTED | PF_ALIVE; p.order = Order.Idle; p.channel = 0; p.emote = Emote.None; p.emoteLeft = 0; p.sprinting = false;
      p.held = false; p.airborne = false; p.stunned = false; p.owned = 0;
      p.evo.fill(0); p.art = Art.None; p.artFrac = 0; p.artCool = 0;
      let [x, y] = this.spot(i), aim = Math.PI / 2;
      switch (pose) {
        case 'circle': {
          const a = t * 0.9;
          x += Math.cos(a) * 1.3; y += Math.sin(a) * 1.3; aim = Math.PI / 2;
          p.flags |= PF_MOVING | PF_FIRING; break;
        }
        case 'sprint': {
          // The real sprint: base speed 6 m/s, times 1.6.
          const span = 6, period = (2 * span) / 9.6, u = (t % period) / period;
          // Out into the open space to the right of the bench, and back.
          x += (u < 0.5 ? u * 2 : 2 - u * 2) * span;
          aim = u < 0.5 ? 0 : Math.PI;
          p.sprinting = true; p.flags |= PF_MOVING; break;
        }
        case 'loot': p.order = Order.Loot; p.channel = 0.5; break;
        case 'revive': p.order = Order.Revive; p.channel = 0.5; break;
        case 'reload': p.flags |= PF_RELOADING; break;
        case 'taunt': p.emote = Emote.Taunt; p.emoteLeft = 1; break;
        case 'down': p.flags = PF_CONNECTED; break;
        case 'shoot': aim = t * 0.7; p.flags |= PF_FIRING; if (t % 2.5 < 0.25) p.flags |= PF_HURT; break;
        case 'dual': p.cur = 0; p.owned |= OWNED_DUAL; aim = Math.PI / 2 + Math.sin(t) * 0.6; p.flags |= PF_FIRING; break;
        case 'thrown': {
          // Held up for a second, thrown three tiles, then stunned where they land.
          const u = t % 3, hold = 1;
          p.stunned = true;
          if (u < hold) p.held = true;
          else if (u < hold + THROW_FLIGHT) { p.airborne = true; x -= (u - hold) / THROW_FLIGHT * 3; }
          else x -= 3;
          break;
        }
        default: [x, y, aim] = this.legend(p, pose, t, x, y, i, fresh); break;
      }
      g.prx[i] = x; g.pry[i] = y; g.paim[i] = aim;
      p.x = x; p.y = y; p.aim = aim;
    }
    if (fresh) this.shots();
    this.huey(t, fresh);
    return fresh;
  }

  // A legendary pose: swinging in a combo, a cut every period seconds, or the weapon art every
  // three seconds. Tracers and blasts go out with fresh frames, as the game's would, for the
  // effects and sounds.
  private legend(p: Player, pose: string, t: number, x: number, y: number, i: number, fresh: boolean): [number, number, number] {
    const f = this.game.cur, aim = 0;
    if (pose === 'homerun' || pose === 'bonebreaker') {
      // The crowbar's Home Run every 2.5 seconds: wound back, then the swing (Bonebreaker's
      // all the way round).
      p.cur = CROWBAR; p.owned = 1 << CROWBAR;
      if (pose === 'bonebreaker') p.evo[CROWBAR] = 1;
      const u = t % 2.5, d = ART_TIME[Art.HomeRun], go = u - 0.8, now = Math.floor(t / 2.5);
      if (go >= 0 && go < d) { p.art = Art.HomeRun; p.artFrac = go / d; }
      if (fresh && go >= d && (this.swung[i] ?? -1) !== now) {
        this.swung[i] = now;
        const j = f.nTracers++;
        f.tX0[j] = x; f.tY0[j] = y; f.tX1[j] = x + 3.2; f.tY1[j] = y; f.tKind[j] = pose === 'bonebreaker' ? TRACER_HOMERUN_ROUND : TRACER_HOMERUN;
      }
      return [x, y, aim];
    }
    if (pose === 'worldsplitter') return this.worldsplitter(p, t, x, y, fresh);
    const great = pose === 'great' || pose === 'skyfall';
    p.cur = great ? GREAT : KATANA;
    p.owned = (1 << p.cur) | (pose === 'katanas' ? OWNED_DUAL_KATANA : 0);
    if (pose === 'evolved') { p.cur = Math.floor(t / 6) % 2 ? GREAT : KATANA; p.evo[KATANA] = 2; p.evo[GREAT] = 2; }
    const tracer = (x0: number, y0: number, x1: number, y1: number, k: number) => {
      const j = f.nTracers++;
      f.tX0[j] = x0; f.tY0[j] = y0; f.tX1[j] = x1; f.tY1[j] = y1; f.tKind[j] = k;
    };
    if (pose === 'flash' || pose === 'skyfall') {
      // The art over its time, then a breath standing where it ended, then back.
      const u = t % 3, d = ART_TIME[pose === 'flash' ? Art.Flash : Art.Skyfall], reach = pose === 'flash' ? 4 : 3;
      const go = u - 1, was = this.swung[i] ?? 0, now = Math.floor(t / 3);
      if (go >= 0 && go < d) { p.art = pose === 'flash' ? Art.Flash : Art.Skyfall; p.artFrac = go / d; }
      const along = go < 0 ? 0 : Math.min(1, go / d);
      if (fresh && go >= d && was !== now) {
        this.swung[i] = now;
        if (pose === 'flash') tracer(x, y, x + reach, y, TRACER_FLASH);
        else { const j = f.nBlasts++; f.bX[j] = x + reach; f.bY[j] = y; f.bR[j] = 3; f.bKind[j] = BlastKind.Skyfall; }
      }
      p.flags |= PF_MOVING;
      return [x + along * reach, y, aim];
    }
    const period = great ? 0.9 : pose === 'katanas' ? 0.32 : 0.45;
    const n = Math.floor(t / period);
    p.swings = n & 255;
    p.flags |= PF_FIRING;
    if (fresh && (this.swung[i] ?? -1) !== n) {
      this.swung[i] = n;
      const k = p.cur === GREAT ? (p.evo[GREAT] && n % 3 === 2 ? TRACER_FOLLOW : TRACER_GREAT) : TRACER_KATANA;
      tracer(x, y, x + (great || p.cur === GREAT ? 2 : 1.6), y, k);
      if (p.cur === KATANA && p.evo[KATANA]) tracer(x, y, x + 4, y, TRACER_MOON);
      if (p.cur === KATANA && n % 4 === 3) { const j = f.nBlasts++; f.bX[j] = x + 1.3; f.bY[j] = y; f.bR[j] = 1; f.bKind[j] = BlastKind.Bleed; }
    }
    return [x, y, aim];
  }

  // Worldsplitter every 7 seconds with a tempered greatsword that has Worldbreaker: raised, then
  // slammed down facing right, the shockwave 7 tiles every way, the ground round the blade
  // cracked 4 s and erupting every half second, and Worldbreaker's shockwave and charges as it
  // closes.
  private worldsplitter(p: Player, t: number, x: number, y: number, fresh: boolean): [number, number, number] {
    const f = this.game.cur, reach = 7, crack = 4, open = 4;
    p.cur = GREAT; p.owned = (1 << GREAT) | OWNED_TEMPERED | OWNED_BREAKER; p.evo[GREAT] = 1;
    const period = 7, cycle = Math.floor(t / period), go = (t % period) - 1, d = ART_TIME[Art.Split];
    p.swings = (cycle + (go >= d ? 1 : 0)) & 255;
    if (go >= 0 && go < d) { p.art = Art.Split; p.artFrac = go / d; }
    const once = (key: string) => {
      if (!fresh || this.split.get(key) === cycle) return false;
      this.split.set(key, cycle);
      return true;
    };
    const tracer = (x0: number, y0: number, x1: number, y1: number, k: number) => {
      const j = f.nTracers++;
      f.tX0[j] = x0; f.tY0[j] = y0; f.tX1[j] = x1; f.tY1[j] = y1; f.tKind[j] = k;
    };
    const blast = (bx: number, by: number, r: number, k: number) => {
      const j = f.nBlasts++;
      f.bX[j] = bx; f.bY[j] = by; f.bR[j] = r; f.bKind[j] = k;
    };
    const since = go - d;
    if (since >= 0 && once('cut')) tracer(x, y, x + reach, y, TRACER_SPLIT);
    if (since >= 0 && since < open) {
      const e = f.nEffects++;
      f.eKind[e] = EffectKind.Fissure; f.eX0[e] = x; f.eY0[e] = y; f.eX[e] = x; f.eY[e] = y; f.eR[e] = crack;
      f.eLeft[e] = Math.ceil((open - since) * 10); f.eTotal[e] = open * 10;
      const burst = Math.floor(since / FISSURE_EVERY);
      if (burst > 0 && once(`burst${burst}`)) for (let k = 0; k < 4; k++) {
        const a = Math.random() * 6.283, d = crack * (0.3 + 0.7 * Math.random());
        blast(x + Math.cos(a) * d, y + Math.sin(a) * d, 1.5, BlastKind.Erupt);
      }
    }
    if (since >= open && once('breaker')) {
      blast(x, y, 10, BlastKind.Breaker);
      // The charges leaping from creep to creep, here between points spiralling out round it.
      const pts = Array.from({ length: 9 }, (_, k) => [x + Math.cos(k * 1.9) * (2 + k * 0.9), y + Math.sin(k * 1.9) * (2 + k * 0.9)]);
      for (let k = 1; k < pts.length; k++) tracer(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], TRACER_ARC);
    }
    return [x, y, 0];
  }

  // The turret evolutions' shots for one frame: a napalm missile 18 tiles a second over nine
  // tiles, bursting at the end, every 1.4 s; and every 1.2 s a tesla coil's arc web through
  // six points, each jump linked to the point two back.
  private shots(): void {
    const f = this.game.cur, x = this.fx(), y = this.y0;
    const tracer = (x0: number, y0: number, x1: number, y1: number, k: number) => {
      const i = f.nTracers++;
      f.tX0[i] = x0; f.tY0[i] = y0; f.tX1[i] = x1; f.tY1[i] = y1; f.tKind[i] = k;
    };
    const blast = (bx: number, by: number, r: number, k: number) => {
      const i = f.nBlasts++;
      f.bX[i] = bx; f.bY[i] = by; f.bR[i] = r; f.bKind[i] = k;
    };
    const m = this.tick % 28, step = 0.9;
    if (m < 10) tracer(x + m * step, y, x + (m + 1) * step, y, TRACER_NAPALM);
    else if (m === 10) { blast(x + 9, y, 1.5, BlastKind.Explosion); blast(x + 9, y, 1.5, BlastKind.Napalm); }
    if (this.tick % 24 === 0) {
      const pts = [[2, 4], [4.5, 3.5], [3.5, 6], [6.5, 5], [5.5, 7.5], [8.5, 6.5]].map(([dx, dy]) => [x + dx, y + dy]);
      tracer(x, y + 5, pts[0][0], pts[0][1], 16 + K_TESLA);
      for (let k = 1; k < pts.length; k++) {
        tracer(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], TRACER_ARC);
        if (k >= 2) tracer(pts[k - 2][0], pts[k - 2][1], pts[k][0], pts[k][1], TRACER_ARC);
      }
      blast(pts[pts.length - 1][0], pts[pts.length - 1][1], 0.8, BlastKind.Tesla);
    }
  }

  // A supply Huey held in its hover, its door gunner firing every other frame at a mark that
  // walks round it (a pause in each lap, to see the gun go back to rest), out on its right
  // side and round under its nose and tail.
  private huey(t: number, fresh: boolean): void {
    const f = this.game.cur, x = this.fx() + 22, y = this.y0 + 2.5;
    const e = f.nEffects++;
    f.eKind[e] = EffectKind.Drop; f.eX0[e] = x - 1; f.eY0[e] = y; f.eX[e] = x; f.eY[e] = y; f.eR[e] = 0;
    f.eLeft[e] = 30; f.eTotal[e] = 250;
    const lap = t % 9;
    if (!fresh || this.tick % 2 || lap > 7) return;
    const a = -2.6 + lap * 0.75, r = 6 + Math.sin(t * 1.7) * 2.5;
    const i = f.nTracers++;
    f.tX0[i] = x; f.tY0[i] = y; f.tX1[i] = x + Math.cos(a) * r; f.tY1[i] = y + Math.sin(a) * r; f.tKind[i] = TRACER_HELI;
  }
}
