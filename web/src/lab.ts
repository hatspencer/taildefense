import {
  BlastKind, K_TESLA, OWNED_DUAL, THROW_FLIGHT, TRACER_ARC, TRACER_NAPALM, CF_ASLEEP, CF_BURNING, CF_GUARD, CF_STRIKE, CF_WINDUP, Emote, Order, PF_ALIVE, PF_CONNECTED, PF_FIRING, PF_HURT, PF_MOVING, PF_RELOADING, Player,
} from './protocol';
import type { Game } from './state';

// #lab: the animation bench. Each creep kind in a row, one column per state (walking back and
// forth, idle, attacking, hit, burning, asleep, dying), and the survivors beside them, each
// showing a pose: walking a circle while aiming one way (so strafing and backpedalling show),
// sprinting, kneeling to search and to revive, reloading, taunting and down, firing dual
// pistols, and caught and thrown by a mauler, each at its own health so the HUD's portraits
// show every state. Past them, the turret evolutions' shots ('fx'): a napalm missile flying
// and bursting, and an arc web striking a knot of points. It takes the demo's world over after
// its first frame and stops it, then poses everything itself.

const COLS = ['walk', 'idle', 'attack', 'hit', 'burn', 'sleep', 'die'] as const;
const DX = 3.2, DY = 3.6;

export class Lab {
  private x0: number; private y0: number;
  private t0 = performance.now();
  private tick = 0;
  private last = 0;
  // Player poses, by player slot.
  private poses = ['circle', 'sprint', 'loot', 'revive', 'reload', 'taunt', 'down', 'shoot', 'dual', 'thrown'];

  // gun, when 0 or more, puts that weapon in every survivor's hands (#lab=h&gun=6).
  constructor(private game: Game, cx: number, cy: number, private gun = -1) {
    this.x0 = cx - 3 * DX;
    this.y0 = cy + 9;
  }

  // Where to look: the whole bench, or one creep row (0..10), or the survivors ('h'), or one
  // of them ('h0'..'h9'), or the turret shots ('fx').
  center(at = ''): [number, number] {
    if (at === 'fx') return [this.fx() + 4.5, this.y0 + 2.5];
    if (/^h\d$/.test(at)) { const i = Number(at[1]); return [this.x0 + COLS.length * DX + 2.5 + (i % 2) * 3.4, this.y0 + Math.floor(i / 2) * DY]; }
    if (at === 'h') return [this.x0 + COLS.length * DX + 4.2, this.y0 + 1.5 * DY];
    if (at !== '') return [this.x0 + 3 * DX, this.y0 + Number(at) * DY];
    return [this.x0 + 3 * DX + 3, this.y0 + 2.5 * DY];
  }

  // The left edge of the turret shots, past the survivors.
  private fx(): number { return this.x0 + COLS.length * DX + 11; }

  // Poses everything for this moment, and reports whether a new frame came with it: its
  // tracers and blasts are the turret shots, for the effects to spawn.
  step(now: number): boolean {
    const g = this.game, f = g.cur, wd = g.welcome!;
    const t = (now - this.t0) / 1000;
    // A new frame 20 times a second, for what keys off frames (the dead).
    let fresh = false;
    if (now - this.last >= 50) { this.last = now; g.frames++; this.tick++; fresh = true; }
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
    f.nBlasts = 0; f.nTracers = 0; f.nDeaths = 0;

    // The survivors, to the right of the creeps.
    const hx = this.x0 + COLS.length * DX + 2.5;
    while (f.players.length < this.poses.length) f.players.push(new Player());
    f.nPlayers = this.poses.length;
    for (let i = 0; i < this.poses.length; i++) {
      const p = f.players[i], pose = this.poses[i];
      // Health varies so the portraits show their wounds; the sprinter has a medkit working.
      p.id = i; p.look = (i * 2654435761) >>> 0; p.cur = this.gun >= 0 ? this.gun : i % 6; p.hp = [80, 50, 55, 80, 22, 80, 0, 45, 70, 35][i]; p.maxHp = 100;
      p.heal = pose === 'sprint' ? 5 : 0;
      p.flags = PF_CONNECTED | PF_ALIVE; p.order = Order.Idle; p.channel = 0; p.emote = Emote.None; p.emoteLeft = 0; p.sprinting = false;
      p.held = false; p.airborne = false; p.stunned = false; p.owned = 0;
      let x = hx + (i % 2) * 3.4, y = this.y0 + Math.floor(i / 2) * DY, aim = Math.PI / 2;
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
      }
      g.prx[i] = x; g.pry[i] = y; g.paim[i] = aim;
      p.x = x; p.y = y; p.aim = aim;
    }
    if (fresh) this.shots();
    return fresh;
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
}
