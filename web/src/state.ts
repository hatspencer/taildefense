import { Frame, MAX_CREEPS, PF_ALIVE, type Player, type Welcome, Weather, decodeFrame } from './protocol';
import { Vision } from './vision';

// Everything the client knows about the world: the last two frames and the interpolation
// state derived from them. Renderers read the r* arrays, indexed like the current frame.
// How long a ping stays on the map, in ms.
export const PING_LIFE = 5000;

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
  frameAt = 0;
  interval = 50;

  // Per creep id.
  private x0 = new Float32Array(MAX_CREEPS); private y0 = new Float32Array(MAX_CREEPS);
  private x1 = new Float32Array(MAX_CREEPS); private y1 = new Float32Array(MAX_CREEPS);
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

  // Per player id.
  private px0 = new Float32Array(256); private py0 = new Float32Array(256);
  private px1 = new Float32Array(256); private py1 = new Float32Array(256);
  private pAim0 = new Float32Array(256); private pAim1 = new Float32Array(256);
  prx = new Float32Array(256); pry = new Float32Array(256); paim = new Float32Array(256);

  private structSig = '';

  // Fog of war, when the host plays with it: creeps out of the team's sight are dropped from
  // each frame as it arrives, so nothing downstream shows them. hiddenAt[id] is the frame
  // serial a creep was last dropped on, which tells a creep walking into the dark from one
  // that died.
  vision: Vision | null = null;
  hiddenAt = new Uint32Array(MAX_CREEPS);

  reset(w: Welcome): void {
    w.siteKinds ??= []; w.sites ??= []; w.weathers ??= [{ name: 'Clear', info: '' }];
    w.difficulties ??= ['Normal']; w.difficulty ??= { id: 0, name: 'Normal' };
    w.taunt ??= { cool: 12, radius: 12, time: 5 }; w.revive ??= { reach: 1.6, time: 2.5, hp: 0.4 };
    this.welcome = w;
    this.w = w.w; this.h = w.h;
    this.vision = w.fogOfWar ? new Vision(w.w, w.h, w) : null;
    this.hiddenAt.fill(0);
    this.frames++;
    this.seen.fill(0);
    this.indexById.fill(-1);
    this.cur.nCreeps = 0; this.cur.nStructs = 0; this.cur.nPlayers = 0; this.cur.nSites = 0;
    this.structSig = '';
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
    if (this.frameAt > 0) this.interval = Math.min(120, Math.max(30, this.interval * 0.9 + (now - this.frameAt) * 0.1));
    this.frameAt = now;
    const contiguous = f.tick === prevTick + 1 || f.tick === prevTick;
    if (this.vision && this.welcome) this.hideUnseen(f, serial);

    const prevIndex = this.indexById;
    for (let i = 0; i < this.back.nCreeps; i++) prevIndex[this.back.cId[i]] = -1;
    for (let i = 0; i < f.nCreeps; i++) {
      const id = f.cId[i], x = f.cX[i], y = f.cY[i], k = f.cKind[i];
      prevIndex[id] = i;
      const known = this.seen[id] === serial - 1 && contiguous && this.kindById[id] === k;
      const ox = this.x1[id], oy = this.y1[id];
      const dx = x - ox, dy = y - oy;
      if (known && dx * dx + dy * dy < 9) {
        this.x0[id] = ox; this.y0[id] = oy;
        if (dx * dx + dy * dy > 1e-4) this.heading[id] = Math.atan2(dy, dx);
        if (f.cHp[i] < this.hpById[id]) this.flashUntil[id] = now + 90;
      } else {
        this.x0[id] = x; this.y0[id] = y;
        this.flashUntil[id] = 0;
        if (!known) this.heading[id] = Math.random() * Math.PI * 2;
      }
      this.x1[id] = x; this.y1[id] = y;
      this.kindById[id] = k; this.hpById[id] = f.cHp[i];
      this.seen[id] = serial;
    }

    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i], id = p.id;
      const old = this.back.player(id);
      const jump = !old || Math.abs(p.x - this.px1[id]) + Math.abs(p.y - this.py1[id]) > 4;
      this.px0[id] = jump ? p.x : this.px1[id]; this.py0[id] = jump ? p.y : this.py1[id];
      this.pAim0[id] = jump ? p.aim : this.pAim1[id];
      this.px1[id] = p.x; this.py1[id] = p.y; this.pAim1[id] = p.aim;
      if (!(p.flags & PF_ALIVE)) { this.px0[id] = p.x; this.py0[id] = p.y; }
    }

    this.updateStructGrid();
    return f;
  }

  // How many guards site i has left, or -1 while fog of war keeps that from the team.
  guardsLeft(i: number): number {
    return this.vision && !this.vision.knows(i) ? -1 : this.cur.siteGuards(i);
  }

  private hideUnseen(f: Frame, serial: number): void {
    const v = this.vision!;
    v.update(f, this.welcome!);
    let n = 0;
    for (let i = 0; i < f.nCreeps; i++) {
      if (!v.sees(f.cX[i], f.cY[i])) { this.hiddenAt[f.cId[i]] = serial; continue; }
      if (n !== i) {
        f.cId[n] = f.cId[i]; f.cX[n] = f.cX[i]; f.cY[n] = f.cY[i]; f.cKind[n] = f.cKind[i];
        f.cHp[n] = f.cHp[i]; f.cFlags[n] = f.cFlags[i]; f.cTarget[n] = f.cTarget[i];
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
      hsh = (Math.imul(hsh, 31) + (f.sAlive[i] ? f.sKind[i] * 7919 + f.sX[i] * 131 + f.sY[i] : 1) + f.sLevel[i] * 17 + (f.sOwner[i] + 1) * 3) | 0;
    }
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

  // Interpolation factor for now, 0 at the last frame's arrival, 1 one interval later.
  alpha(now: number): number {
    return Math.min(1, Math.max(0, (now - this.frameAt) / this.interval));
  }

  interpolate(now: number): void {
    const a = this.alpha(now);
    const f = this.cur;
    for (let i = 0; i < f.nCreeps; i++) {
      const id = f.cId[i];
      this.rx[i] = this.x0[id] + (this.x1[id] - this.x0[id]) * a;
      this.ry[i] = this.y0[id] + (this.y1[id] - this.y0[id]) * a;
    }
    for (let i = 0; i < f.nPlayers; i++) {
      const id = f.players[i].id;
      this.prx[id] = this.px0[id] + (this.px1[id] - this.px0[id]) * a;
      this.pry[id] = this.py0[id] + (this.py1[id] - this.py0[id]) * a;
      let d = this.pAim1[id] - this.pAim0[id];
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.paim[id] = this.pAim0[id] + d * a;
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
