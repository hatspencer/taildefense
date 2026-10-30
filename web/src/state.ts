import { type AckMsg, EvacStage, Frame, K_GATE, MAX_CREEPS, type NetStatsMsg, PF_ALIVE, PF_FIRING, type Player, type Welcome, Weather, decodeFrame } from './protocol';
import { type Me, Predictor, type World, Wrecks, tileBlocked } from './predict';
import { Vision } from './vision';

// Everything the client knows about the world: the current frame, and a short history of the
// creeps' and players' positions the page draws them from. Renderers read the r* arrays,
// indexed like the current frame.
// How long a ping stays on the map, in ms.
export const PING_LIFE = 5000;

// Motion is drawn a little in the past, at renderTime = now - delay, from the two snapshots
// either side of it, so a frame arriving late or several arriving together change nothing on
// screen as long as the delay covers them. Snapshots kept, per creep and player: the delay is
// at most DELAY_MAX, four and a half intervals at the host's 30 Hz, so six always bracket it.
const HIST = 6;
// The delay is the mean arrival interval plus twice the jitter, no less than a tick and no
// more than DELAY_MAX ms: past that the lag is felt more than a stutter would be. It moves
// toward that by at most DELAY_SLEW ms per ms, which slows or speeds the drawn world by 5%
// rather than jumping it.
const DELAY_MAX = 150, DELAY_SLEW = 0.05;
// Past the newest snapshot things go on along their last velocity for up to EXTRAP_MS, then
// stand: a guess longer than that is more often wrong than right.
const EXTRAP_MS = 100;
// When a frame moves where something is drawn (after a guess past the newest snapshot, or the
// oldest falling out of the history), the difference is carried and let go with this time
// constant in ms, so nothing snaps.
const BLEND_MS = 100;
// The timeline the snapshots are stamped on: each is due one mean interval after the last,
// pulled PLL_GAIN of the way to when it really came, so arrival jitter does not become speed
// jitter. The mean and the jitter (mean |arrival - due|) are running averages with these gains.
// A frame over RESYNC_MS off its due time (a stall, a background tab) restarts the timeline.
const MEAN_GAIN = 0.05, PLL_GAIN = 0.1, JIT_GAIN = 0.1, RESYNC_MS = 250;

// Where renderTime falls among the snapshots: between lo and lo + 1 at frac, or ext ms past
// the newest (top); inv is 1 / the newest pair's spacing, for the velocity.
class Bracket { lo = 0; top = 0; frac = 0; ext = 0; inv = 0 }

export class Game {
  welcome: Welcome | null = null;
  tiles = new Uint8Array(0);
  w = 0; h = 0;
  // Struct id + 1 per tile, 0 for none.
  structAt = new Int32Array(0);
  structsVersion = 0;
  terrainVersion = 0;

  cur = new Frame();
  private back = new Frame();
  // Starts at 1 so a never-seen id (seen 0) is never taken for one seen last frame.
  frames = 1;
  // When the newest frame came, and the mean time between frames (clamped for alpha's users).
  frameAt = 0;
  interval = 50;
  // How far in the past motion is drawn, in ms, and what it is moving toward.
  delay = 50;
  delayGoal = 50;
  // The running mean frame interval and arrival jitter behind it, in ms.
  meanInterval = 50;
  jitter = 0;
  // The last round trip to the host in ms, and its running average; NaN before the first.
  rtt = NaN;
  rttAvg = NaN;
  // The latest ack of this page's commands (see AckMsg), and the latest netstats; null before
  // the first. The demo host sends neither.
  ack: AckMsg | null = null;
  netStats: NetStatsMsg | null = null;

  // The snapshot timeline: the newest snapshot's serial (0 before any), and each kept one's
  // stamp in performance.now() ms, by serial % HIST.
  private snap = 0;
  private stamps = new Float64Array(HIST);
  private resync = true;
  private tickMs = 50;
  private drawnAt = 0;
  private brOld = new Bracket(); private brNew = new Bracket(); private brNow = new Bracket();
  // What sample() found.
  private sx = 0; private sy = 0;

  // Per creep id: positions by id * HIST + serial % HIST, the serial its unbroken history
  // starts at, and the carried difference being let go.
  private hx = new Float32Array(MAX_CREEPS * HIST); private hy = new Float32Array(MAX_CREEPS * HIST);
  private since = new Uint32Array(MAX_CREEPS);
  private ex = new Float32Array(MAX_CREEPS); private ey = new Float32Array(MAX_CREEPS);
  private seen = new Uint32Array(MAX_CREEPS);
  private kindById = new Uint8Array(MAX_CREEPS);
  private hpById = new Uint8Array(MAX_CREEPS);
  heading = new Float32Array(MAX_CREEPS);
  flashUntil = new Float32Array(MAX_CREEPS);
  // Current creep index by id, -1 when absent.
  indexById = new Int32Array(MAX_CREEPS).fill(-1);

  // Interpolated, per index of the current frame.
  rx = new Float32Array(MAX_CREEPS);
  ry = new Float32Array(MAX_CREEPS);

  // Per player id, as for creeps, with the aim; pSeen is the snapshot serial last seen in.
  private phx = new Float32Array(256 * HIST); private phy = new Float32Array(256 * HIST); private pha = new Float32Array(256 * HIST);
  private pSince = new Uint32Array(256); private pSeen = new Uint32Array(256);
  private pex = new Float32Array(256); private pey = new Float32Array(256); private pea = new Float32Array(256);
  prx = new Float32Array(256); pry = new Float32Array(256); paim = new Float32Array(256);

  private structSig = '';

  // The page's own survivor walking with WASD is drawn where predict.ts has them now, not
  // where the frames had them a delay ago; everything else stays interpolated.
  predict = new Predictor();
  // Whether the last interpolate() drew the hero predicted.
  predicted = false;
  private wrecks: Wrecks | null = null;
  private meView: Me = {
    x: 0, y: 0, stamina: 1, winded: false, slow: 0, buff: 0, buffLeft: 0, cur: 0, gear: [0, 0, 0, 0],
    alive: false, stunned: false, held: false, airborne: false, aboard: false, art: 0,
  };
  private searched = (i: number) => this.cur.siteSearched(i);
  private passable = (k: number) => k === K_GATE || !!this.welcome?.structs[k]?.floor;
  private kindAt = (tx: number, ty: number) => { const s = this.structAtTile(tx, ty); return s >= 0 ? this.cur.sKind[s] : -1; };
  // What is in the hero's way, as the host's CanStand sees it: terrain, structures but gates and
  // traps, wrecks and standing pumps.
  private walkWorld: World = {
    blocked: (tx, ty) => tileBlocked(this.tiles, this.w, this.h, tx, ty, this.kindAt, this.passable),
    wreck: (x, y) => this.wrecks?.at(x, y, this.searched) ?? false,
    weather: 0, amt: 0,
  };

  // Fog of war, when the host plays with it: creeps out of the team's sight are dropped from
  // each frame as it arrives, so nothing downstream shows them. hiddenAt[id] is the frame
  // serial a creep was last dropped on, which tells a creep walking into the dark from one
  // that died.
  vision: Vision | null = null;
  // At night: someone has seen the helipad, and it stays on the map.
  private padSeen = false;
  hiddenAt = new Uint32Array(MAX_CREEPS);

  // setDifficulty follows the host changing the difficulty: night comes or goes with it, and
  // with night the sight the page keeps.
  setDifficulty(d: { id: number; name: string }, dark: number, cone = 0): void {
    const w = this.welcome;
    if (!w) return;
    w.difficulty = d;
    if ((w.dark ?? 0) === dark && (w.cone ?? 0) === cone) return;
    w.dark = dark; w.cone = cone;
    this.vision = w.fogOfWar || w.dark ? new Vision(w.w, w.h, w) : null;
    this.hiddenAt.fill(0);
  }

  reset(w: Welcome): void {
    w.siteKinds ??= []; w.sites ??= []; w.weathers ??= [{ name: 'Clear', info: '' }];
    w.difficulties ??= ['Normal']; w.difficulty ??= { id: 0, name: 'Normal' };
    w.taunt ??= { cool: 12, radius: 12, time: 5 }; w.revive ??= { reach: 1.6, time: 2.5, hp: 0.4 };
    this.welcome = w;
    this.padSeen = false;
    this.w = w.w; this.h = w.h;
    this.vision = w.fogOfWar || w.dark ? new Vision(w.w, w.h, w) : null;
    this.hiddenAt.fill(0);
    this.frames++;
    this.seen.fill(0);
    this.pSeen.fill(0);
    this.resync = true;
    this.tickMs = 1000 / (w.tickRate > 0 ? w.tickRate : 20);
    // A new session's timeline starts from its host's tick, not the last one's.
    this.interval = this.meanInterval = this.delay = this.delayGoal = this.tickMs;
    this.indexById.fill(-1);
    this.cur.nCreeps = 0; this.cur.nStructs = 0; this.cur.nPlayers = 0; this.cur.nSites = 0;
    this.structSig = '';
    this.predict.reset(w.tickRate);
    this.predicted = false;
    this.wrecks = new Wrecks(w.sites, w.w, w.h);
  }

  // onAck takes the host's ack of this page's commands.
  onAck(m: AckMsg): void {
    this.ack = m;
    this.predict.ack(m.seq, m.tick);
  }

  setTerrain(t: Uint8Array): void {
    this.tiles = t.slice();
    this.structAt = new Int32Array(this.w * this.h);
    this.terrainVersion++;
  }

  me(): Player | null {
    return this.welcome ? this.cur.player(this.welcome.you) : null;
  }

  // Thick fog: teammates drop off the map and their bars go, only the figures stay.
  // Pings the team placed in the last PING_LIFE ms, oldest first; at is performance.now().
  pings: { player: number; x: number; y: number; kind: number; at: number }[] = [];

  fogged(): boolean {
    return this.cur.weather === Weather.Fog && this.cur.weatherAmt > 0.4;
  }

  // Decodes a frame and advances the interpolation state. now is performance.now().
  applyFrame(buf: ArrayBuffer, now: number): Frame {
    const prevTick = this.cur.tick;
    decodeFrame(buf, this.back);
    const f = this.back;
    this.back = this.cur;
    this.cur = f;
    this.frames++;
    const serial = this.frames;
    for (const g of f.pings) this.pings.push({ ...g, at: now });
    while (this.pings.length && (now - this.pings[0].at > PING_LIFE || this.pings.length > 24)) this.pings.shift();
    const contiguous = f.tick === prevTick + 1 || f.tick === prevTick;
    if (this.vision && this.welcome) this.hideUnseen(f, serial);

    // The snapshot this frame becomes. Where things are drawn now is read against the old
    // history and the new, to carry over whatever the new one would move.
    const top = this.snap, next = top + 1, H = HIST;
    const rt = now - this.delay;
    this.bracket(rt, top, this.brOld);
    this.stamps[next % H] = this.arrive(now);
    this.snap = next;
    this.bracket(rt, next, this.brNew);
    const bo = this.brOld, bn = this.brNew, slot = next % H, prev = top % H;

    const prevIndex = this.indexById, hx = this.hx, hy = this.hy;
    for (let i = 0; i < this.back.nCreeps; i++) prevIndex[this.back.cId[i]] = -1;
    for (let i = 0; i < f.nCreeps; i++) {
      const id = f.cId[i], x = f.cX[i], y = f.cY[i], k = f.cKind[i], base = id * H;
      prevIndex[id] = i;
      const known = this.seen[id] === serial - 1 && contiguous && this.kindById[id] === k;
      const dx = x - hx[base + prev], dy = y - hy[base + prev];
      if (known && dx * dx + dy * dy < 9) {
        this.sample(hx, hy, base, this.since[id], bo);
        const bx = this.sx, by = this.sy;
        hx[base + slot] = x; hy[base + slot] = y;
        this.sample(hx, hy, base, this.since[id], bn);
        this.ex[id] += bx - this.sx; this.ey[id] += by - this.sy;
        if (dx * dx + dy * dy > 1e-4) this.heading[id] = Math.atan2(dy, dx);
        if (f.cHp[i] < this.hpById[id]) this.flashUntil[id] = now + 90;
      } else {
        // New, back from the dark or a jump of three tiles or more: it starts here.
        hx[base + slot] = x; hy[base + slot] = y;
        this.since[id] = next;
        this.ex[id] = 0; this.ey[id] = 0;
        this.flashUntil[id] = 0;
        if (!known) this.heading[id] = Math.random() * Math.PI * 2;
      }
      this.kindById[id] = k; this.hpById[id] = f.cHp[i];
      this.seen[id] = serial;
    }

    const phx = this.phx, phy = this.phy, pha = this.pha;
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i], id = p.id, base = id * H;
      const known = top > 0 && this.pSeen[id] === top && contiguous;
      // The dead lie where they fell: no gliding into it.
      const jump = !known || !(p.flags & PF_ALIVE) || Math.abs(p.x - phx[base + prev]) + Math.abs(p.y - phy[base + prev]) > 4;
      if (!jump) {
        this.sample(phx, phy, base, this.pSince[id], bo);
        const bx = this.sx, by = this.sy, ba = this.sampleAim(base, this.pSince[id], bo);
        phx[base + slot] = p.x; phy[base + slot] = p.y; pha[base + slot] = p.aim;
        this.sample(phx, phy, base, this.pSince[id], bn);
        this.pex[id] += bx - this.sx; this.pey[id] += by - this.sy;
        const da = ba - this.sampleAim(base, this.pSince[id], bn);
        this.pea[id] += Math.atan2(Math.sin(da), Math.cos(da));
      } else {
        phx[base + slot] = p.x; phy[base + slot] = p.y; pha[base + slot] = p.aim;
        this.pSince[id] = next;
        this.pex[id] = 0; this.pey[id] = 0; this.pea[id] = 0;
      }
      this.pSeen[id] = next;
    }

    this.updateStructGrid();
    const me = this.me();
    if (me) {
      const v = this.meView;
      v.x = me.x; v.y = me.y; v.stamina = me.stamina; v.winded = me.winded; v.slow = me.slow;
      v.buff = me.buff; v.buffLeft = me.buffLeft; v.cur = me.cur; v.gear = me.gear;
      v.alive = (me.flags & PF_ALIVE) !== 0; v.stunned = me.stunned; v.held = me.held; v.airborne = me.airborne;
      v.aboard = me.aboard; v.art = me.art;
      this.walkWorld.weather = f.weather; this.walkWorld.amt = f.weatherAmt;
      this.predict.frame(f.tick, v, this.walkWorld, now);
    }
    return f;
  }

  // Stamps a frame arriving at now on the snapshot timeline and updates the delay's goal.
  private arrive(now: number): number {
    const top = this.snap;
    let st = now;
    if (top > 0 && !this.resync) {
      const last = this.stamps[top % HIST];
      const gap = Math.min(now - this.frameAt, RESYNC_MS);
      this.meanInterval = Math.min(RESYNC_MS, Math.max(10, this.meanInterval + (gap - this.meanInterval) * MEAN_GAIN));
      const due = last + this.meanInterval, dev = now - due;
      if (Math.abs(dev) <= RESYNC_MS) {
        st = due + dev * PLL_GAIN;
        this.jitter += (Math.abs(dev) - this.jitter) * JIT_GAIN;
      }
      st = Math.max(st, last + 1);
    }
    this.resync = false;
    this.frameAt = now;
    this.interval = Math.min(2.4 * this.tickMs, Math.max(0.6 * this.tickMs, this.meanInterval));
    this.delayGoal = Math.min(DELAY_MAX, Math.max(this.tickMs, this.meanInterval + 2 * this.jitter));
    return st;
  }

  // Finds where renderTime rt falls among the snapshots up to top.
  private bracket(rt: number, top: number, b: Bracket): void {
    const st = this.stamps, H = HIST;
    b.top = top; b.lo = top; b.frac = 0; b.ext = 0; b.inv = 0;
    if (top === 0) return;
    if (top > 1) { const d = st[top % H] - st[(top - 1) % H]; b.inv = d > 0 ? 1 / d : 0; }
    const tTop = st[top % H];
    if (rt >= tTop) { b.ext = Math.min(rt - tTop, EXTRAP_MS); return; }
    const oldest = Math.max(1, top - H + 1);
    for (let s = top - 1; s >= oldest; s--) {
      const t = st[s % H];
      if (rt >= t) { b.lo = s; b.frac = (rt - t) / (st[(s + 1) % H] - t); return; }
    }
    // Older than everything kept: the oldest stands.
    b.lo = oldest;
  }

  // One thing's position at bracket b, from its history at base, unbroken from serial since,
  // into sx, sy.
  private sample(hx: Float32Array, hy: Float32Array, base: number, since: number, b: Bracket): void {
    const H = HIST;
    let lo = b.lo, frac = b.frac;
    // Its history starts after renderTime: it stands where it was first seen until then.
    if (lo < since) { lo = since; frac = 0; }
    const a = base + lo % H;
    let x = hx[a], y = hy[a];
    if (lo === b.top) {
      if (b.ext > 0 && since < lo) {
        const p = base + (lo - 1) % H, k = b.ext * b.inv;
        x += (x - hx[p]) * k; y += (y - hy[p]) * k;
      }
    } else if (frac > 0) {
      const n = base + (lo + 1) % H;
      x += (hx[n] - x) * frac; y += (hy[n] - y) * frac;
    }
    this.sx = x; this.sy = y;
  }

  // A player's aim at bracket b, turning the short way round; it stands past the newest.
  private sampleAim(base: number, since: number, b: Bracket): number {
    const H = HIST, ha = this.pha;
    let lo = b.lo, frac = b.frac;
    if (lo < since) { lo = since; frac = 0; }
    const a0 = ha[base + lo % H];
    if (lo === b.top || frac <= 0) return a0;
    let d = ha[base + (lo + 1) % H] - a0;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return a0 + d * frac;
  }

  // How many guards site i has left; -1 while fog of war keeps that from the team, -2 at
  // night (hard and brutal), when nobody keeps count.
  guardsLeft(i: number): number {
    if (this.welcome?.dark) return -2;
    return this.vision && !this.vision.knows(i) ? -1 : this.cur.siteGuards(i);
  }

  // Brutal's night: only what a survivor's pool and flashlight, the generator or a turret
  // lights right now shows; ground the team found before goes back to black once nobody is on it.
  lightOnly(): boolean {
    return !!this.welcome?.dark && !!this.welcome.cone;
  }

  // Whether site i is still out in the dark: at night, where the team has never been.
  // Whether the helipad shows, in the world and on the minimap: always by day; at night, where
  // it lies out past the generator's lights, once any of it has been seen or the Huey has come
  // down on it, as the host's PadKnown has it.
  padKnown(): boolean {
    const w = this.welcome, ev = w?.evac, v = this.vision;
    if (!ev) return false;
    if (!w!.dark || !v || this.padSeen || this.cur.evac >= EvacStage.Landed) return true;
    const x0 = Math.floor(ev.pad.x - ev.half), y0 = Math.floor(ev.pad.y - ev.half), n = ev.half * 2;
    for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) if (v.seen[y * v.w + x]) return (this.padSeen = true);
    return false;
  }

  unfound(i: number): boolean {
    return !!this.welcome?.dark && !!this.vision && !this.vision.found(i);
  }

  private hideUnseen(f: Frame, serial: number): void {
    const v = this.vision!;
    v.update(f, this.welcome!, this.fogged());
    let n = 0;
    for (let i = 0; i < f.nCreeps; i++) {
      if (!v.sees(f.cX[i], f.cY[i])) { this.hiddenAt[f.cId[i]] = serial; continue; }
      if (n !== i) {
        f.cId[n] = f.cId[i]; f.cX[n] = f.cX[i]; f.cY[n] = f.cY[i]; f.cKind[n] = f.cKind[i];
        f.cHp[n] = f.cHp[i]; f.cFlags[n] = f.cFlags[i]; f.cTarget[n] = f.cTarget[i]; f.cFx[n] = f.cFx[i];
      }
      n++;
    }
    f.nCreeps = n;
    n = 0;
    for (let i = 0; i < f.nDeaths; i++) {
      if (!v.sees(f.dX[i], f.dY[i])) continue;
      f.dX[n] = f.dX[i]; f.dY[n] = f.dY[i]; f.dKind[n] = f.dKind[i];
      n++;
    }
    f.nDeaths = n;
  }

  private updateStructGrid(): void {
    const f = this.cur;
    // A cheap signature of what is standing where; levels and hp do not matter here.
    let sig = '' + f.nStructs;
    let hsh = 0;
    for (let i = 0; i < f.nStructs; i++) {
      hsh = (Math.imul(hsh, 31) + (f.sAlive[i] ? f.sKind[i] * 7919 + f.sX[i] * 131 + f.sY[i] : 1) + f.sLevel[i] * 17 + (f.sOwner[i] + 1) * 3 + f.sOpen[i] * 5 + f.sEvo[i] * 11) | 0;
    }
    sig += ':' + f.tier;
    sig += ':' + hsh;
    if (sig === this.structSig || this.structAt.length === 0) return;
    this.structSig = sig;
    this.structsVersion++;
    const g = this.structAt, w = this.w;
    g.fill(0);
    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sAlive[i]) continue;
      for (let y = f.sY[i]; y < f.sY[i] + f.sH[i]; y++) for (let x = f.sX[i]; x < f.sX[i] + f.sW[i]; x++) {
        if (x < w && y < this.h) g[y * w + x] = i + 1;
      }
    }
  }

  // Progress since the newest frame came: 0 on its arrival, 1 one mean interval later. For
  // what is still drawn from the last two frames alone (the evac Huey) and the countdowns.
  alpha(now: number): number {
    return Math.min(1, Math.max(0, (now - this.frameAt) / this.interval));
  }

  // Draws the creeps and players at renderTime, now - delay, into rx/ry and prx/pry/paim.
  interpolate(now: number): void {
    const dt = this.drawnAt > 0 ? Math.min(100, Math.max(0, now - this.drawnAt)) : 0;
    this.drawnAt = now;
    const step = dt * DELAY_SLEW;
    this.delay += Math.min(step, Math.max(-step, this.delayGoal - this.delay));
    const b = this.brNow;
    this.bracket(now - this.delay, this.snap, b);
    const k = Math.exp(-dt / BLEND_MS), H = HIST;
    const f = this.cur, ex = this.ex, ey = this.ey;
    for (let i = 0; i < f.nCreeps; i++) {
      const id = f.cId[i];
      this.sample(this.hx, this.hy, id * H, this.since[id], b);
      ex[id] *= k; ey[id] *= k;
      this.rx[i] = this.sx + ex[id];
      this.ry[i] = this.sy + ey[id];
    }
    for (let i = 0; i < f.nPlayers; i++) {
      const id = f.players[i].id;
      this.sample(this.phx, this.phy, id * H, this.pSince[id], b);
      this.pex[id] *= k; this.pey[id] *= k; this.pea[id] *= k;
      this.prx[id] = this.sx + this.pex[id];
      this.pry[id] = this.sy + this.pey[id];
      this.paim[id] = this.sampleAim(id * H, this.pSince[id], b) + this.pea[id];
    }
    this.drawMe(now);
  }

  // Puts the page's own survivor where prediction has them, easing over from the interpolated
  // view when it starts, and back when it ends.
  private drawMe(now: number): void {
    const me = this.me();
    if (!me) { this.predicted = false; return; }
    const id = me.id, p = this.predict;
    const lx = p.x, ly = p.y, la = p.aim;
    if (p.draw(now)) {
      if (!this.predicted) p.carry(this.prx[id] - p.x, this.pry[id] - p.y);
      this.prx[id] = p.x; this.pry[id] = p.y;
      // Shooting, the host turns the hero to the target; the frames say where.
      if (!(me.flags & PF_FIRING)) this.paim[id] = p.aim;
      this.predicted = true;
    } else if (this.predicted) {
      this.predicted = false;
      if (!p.lost && Math.abs(lx - this.prx[id]) + Math.abs(ly - this.pry[id]) < 1.5) {
        this.pex[id] += lx - this.prx[id]; this.pey[id] += ly - this.pry[id];
        const da = la - this.paim[id];
        this.pea[id] += Math.atan2(Math.sin(da), Math.cos(da));
        this.prx[id] = lx; this.pry[id] = ly; this.paim[id] = la;
      }
    }
  }

  tile(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 6;
    return this.tiles[y * this.w + x];
  }

  structAtTile(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return this.structAt[y * this.w + x] - 1;
  }
}
