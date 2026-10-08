// An in-browser stand-in for the game host. It runs a small simulation, encodes real
// protocol frames and feeds them through the same dispatch and decoder as the WebSocket,
// so demo mode exercises the real parsing path.
import { dispatch, type Handlers, type Transport } from '../net';
import {
  type Command, MAX_CREEPS, Tile, Phase, Order, PF_ALIVE, PF_ARMORY, PF_CONNECTED, PF_FIRING,
  PF_HURT, PF_MOVING, PF_READY, PF_RELOADING, CF_BURNING, CF_SLOWED, type Welcome,
} from '../protocol';
import { ABILITY_RADIUS, CREEPS, STRUCTS, WEAPON_BASE, demoWelcome } from './defs';
import { Writer } from './encode';
import { generateMap, rng } from './map';

export interface DemoOptions { creeps: number; phase: 'wave' | 'build' | 'over'; wave: number; gold: number }

const W = 320, H = 200, DT = 0.05;

interface DPlayer {
  id: number; name: string; bot: boolean; x: number; y: number; aim: number; hp: number; maxHp: number;
  cur: number; ammo: number; reloadLeft: number; respawn: number; gold: number; kills: number; damage: number;
  owned: number; levels: Uint8Array; gear: Uint8Array; order: number; tx: number; ty: number; target: number;
  buildKind: number; repairId: number; buff: number; buffLeft: number; abLevel: number[]; abCool: number[];
  ready: boolean; fireCd: number; shot: number; hurt: number; moving: boolean; wander: number;
}
interface DStruct { alive: boolean; kind: number; x: number; y: number; w: number; h: number; hp: number; maxHp: number; level: number; owner: number; cd: number }
interface DEffect { kind: number; x0: number; y0: number; x: number; y: number; r: number; left: number; total: number; owner: number; dmg: number }

export class DemoHost implements Transport {
  private wr = new Writer();
  private rnd = rng(7);
  private welcome: Welcome;
  private tiles: Uint8Array;
  private spawns: { x: number; y: number }[];
  private ring: { x0: number; y0: number; x1: number; y1: number };
  private timer = 0;
  private statusTimer = 0;
  private tick = 0;
  private phase = Phase.Wave;
  private wave = 7;
  private phaseLeft = 300;
  private pending = 0;
  private totalKills = 0;
  private best = 0;
  private target: number;

  private players: DPlayer[] = [];
  private structs: DStruct[] = [];
  private effects: DEffect[] = [];
  private notes: { level: number; text: string }[] = [];

  // Creeps, by id.
  private cAlive = new Uint8Array(MAX_CREEPS);
  private cKind = new Uint8Array(MAX_CREEPS);
  private cX = new Float32Array(MAX_CREEPS);
  private cY = new Float32Array(MAX_CREEPS);
  private cHp = new Float32Array(MAX_CREEPS);
  private cMax = new Float32Array(MAX_CREEPS);
  private cBurn = new Float32Array(MAX_CREEPS);
  private cSlow = new Float32Array(MAX_CREEPS);
  private cRespawn = new Float32Array(MAX_CREEPS);
  private cOffX = new Float32Array(MAX_CREEPS);
  private cOffY = new Float32Array(MAX_CREEPS);
  private bosses = 0;

  // Per-tick events.
  private tr: number[] = [];
  private bl: number[] = [];
  private de: number[] = [];

  // Flow field towards the core.
  private next = new Int32Array(W * H);
  private occ = new Int32Array(W * H);

  // Spatial hash of live creeps, cells of 8 tiles.
  private gw = Math.ceil(W / 8);
  private gh = Math.ceil(H / 8);
  private cellStart = new Int32Array(this.gw * this.gh + 1);
  private cellItems = new Int32Array(MAX_CREEPS);
  private q = new Int32Array(MAX_CREEPS);

  constructor(private h: Handlers, private opt: DemoOptions) {
    this.target = Math.min(opt.creeps, MAX_CREEPS - 1);
    this.welcome = demoWelcome(W, H);
    const m = generateMap(W, H, 424242);
    this.tiles = m.tiles; this.spawns = m.spawns; this.ring = m.ring;
    this.welcome.core = { x: W / 2 + 0.5, y: H / 2 + 0.5 };
    this.reset();
    h.onConn('connecting');
    // Asynchronous like a socket, so the client finishes its own setup first.
    setTimeout(() => this.start(), 30);
  }

  private start(): void {
    this.h.onConn('open');
    dispatch(this.h, JSON.stringify(this.welcome));
    const terr = new Uint8Array(1 + W * H);
    terr[0] = 2; terr.set(this.tiles, 1);
    dispatch(this.h, terr.buffer);
    this.step();
    this.clock = performance.now();
    this.timer = window.setInterval(() => this.pump(), 50);
  }

  // Runs the 20 Hz simulation on wall time. Called from a timer and from the render loop,
  // because background or headless pages throttle timers.
  private clock = 0;
  pump(): void {
    if (!this.timer) return;
    const now = performance.now();
    let n = 0;
    while (now - this.clock >= 50 && n++ < 4) { this.clock += 50; this.step(); }
    if (now - this.clock > 200) this.clock = now;
  }

  private reset(): void {
    const cx = W / 2, cy = H / 2, r = this.ring;
    this.structs = [];
    this.addStruct(1, cx - 1, cy - 1, -1);
    this.addStruct(2, cx + 4, cy - 6, -1);
    const gate = (x: number, y: number) =>
      ((y === r.y0 || y === r.y1) && Math.abs(x - cx) <= 1) || ((x === r.x0 || x === r.x1) && Math.abs(y - cy) <= 1);
    for (let x = r.x0; x <= r.x1; x++) for (const y of [r.y0, r.y1]) this.addStruct(gate(x, y) ? 4 : 3, x, y, -1);
    for (let y = r.y0 + 1; y < r.y1; y++) for (const x of [r.x0, r.x1]) this.addStruct(gate(x, y) ? 4 : 3, x, y, -1);
    const t = (k: number, x: number, y: number, lvl: number, owner = -1) => { const s = this.addStruct(k, x, y, owner); s.level = lvl; };
    t(5, r.x0 + 2, r.y0 + 2, 2); t(5, r.x1 - 2, r.y0 + 2, 1); t(5, r.x0 + 2, r.y1 - 2, 1); t(5, r.x1 - 2, r.y1 - 2, 3);
    t(6, cx - 4, r.y0 + 2, 1); t(6, cx + 4, r.y1 - 2, 2); t(6, r.x0 + 2, cy + 4, 1, 0);
    t(7, r.x0 + 3, cy - 3, 1); t(7, r.x1 - 3, cy + 3, 2);
    t(8, cx + 4, r.y0 + 2, 1); t(8, cx - 4, r.y1 - 2, 4, 1);
    // A broken wall to show damage bars.
    this.structs[5].hp = 140;
    this.rebuildFlow();

    this.players = [];
    this.addPlayer(0, 'you', false, cx + 6, cy - 2, 0);
    this.addPlayer(1, 'mira', true, r.x0 + 3, cy + 1, 2);
    this.addPlayer(2, 'kofi', true, cx + 1, r.y1 - 3, 3);
    const me = this.players[0];
    me.gold = this.opt.gold; me.owned = 0b1000101; me.levels[0] = 2; me.levels[1] = 1; me.levels[8] = 1;
    me.abLevel = [1, 1, 1, 0];

    this.cAlive.fill(0);
    this.effects = [];
    this.wave = this.opt.wave;
    this.totalKills = 1234;
    this.bosses = 0;
    if (this.opt.phase === 'build') { this.phase = Phase.Build; this.phaseLeft = 300; this.pending = 0; }
    else {
      this.phase = Phase.Wave;
      this.pending = this.target * 2;
      for (let id = 0; id < this.target; id++) this.spawnCreep(id, true);
    }
    if (this.opt.phase === 'over') { this.phase = Phase.Over; this.best = this.wave - 1; }
  }

  private addStruct(kind: number, x: number, y: number, owner: number): DStruct {
    const d = STRUCTS[kind];
    const s: DStruct = { alive: true, kind, x, y, w: d.w, h: d.h, hp: d.hp, maxHp: d.hp, level: 1, owner, cd: this.rnd() };
    // Reuse a dead slot so ids stay small, the way the host keeps them stable.
    const i = this.structs.findIndex((o) => !o.alive);
    if (i >= 0) this.structs[i] = s; else this.structs.push(s);
    return s;
  }

  private addPlayer(id: number, name: string, bot: boolean, x: number, y: number, cur: number): void {
    const p: DPlayer = {
      id, name, bot, x, y, aim: 0, hp: 100, maxHp: 100, cur, ammo: WEAPON_BASE[cur].mag, reloadLeft: 0, respawn: 0,
      gold: 400 + id * 150, kills: 40 + id * 17, damage: 9000 + id * 2100, owned: 1 | (1 << cur),
      levels: new Uint8Array(28), gear: new Uint8Array(3), order: Order.Idle, tx: x, ty: y, target: -1, buildKind: 0,
      repairId: -1, buff: 0, buffLeft: 0, abLevel: [1, 0, 0, 0], abCool: [0, 0, 0, 0], ready: bot, fireCd: 0, shot: 0, hurt: 0,
      moving: false, wander: 2 + id,
    };
    p.levels[cur * 4] = 2;
    this.players.push(p);
  }

  // --- terrain and pathing ---

  private blocked(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= W || y >= H) return true;
    const i = y * W + x;
    if (this.tiles[i] >= Tile.Water) return true;
    const s = this.occ[i];
    return s > 0 && this.structs[s - 1].kind !== 4;
  }

  private rebuildFlow(): void {
    const occ = this.occ;
    occ.fill(0);
    this.structs.forEach((s, i) => {
      if (!s.alive) return;
      for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) occ[y * W + x] = i + 1;
    });
    const dist = new Float32Array(W * H).fill(Infinity);
    const heap: number[] = [];
    const push = (i: number, d: number) => {
      dist[i] = d; heap.push(i);
      let k = heap.length - 1;
      while (k > 0) { const p = (k - 1) >> 1; if (dist[heap[p]] <= dist[heap[k]]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
    };
    const pop = (): number => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last; let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1; let m = k;
          if (l < heap.length && dist[heap[l]] < dist[heap[m]]) m = l;
          if (r < heap.length && dist[heap[r]] < dist[heap[m]]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
        }
      }
      return top;
    };
    const core = this.structs[0];
    for (let y = core.y - 1; y <= core.y + core.h; y++) for (let x = core.x - 1; x <= core.x + core.w; x++) {
      if (!this.blocked(x, y)) push(y * W + x, 0);
    }
    const done = new Uint8Array(W * H);
    while (heap.length) {
      const i = pop();
      if (done[i]) continue;
      done[i] = 1;
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (this.blocked(nx, ny)) continue;
        if (dx && dy && (this.blocked(x + dx, y) || this.blocked(x, y + dy))) continue;
        const j = ny * W + nx;
        const tl = this.tiles[j];
        const c = (tl === Tile.Dirt || tl === Tile.Floor ? 1 : 2.4) * (dx && dy ? 1.414 : 1);
        if (dist[i] + c < dist[j]) push(j, dist[i] + c);
      }
    }
    // Each tile points at its cheapest neighbour.
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let best = -1, bd = dist[i];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((!dx && !dy) || this.blocked(nx, ny)) continue;
        if (dx && dy && (this.blocked(x + dx, y) || this.blocked(x, y + dy))) continue;
        const j = ny * W + nx;
        if (dist[j] < bd) { bd = dist[j]; best = j; }
      }
      this.next[i] = best;
    }
  }

  // --- creeps ---

  private pickKind(): number {
    const r = this.rnd();
    if (r < 0.002 && this.bosses < 3) { this.bosses++; return 5; }
    if (r < 0.06) return 3;
    if (r < 0.12) return 4;
    if (r < 0.37) return 2;
    if (r < 0.57) return 1;
    return 0;
  }

  private spawnCreep(id: number, prefill: boolean): void {
    const k = this.pickKind();
    const sp = this.spawns[Math.floor(this.rnd() * this.spawns.length)];
    let x = sp.x + (this.rnd() - 0.5) * 3, y = sp.y + (this.rnd() - 0.5) * 3;
    x = Math.min(W - 0.6, Math.max(0.6, x)); y = Math.min(H - 0.6, Math.max(0.6, y));
    this.cOffX[id] = (this.rnd() - 0.5) * 1.4; this.cOffY[id] = (this.rnd() - 0.5) * 1.4;
    if (prefill) {
      // Walk the flow field a random distance so the map starts full.
      const steps = Math.floor(this.rnd() * 230);
      let i = Math.floor(y) * W + Math.floor(x);
      for (let s = 0; s < steps && this.next[i] >= 0; s++) i = this.next[i];
      x = (i % W) + 0.5 + this.cOffX[id] * 0.4; y = ((i / W) | 0) + 0.5 + this.cOffY[id] * 0.4;
    }
    this.cAlive[id] = 1; this.cKind[id] = k; this.cX[id] = x; this.cY[id] = y;
    const hp = CREEPS[k].hp * (1 + 0.14 * (this.wave - 1));
    this.cHp[id] = hp; this.cMax[id] = hp; this.cBurn[id] = 0; this.cSlow[id] = 0;
    if (prefill && this.rnd() < 0.3) this.cHp[id] = hp * (0.2 + this.rnd() * 0.8);
  }

  private kill(id: number, by: DPlayer | null, bounty: boolean): void {
    if (!this.cAlive[id]) return;
    this.cAlive[id] = 0;
    if (this.cKind[id] === 5) this.bosses--;
    this.de.push(this.cX[id], this.cY[id], this.cKind[id]);
    if (bounty) {
      this.totalKills++;
      if (by) { by.kills++; by.gold += CREEPS[this.cKind[id]].bounty; }
    }
    this.cRespawn[id] = this.pending > 0 ? 0.5 + this.rnd() * 3 : -1;
  }

  private hurt(id: number, dmg: number, by: DPlayer | null): void {
    if (!this.cAlive[id]) return;
    const k = this.cKind[id];
    const d = Math.max(1, dmg - (k === 3 ? 4 : k === 5 ? 9 : 0));
    this.cHp[id] -= d;
    if (by) by.damage += d;
    if (this.cHp[id] <= 0) this.kill(id, by, true);
  }

  private buildGrid(): void {
    const cs = this.cellStart, gw = this.gw;
    cs.fill(0);
    for (let id = 0; id < MAX_CREEPS; id++) {
      if (!this.cAlive[id]) continue;
      cs[Math.min(this.gh - 1, (this.cY[id] / 8) | 0) * gw + Math.min(gw - 1, (this.cX[id] / 8) | 0) + 1]++;
    }
    for (let i = 1; i < cs.length; i++) cs[i] += cs[i - 1];
    const fill = this.q;
    for (let i = 0; i < cs.length - 1; i++) fill[i] = cs[i];
    for (let id = 0; id < MAX_CREEPS; id++) {
      if (!this.cAlive[id]) continue;
      const c = Math.min(this.gh - 1, (this.cY[id] / 8) | 0) * gw + Math.min(gw - 1, (this.cX[id] / 8) | 0);
      this.cellItems[fill[c]++] = id;
    }
  }

  // Ids of live creeps within r of (x, y), into out; returns the count.
  private query(x: number, y: number, r: number, out: Int32Array, max = out.length): number {
    const gw = this.gw;
    const x0 = Math.max(0, ((x - r) / 8) | 0), x1 = Math.min(gw - 1, ((x + r) / 8) | 0);
    const y0 = Math.max(0, ((y - r) / 8) | 0), y1 = Math.min(this.gh - 1, ((y + r) / 8) | 0);
    let n = 0;
    const r2 = r * r;
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const c = cy * gw + cx;
      for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
        const id = this.cellItems[k];
        if (!this.cAlive[id]) continue;
        const dx = this.cX[id] - x, dy = this.cY[id] - y;
        if (dx * dx + dy * dy <= r2) { out[n++] = id; if (n >= max) return n; }
      }
    }
    return n;
  }

  private nearest(x: number, y: number, r: number): number {
    const qn = this.q;
    const n = this.query(x, y, r, qn, 400);
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const id = qn[i], d = (this.cX[id] - x) ** 2 + (this.cY[id] - y) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  private moveCreeps(): void {
    const core = this.structs[0];
    const ccx = core.x + 1.5, ccy = core.y + 1.5;
    for (let id = 0; id < MAX_CREEPS; id++) {
      if (!this.cAlive[id]) {
        if (this.cRespawn[id] > 0) {
          this.cRespawn[id] -= DT;
          if (this.cRespawn[id] <= 0 && this.pending > 0 && this.phase === Phase.Wave) { this.pending--; this.spawnCreep(id, false); }
        }
        continue;
      }
      const k = this.cKind[id];
      let sp = CREEPS[k].speed * DT;
      if (this.cSlow[id] > 0) { sp *= 0.5; this.cSlow[id] -= DT; }
      if (this.cBurn[id] > 0) { this.cBurn[id] -= DT; this.hurt(id, 8 * DT, null); if (!this.cAlive[id]) continue; }
      let x = this.cX[id], y = this.cY[id];
      const tx = Math.floor(x), ty = Math.floor(y);
      const n = this.next[ty * W + tx];
      let gx: number, gy: number;
      if (n >= 0) { gx = (n % W) + 0.5 + this.cOffX[id] * 0.3; gy = ((n / W) | 0) + 0.5 + this.cOffY[id] * 0.3; }
      else { gx = ccx; gy = ccy; }
      const dx = gx - x, dy = gy - y, d = Math.hypot(dx, dy) || 1;
      x += (dx / d) * sp; y += (dy / d) * sp;
      this.cX[id] = x; this.cY[id] = y;
      if (Math.hypot(x - ccx, y - ccy) < 2.6 + CREEPS[k].radius) {
        core.hp = Math.max(1, core.hp - (k === 5 ? 40 : 2));
        this.kill(id, null, false);
      }
    }
  }

  // --- players ---

  private tracer(x0: number, y0: number, x1: number, y1: number, kind: number): void { this.tr.push(x0, y0, x1, y1, kind); }

  private fire(p: DPlayer, target: number): void {
    const w = WEAPON_BASE[p.cur];
    const tx = this.cX[target], ty = this.cY[target];
    p.aim = Math.atan2(ty - p.y, tx - p.x);
    const mx = p.x + Math.cos(p.aim) * 0.6, my = p.y + Math.sin(p.aim) * 0.6;
    const dmg = w.dmg * (1 + 0.22 * p.levels[p.cur * 4]) * (p.buff === 5 ? 1.5 : 1);
    if (w.fire === 'cone') {
      const pellets = p.cur === 1 ? 7 : 2;
      for (let i = 0; i < pellets; i++) {
        const a = p.aim + (this.rnd() - 0.5) * (p.cur === 1 ? 0.6 : 0.7);
        const r = w.range * (0.6 + this.rnd() * 0.4);
        this.tracer(mx, my, p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, p.cur);
      }
      const ids = this.q, n = this.query(tx, ty, p.cur === 1 ? 1.5 : 2, ids, 12);
      for (let i = 0; i < n; i++) { if (p.cur === 4) this.cBurn[ids[i]] = 3; this.hurt(ids[i], dmg, p); }
    } else if (w.fire === 'rocket') {
      this.tracer(mx, my, tx, ty, p.cur);
      this.blast(tx, ty, 3, 0, dmg, p);
    } else {
      const sx = (this.rnd() - 0.5) * 0.4, sy = (this.rnd() - 0.5) * 0.4;
      this.tracer(mx, my, tx + sx, ty + sy, p.cur);
      this.hurt(target, dmg, p);
    }
    p.ammo--;
    p.shot = 0.2;
    p.fireCd += 1 / (w.rate * (1 + 0.13 * p.levels[p.cur * 4 + 1]) * (p.buff === 2 ? 2 : 1));
    if (p.ammo <= 0) p.reloadLeft = w.reload;
  }

  private blast(x: number, y: number, r: number, kind: number, dmg: number, by: DPlayer | null): void {
    this.bl.push(x, y, r, kind);
    if (dmg <= 0) return;
    const ids = this.q, n = this.query(x, y, r, ids, 2000);
    for (let i = 0; i < n; i++) {
      if (kind === 1) this.cSlow[ids[i]] = 1.6;
      this.hurt(ids[i], dmg, by);
    }
  }

  private toast(text: string): void { dispatch(this.h, JSON.stringify({ t: 'toast', level: 2, text })); }

  private armory(): DStruct { return this.structs[1]; }
  private atArmory(p: DPlayer): boolean {
    const a = this.armory();
    return Math.hypot(p.x - (a.x + 1), p.y - (a.y + 1)) <= this.welcome.shopRadius;
  }

  private walk(p: DPlayer, tx: number, ty: number, stopAt: number): boolean {
    const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
    if (d <= stopAt) { p.moving = false; return true; }
    const sp = Math.min(d, 4.2 * (1 + 0.08 * p.gear[1]) * DT);
    const nx = p.x + (dx / d) * sp, ny = p.y + (dy / d) * sp;
    const ok = (x: number, y: number) => {
      const i = Math.floor(y) * W + Math.floor(x);
      return !(this.tiles[i] >= Tile.Water || (this.occ[i] > 0 && this.structs[this.occ[i] - 1].kind !== 4));
    };
    if (ok(nx, ny)) { p.x = nx; p.y = ny; }
    else if (ok(nx, p.y)) p.x = nx;
    else if (ok(p.x, ny)) p.y = ny;
    p.aim = Math.atan2(dy, dx);
    p.moving = true;
    return false;
  }

  private stepPlayer(p: DPlayer): void {
    if (p.hp <= 0) {
      p.respawn -= DT;
      if (p.respawn <= 0) { const c = this.structs[0]; p.hp = p.maxHp; p.x = c.x + 4.5; p.y = c.y + 1.5; p.order = Order.Idle; }
      return;
    }
    p.hurt = Math.max(0, p.hurt - DT);
    p.shot = Math.max(0, p.shot - DT);
    for (let i = 0; i < 4; i++) p.abCool[i] = Math.max(0, p.abCool[i] - DT);
    if (p.buffLeft > 0) { p.buffLeft -= DT; if (p.buffLeft <= 0) p.buff = 0; }
    p.hp = Math.min(p.maxHp, p.hp + (0.3 + 1.5 * p.gear[2]) * DT);
    if (p.bot) {
      p.wander -= DT;
      if (p.wander <= 0) {
        p.wander = 4 + this.rnd() * 6;
        const r = this.ring;
        p.order = Order.AMove;
        p.tx = r.x0 + 2 + this.rnd() * (r.x1 - r.x0 - 4); p.ty = r.y0 + 2 + this.rnd() * (r.y1 - r.y0 - 4);
      }
    }
    const w = WEAPON_BASE[p.cur];
    p.moving = false;
    let target = -1;
    switch (p.order) {
      case Order.Move:
        if (this.walk(p, p.tx, p.ty, 0.15)) p.order = Order.Idle;
        break;
      case Order.Attack:
        if (!this.cAlive[p.target]) { p.order = Order.Idle; break; }
        if (Math.hypot(this.cX[p.target] - p.x, this.cY[p.target] - p.y) > w.range * 0.95) this.walk(p, this.cX[p.target], this.cY[p.target], 0);
        else target = p.target;
        break;
      case Order.Build: {
        const d = STRUCTS[p.buildKind];
        if (this.walk(p, p.tx + d.w / 2, p.ty + d.h / 2, 2.2)) {
          p.order = Order.Idle;
          const err = this.canBuild(p, p.buildKind, p.tx, p.ty);
          if (err) this.toast(err);
          else { p.gold -= d.price; this.addStruct(p.buildKind, p.tx, p.ty, p.id); this.rebuildFlow(); }
        }
        break;
      }
      case Order.Repair: {
        const s = this.structs[p.repairId];
        if (!s || !s.alive || s.hp >= s.maxHp) { p.order = Order.Idle; break; }
        if (this.walk(p, s.x + s.w / 2, s.y + s.h / 2, 1.6 + s.w / 2)) {
          const hp = Math.min(s.maxHp - s.hp, 60 * DT), cost = hp * this.welcome.repairCostPerHP;
          if (p.gold < cost) { this.toast('not enough gold to repair'); p.order = Order.Idle; break; }
          p.gold -= cost; s.hp += hp;
        }
        break;
      }
    }
    if (target < 0 && p.order !== Order.Move && p.order !== Order.Build && p.order !== Order.Repair) {
      target = this.nearest(p.x, p.y, w.range);
    }
    if (p.order === Order.AMove) {
      if (target < 0 && this.walk(p, p.tx, p.ty, 0.2)) p.order = Order.Idle;
    }
    if (p.reloadLeft > 0) {
      p.reloadLeft -= DT;
      if (p.reloadLeft <= 0) { p.reloadLeft = 0; p.ammo = this.mag(p); }
    }
    p.fireCd = Math.max(p.fireCd - DT, target >= 0 ? -DT : 0);
    if (target >= 0 && p.reloadLeft <= 0) {
      while (p.fireCd <= 0 && p.ammo > 0 && this.cAlive[target]) this.fire(p, target);
    }
    // Creeps bite whoever stands among them.
    const ids = this.q, n = this.query(p.x, p.y, 0.9, ids, 8);
    // The demo's own hero is tougher so a screenshot does not open on a death screen.
    if (n > 0) { p.hp -= n * (p.bot ? 6 : 1.5) * DT; p.hurt = 0.3; }
    else if (p.hurt <= 0) p.hp = Math.min(p.maxHp, p.hp + 2 * DT);
    if (p.hp <= 0) { p.hp = 0; p.respawn = 10; this.notes.push({ level: 2, text: `${p.name} died` }); }
  }

  private mag(p: DPlayer): number { return Math.round(WEAPON_BASE[p.cur].mag * (1 + 0.25 * p.levels[p.cur * 4 + 2])); }

  private canBuild(p: DPlayer, kind: number, tx: number, ty: number): string {
    const d = STRUCTS[kind];
    if (!d || !this.welcome.buildable.includes(kind)) return 'cannot build that';
    if (p.gold < d.price) return `not enough gold: need ${d.price}, have ${Math.floor(p.gold)}`;
    const c = this.welcome.core;
    if (Math.hypot(tx + d.w / 2 - c.x, ty + d.h / 2 - c.y) > this.welcome.buildRadius) return 'too far from the generator';
    for (let y = ty; y < ty + d.h; y++) for (let x = tx; x < tx + d.w; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H || this.tiles[y * W + x] >= Tile.Water) return 'blocked';
      if (this.occ[y * W + x]) return 'something is already built there';
    }
    return '';
  }

  // --- turrets ---

  private stepStructs(): void {
    for (const s of this.structs) {
      if (!s.alive) continue;
      const d = STRUCTS[s.kind];
      if (!d.turret) continue;
      s.cd -= DT;
      if (s.cd > 0) continue;
      const cx = s.x + 0.5, cy = s.y + 0.5, lv = s.level - 1;
      const range = d.range * (1 + 0.08 * lv);
      const t = this.nearest(cx, cy, range);
      if (t < 0) { s.cd = 0.1; continue; }
      const rate = [0, 0, 0, 0, 0, 4, 0.7, 1, 1.2][s.kind] * (1 + 0.1 * lv);
      s.cd += 1 / rate;
      const dmg = [0, 0, 0, 0, 0, 11, 60, 3, 32][s.kind] * (1 + 0.4 * lv);
      if (s.kind === 7) { this.blast(cx, cy, range, 1, dmg, null); continue; }
      this.tracer(cx, cy, this.cX[t], this.cY[t], 16 + s.kind);
      if (s.kind === 6) this.blast(this.cX[t], this.cY[t], 2.2, 0, dmg, null);
      else if (s.kind === 8) {
        let px = this.cX[t], py = this.cY[t], cur = t;
        this.bl.push(px, py, 0.8, 2);
        for (let c = 0; c < 4; c++) {
          this.hurt(cur, dmg, null);
          cur = this.nearestExcept(px, py, 4, cur);
          if (cur < 0) break;
          this.tracer(px, py, this.cX[cur], this.cY[cur], 16 + 8);
          px = this.cX[cur]; py = this.cY[cur];
        }
      } else this.hurt(t, dmg, null);
    }
    // Spitters spit at whatever is close.
    if (this.tick % 3 === 0) {
      for (const p of this.players) {
        if (p.hp <= 0) continue;
        const ids = this.q, n = this.query(p.x, p.y, 6, ids, 64);
        for (let i = 0; i < n; i++) if (this.cKind[ids[i]] === 4 && this.rnd() < 0.15) {
          this.tracer(this.cX[ids[i]], this.cY[ids[i]], p.x, p.y, 32); p.hp -= p.bot ? 3 : 1; p.hurt = 0.3;
        }
      }
    }
  }

  private nearestExcept(x: number, y: number, r: number, not: number): number {
    const ids = this.q, n = this.query(x, y, r, ids, 32);
    for (let i = 0; i < n; i++) if (ids[i] !== not && this.rnd() < 0.7) return ids[i];
    return -1;
  }

  // --- abilities and lasting effects ---

  private cast(p: DPlayer, slot: number, x: number, y: number): void {
    if (p.hp <= 0) return;
    const lvl = p.abLevel[slot];
    if (lvl <= 0) { this.toast('ability not learned yet'); return; }
    if (p.abCool[slot] > 0) { this.toast(`not ready: ${p.abCool[slot].toFixed(1)}s`); return; }
    const a = this.welcome.abilities[slot];
    const sig = this.welcome.weapons[p.cur].sig;
    const range = slot === 0 ? sig.range : a.range;
    const d = Math.hypot(x - p.x, y - p.y);
    if (range > 0 && d > range + 0.5) { this.toast('out of range'); return; }
    p.aim = Math.atan2(y - p.y, x - p.x);
    p.abCool[slot] = slot === 0 ? sig.cool : a.cool[lvl - 1];
    if (slot === 1) this.effects.push({ kind: 1, x0: p.x, y0: p.y, x, y, r: ABILITY_RADIUS[1], left: 8, total: 8, owner: p.id, dmg: 120 });
    else if (slot === 2) {
      // Dash: a quick hop towards the point, stopping short of anything solid.
      const sx = p.x, sy = p.y, n = Math.ceil(d / 0.25);
      for (let i = 1; i <= n; i++) {
        const nx = sx + (x - sx) * (i / n), ny = sy + (y - sy) * (i / n), t = Math.floor(ny) * W + Math.floor(nx);
        if (this.tiles[t] >= Tile.Water || (this.occ[t] > 0 && this.structs[this.occ[t] - 1].kind !== 4)) break;
        p.x = nx; p.y = ny;
      }
      p.moving = false; p.order = Order.Idle;
    }
    else if (slot === 3) this.effects.push({ kind: 3, x0: x, y0: y, x, y, r: ABILITY_RADIUS[3], left: 30, total: 30, owner: p.id, dmg: 400 });
    else {
      switch (p.cur) {
        case 0: for (let i = 0; i < 6; i++) { const t = this.nearest(x, y, 3); if (t >= 0) this.fire(p, t); } p.fireCd = 0; break;
        case 1: this.blast(p.x + Math.cos(p.aim) * 2.5, p.y + Math.sin(p.aim) * 2.5, 4, 3, 40, p); break;
        case 3: this.tracer(p.x, p.y, p.x + Math.cos(p.aim) * 40, p.y + Math.sin(p.aim) * 40, 3); break;
        case 4: this.effects.push({ kind: 2, x0: x, y0: y, x, y, r: 2.5, left: 50, total: 50, owner: p.id, dmg: 0 }); break;
        case 6: for (let i = 0; i < 4; i++) this.blast(x + (this.rnd() - 0.5) * 6, y + (this.rnd() - 0.5) * 6, 3, 0, 120, p); break;
        default: p.buff = p.cur; p.buffLeft = 6;
      }
    }
  }

  private stepEffects(): void {
    const keep: DEffect[] = [];
    for (const e of this.effects) {
      const by = this.players[e.owner] ?? null;
      if (e.kind === 2 && this.tick % 4 === 0) {
        const ids = this.q, n = this.query(e.x, e.y, e.r, ids, 500);
        for (let i = 0; i < n; i++) this.cBurn[ids[i]] = 2;
      }
      if (this.tick % 2 === 0) e.left--;
      if (e.left > 0) { keep.push(e); continue; }
      if (e.kind === 1) this.blast(e.x, e.y, e.r, 0, e.dmg, by);
      if (e.kind === 3) {
        for (let i = 0; i < 7; i++) {
          const a = this.rnd() * 6.28, r = Math.sqrt(this.rnd()) * e.r * 0.8;
          this.blast(e.x + Math.cos(a) * r, e.y + Math.sin(a) * r, 3, 4, e.dmg, by);
        }
      }
    }
    this.effects = keep;
  }

  // --- the wave cycle ---

  private stepPhase(): void {
    if (this.phase === Phase.Over) return;
    if (this.phase === Phase.Build) {
      const humans = this.players.filter((p) => !p.bot);
      if (humans.every((p) => p.ready) && this.phaseLeft > 30) this.phaseLeft = 30;
      if (this.tick % 2 === 0) this.phaseLeft--;
      if (this.phaseLeft <= 0) {
        this.wave++;
        this.phase = Phase.Wave;
        this.pending = this.target * 2;
        this.notes.push({ level: 2, text: `Wave ${this.wave} is coming` });
        for (let id = 0; id < this.target; id++) this.cRespawn[id] = 0.05 + this.rnd() * 6;
        for (const p of this.players) p.ready = p.bot;
      }
      return;
    }
    if (this.pending === 0) {
      let any = false;
      for (let id = 0; id < MAX_CREEPS; id++) if (this.cAlive[id]) { any = true; break; }
      if (!any) {
        this.phase = Phase.Build; this.phaseLeft = 450;
        this.notes.push({ level: 1, text: `Wave ${this.wave} cleared` });
        for (const p of this.players) p.gold += 100 + this.wave * 20;
      }
    }
    if (this.structs[0].hp <= 1 && this.rnd() < 0.001) {
      this.phase = Phase.Over; this.best = this.wave - 1;
      this.notes.push({ level: 2, text: 'The generator was destroyed' });
    }
  }

  private step(): void {
    this.tick++;
    this.tr.length = 0; this.bl.length = 0; this.de.length = 0;
    this.stepPhase();
    if (this.phase !== Phase.Over) {
      this.buildGrid();
      this.moveCreeps();
      for (const p of this.players) this.stepPlayer(p);
      this.stepStructs();
      this.stepEffects();
    }
    dispatch(this.h, this.encode());
    this.notes.length = 0;
    if (--this.statusTimer <= 0) {
      this.statusTimer = 40;
      const n = this.cAlive.reduce((a, b) => a + b, 0);
      dispatch(this.h, JSON.stringify({ t: 'status', text: `demo · 3/8 players · ${n} creeps` }));
    }
  }

  private encode(): ArrayBuffer {
    const w = this.wr;
    w.reset();
    w.u8(1); w.u32(this.tick); w.u8(this.phase); w.u16(this.wave); w.u16(Math.max(0, this.phaseLeft));
    w.u32(this.pending); w.u32(this.totalKills); w.u16(this.best);
    w.u8(this.players.length);
    for (const p of this.players) {
      const alive = p.hp > 0;
      let f = PF_CONNECTED;
      if (alive) f |= PF_ALIVE;
      if (alive && p.shot > 0) f |= PF_FIRING;
      if (p.ready) f |= PF_READY;
      if (p.reloadLeft > 0) f |= PF_RELOADING;
      if (p.hurt > 0) f |= PF_HURT;
      if (alive && this.atArmory(p)) f |= PF_ARMORY;
      if (p.moving) f |= PF_MOVING;
      w.u8(p.id); w.u8(f); w.q8(p.x); w.q8(p.y);
      w.u16((((p.aim / (Math.PI * 2)) % 1 + 1) % 1) * 65536 % 65536);
      w.u16(Math.ceil(p.hp)); w.u16(p.maxHp); w.u8(p.cur); w.u16(p.ammo); w.u16(this.mag(p));
      w.u8(p.reloadLeft > 0 ? Math.min(255, (p.reloadLeft / WEAPON_BASE[p.cur].reload) * 255) : 0);
      w.u8(Math.ceil(Math.max(0, p.respawn)));
      w.u32(p.gold); w.u32(p.kills); w.u32(p.damage); w.u8(p.owned);
      w.bytes(p.levels); w.bytes(p.gear);
      w.u8(p.order); w.u8(p.buff); w.u8(Math.max(0, p.buffLeft * 10));
      for (let a = 0; a < 4; a++) { w.u8(p.abLevel[a]); w.u16(p.abCool[a] * 10); }
      w.str8(p.name);
    }
    w.u16(this.structs.length);
    for (const s of this.structs) {
      w.u8(s.alive ? 1 : 0); w.u8(s.kind); w.u16(s.x); w.u16(s.y); w.u8(s.w); w.u8(s.h);
      w.u16(s.hp); w.u16(s.maxHp); w.u8(s.level); w.i8(s.owner);
    }
    let n = 0;
    for (let id = 0; id < MAX_CREEPS; id++) n += this.cAlive[id];
    w.u16(n);
    for (let id = 0; id < MAX_CREEPS; id++) {
      if (!this.cAlive[id]) continue;
      w.u16(id); w.q8(this.cX[id]); w.q8(this.cY[id]); w.u8(this.cKind[id]);
      w.u8(Math.max(1, Math.min(255, (this.cHp[id] / this.cMax[id]) * 255)));
      w.u8((this.cBurn[id] > 0 ? CF_BURNING : 0) | (this.cSlow[id] > 0 ? CF_SLOWED : 0)); w.u8(0);
    }
    const tr = this.tr;
    w.u16(tr.length / 5);
    for (let i = 0; i < tr.length; i += 5) { w.q8(tr[i]); w.q8(tr[i + 1]); w.q8(tr[i + 2]); w.q8(tr[i + 3]); w.u8(tr[i + 4]); }
    const bl = this.bl;
    w.u16(bl.length / 4);
    for (let i = 0; i < bl.length; i += 4) { w.q8(bl[i]); w.q8(bl[i + 1]); w.u8(Math.min(255, bl[i + 2] * 8)); w.u8(bl[i + 3]); }
    const de = this.de;
    w.u16(de.length / 3);
    for (let i = 0; i < de.length; i += 3) { w.q8(de[i]); w.q8(de[i + 1]); w.u8(de[i + 2]); }
    w.u16(this.effects.length);
    for (const e of this.effects) {
      w.u8(e.kind); w.q8(e.x0); w.q8(e.y0); w.q8(e.x); w.q8(e.y); w.u8(e.r * 8); w.u8(e.left); w.u8(e.total);
    }
    w.u8(this.notes.length);
    for (const nt of this.notes) { w.u8(nt.level); w.str16(nt.text); }
    return w.take();
  }

  // --- commands ---

  send(cmd: Command): void {
    const p = this.players[0];
    const wd = this.welcome;
    switch (cmd.op) {
      case 'move': p.order = Order.Move; p.tx = cmd.x; p.ty = cmd.y; break;
      case 'amove': p.order = Order.AMove; p.tx = cmd.x; p.ty = cmd.y; break;
      case 'attack': if (this.cAlive[cmd.id]) { p.order = Order.Attack; p.target = cmd.id; } break;
      case 'stop': p.order = Order.Idle; break;
      case 'hold': p.order = Order.Hold; break;
      case 'reload': if (p.ammo < this.mag(p) && p.reloadLeft <= 0) p.reloadLeft = WEAPON_BASE[p.cur].reload; break;
      case 'ability': this.cast(p, cmd.slot, cmd.x, cmd.y); break;
      case 'build': {
        const err = this.canBuild(p, cmd.kind, cmd.tx, cmd.ty);
        if (err) { this.toast(err); break; }
        p.order = Order.Build; p.buildKind = cmd.kind; p.tx = cmd.tx; p.ty = cmd.ty;
        break;
      }
      case 'repair': p.order = Order.Repair; p.repairId = cmd.s; break;
      case 'upgradeStruct': {
        const s = this.structs[cmd.s];
        if (!s || !s.alive || !STRUCTS[s.kind].turret) { this.toast('cannot upgrade that'); break; }
        if (s.level >= wd.maxStructLevel) { this.toast('already at max level'); break; }
        const c = STRUCTS[s.kind].upgrade[s.level];
        if (p.gold < c) { this.toast(`not enough gold: need ${c}, have ${p.gold}`); break; }
        p.gold -= c; s.level++; s.maxHp = Math.round(STRUCTS[s.kind].hp * (1 + 0.25 * (s.level - 1))); s.hp = s.maxHp;
        break;
      }
      case 'sell': {
        const s = this.structs[cmd.s];
        if (!s || !s.alive || s.kind <= 2) { this.toast('cannot sell that'); break; }
        p.gold += Math.floor(STRUCTS[s.kind].price / 2); s.alive = false; this.rebuildFlow();
        break;
      }
      case 'buyWeapon': {
        if (!this.atArmory(p)) { this.toast('walk to the armory first'); break; }
        const w = wd.weapons[cmd.w];
        if (!w || p.owned & (1 << cmd.w)) break;
        if (p.gold < w.price) { this.toast(`not enough gold: need ${w.price}, have ${p.gold}`); break; }
        p.gold -= w.price; p.owned |= 1 << cmd.w;
        this.notes.push({ level: 0, text: `${p.name} bought the ${w.name}` });
        break;
      }
      case 'upgrade': {
        if (!this.atArmory(p)) { this.toast('walk to the armory first'); break; }
        const l = p.levels[cmd.w * 4 + cmd.track];
        if (l >= wd.maxLevel) break;
        const c = wd.weapons[cmd.w].costs[cmd.track][l];
        if (p.gold < c) { this.toast(`not enough gold: need ${c}, have ${p.gold}`); break; }
        p.gold -= c; p.levels[cmd.w * 4 + cmd.track]++;
        break;
      }
      case 'gear': {
        if (!this.atArmory(p)) { this.toast('walk to the armory first'); break; }
        const l = p.gear[cmd.g];
        if (l >= wd.maxLevel) break;
        const c = wd.gear[cmd.g].costs[l];
        if (p.gold < c) { this.toast(`not enough gold: need ${c}, have ${p.gold}`); break; }
        p.gold -= c; p.gear[cmd.g]++;
        if (cmd.g === 0) { p.maxHp += 25; p.hp += 25; }
        break;
      }
      case 'buyAbility': {
        if (!this.atArmory(p)) { this.toast('walk to the armory first'); break; }
        const l = p.abLevel[cmd.slot];
        if (cmd.slot === 0 || l >= 3) break;
        const c = wd.abilities[cmd.slot].costs[l];
        if (p.gold < c) { this.toast(`not enough gold: need ${c}, have ${p.gold}`); break; }
        p.gold -= c; p.abLevel[cmd.slot]++;
        break;
      }
      case 'select':
        if (p.owned & (1 << cmd.w) && p.cur !== cmd.w) { p.cur = cmd.w; p.ammo = this.mag(p); p.reloadLeft = 0; }
        break;
      case 'ready': p.ready = cmd.on; break;
      case 'chat': this.notes.push({ level: 0, text: `${p.name}: ${cmd.text}` }); break;
      case 'restart':
        if (this.phase === Phase.Over) { this.opt.phase = 'build'; this.reset(); dispatch(this.h, JSON.stringify(this.welcome)); const t = new Uint8Array(1 + W * H); t[0] = 2; t.set(this.tiles, 1); dispatch(this.h, t.buffer); }
        else this.toast('restart only once the game is over');
        break;
      case 'leave':
        dispatch(this.h, JSON.stringify({ t: 'end', reason: 'you left the demo' }));
        this.close();
        break;
    }
  }

  close(): void { clearInterval(this.timer); this.timer = 0; }
}
