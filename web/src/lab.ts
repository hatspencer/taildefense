import {
  Art, ART_TIME, BlastKind, CROWBAR, EffectKind, FISSURE_EVERY, GREAT, OWNED_BREAKER, OWNED_TEMPERED, TRACER_HELI, TRACER_SPLIT, TRACER_HOMERUN, TRACER_HOMERUN_ROUND, K_TESLA, KATANA, OWNED_DUAL, OWNED_DUAL_KATANA, TRACER_FLASH, TRACER_FOLLOW, TRACER_GREAT,
  TRACER_KATANA, TRACER_MOON, THROW_FLIGHT, K_SNIPER, TURRET_TRACKS, TRACER_ARC, TRACER_NAPALM, CX_AIR, CX_HELD, K_BAIT, K_CATAPULT, CF_ASLEEP, CF_BURNING, CF_GUARD, CF_STRIKE, CF_WINDUP, Emote, EvacStage, Order, PF_ALIVE, PF_CONNECTED, PF_FIRING, PF_HURT, PF_MOVING, PF_RELOADING, Player, RIFLE,
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
// hovering with its door gunner sweeping the ground around it. And ('sniper') the demo base's
// sniper tower made fully upgraded, its laser on a big creep pacing to and fro outside the wall
// and a round into it every 1.45 s, its fastest reload: the recoil, the blast and the laser
// coming back on. A survivor ('awm', h19) holds a fully bought Rifle, the AWM, firing it at its
// rate, holding still for three rounds at a time.
// Past that ('traps'), a bait pit and a catapult pit going off on a loop over a stream of creeps,
// with the state bits the host sends: the pit knotting eight walkers and letting them go, the
// catapult throwing three at a time back up the road. It takes the demo's world over after
// its first frame and stops it, then poses everything itself.
//
// 'art' is another thing: the reference line-up, held beside docs/artdirection.png. Nothing of
// the bench, only the picture's four survivors (paramedic, mechanic, hunter, student) in a row
// above five of the dead (walker, swarmer for the crawler, spitter for the grabber, brute,
// runner), standing at rest where the picture has them and turned as it turns them.
// &fig=0..8 looks at one of them. With `still` the bench's survivors stand at rest too
// instead of their poses, and `arch` (0..9) puts every one of them in that archetype's outfit.

const COLS = ['walk', 'idle', 'attack', 'hit', 'burn', 'sleep', 'die'] as const;

// A survivor's look from its parts (see scene/look.ts for the bits); no glasses.
const look = (arch: number, skin: number, body: number, style: number, hair: number, beard: number, build: number, height: number) =>
  (arch | skin << 4 | body << 7 | style << 9 | hair << 13 | beard << 16 | build << 18 | height << 20 | 1 << 22) >>> 0;
// The line-up's survivors: across (tiles from the middle), the player slot (its colour: teal,
// blue, orange, purple), the look and the way each faces (0 east, a quarter turn south, towards
// the camera).
const ART_LIVING: [number, number, number, number][] = [
  [-2.7, 5, look(0, 5, 0, 2, 0, 0, 1, 2), 0.6],
  [-1.0, 0, look(1, 4, 0, 2, 2, 1, 2, 2), 0.9],
  [0.8, 6, look(2, 5, 0, 3, 2, 2, 2, 2), 0.35],
  [2.7, 4, look(3, 5, 1, 1, 3, 0, 0, 1), 0.3],
];
// The dead below them: across, the creep kind, the way it faces.
const ART_DEAD: [number, number, number][] = [[-3.4, 0, 0.9], [-1.8, 2, 0.7], [-0.25, 4, 0.25], [1.6, 3, 1.3], [3.45, 1, 1.9]];
// The rows are this far apart on the ground, the dead nearer the camera.
const ART_ROWS = 3.05;
const DX = 3.2, DY = 3.6;
// The way #lab=traps's catapult faces: 3 eighths of a turn from east towards south.
const LAB_FACING = 3;

export class Lab {
  private x0: number; private y0: number;
  private t0 = performance.now();
  private tick = 0;
  private last = 0;
  // Player poses, by player slot.
  private poses = ['circle', 'sprint', 'loot', 'revive', 'reload', 'taunt', 'down', 'shoot', 'dual', 'thrown',
    'katana', 'katanas', 'flash', 'great', 'skyfall', 'evolved', 'homerun', 'bonebreaker', 'worldsplitter', 'awm'];
  // The swing counter each legendary pose last showed, to cut a tracer when it moves.
  private swung: number[] = [];
  // Worldsplitter's moments already sent (the cut, each burst, the detonation), by name, with
  // the cycle they were sent in.
  private split = new Map<string, number>();

  // gun, when 0 or more, puts that weapon in every survivor's hands (#lab=h&gun=6).
  // art: the reference line-up instead of the bench. still: survivors at rest, not posing.
  // fig: the one figure of the line-up to look at. arch: every survivor's archetype.
  constructor(private game: Game, cx: number, cy: number, private gun = -1, private art = false, private still = false, private fig = -1, private arch = -1) {
    this.x0 = cx - 3 * DX;
    this.y0 = cy + 9;
  }

  // The line-up's middle, between its two rows.
  private artAt(): [number, number] { return [this.x0 + 3 * DX, this.y0 + 4]; }
  // Where figure i of the line-up stands: 0..3 the survivors, 4..8 the dead.
  private artSpot(i: number): [number, number] {
    const [mx, my] = this.artAt();
    return i < ART_LIVING.length ? [mx + ART_LIVING[i][0], my - ART_ROWS / 2] : [mx + ART_DEAD[(i - ART_LIVING.length) % ART_DEAD.length][0], my + ART_ROWS / 2];
  }

  // The line-up for this moment: everyone standing where the picture has them.
  private stepArt(): void {
    const g = this.game, f = g.cur;
    f.nBlasts = 0; f.nTracers = 0; f.nDeaths = 0; f.nEffects = 0;
    ART_DEAD.forEach(([, kind, heading], n) => {
      const id = 100 + n, [x, y] = this.artSpot(ART_LIVING.length + n);
      f.cId[n] = id; f.cKind[n] = Math.min(kind, g.welcome!.creeps.length - 1); f.cFlags[n] = 0; f.cFx[n] = 0; f.cTarget[n] = 255; f.cHp[n] = 255;
      f.cX[n] = x; f.cY[n] = y; g.rx[n] = x; g.ry[n] = y; g.heading[id] = heading; g.indexById[id] = n;
    });
    f.nCreeps = ART_DEAD.length;
    while (f.players.length < 8) f.players.push(new Player());
    f.nPlayers = 8;
    for (let i = 0; i < 8; i++) {
      const p = f.players[i], who = ART_LIVING.findIndex((a) => a[1] === i);
      p.id = i; p.flags = 0; p.hp = 100; p.maxHp = 100; p.heal = 0;
      p.order = Order.Idle; p.channel = 0; p.emote = Emote.None; p.emoteLeft = 0; p.sprinting = false;
      p.held = false; p.airborne = false; p.stunned = false; p.owned = 0; p.evo.fill(0); p.art = Art.None; p.artFrac = 0; p.artCool = 0;
      if (who < 0) continue;
      const [x, y] = this.artSpot(who);
      p.look = ART_LIVING[who][2]; p.cur = this.gun >= 0 ? this.gun : who === 2 ? RIFLE : 0;
      p.flags = PF_CONNECTED | PF_ALIVE;
      p.x = x; p.y = y; p.aim = ART_LIVING[who][3];
      g.prx[i] = x; g.pry[i] = y; g.paim[i] = p.aim;
    }
  }

  // Where to look: the whole bench, or one creep row (0..10), or the survivors ('h'), or one
  // of them ('h0'..'h19'), or the crowbar's Home Run ('crowbar'), or Worldsplitter
  // ('worldsplitter'), or the turret shots ('fx').
  center(at = ''): [number, number] {
    if (this.art) return this.fig >= 0 ? this.artSpot(this.fig) : this.artAt();
    // One kind at rest: its idle column.
    if (/^k\d+$/.test(at)) return [this.x0 + DX, this.y0 + Number(at.slice(1)) * DY];
    if (at === 'fx') return [this.fx() + 4.5, this.y0 + 2.5];
    if (at === 'sniper') { const s = this.dressSniper(); if (s) return [s[0], s[1] - 3.5]; }
    if (at === 'awm') return this.spot(19);
    if (at === 'huey') return [this.fx() + 22, this.y0 - 2]; // north of it, as the Huey is up in the air
    if (at === 'structs') {
      // &fig=0..6 a turret, 7 the walls, 8 the generator, 9 the armory.
      const sx = Math.floor(this.x0), sy = Math.floor(this.y0) - 18, i = this.fig;
      this.structs();
      return i < 0 ? [sx + 11, sy + 3] : i < 7 ? [sx + i * 2 + 0.5, sy + 0.5] : ([[sx + 4.5, sy + 5], [sx + 16.5, sy + 1.5], [sx + 21.5, sy + 4.5]] as [number, number][])[i - 7];
    }
    if (at === 'traps') { const [bx, by] = this.trapsAt(); return [bx + 7, by]; }
    if (at === 'heli') { this.heli = true; return this.heliAt(); }
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
    if (i === 19) return [hx + 7.5 + 3.4, this.y0 + 3 * DY];
    if (i >= 16) return [hx + 7.5 + (i % 2) * 3.4, this.y0 + 2 * DY];
    return [hx + (i % 2) * 3.4, this.y0 + Math.floor(i / 2) * DY];
  }

  // The demo base's first sniper tower's centre, or null.
  private sniper(): [number, number] | null {
    const f = this.game.cur;
    for (let i = 0; i < f.nStructs; i++) if (f.sAlive[i] && f.sKind[i] === K_SNIPER) return [f.sX[i] + 0.5, f.sY[i] + 0.5];
    return null;
  }

  // Makes the demo base's sniper tower fully upgraded (every track at the top, evolved into
  // Anti-materiel); returns its centre.
  private dressSniper(): [number, number] | null {
    const g = this.game, f = g.cur, wd = g.welcome!;
    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sAlive[i] || f.sKind[i] !== K_SNIPER) continue;
      for (let t = 0; t < TURRET_TRACKS; t++) f.sLv[i * TURRET_TRACKS + t] = wd.maxLevel;
      f.sLevel[i] = 1 + wd.maxLevel * TURRET_TRACKS;
      f.sEvo[i] = 2;
      g.structsVersion++;
      return [f.sX[i] + 0.5, f.sY[i] + 0.5];
    }
    return null;
  }

  // The sniper's mark: the biggest kind of creep, pacing six tiles to and fro seven tiles north
  // of the tower, put in as creep n; returns the count with it.
  private sniperMark(t: number, n: number): number {
    const s = this.sniper(), g = this.game, f = g.cur, wd = g.welcome!;
    if (!s) return n;
    let k = 0;
    for (let i = 1; i < wd.creeps.length; i++) if (wd.creeps[i].hp > wd.creeps[k].hp) k = i;
    const u = (t % 8) / 8, along = u < 0.5 ? u * 2 : 2 - u * 2, id = 99;
    const x = s[0] - 3 + along * 6, y = s[1] - 7;
    f.cId[n] = id; f.cKind[n] = k; f.cFlags[n] = 0; f.cFx[n] = 0; f.cTarget[n] = 255; f.cHp[n] = 255;
    f.cX[n] = x; f.cY[n] = y; g.rx[n] = x; g.ry[n] = y; g.heading[id] = u < 0.5 ? 0 : Math.PI;
    g.indexById[id] = n;
    return n + 1;
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
    if (this.art) { this.stepArt(); return fresh; }
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
    n = this.sniperMark(t, n);
    n = this.traps(t, n);
    f.nCreeps = n;
    f.nBlasts = 0; f.nTracers = 0; f.nDeaths = 0; f.nEffects = 0;

    // The survivors, to the right of the creeps.
    while (f.players.length < this.poses.length) f.players.push(new Player());
    f.nPlayers = this.poses.length;
    for (let i = 0; i < this.poses.length; i++) {
      const p = f.players[i], pose = this.still ? 'rest' : this.poses[i];
      // Health varies so the portraits show their wounds; the sprinter has a medkit working.
      p.id = i; p.look = (i * 2654435761) >>> 0;
      if (this.arch >= 0) p.look = ((p.look & ~15) | (this.arch & 15)) >>> 0;
      p.cur = this.gun >= 0 ? this.gun : i % 6; p.hp = [80, 50, 55, 80, 22, 80, 0, 45, 70, 35, 90, 75, 60, 85, 65, 95, 70, 88, 100, 90][i]; p.maxHp = 100;
      p.heal = pose === 'sprint' ? 5 : 0;
      p.flags = PF_CONNECTED | PF_ALIVE; p.order = Order.Idle; p.channel = 0; p.emote = Emote.None; p.emoteLeft = 0; p.sprinting = false;
      p.held = false; p.airborne = false; p.stunned = false; p.owned = 0;
      p.evo.fill(0); p.art = Art.None; p.artFrac = 0; p.artCool = 0;
      let [x, y] = this.spot(i), aim = this.still ? 0.6 : Math.PI / 2;
      switch (pose) {
        case 'rest': break;
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
        case 'awm': {
          // The Rifle with all four tracks at the top, a round at its rate; it holds each
          // heading for three rounds, so the kick is not lost in a turn, then turns a step.
          p.cur = RIFLE; p.owned = 1 << RIFLE; p.levels.fill(0);
          for (let k = 0; k < 4; k++) p.levels[RIFLE * 4 + k] = wd.maxLevel;
          aim = Math.floor(t / 2) * 0.9; p.flags |= PF_FIRING;
          const n = Math.floor(t * 1.5);
          if (fresh && (this.swung[i] ?? -1) !== n) {
            this.swung[i] = n;
            const j = f.nTracers++;
            f.tX0[j] = x; f.tY0[j] = y; f.tX1[j] = x + Math.cos(aim) * 12; f.tY1[j] = y + Math.sin(aim) * 12; f.tKind[j] = RIFLE;
          }
          break;
        }
        default: [x, y, aim] = this.legend(p, pose, t, x, y, i, fresh); break;
      }
      g.prx[i] = x; g.pry[i] = y; g.paim[i] = aim;
      p.x = x; p.y = y; p.aim = aim;
    }
    if (fresh) this.shots();
    this.huey(t, fresh);
    if (this.heli) this.landed();
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
    // A round from the sniper into its mark every 29 frames (1.45 s at 20 Hz).
    const sn = this.sniper(), mk = this.game.indexById[99];
    if (sn && mk >= 0 && this.tick % 29 === 0) tracer(sn[0], sn[1], f.cX[mk], f.cY[mk], 16 + K_SNIPER);
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

  // #lab=structs: one of each building in a line-up north of the bench, turrets with some
  // tracks bought, a run of wall with a corner, a shut gate and an open one, the generator
  // and the armory; &hp=0..1 their health, &tier=1..3 the generator's tier.
  private structsUp = false;
  private structs(): void {
    if (this.structsUp) return;
    this.structsUp = true;
    const g = this.game, f = g.cur, P = new URLSearchParams(location.hash.slice(1)), sx = Math.floor(this.x0), sy = Math.floor(this.y0) - 18;
    const add = (k: number, x: number, y: number, w = 1, open = 0) => {
      const s = f.nStructs++;
      f.sAlive[s] = 1; f.sGhost[s] = 0; f.sKind[s] = k; f.sX[s] = x; f.sY[s] = y; f.sW[s] = w; f.sH[s] = w; f.sMaxHp[s] = 1000; f.sHp[s] = 1000 * Number(P.get('hp') ?? 1);
      f.sLevel[s] = 1; f.sOwner[s] = s % 3; f.sOpen[s] = open; f.sEvo[s] = 0; f.sTrap[s] = 0; f.sFacing[s] = 0;
      for (let t = 0; t < TURRET_TRACKS; t++) f.sLv[s * TURRET_TRACKS + t] = (s + t) % 4;
    };
    [K_GUN, K_CANNON, K_FROST, K_TESLA, K_SNIPER, K_MISSILE, K_PYLON].forEach((k, i) => add(k, sx + i * 2, sy));
    for (let i = 0; i < 9; i++) add(i === 3 || i === 6 ? K_GATE : K_WALL, sx + i, sy + 4, 1, i === 6 ? 1 : 0);
    for (let j = 1; j < 3; j++) add(K_WALL, sx + 8, sy + 4 + j);
    add(K_CORE, sx + 14, sy - 1, 5); add(K_ARMORY, sx + 20, sy + 3, 3);
    if (P.has('tier')) f.tier = Number(P.get('tier'));
    g.updateStructGrid();
  }

  // The bait pit's middle; the catapult pit's is 16 tiles on, the road running east through
  // both.
  private trapsAt(): [number, number] { return [Math.floor(this.fx() + 40) + 0.5, Math.floor(this.y0 + 2) + 0.5]; }
  private trapSlots: [number, number] | null = null;

  // #lab=heli: the evac Huey down on its pad, south of the hovering one, its door towards the
  // camera, with the first survivor standing by its cabin for scale.
  private heli = false;
  private heliAt(): [number, number] { return [this.fx() + 22, this.y0 + 19]; }
  private landed(): void {
    const g = this.game, f = g.cur, [x, y] = this.heliAt(), p = f.players[0];
    g.welcome!.evac ??= { pad: { x, y }, half: 3, reach: 3, board: 1, inbound: 60, flight: 20, settle: 4, wait: 90, last: 30, depart: 4, climb: 6 };
    f.evac = EvacStage.Landed; f.evacLeft = 60; f.evacX = x; f.evacY = y; f.evacAlt = 0; f.evacYaw = 0.3;
    p.x = g.prx[0] = x - 1.4; p.y = g.pry[0] = y + 2.6; p.aim = g.paim[0] = 1.2;
  }

  // The two traps and their creeps for this moment, from creep slot n: the slots after them.
  // The bait pit's cycle is 10 s: eight walkers come down the road, at 2 s it takes them all
  // into its knot for 4 s, then lets them walk on and recharges over 5 s. The catapult's is
  // 5 s: three creeps walk onto it, at 1.2 s its arm snaps up and throws them 0.9 s through
  // the air the way it faces (LAB_FACING, south-west), 6 to 10 tiles out and within 15
  // degrees of it, to spots that shift a little each round, where they lie stunned 1 s,
  // get up and walk on 1.5 s; it recharges over 3 s. Between rounds each creep is gone a
  // moment, marked hidden as fog of war marks one, so the page takes it out of sight, not
  // dead (a creep dropped from the frame otherwise falls as a corpse).
  private traps(t: number, n: number): number {
    const g = this.game, f = g.cur;
    const [bx, by] = this.trapsAt(), kx = bx + 16, ky = by;
    if (!this.trapSlots) {
      const i = f.nStructs;
      f.nStructs += 2;
      this.trapSlots = [i, i + 1];
      [[K_BAIT, bx], [K_CATAPULT, kx]].forEach(([k, x], j) => {
        const s = i + j;
        f.sAlive[s] = 1; f.sGhost[s] = 0; f.sKind[s] = k; f.sX[s] = x - 1.5; f.sY[s] = by - 1.5; f.sW[s] = 3; f.sH[s] = 3;
        f.sHp[s] = 300; f.sMaxHp[s] = 300; f.sLevel[s] = 1; f.sOwner[s] = 0; f.sOpen[s] = 0; f.sEvo[s] = 0; f.sTrap[s] = 0;
        f.sFacing[s] = k === K_CATAPULT ? LAB_FACING : 0;
      });
      g.updateStructGrid();
    }
    const [bs, ks] = this.trapSlots;
    const shown = new Set<number>();
    const put = (id: number, kind: number, x: number, y: number, heading: number, fx: number, hp = 255) => {
      shown.add(id);
      f.cId[n] = id; f.cKind[n] = kind; f.cFlags[n] = 0; f.cFx[n] = fx; f.cTarget[n] = 255; f.cHp[n] = hp;
      f.cX[n] = x; f.cY[n] = y; g.rx[n] = x; g.ry[n] = y; g.heading[id] = heading; g.indexById[id] = n;
      n++;
    };
    // The bait pit.
    const u = t % 10, v = 1.5;
    const held = u >= 2 && u < 6;
    if (held) f.sTrap[bs] = 1;
    else { const since = u >= 6 ? u - 6 : u + 4; f.sTrap[bs] = (since >= 5 ? 15 : Math.min(14, Math.floor(since / 5 * 15))) << 1; }
    if (u < 9.5) for (let k = 0; k < 8; k++) {
      const id = 4000 + k, sx = bx - 10 + k * 1.3, sy = by + ((k % 3) - 1) * 0.5;
      const a = id * 2.399963, r = 0.9 * Math.sqrt((id * 0.618) % 1);
      const nx = bx + Math.cos(a) * r, ny = by + Math.sin(a) * r, gx = sx + 2 * v;
      if (u < 2) put(id, 0, sx + v * u, sy, 0, 0);
      else if (held) { const s = Math.min(1, (u - 2) / 0.7); put(id, 0, gx + (nx - gx) * s, sy + (ny - sy) * s, Math.atan2(ny - sy, nx - gx), CX_HELD); }
      else put(id, 0, nx + v * (u - 6), ny, 0, 0);
    }
    // The catapult pit.
    const c = t % 5, air = 0.9, at = 1.2, stun = 1, cyc = Math.floor(t / 5);
    if (c >= at && c < at + 0.45) f.sTrap[ks] = 1;
    else { const since = (c - at + 5) % 5; f.sTrap[ks] = (since >= 3 ? 15 : Math.min(14, Math.floor(since / 3 * 15))) << 1; }
    if (c < at + air + stun + 1.5) for (let k = 0; k < 3; k++) {
      const id = 4100 + k, kind = [0, 1, 2][k];
      const x0 = kx - 4 + k * 0.5 + 2.6 * Math.min(c, at), y0 = ky + (k - 1) * 0.7;
      const j = (((cyc * 7 + k * 3) % 5) - 2) * 0.5;
      const a = LAB_FACING * Math.PI / 4 + (k - 1) * 0.17 + j * 0.08, d = 6.6 + 1.2 * k + j;
      const lx = kx + Math.cos(a) * d, ly = ky + Math.sin(a) * d;
      if (c < at) put(id, kind, x0, y0, 0, 0);
      else if (c < at + air) { const s = (c - at) / air; put(id, kind, x0 + (lx - x0) * s, y0 + (ly - y0) * s, a, CX_AIR); }
      else if (c < at + air + stun) put(id, kind, lx, ly, a, 0, 166);
      else put(id, kind, lx + 1.5 * (c - at - air - stun), ly, 0, 0, 166);
    }
    for (const id of [4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4100, 4101, 4102]) {
      if (!shown.has(id)) { g.hiddenAt[id] = g.frames; g.indexById[id] = -1; }
    }
    return n;
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
