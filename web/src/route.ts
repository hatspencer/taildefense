import { K_ARMORY, Tile } from './protocol';
import type { Game } from './state';

// The way the creeps of the waves walk in, as the host's maze field has it (flow.go): round
// every wall and shut gate, through open gates, eight ways without cutting a corner past
// solid ground or a building. Worked out over a window round the build ring only, from
// eight points out past it, for the build mode's preview of how a wall changes the maze.

const PAD = 10; // the window reaches this far past the build ring
const ENTRIES = 8;
const FAR = 1 << 30;

export interface RouteSet {
  // Each entry's way in as tile indices of the window, generator last; empty when it has none.
  paths: Int32Array[];
  // The average walk in from the entries, in tiles; -1 when the base is sealed.
  walk: number;
}

export class Routes {
  private n = 0; private x0 = 0; private y0 = 0;
  private dist = new Int32Array(0); private next = new Int32Array(0); private block = new Uint8Array(0);
  private heap: number[] = [];
  private baseKey = ''; private base: RouteSet = { paths: [], walk: -1 };
  private withKey = ''; private with: RouteSet = { paths: [], walk: -1 };

  // The maze as it stands, and with a structure of w by h more at tx, ty; cached until either
  // changes. A trap stops nobody, so it leaves the maze as it is.
  get(game: Game, ghost?: { tx: number; ty: number; w: number; h: number; floor?: boolean }): { now: RouteSet; then: RouteSet | null } {
    const v = `${game.structsVersion}`;
    if (v !== this.baseKey) { this.baseKey = v; this.base = this.solve(game); this.withKey = ''; }
    if (!ghost || ghost.floor) return { now: this.base, then: null };
    const k = `${v}:${ghost.tx},${ghost.ty},${ghost.w},${ghost.h}`;
    if (k !== this.withKey) { this.withKey = k; this.with = this.solve(game, ghost); }
    return { now: this.base, then: this.with };
  }

  // Window coordinates of index i, in tiles.
  tileX(i: number): number { return this.x0 + (i % this.n); }
  tileY(i: number): number { return this.y0 + Math.floor(i / this.n); }

  private solve(game: Game, ghost?: { tx: number; ty: number; w: number; h: number; floor?: boolean }): RouteSet {
    const wd = game.welcome, f = game.cur;
    if (!wd) return { paths: [], walk: -1 };
    const r = Math.ceil(wd.buildRadius) + PAD, n = 2 * r + 1;
    const cx = Math.floor(wd.core.x), cy = Math.floor(wd.core.y);
    this.n = n; this.x0 = cx - r; this.y0 = cy - r;
    if (this.dist.length !== n * n) { this.dist = new Int32Array(n * n); this.next = new Int32Array(n * n); this.block = new Uint8Array(n * n); }
    const dist = this.dist, next = this.next, block = this.block;
    // block: 1 solid ground or a creep wall, 2 the armory (gone round, and no goal either);
    // goals are the generator's tiles.
    const goals: number[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = this.x0 + i, y = this.y0 + j, k = j * n + i;
      let b = game.tile(x, y) >= Tile.Water ? 1 : 0;
      const s = game.structAtTile(x, y);
      if (s >= 0) {
        if (s === coreIndex(game)) { goals.push(k); b = 0; }
        else if (f.sKind[s] === K_ARMORY) b = 1;
        else if (!f.sOpen[s] && !wd.structs[f.sKind[s]]?.floor) b = 1;
      }
      if (ghost && x >= ghost.tx && x < ghost.tx + ghost.w && y >= ghost.ty && y < ghost.ty + ghost.h) b = 1;
      block[k] = b;
      dist[k] = FAR; next[k] = -1;
    }
    const h = this.heap; h.length = 0;
    for (const k of goals) { dist[k] = 0; push(h, k); }
    while (h.length) {
      const top = pop(h), d = Math.floor(top / 2 ** 22), k = top % 2 ** 22;
      if (d > dist[k]) continue;
      const x = k % n, y = (k - x) / n;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const nk = ny * n + nx;
        if (block[nk]) continue;
        if (dx && dy && (block[y * n + nx] || block[ny * n + x])) continue;
        const nd = d + (dx && dy ? 14 : 10);
        if (nd < dist[nk]) { dist[nk] = nd; next[nk] = k; push(h, nd * 2 ** 22 + nk); }
      }
    }
    const paths: Int32Array[] = [];
    let sum = 0, got = 0;
    for (let e = 0; e < ENTRIES; e++) {
      const a = (e / ENTRIES) * Math.PI * 2;
      const k = this.entry(Math.round(r + Math.cos(a) * (r - 2)), Math.round(r + Math.sin(a) * (r - 2)));
      if (k < 0) { paths.push(new Int32Array(0)); continue; }
      const p: number[] = [];
      for (let at = k; at >= 0 && p.length < n * n; at = next[at]) p.push(at);
      paths.push(Int32Array.from(p));
      sum += dist[k] / 10; got++;
    }
    return { paths, walk: got ? sum / got : -1 };
  }

  // The reachable tile nearest window tile i, j, searching a little round it; -1 if none.
  private entry(i: number, j: number): number {
    const n = this.n;
    for (let s = 0; s <= 4; s++) for (let dy = -s; dy <= s; dy++) for (let dx = -s; dx <= s; dx++) {
      const x = i + dx, y = j + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      if (this.dist[y * n + x] < FAR) return y * n + x;
    }
    return -1;
  }
}

function coreIndex(game: Game): number {
  const wd = game.welcome!;
  return game.structAtTile(Math.floor(wd.core.x), Math.floor(wd.core.y));
}

// A binary min-heap of distance * 2^22 + index, as numbers.
function push(h: number[], v: number): void {
  let j = h.length; h.push(v);
  while (j > 0) { const p = (j - 1) >> 1; if (h[p] <= h[j]) break; [h[p], h[j]] = [h[j], h[p]]; j = p; }
}
function pop(h: number[]): number {
  const top = h[0], last = h.pop()!;
  if (h.length) {
    h[0] = last;
    let j = 0;
    for (;;) {
      const l = 2 * j + 1; if (l >= h.length) break;
      const m = l + 1 < h.length && h[l + 1] < h[l] ? l + 1 : l;
      if (h[j] <= h[m]) break;
      [h[j], h[m]] = [h[m], h[j]]; j = m;
    }
  }
  return top;
}
