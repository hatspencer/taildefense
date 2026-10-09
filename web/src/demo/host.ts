// An in-browser stand-in for the game host. It runs a small simulation, encodes real
// protocol frames and feeds them through the same dispatch and decoder as the WebSocket,
// so demo mode exercises the real parsing path.
import { dispatch, type Handlers, type Transport } from '../net';
import {
  type Command, MAX_CREEPS, Tile, Phase, Order, PF_ALIVE, PF_ARMORY, PF_CONNECTED, PF_FIRING,
  PF_HURT, PF_MOVING, PF_READY, PF_RELOADING, CF_BURNING, CF_SLOWED, CF_GUARD, CF_HUNTING, CF_SIEGE, CF_ASLEEP,
  CF_WINDUP, CF_STRIKE,
  BlastKind, EffectKind, Emote, type SiteDef, SiteKind, TRACER_HELI, Weather, type Welcome,
} from '../protocol';
import { ABILITY_RADIUS, CREEPS, STRUCTS, WEAPON_BASE, WEATHERS, demoWelcome } from './defs';
import { Writer } from './encode';
import { type DemoMap, generateMap, rng } from './map';

// weather: a fixed kind, or -1 to cycle. down: a teammate starts downed. coreHp: the generator's share of hp.
export interface DemoOptions { creeps: number; phase: 'wave' | 'build' | 'over'; wave: number; gold: number; weather?: number; down?: boolean; coreHp?: number; drop?: boolean }

// How much each weather counts as rain, as the host's wetness.
const WET = [0, 0, 1, 1, 0, 0.3, 0.5, 0];
const SNOWY = [0, 0, 0, 0, 0.4, 0, 0, 1];
// Guard creeps take the top ids, clear of the wave's.
const GUARD_ID0 = 16000;
// Guard states.
const G_ASLEEP = 1, G_HUNT = 2, G_HOME = 3;
// Swing states, as the host's: in reach, the blow wound up, the blow landing this tick.
const S_READY = 1, S_WINDUP = 2, S_STRIKE = 3;
// Per kind: reach beyond the creep's radius (internal/game/defs.go), blows a second, windup,
// and how hard a blow lands on a survivor relative to a walker's.
const REACH = [0.5, 0.5, 0.4, 0.6, 6, 0.8];
const RATE = CREEPS.map((c) => c.rate ?? 1), WINDUP = CREEPS.map((c) => c.windup ?? 0.4);
const HEFT = [1, 1, 0.7, 2.5, 1, 5];
// A creep's blow on a structure, as the host's.
const SDMG = [6, 4, 2, 39, 9, 105];

const W = 320, H = 200, DT = 0.05;

interface DPlayer {
  id: number; name: string; bot: boolean; x: number; y: number; aim: number; hp: number; maxHp: number;
  cur: number; ammo: number; reloadLeft: number; respawn: number; gold: number; kills: number; damage: number;
  owned: number; levels: Uint8Array; gear: Uint8Array; order: number; tx: number; ty: number; target: number;
  buildKind: number; repairId: number; buff: number; buffLeft: number; abLevel: number[]; abCool: number[];
  ready: boolean; fireCd: number; shot: number; hurt: number; harm: number; moving: boolean; wander: number;
  site: number; searchT: number; revTarget: number; channel: number; emoteLeft: number; tauntCool: number; downT: number; look: number;
  medkits: number; heal: number; steerX: number; steerY: number; steerLeft: number;
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
  private crates: { x: number; y: number; open: number }[] = [];
  private notes: { level: number; text: string }[] = [];
  private pings: { player: number; x: number; y: number; kind: number }[] = [];
  private sites: SiteDef[] = [];
  private searched = new Uint8Array(0);
  private guardIds: number[][] = [];
  private paused = -1;
  private weather = 0; private weatherAmt = 0; private nextWeather = 0; private weatherT = 0; private boltT = 2;

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
  // Guards: the site (-1 for wave creeps), state and home. Any creep can be hunting a player.
  private cSite = new Int16Array(MAX_CREEPS).fill(-1);
  private cState = new Uint8Array(MAX_CREEPS);
  private cHomeX = new Float32Array(MAX_CREEPS);
  private cHomeY = new Float32Array(MAX_CREEPS);
  private cHunt = new Uint8Array(MAX_CREEPS).fill(255);
  private cHuntT = new Float32Array(MAX_CREEPS);
  // Attacking: cooldown to the next blow, this tick's and last tick's swing, the target byte
  // while on a structure (128 + angle, else 255), blows dealt to it, and time it ignores structures.
  private cCool = new Float32Array(MAX_CREEPS);
  private cSwing = new Uint8Array(MAX_CREEPS);
  private cSwung = new Uint8Array(MAX_CREEPS);
  private cFace = new Uint8Array(MAX_CREEPS).fill(255);
  private cBlows = new Uint8Array(MAX_CREEPS);
  private cCalm = new Float32Array(MAX_CREEPS);
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
    this.target = Math.min(opt.creeps, GUARD_ID0);
    this.welcome = demoWelcome(W, H);
    const m = generateMap(W, H, 424242);
    this.tiles = m.tiles; this.spawns = m.spawns; this.ring = m.ring;
    this.welcome.core = { x: W / 2 + 0.5, y: H / 2 + 0.5 };
    this.sites = this.placeSites(m);
    this.welcome.sites = this.sites;
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

  // Stops the simulation where it is, for the lab to take the world over.
  halt(): void { window.clearInterval(this.timer); this.timer = 0; }

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
    this.addStruct(1, cx - 2, cy - 2, -1);
    this.addStruct(2, cx + 6, cy - 1, -1);
    const gate = (x: number, y: number) =>
      ((y === r.y0 || y === r.y1) && Math.abs(x - cx) <= 1) || ((x === r.x0 || x === r.x1) && Math.abs(y - cy) <= 1);
    for (let x = r.x0; x <= r.x1; x++) for (const y of [r.y0, r.y1]) this.addStruct(gate(x, y) ? 4 : 3, x, y, -1);
    for (let y = r.y0 + 1; y < r.y1; y++) for (const x of [r.x0, r.x1]) this.addStruct(gate(x, y) ? 4 : 3, x, y, -1);
    const t = (k: number, x: number, y: number, lvl: number, owner = -1) => { const s = this.addStruct(k, x, y, owner); s.level = lvl; };
    // The base's own four turrets, then some the players built.
    t(5, cx - 3, cy - 12, 1); t(5, cx + 3, cy + 12, 1); t(5, cx - 12, cy + 3, 1); t(5, cx + 12, cy - 3, 1);
    t(6, r.x0 + 2, r.y0 + 2, 2, 0); t(7, r.x1 - 2, r.y0 + 2, 1, 1); t(8, r.x0 + 2, r.y1 - 2, 3, 2); t(5, r.x1 - 2, r.y1 - 2, 3, 0);
    t(6, cx + 6, r.y0 + 3, 1, 1); t(8, cx - 7, r.y1 - 3, 4, 1); t(7, r.x0 + 4, cy - 5, 2, 2);
    // A broken wall to show damage bars, and the generator as the options say.
    this.structs[5].hp = 140;
    const core = this.structs[0];
    core.hp = Math.max(1, Math.round(core.maxHp * Math.min(1, this.opt.coreHp ?? 1)));
    this.rebuildFlow();

    this.players = [];
    this.addPlayer(0, 'you', false, cx + 5, cy + 4, 0);
    this.addPlayer(1, 'mira', true, r.x0 + 3, cy + 1, 2);
    this.addPlayer(2, 'kofi', true, cx + 1, r.y1 - 3, 3);
    const me = this.players[0];
    me.gold = this.opt.gold; me.owned = 0b1000101; me.levels[0] = 2; me.levels[1] = 1; me.levels[8] = 1;
    me.abLevel = [1, 1, 1, 0];

    // A few sites start picked over, to show both states.
    this.searched = new Uint8Array(this.sites.length);
    for (let i = 0; i < this.sites.length; i++) this.searched[i] = i % 4 === 3 ? 1 : 0;

    this.cAlive.fill(0);
    this.cSite.fill(-1); this.cHunt.fill(255); this.cHuntT.fill(0); this.cState.fill(0);
    this.spawnGuards();
    if (this.opt.down) { const k = this.players[2]; k.hp = 0; k.respawn = 25; k.downT = 0; k.x = cx + 3; k.y = cy + 6; }
    this.weather = this.opt.weather !== undefined && this.opt.weather >= 0 ? this.opt.weather : 0;
    this.weatherAmt = this.weather ? 1 : 0; this.nextWeather = this.weather; this.weatherT = 30;
    this.effects = [];
    this.crates = [];
    if (this.opt.drop) this.callDrop();
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
      levels: new Uint8Array(28), gear: new Uint8Array(4), order: Order.Idle, tx: x, ty: y, target: -1, buildKind: 0,
      repairId: -1, buff: 0, buffLeft: 0, abLevel: [1, 0, 0, 0], abCool: [0, 0, 0, 0], ready: bot, fireCd: 0, shot: 0, hurt: 0, harm: 0,
      moving: false, wander: 2 + id, site: -1, searchT: 0, revTarget: -1, channel: 0, emoteLeft: 0, tauntCool: 0, downT: 0, medkits: 1, heal: 0, steerX: 0, steerY: 0, steerLeft: 0,
      // A random survivor, a different outfit for each.
      look: ((Math.floor(this.rnd() * 0x10000000) << 4) | (id * 3 % 10)) >>> 0,
    };
    p.levels[cur * 4] = 2;
    this.players.push(p);
  }

  // --- loot sites ---

  // Sites the host would make: the map's ruined houses, cars along the roads, crates in the open.
  private placeSites(m: DemoMap): SiteDef[] {
    const cx = W / 2, cy = H / 2, r = rng(99);
    const sites: SiteDef[] = [];
    const tier = (x: number, y: number) => { const d = Math.hypot(x - cx, y - cy); return d < 50 ? 0 : d < 85 ? 1 : 2; };
    for (const h of m.houses) {
      const sx = Math.floor(h.x + h.w / 2) + 0.5, sy = Math.floor(h.y + h.h / 2) + 0.5;
      if (this.tiles[Math.floor(sy) * W + Math.floor(sx)] >= Tile.Water) continue;
      const tr = tier(sx, sy);
      sites.push({ kind: SiteKind.House, x: h.x, y: h.y, w: h.w, h: h.h, sx, sy, tier: tr, guard: Math.min(3, tr + (r() < 0.35 ? 1 : 0)) });
    }
    const free = (x: number, y: number) => sites.every((s) => Math.hypot(s.x + s.w / 2 - x - 0.5, s.y + s.h / 2 - y - 0.5) > s.w / 2 + 5);
    const scatter = (kind: number, want: number, tile: number, minD: number) => {
      for (let n = 0, tries = 0; n < want && tries < 20000; tries++) {
        const x = 2 + Math.floor(r() * (W - 4)), y = 2 + Math.floor(r() * (H - 4));
        const d = Math.hypot(x - cx, (y - cy) * 1.3);
        if (d < minD || this.tiles[y * W + x] !== tile || !free(x, y)) continue;
        const tr = tier(x, y);
        // Wrecks come in kinds: the plain car most, the army truck only far out.
        const k = kind !== SiteKind.Car ? kind : [SiteKind.Car, SiteKind.Car, SiteKind.Pickup, SiteKind.Police, SiteKind.Ambulance, SiteKind.Bus, tr === 2 ? SiteKind.Army : SiteKind.Car][Math.floor(r() * 7)];
        sites.push({ kind: k, x, y, w: 1, h: 1, sx: x + 0.5, sy: y + 0.5, tier: tr, guard: r() < 0.3 ? 0 : Math.min(2, tr) });
        n++;
      }
    };
    scatter(SiteKind.Car, 4, Tile.Dirt, 20);
    scatter(SiteKind.Car, 10, Tile.Dirt, 34);
    scatter(SiteKind.Crate, 4, Tile.Grass, 20);
    scatter(SiteKind.Crate, 8, Tile.Grass, 34);
    return sites;
  }

  // Guards sleep around their sites from the start: more and tougher the higher the site's guard.
  private spawnGuards(): void {
    this.guardIds = this.sites.map(() => []);
    let id = GUARD_ID0;
    const r = rng(5);
    for (let i = 0; i < this.sites.length && id < MAX_CREEPS; i++) {
      const s = this.sites[i], n = [0, 2, 4, 7][s.guard] ?? 0;
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      for (let k = 0; k < n && id < MAX_CREEPS; k++) {
        let x = cx, y = cy;
        for (let tries = 0; tries < 12; tries++) {
          const a = r() * 6.28, d = (s.kind === SiteKind.House ? Math.max(s.w, s.h) / 2 + 0.8 : 1.4) + r() * 2.2;
          x = cx + Math.cos(a) * d; y = cy + Math.sin(a) * d;
          if (!this.blocked(Math.floor(x), Math.floor(y))) break;
        }
        const kind = s.guard >= 3 && k === 0 ? 3 : s.guard >= 2 && k % 3 === 1 ? (k === 1 ? 4 : 1) : r() < 0.3 ? 2 : 0;
        const hp = CREEPS[kind].hp * (1 + 0.4 * s.guard);
        this.cAlive[id] = 1; this.cKind[id] = kind; this.cX[id] = x; this.cY[id] = y; this.cHp[id] = hp; this.cMax[id] = hp;
        this.cBurn[id] = 0; this.cSlow[id] = 0; this.cRespawn[id] = -1; this.fresh(id);
        this.cSite[id] = i; this.cState[id] = G_ASLEEP; this.cHomeX[id] = x; this.cHomeY[id] = y;
        this.guardIds[i].push(id++);
      }
    }
  }

  private guardsLeft(site: number): number {
    let n = 0;
    for (const id of this.guardIds[site] ?? []) n += this.cAlive[id];
    return n;
  }

  // A site's sleeping guards wake and go for the nearest survivor.
  private wakeSite(site: number): void {
    for (const id of this.guardIds[site] ?? []) {
      if (!this.cAlive[id] || this.cState[id] === G_HUNT) continue;
      let best = 255, bd = Infinity;
      for (const p of this.players) {
        if (p.hp <= 0) continue;
        const d = Math.hypot(p.x - this.cX[id], p.y - this.cY[id]);
        if (d < bd) { bd = d; best = p.id; }
      }
      if (best === 255) continue;
      if (this.cState[id] === G_ASLEEP) this.bl.push(this.cX[id], this.cY[id], 1, BlastKind.GuardsWake);
      this.cState[id] = G_HUNT; this.cHunt[id] = best; this.cHuntT[id] = 1e9;
    }
  }

  // Walking to a site and searching it; true while the order goes on.
  private stepLoot(p: DPlayer): boolean {
    const s = this.sites[p.site];
    if (!s || this.searched[p.site]) return false;
    if (this.guardsLeft(p.site) > 0) { this.toast(`guarded: kill its ${this.guardsLeft(p.site)} guards first`); return false; }
    const kind = this.welcome.siteKinds[s.kind];
    const reach = s.kind === SiteKind.House ? 0.3 : 1.2;
    const ox = p.x, oy = p.y;
    if (!this.walk(p, s.sx, s.sy, reach)) {
      // The demo has no pathfinding: squeeze through a ruin's wall rather than stick to it.
      if (p.x === ox && p.y === oy) {
        const d = Math.hypot(s.sx - p.x, s.sy - p.y), sp = Math.min(d, 4.2 * DT);
        p.x += (s.sx - p.x) / d * sp; p.y += (s.sy - p.y) / d * sp;
      }
      p.searchT = 0;
      return true;
    }
    if (p.hurt > 0.2 && p.searchT > 0) { this.toast('search interrupted'); p.searchT = 0; return false; }
    p.searchT += DT;
    if (p.searchT < kind.search) return true;
    this.searched[p.site] = 1;
    const x = s.x + s.w / 2, y = s.y + s.h / 2, name = kind.name.toLowerCase();
    if (s.kind === SiteKind.House && this.rnd() < 0.2) {
      this.bl.push(x, y, 2, 6);
      this.notes.push({ level: 2, text: `${p.name} woke a nest in a ${name}` });
      for (let id = 0, n = 0; id < MAX_CREEPS && n < 5; id++) {
        if (this.cAlive[id] || this.cRespawn[id] > 0) continue;
        const hp = CREEPS[0].hp * (1 + 0.14 * (this.wave - 1));
        this.cAlive[id] = 1; this.cKind[id] = 0; this.cHp[id] = hp; this.cMax[id] = hp; this.cBurn[id] = 0; this.cSlow[id] = 0;
        this.cX[id] = x + (this.rnd() - 0.5) * (s.w - 2); this.cY[id] = y + (this.rnd() - 0.5) * (s.h - 2);
        this.cOffX[id] = (this.rnd() - 0.5) * 1.4; this.cOffY[id] = (this.rnd() - 0.5) * 1.4;
        n++;
      }
      return false;
    }
    const luck = 1 + 0.1 * p.gear[3] + (this.phase === Phase.Wave ? 0.5 : 0);
    const rare = this.rnd() < 0.12 * luck;
    const gold = Math.round([60, 40, 25][s.kind] * (1 + s.tier) * luck * (0.7 + this.rnd() * 0.6) * (rare ? 3 : 1));
    p.gold += gold;
    this.bl.push(x, y, rare ? 1 : 0.5, 5);
    this.notes.push({ level: 1, text: `${rare ? 'jackpot: ' : ''}${p.name} found ${gold} gold in a ${name}` });
    return false;
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
    this.cSite[id] = -1; this.cHunt[id] = 255; this.cHuntT[id] = 0; this.cState[id] = 0;
    const hp = CREEPS[k].hp * (1 + 0.14 * (this.wave - 1));
    this.cHp[id] = hp; this.cMax[id] = hp; this.cBurn[id] = 0; this.cSlow[id] = 0; this.fresh(id);
    if (prefill && this.rnd() < 0.3) this.cHp[id] = hp * (0.2 + this.rnd() * 0.8);
  }

  private fresh(id: number): void {
    this.cCool[id] = 0; this.cSwing[id] = 0; this.cSwung[id] = 0; this.cFace[id] = 255; this.cBlows[id] = 0; this.cCalm[id] = 0;
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
    this.cRespawn[id] = this.pending > 0 && this.cSite[id] < 0 ? 0.5 + this.rnd() * 3 : -1;
  }

  private hurt(id: number, dmg: number, by: DPlayer | null): void {
    if (!this.cAlive[id]) return;
    const k = this.cKind[id];
    const d = Math.max(1, dmg - (k === 3 ? 4 : k === 5 ? 9 : 0));
    this.cHp[id] -= d;
    if (by) by.damage += d;
    if (this.cSite[id] >= 0 && this.cState[id] !== G_HUNT) this.wakeSite(this.cSite[id]);
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
      if (this.cState[id] === G_ASLEEP) continue;
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  // Straight towards (gx, gy), sliding along anything solid; true on arrival.
  private stepTo(id: number, gx: number, gy: number, sp: number, stop: number): boolean {
    const x = this.cX[id], y = this.cY[id], dx = gx - x, dy = gy - y, d = Math.hypot(dx, dy);
    if (d <= stop) return true;
    const s = Math.min(sp, d - stop * 0.5), nx = x + (dx / d) * s, ny = y + (dy / d) * s;
    if (!this.blocked(Math.floor(nx), Math.floor(ny))) { this.cX[id] = nx; this.cY[id] = ny; }
    else if (!this.blocked(Math.floor(nx), Math.floor(y))) this.cX[id] = nx;
    else if (!this.blocked(Math.floor(x), Math.floor(ny))) this.cY[id] = ny;
    else { this.cX[id] = nx; this.cY[id] = ny; }
    return false;
  }

  // Guards sleep until someone comes close, chase, and go home when led too far.
  private moveGuard(id: number, sp: number): void {
    const st = this.cState[id];
    if (st === G_ASLEEP) return;
    if (st === G_HOME) {
      if (this.stepTo(id, this.cHomeX[id], this.cHomeY[id], sp, 0.2)) this.cState[id] = G_ASLEEP;
      return;
    }
    const p = this.players[this.cHunt[id]];
    if (!p || p.hp <= 0 || Math.hypot(this.cX[id] - this.cHomeX[id], this.cY[id] - this.cHomeY[id]) > 26) {
      this.cState[id] = G_HOME; this.cHunt[id] = 255;
      return;
    }
    this.stepTo(id, p.x + this.cOffX[id] * 0.4, p.y + this.cOffY[id] * 0.4, sp, 0.5);
  }

  // Sleeping guards notice a survivor near their site.
  private wakeGuards(): void {
    const notice = 7 * (this.weather === Weather.Fog ? 1 - 0.4 * this.weatherAmt : 1);
    for (let i = 0; i < this.sites.length; i++) {
      const ids = this.guardIds[i];
      for (const id of ids) {
        if (!this.cAlive[id] || this.cState[id] !== G_ASLEEP) continue;
        let near = false;
        for (const p of this.players) if (p.hp > 0 && Math.hypot(p.x - this.cX[id], p.y - this.cY[id]) < notice) near = true;
        if (near) { this.wakeSite(i); break; }
      }
    }
  }

  private moveCreeps(): void {
    const core = this.structs[0];
    const ccx = core.x + core.w / 2, ccy = core.y + core.h / 2;
    const slowW = 1 - 0.15 * this.weatherAmt * SNOWY[this.weather] - 0.08 * this.weatherAmt * WET[this.weather];
    for (let id = 0; id < MAX_CREEPS; id++) {
      if (!this.cAlive[id]) {
        if (this.cRespawn[id] > 0) {
          this.cRespawn[id] -= DT;
          if (this.cRespawn[id] <= 0 && this.pending > 0 && this.phase === Phase.Wave) { this.pending--; this.spawnCreep(id, false); }
        }
        continue;
      }
      const k = this.cKind[id];
      let sp = CREEPS[k].speed * DT * slowW;
      if (this.cSlow[id] > 0) { sp *= 0.5; this.cSlow[id] -= DT; }
      if (this.cBurn[id] > 0) { this.cBurn[id] -= DT; this.hurt(id, 8 * DT, null); if (!this.cAlive[id]) continue; }
      this.cCool[id] = Math.max(-1, this.cCool[id] - DT);
      this.cSwung[id] = this.cSwing[id]; this.cSwing[id] = 0; this.cFace[id] = 255;
      if (this.cCalm[id] > 0) this.cCalm[id] -= DT;
      if (this.cState[id] !== G_ASLEEP && this.bite(id)) continue;
      if (this.cSite[id] >= 0) { this.moveGuard(id, sp); continue; }
      if (this.cHuntT[id] > 0) {
        // Taunted: straight for the survivor until it wears off.
        this.cHuntT[id] -= DT;
        const p = this.players[this.cHunt[id]];
        if (this.cHuntT[id] <= 0 || !p || p.hp <= 0) { this.cHuntT[id] = 0; this.cHunt[id] = 255; }
        else { this.stepTo(id, p.x + this.cOffX[id] * 0.5, p.y + this.cOffY[id] * 0.5, sp, 0.5); continue; }
      }
      let x = this.cX[id], y = this.cY[id];
      if (this.cCalm[id] <= 0 && this.siege(id, ccx, ccy)) continue;
      const tx = Math.floor(x), ty = Math.floor(y);
      const n = this.next[ty * W + tx];
      let gx: number, gy: number;
      if (n >= 0) { gx = (n % W) + 0.5 + this.cOffX[id] * 0.3; gy = ((n / W) | 0) + 0.5 + this.cOffY[id] * 0.3; }
      else { gx = ccx; gy = ccy; }
      const dx = gx - x, dy = gy - y, d = Math.hypot(dx, dy) || 1;
      x += (dx / d) * sp; y += (dy / d) * sp;
      this.cX[id] = x; this.cY[id] = y;
    }
  }

  // Mirrors the host's Creep.swing: coming into reach it winds up first, then a blow lands
  // every 1/rate seconds, the last windup seconds of each telegraphed. True on the blow.
  private swing(id: number): boolean {
    const k = this.cKind[id], wu = WINDUP[k];
    if (this.cSwung[id] === 0 && this.cSwing[id] === 0 && this.cCool[id] < wu) this.cCool[id] = wu;
    if (this.cCool[id] <= 0) { this.cCool[id] = 1 / RATE[k]; this.cSwing[id] = S_STRIKE; return true; }
    this.cSwing[id] = Math.max(this.cSwing[id], this.cCool[id] <= wu ? S_WINDUP : S_READY);
    return false;
  }

  // A creep within reach of a survivor (the hunted one first) stops and attacks it; true if so.
  private bite(id: number): boolean {
    const k = this.cKind[id], x = this.cX[id], y = this.cY[id];
    const r = CREEPS[k].radius + REACH[k] + 0.3, r2 = r * r, ps = this.players;
    let p = this.cHunt[id] !== 255 ? ps[this.cHunt[id]] : undefined;
    if (p && (p.hp <= 0 || (p.x - x) ** 2 + (p.y - y) ** 2 > r2)) p = undefined;
    for (let i = 0; !p && i < ps.length; i++) if (ps[i].hp > 0 && (ps[i].x - x) ** 2 + (ps[i].y - y) ** 2 <= r2) p = ps[i];
    if (!p) return false;
    if (!this.swing(id)) return true;
    // The demo's own hero is tougher so a screenshot does not open on a death screen; bots go gently too.
    if (k === 4) { this.tracer(x, y, p.x, p.y, 32); this.hit(p, p.bot ? 5 : 2); }
    else this.hit(p, (p.bot ? 4 : 1.5) * HEFT[k] / RATE[k]);
    return true;
  }

  // A wave creep against the generator, or (some of them) a wall or turret it brushes, stops and
  // attacks it; true if so. Three blows spend a creep on the generator; elsewhere it then moves on.
  private siege(id: number, ccx: number, ccy: number): boolean {
    const k = this.cKind[id], x = this.cX[id], y = this.cY[id], r = CREEPS[k].radius;
    let s: DStruct | undefined, sx = ccx, sy = ccy;
    if (Math.hypot(x - ccx, y - ccy) < 3.4 + r) s = this.structs[0];
    else if (this.cOffX[id] > 0.2) {
      const e = r + 0.3;
      for (let d = 0; d < 4 && !s; d++) {
        const tx = Math.floor(x + (d === 0 ? e : d === 1 ? -e : 0)), ty = Math.floor(y + (d === 2 ? e : d === 3 ? -e : 0));
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const o = this.occ[ty * W + tx];
        if (o > 1 && this.structs[o - 1].kind !== 4) { s = this.structs[o - 1]; sx = s.x + s.w / 2; sy = s.y + s.h / 2; }
      }
    }
    if (!s) return false;
    const a = Math.atan2(sy - y, sx - x);
    this.cFace[id] = 128 + ((Math.round(a / (2 * Math.PI) * 127) + 127) % 127);
    if (!this.swing(id)) return true;
    const core = s === this.structs[0];
    s.hp = Math.max(core ? 1 : Math.round(s.maxHp * 0.3), s.hp - (core ? (k === 5 ? 40 : 2) : SDMG[k]));
    if (++this.cBlows[id] >= 3) {
      if (core) this.kill(id, null, false);
      else { this.cBlows[id] = 0; this.cCalm[id] = 4; }
    }
    return true;
  }

  // A creep's blow on a survivor. A crowd only hurts so fast, so a survivor deep in the
  // horde lasts long enough to be worth watching.
  private hit(p: DPlayer, dmg: number): void {
    const cap = p.bot ? 24 : 6;
    dmg = Math.min(dmg, Math.max(0, cap - p.harm)); p.harm += dmg;
    p.hp -= dmg; p.hurt = 0.3;
    if (p.heal > 0) { p.heal = 0; if (!p.bot) this.toast('a hit cut the medkit short'); }
    if (p.hp <= 0) { p.hp = 0; p.respawn = 20; p.downT = 0; p.order = Order.Idle; this.notes.push({ level: 2, text: `${p.name} is down` }); }
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
    return Math.hypot(p.x - (a.x + a.w / 2), p.y - (a.y + a.h / 2)) <= this.welcome.shopRadius;
  }

  private walk(p: DPlayer, tx: number, ty: number, stopAt: number): boolean {
    const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
    if (d <= stopAt) { p.moving = false; return true; }
    const snow = 1 - 0.08 * this.weatherAmt * SNOWY[this.weather];
    const sp = Math.min(d, 4.2 * (1 + 0.08 * p.gear[1]) * snow * DT);
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
      p.respawn -= DT; p.downT += DT;
      p.emoteLeft = 0; p.channel = 0;
      if (p.respawn <= 0) { const c = this.structs[0]; p.hp = p.maxHp; p.x = c.x + c.w / 2; p.y = c.y + c.h + 1.5; p.order = Order.Idle; }
      return;
    }
    p.emoteLeft = Math.max(0, p.emoteLeft - DT);
    p.tauntCool = Math.max(0, p.tauntCool - DT);
    p.hurt = Math.max(0, p.hurt - DT);
    p.harm = Math.max(0, p.harm - (p.bot ? 24 : 6) * DT);
    p.shot = Math.max(0, p.shot - DT);
    for (let i = 0; i < 4; i++) p.abCool[i] = Math.max(0, p.abCool[i] - DT);
    if (p.buffLeft > 0) { p.buffLeft -= DT; if (p.buffLeft <= 0) p.buff = 0; }
    p.hp = Math.min(p.maxHp, p.hp + (0.3 + 1.5 * p.gear[2]) * DT);
    if (p.heal > 0) { p.heal = Math.max(0, p.heal - DT); p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.4 / 3 * DT); }
    if (p.bot) {
      // Bots pick a downed teammate up once they have been down a while, and taunt now and then.
      const down = this.players.find((o) => o.hp <= 0 && o.downT > 8 && o.respawn > 2);
      if (down && p.order !== Order.Revive && !this.players.some((o) => o.order === Order.Revive && o.revTarget === down.id)) {
        p.order = Order.Revive; p.revTarget = down.id; p.channel = 0;
      }
      if (this.phase === Phase.Wave && p.tauntCool <= 0 && this.rnd() < 0.004) this.taunt(p);
      if (p.order !== Order.Revive) p.wander -= DT;
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
      case Order.Steer:
        // A steer lapses unless the client repeats it, as on the host.
        if ((p.steerLeft -= DT) <= 0) { p.order = Order.Idle; break; }
        this.walk(p, p.x + p.steerX * 2, p.y + p.steerY * 2, 0);
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
      case Order.Loot:
        if (!this.stepLoot(p)) { p.order = Order.Idle; p.searchT = 0; }
        break;
      case Order.Revive: {
        const o = this.players[p.revTarget];
        if (!o || o.hp > 0 || o.respawn <= 0) { p.order = Order.Idle; p.channel = 0; break; }
        if (!this.walk(p, o.x, o.y, this.welcome.revive.reach * 0.8)) { p.channel = 0; break; }
        p.channel += DT / this.welcome.revive.time;
        if (p.channel >= 1) {
          o.hp = Math.round(o.maxHp * this.welcome.revive.hp); o.respawn = 0; o.downT = 0; o.hurt = 0;
          this.bl.push(o.x, o.y, 1, BlastKind.Revived);
          this.notes.push({ level: 1, text: `${p.name} got ${o.name} back up` });
          p.order = Order.Idle; p.channel = 0;
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
    if (target < 0 && p.order !== Order.Move && p.order !== Order.Build && p.order !== Order.Repair && p.order !== Order.Loot && p.order !== Order.Revive) {
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
    // Creeps' blows land in moveCreeps (hit); standing among them still holds off the quick regen.
    if (p.hurt <= 0 && this.query(p.x, p.y, 0.9, this.q, 1) === 0) p.hp = Math.min(p.maxHp, p.hp + 2 * DT);
  }

  // Pulls every creep within the taunt radius onto p.
  private taunt(p: DPlayer): void {
    const tw = this.welcome.taunt;
    if (p.hp <= 0) return;
    if (p.tauntCool > 0) { if (!p.bot) this.toast(`taunt not ready: ${p.tauntCool.toFixed(1)}s`); return; }
    p.tauntCool = tw.cool; p.emoteLeft = 1.6;
    this.bl.push(p.x, p.y, tw.radius, BlastKind.Taunt);
    const ids = this.q, n = this.query(p.x, p.y, tw.radius, ids, 4000);
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      if (this.cSite[id] >= 0) {
        if (this.cState[id] === G_ASLEEP) this.bl.push(this.cX[id], this.cY[id], 1, BlastKind.GuardsWake);
        this.cState[id] = G_HUNT;
      }
      this.cHunt[id] = p.id; this.cHuntT[id] = this.cSite[id] >= 0 ? 1e9 : tw.time;
    }
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
  // A Huey with a supply crate, as the host sends one after every tenth wave: here out past the
  // east wall of the first player, on open ground.
  // of the first player, so it is in view.
  callDrop(): void {
    const me = this.players[0];
    const x = Math.floor(me.x + 20) + 0.5, y = Math.floor(me.y - 6) + 0.5;
    const dx = x - me.x, dy = y - me.y, d = Math.hypot(dx, dy) || 1;
    this.effects.push({ kind: EffectKind.Drop, x0: x + dx / d * 50, y0: y + dy / d * 50, x, y, r: 0, left: 140, total: 140, owner: -1, dmg: 0 });
    this.notes.push({ level: 1, text: 'supply drop inbound: a Huey is bringing a crate in' });
  }

  private stepCrates(): void {
    for (let i = 0; i < this.crates.length; i++) {
      const c = this.crates[i];
      const p = this.players.find((o) => o.hp > 0 && o.hurt <= 0 && Math.hypot(o.x - c.x, o.y - c.y) <= 1.8);
      if (!p) { c.open = 0; continue; }
      if ((c.open += DT) < 2.5) continue;
      for (const o of this.players) { o.gold += 400; o.medkits = 3; }
      this.notes.push({ level: 1, text: `${p.name} opened the supply crate: +400 gold and full medkits for everyone` });
      this.crates.splice(i--, 1);
    }
  }

  private stepEffects(): void {
    const keep: DEffect[] = [];
    for (const e of this.effects) {
      if (e.kind === EffectKind.Drop) {
        // The door gunner, from where the Huey is, once it is near.
        const tl = (e.total - e.left) / 10, k0 = Math.min(1, tl / (e.total / 10 - 3)), k = 1 - (1 - k0) * (1 - k0);
        const hx = e.x0 + (e.x - e.x0) * k, hy = e.y0 + (e.y - e.y0) * k;
        if (tl > 2 && this.tick % 2 === 0) {
          const t = this.nearest(hx, hy, 11);
          if (t >= 0) { this.tracer(hx, hy, this.cX[t], this.cY[t], TRACER_HELI); this.hurt(t, 60, null); }
        }
        if (this.tick % 2 === 0) e.left--;
        if (e.left > 0) keep.push(e);
        else { this.crates.push({ x: e.x, y: e.y, open: 0 }); this.blast(e.x, e.y, 1.5, 5, 0, null); }
        continue;
      }
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
      for (let id = 0; id < GUARD_ID0; id++) if (this.cAlive[id]) { any = true; break; }
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

  // Weather drifts from one kind to the next every so often, easing out and in.
  private stepWeather(): void {
    const fixed = this.opt.weather !== undefined && this.opt.weather >= 0;
    if (!fixed && (this.weatherT -= DT) <= 0) { this.weatherT = 30; this.nextWeather = (this.weather + 1) % WEATHERS.length; }
    if (this.nextWeather !== this.weather) {
      this.weatherAmt = Math.max(0, this.weatherAmt - DT / 3);
      if (this.weatherAmt <= 0) {
        this.weather = this.nextWeather;
        this.notes.push({ level: 0, text: `The weather turns: ${this.welcome.weathers[this.weather].name.toLowerCase()}` });
      }
    } else if (this.weather !== Weather.Clear) this.weatherAmt = Math.min(1, this.weatherAmt + DT / 3);
    const bolts = this.weather === Weather.Storm || this.weather === Weather.Thunder;
    if (!bolts || this.weatherAmt < 0.5 || (this.boltT -= DT) > 0) return;
    // Lightning finds a creep in the open near the action, else the ground.
    this.boltT = this.weather === Weather.Storm ? 1.2 + this.rnd() * 3 : 7 + this.rnd() * 8;
    const me = this.players[0], ids = this.q, n = this.query(me.x, me.y, 26, ids, 400);
    let x = me.x + (this.rnd() - 0.5) * 36, y = me.y + (this.rnd() - 0.5) * 24;
    if (n > 0) { const id = ids[Math.floor(this.rnd() * n)]; x = this.cX[id]; y = this.cY[id]; }
    this.blast(x, y, 2, BlastKind.Lightning, 150, null);
  }

  private step(): void {
    this.tr.length = 0; this.bl.length = 0; this.de.length = 0;
    if (this.paused < 0) { this.tick++; this.stepPhase(); }
    if (this.phase !== Phase.Over && this.paused < 0) {
      this.buildGrid();
      this.stepWeather();
      this.wakeGuards();
      this.moveCreeps();
      for (const p of this.players) this.stepPlayer(p);
      this.stepStructs();
      this.stepEffects();
      this.stepCrates();
    }
    dispatch(this.h, this.encode());
    this.notes.length = 0; this.pings.length = 0;
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
    w.u8(this.weather); w.u8(Math.round(this.weatherAmt * 255)); w.u8(this.paused + 1);
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
      w.u8(p.order);
      const kind = p.order === Order.Loot ? this.welcome.siteKinds[this.sites[p.site]?.kind] : undefined;
      w.u8(kind ? Math.min(255, (p.searchT / kind.search) * 255) : p.order === Order.Revive ? Math.min(255, p.channel * 255) : 0);
      let rev = 0;
      if (!alive) for (const o of this.players) if (o.order === Order.Revive && o.revTarget === p.id) rev = Math.max(rev, o.channel);
      w.u8(Math.min(255, rev * 255));
      w.u8(p.emoteLeft > 0 ? Emote.Taunt : Emote.None); w.u8(Math.ceil(p.emoteLeft * 10)); w.u16(Math.ceil(p.tauntCool * 10));
      w.u8(255); w.u8(0); w.u32(p.look);
      w.u8(p.buff); w.u8(Math.max(0, p.buffLeft * 10));
      for (let a = 0; a < 4; a++) { w.u8(p.abLevel[a]); w.u16(p.abCool[a] * 10); }
      w.u8(p.medkits); w.u8(Math.ceil(p.heal * 10));
      w.u8(p.reloadLeft > 0 ? 1 << p.cur : 0);
      w.str8(p.name);
    }
    w.u16(this.sites.length);
    for (let i = 0; i < this.sites.length; i++) w.u8((this.searched[i] ? 0x80 : 0) | Math.min(127, this.guardsLeft(i)));
    w.u8(this.crates.length);
    for (const c of this.crates) { w.q8(c.x); w.q8(c.y); w.u8(Math.min(255, c.open / 2.5 * 255)); }
    w.u16(this.structs.length);
    for (const s of this.structs) {
      w.u8(s.alive ? 1 : 0); w.u8(s.kind); w.u16(s.x); w.u16(s.y); w.u8(s.w); w.u8(s.h);
      w.u16(s.hp); w.u16(s.maxHp); w.u8(s.level); w.i8(s.owner);
    }
    let n = 0;
    for (let id = 0; id < MAX_CREEPS; id++) n += this.cAlive[id];
    w.u16(n);
    const core = this.structs[0], ccx = core.x + core.w / 2, ccy = core.y + core.h / 2;
    for (let id = 0; id < MAX_CREEPS; id++) {
      if (!this.cAlive[id]) continue;
      w.u16(id); w.q8(this.cX[id]); w.q8(this.cY[id]); w.u8(this.cKind[id]);
      w.u8(Math.max(1, Math.min(255, (this.cHp[id] / this.cMax[id]) * 255)));
      const guard = this.cSite[id] >= 0, st = this.cState[id];
      const hunting = guard ? st === G_HUNT : this.cHuntT[id] > 0;
      let fl = (this.cBurn[id] > 0 ? CF_BURNING : 0) | (this.cSlow[id] > 0 ? CF_SLOWED : 0);
      if (guard) fl |= CF_GUARD;
      if (guard && st === G_ASLEEP) fl |= CF_ASLEEP;
      if (hunting) fl |= CF_HUNTING;
      else if (!guard && (this.cFace[id] !== 255 || (Math.abs(this.cX[id] - ccx) < 18 && Math.abs(this.cY[id] - ccy) < 18))) fl |= CF_SIEGE;
      const sw = this.cSwing[id];
      if (sw === S_WINDUP) fl |= CF_WINDUP;
      else if (sw === S_STRIKE) fl |= CF_STRIKE;
      w.u8(fl); w.u8(hunting ? this.cHunt[id] : this.cFace[id]);
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
    w.u8(this.pings.length);
    for (const g of this.pings) { w.u8(g.player); w.q8(g.x); w.q8(g.y); w.u8(g.kind); }
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
      case 'steer':
        if (!cmd.on) { if (p.order === Order.Steer) p.order = Order.Idle; break; }
        if (p.hp <= 0) break;
        p.order = Order.Steer; p.steerX = Math.cos(cmd.x); p.steerY = Math.sin(cmd.x); p.steerLeft = 0.4;
        break;
      case 'medkit':
        if (p.hp <= 0) this.toast('you are down');
        else if (p.medkits <= 0) this.toast('no medkits; buy them at the armory');
        else if (p.heal > 0) this.toast('already patching up');
        else if (p.hp >= p.maxHp) this.toast('you are not hurt');
        else { p.medkits--; p.heal = 3; }
        break;
      case 'buyMedkit':
        if (!this.atArmory(p)) this.toast('walk to the armory first');
        else if (p.medkits >= 3) this.toast('you carry 3 medkits already, as many as fit');
        else if (p.gold < 60) this.toast(`not enough gold: need 60, have ${p.gold}`);
        else { p.gold -= 60; p.medkits++; }
        break;
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
      case 'loot':
        if (!this.sites[cmd.site]) break;
        if (this.searched[cmd.site]) { this.toast('already searched'); break; }
        if (this.guardsLeft(cmd.site) > 0) { this.toast(`guarded: kill its ${this.guardsLeft(cmd.site)} guards first`); break; }
        p.order = Order.Loot; p.site = cmd.site; p.searchT = 0;
        break;
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
      case 'taunt': this.taunt(p); break;
      case 'revive': {
        const o = this.players[cmd.p];
        if (!o || o === p || o.hp > 0) { this.toast('nobody to revive there'); break; }
        p.order = Order.Revive; p.revTarget = o.id; p.channel = 0;
        break;
      }
      case 'chat': this.notes.push({ level: 3, text: `${p.name}: ${cmd.text}` }); break;
      case 'ping': this.pings.push({ player: p.id, x: cmd.x, y: cmd.y, kind: Math.min(3, Math.max(0, cmd.kind | 0)) }); break;
      case 'pause':
        this.paused = this.paused >= 0 ? -1 : p.id;
        this.notes.push({ level: 0, text: `${p.name} ${this.paused >= 0 ? 'paused' : 'resumed'} the game` });
        break;
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
