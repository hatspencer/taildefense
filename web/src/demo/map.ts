import { Ruin, SiteKind, Tile } from '../protocol';
import { CAMP_PLAN, CEMETERY_PLAN, CHECKPOINT_PLAN } from '../scene/places';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth value noise in [0, 1), a few octaves.
function noise(w: number, h: number, rnd: () => number, cell: number, octaves: number): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 1, total = 0;
  for (let oc = 0; oc < octaves; oc++) {
    const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
    const g = new Float32Array(gw * gh);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    for (let y = 0; y < h; y++) {
      const fy = y / cell, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < w; x++) {
        const fx = x / cell, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
        const a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
        out[y * w + x] += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy);
      }
    }
    total += amp; amp *= 0.5; cell = Math.max(2, cell / 2);
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

export interface DemoMap {
  tiles: Uint8Array;
  spawns: { x: number; y: number }[];
  // The wall ring around the base and where gates go.
  ring: { x0: number; y0: number; x1: number; y1: number };
  // The ruined houses, walls included.
  houses: { x: number; y: number; w: number; h: number; kind: Ruin }[];
  // The gas station by the west road: its shop, walls included, and its fuel pumps' tiles.
  station?: { x: number; y: number; w: number; h: number; pumps: [number, number][] };
  // The church out east, as the host lays it (internal/game/church.go): its nave, the rope
  // spot inside at the tower's foot, and the way the tower faces.
  church?: { x: number; y: number; w: number; h: number; sx: number; sy: number; yaw: number };
  // The places of internal/game/landmarks.go, laid from the same plans: the checkpoint across
  // the south road (its box the tent, its trucks' tiles), the cemetery and the quarantine camp.
  places: { kind: SiteKind; x: number; y: number; w: number; h: number; sx: number; sy: number; yaw: number; trucks: [number, number][] }[];
}

// planAt is the tile of cell lx, ly of a plan laid from ax, ay, its rows along fx, fy
// (landmarks.go planAt).
const planAt = (ax: number, ay: number, fx: number, fy: number, lx: number, ly: number): [number, number] => [ax + lx * fy + ly * fx, ay - lx * fx + ly * fy];

// The church's plan, as the host's: x across the nave, y along it to the tower.
const CHURCH = [
  '#########', '#.......#', '#.......#', '#.......#', '........#', '#.......#', '#.......#', '#.......#', '#........',
  '#.......#', '#.......#', '#.......#', '#.......#', '#..###..#', '   ###   ', '   ###   ', '   ###   ',
];

export function generateMap(w: number, h: number, seed: number): DemoMap {
  const rnd = rng(seed);
  const t = new Uint8Array(w * h);
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  const lake = noise(w, h, rnd, 40, 3);
  const forest = noise(w, h, rnd, 24, 3);
  const dry = noise(w, h, rnd, 30, 2);
  const set = (x: number, y: number, v: number) => { if (x >= 0 && y >= 0 && x < w && y < h) t[y * w + x] = v; };
  const get = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? t[y * w + x] : Tile.Rock);

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const dc = Math.hypot(x - cx, (y - cy) * 1.3);
    let v = Tile.Grass;
    if (dry[i] > 0.66) v = Tile.Sand;
    if (lake[i] > 0.64 && dc > 34) v = Tile.Water;
    else if (forest[i] > 0.6 && dc > 30 && rnd() < 0.75) v = Tile.Tree;
    else if (rnd() < 0.006 && dc > 28) v = Tile.Tree;
    else if (rnd() < 0.002 && dc > 28) v = Tile.Rock;
    t[i] = v;
  }
  // Shores.
  const shore = t.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (t[y * w + x] !== Tile.Grass) continue;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (get(x + dx, y + dy) === Tile.Water) { near = true; break; }
    if (near) shore[y * w + x] = Tile.Sand;
  }
  t.set(shore);

  // Ruined houses of all kinds, laid out as the host lays them (internal/game/ruins.go).
  const houses: DemoMap['houses'] = [];
  for (let n = 0; n < 40; n++) {
    const kind = pickRuin(rnd), sz = RUIN_SIZE[kind];
    const rw = sz[0] + Math.floor(rnd() * (sz[1] + 1)), rh = sz[2] + Math.floor(rnd() * (sz[3] + 1));
    const x0 = 6 + Math.floor(rnd() * (w - rw - 12)), y0 = 6 + Math.floor(rnd() * (h - rh - 12));
    if (Math.hypot(x0 + rw / 2 - cx, y0 + rh / 2 - cy) < 40) continue;
    if (houses.some((o) => x0 < o.x + o.w + 1 && o.x < x0 + rw + 1 && y0 < o.y + o.h + 1 && o.y < y0 + rh + 1)) continue;
    houses.push({ x: x0, y: y0, w: rw, h: rh, kind });
    house(t, w, rnd, x0, y0, rw, rh, kind);
  }

  // Roads from the edges to the core, meandering far out and straight near the base.
  const spawns: { x: number; y: number }[] = [];
  const ends = [
    { x: 0, y: cy + 0.5 }, { x: w - 1, y: cy + 0.5 }, { x: cx + 0.5, y: 0 }, { x: cx + 0.5, y: h - 1 },
    { x: 0, y: h * 0.18 }, { x: w - 1, y: h * 0.82 }, { x: w * 0.2, y: h - 1 }, { x: w * 0.8, y: 0 },
  ];
  for (const e of ends) {
    spawns.push({ x: e.x + (e.x === 0 ? 0.5 : e.x === w - 1 ? 0.5 : 0), y: e.y + (e.y === 0 ? 0.5 : e.y === h - 1 ? 0.5 : 0) });
    const len = Math.hypot(cx + 0.5 - e.x, cy + 0.5 - e.y);
    const nx = -(cy + 0.5 - e.y) / len, ny = (cx + 0.5 - e.x) / len;
    const ph = rnd() * 6.28, fq = 2 + rnd() * 2;
    const steps = Math.ceil(len * 2);
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const amp = 9 * Math.sin(u * Math.PI) * Math.min(1, (1 - u) * 3);
      const off = amp * Math.sin(u * fq * Math.PI + ph);
      const px = e.x + (cx + 0.5 - e.x) * u + nx * off, py = e.y + (cy + 0.5 - e.y) * u + ny * off;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const d = Math.hypot(dx, dy);
        const x = Math.floor(px + dx), y = Math.floor(py + dy);
        if (d <= 1.6) set(x, y, Tile.Dirt);
        else if (d <= 3 && get(x, y) >= Tile.Water) set(x, y, Tile.Grass);
      }
    }
  }

  // The gas station, on the north side of the west road: a concrete lot, the shop at the back
  // with its door to the pumps, as the host lays it out.
  let station: DemoMap['station'];
  const sx0 = 44;
  let road = cy - 25;
  while (road < cy + 25 && get(sx0 + 8, road) !== Tile.Dirt) road++;
  if (road < cy + 25) {
    const top = road - 14;
    for (let y = top - 1; y <= top + 13; y++) for (let x = sx0 - 1; x <= sx0 + 16; x++) {
      if (y >= top && y < top + 13 && x >= sx0 && x < sx0 + 16) set(x, y, Tile.Floor);
      else if (get(x, y) >= Tile.Water) set(x, y, Tile.Dirt);
    }
    for (let y = top; y <= top + 5; y++) for (let x = sx0 + 4; x <= sx0 + 11; x++) {
      const edge = y === top || y === top + 5 || x === sx0 + 4 || x === sx0 + 11;
      if (edge && !(y === top + 5 && (x === sx0 + 7 || x === sx0 + 8))) set(x, y, Tile.Rock);
    }
    station = { x: sx0 + 4, y: top, w: 8, h: 6, pumps: [[sx0 + 6, top + 8], [sx0 + 9, top + 8], [sx0 + 6, top + 10], [sx0 + 9, top + 10]] };
    for (let i = houses.length - 1; i >= 0; i--) {
      const o = houses[i];
      if (o.x < sx0 + 18 && sx0 - 2 < o.x + o.w && o.y < top + 15 && top - 2 < o.y + o.h) houses.splice(i, 1);
    }
  }

  // The church out on the eastern outskirts, its tower towards the base.
  const ccx = w - 30, ccy = Math.floor(h * 0.3), fx = -1, fy = 0;
  const at = (lx: number, ly: number): [number, number] => {
    const ox = lx - 4, oy = ly - 8;
    return [ccx + ox * fy + oy * fx, ccy - ox * fx + oy * fy];
  };
  for (let y = ccy - 11; y <= ccy + 11; y++) for (let x = ccx - 11; x <= ccx + 11; x++) if (get(x, y) >= Tile.Water || get(x, y) === Tile.Sand) set(x, y, Tile.Grass);
  for (let i = houses.length - 1; i >= 0; i--) {
    const o = houses[i];
    if (o.x < ccx + 12 && ccx - 12 < o.x + o.w && o.y < ccy + 12 && ccy - 12 < o.y + o.h) houses.splice(i, 1);
  }
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  CHURCH.forEach((row, ly) => [...row].forEach((c, lx) => {
    const [x, y] = at(lx, ly);
    if (c === '#') set(x, y, Tile.Rock); else if (c === '.') set(x, y, Tile.Floor);
    if (ly < 14) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }));
  const [rx, ry] = at(4, 12);
  const church = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, sx: rx + 0.5, sy: ry + 0.5, yaw: Math.atan2(fy, fx) };

  // The ground under a place cleared, and any house there knocked flat (landmarks.go flatten
  // and clearBox): the road's dirt stays.
  const clear = (x0: number, y0: number, x1: number, y1: number) => {
    for (let i = houses.length - 1; i >= 0; i--) {
      const o = houses[i];
      if (o.x > x1 || o.x + o.w - 1 < x0 || o.y > y1 || o.y + o.h - 1 < y0) continue;
      for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) set(x, y, Tile.Dirt);
      houses.splice(i, 1);
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (get(x, y) >= Tile.Water || get(x, y) === Tile.Sand) set(x, y, Tile.Grass);
  };
  // Lays plan from ax, ay along fx, fy: cells of solid as rock, of floor as floor, '.' as
  // ground, '=' as road; returns the place, its box the cells box picks out.
  const lay = (plan: string[], kind: SiteKind, ax: number, ay: number, fx: number, fy: number, ground: number, solid: string, box: (c: string) => boolean): DemoMap['places'][number] => {
    let bx0 = w, by0 = h, bx1 = 0, by1 = 0, sx = 0, sy = 0;
    const trucks: [number, number][] = [];
    plan.forEach((row, ly) => [...row].forEach((c, lx) => {
      const [x, y] = planAt(ax, ay, fx, fy, lx, ly);
      if (solid.includes(c)) set(x, y, Tile.Rock);
      else if (c === ',' || c === 's' || (c === '.' && kind === SiteKind.Checkpoint)) set(x, y, Tile.Floor);
      else if (c === '.') set(x, y, ground);
      else if (c === '=') set(x, y, Tile.Dirt);
      else if (c === 'T') trucks.push([x, y]);
      if (c === 's') { sx = x + 0.5; sy = y + 0.5; }
      if (box(c)) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
    }));
    return { kind, x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1, sx, sy, yaw: Math.atan2(fy, fx), trucks };
  };
  const places: DemoMap['places'] = [];
  // The cemetery out north-west and the camp out south-east, each its gate towards the base.
  for (const [plan, kind, px, py, ground] of [[CEMETERY_PLAN, SiteKind.Cemetery, 75, 40, Tile.Grass], [CAMP_PLAN, SiteKind.Camp, w - 100, h - 35, Tile.Dirt]] as const) {
    const pw = plan[0].length, pl = plan.length, r = (Math.max(pw, pl) >> 1) + 3;
    const ddx = cx - px, ddy = cy - py, ax_ = Math.abs(ddx) >= Math.abs(ddy);
    const ffx = ax_ ? Math.sign(ddx) : 0, ffy = ax_ ? 0 : Math.sign(ddy);
    clear(px - r, py - r, px + r, py + r);
    places.push(lay(plan, kind, px - (pw >> 1) * ffy - (pl >> 1) * ffx, py + (pw >> 1) * ffx - (pl >> 1) * ffy, ffx, ffy, ground, kind === SiteKind.Cemetery ? 'fg#' : 'wc', () => true));
  }
  // The checkpoint across the south road, where it runs straightest, its tent to the west.
  const roadX = (y: number) => {
    let n = 0, s = 0;
    for (let x = cx - 16; x <= cx + 16; x++) if (get(x, y) === Tile.Dirt) { n++; s += x; }
    return n ? s / n : NaN;
  };
  let best = -1, bestBend = Infinity;
  for (let y = cy + 70; y <= cy + 92; y++) {
    const a = roadX(y - 11), b = roadX(y), c = roadX(y + 11), bend = Math.abs(a - c) + Math.abs(b - (a + c) / 2);
    if (bend < bestBend) { best = y; bestBend = bend; }
  }
  if (best > 0) {
    const px = Math.floor(roadX(best)) - 1, py = best;
    clear(px - 11, py - 14, px + 12, py + 14);
    places.push(lay(CHECKPOINT_PLAN, SiteKind.Checkpoint, px - 7, py + 11, 1, 0, Tile.Floor, 'bSc', (c) => c === 'c'));
  }

  // A hamlet along the east road: a row of houses each side, doors to the street.
  const kinds = [Ruin.Terrace, Ruin.Cottage, Ruin.Shell, Ruin.TwoRoom, Ruin.Cottage, Ruin.Terrace, Ruin.Collapsed, Ruin.Shell, Ruin.L, Ruin.Cottage];
  let ki = 0;
  for (const side of [-1, 1]) {
    for (let x = cx + 46; x < cx + 100;) {
      const kind = kinds[ki++ % kinds.length], sz = RUIN_SIZE[kind];
      const rw = sz[0] + Math.floor(rnd() * (sz[1] + 1)), rh = Math.min(sz[2] + Math.floor(rnd() * (sz[3] + 1)), 7);
      // The street's edge under the house's length, and a yard of a tile or two.
      let edge = side < 0 ? Infinity : -Infinity;
      for (let xx = x; xx < x + rw; xx++) for (let y = cy - 16; y <= cy + 16; y++) if (get(xx, y) === Tile.Dirt) edge = side < 0 ? Math.min(edge, y) : Math.max(edge, y);
      if (!Number.isFinite(edge)) { x += 4; continue; }
      const yard = 1 + Math.floor(rnd() * 2), y0 = side < 0 ? edge - yard - rh : edge + yard + 1;
      clear(x - 1, y0 - 1, x + rw, y0 + rh);
      for (let y = y0; y < y0 + rh; y++) for (let xx = x; xx < x + rw; xx++) set(xx, y, Tile.Grass);
      houses.push({ x, y: y0, w: rw, h: rh, kind });
      house(t, w, rnd, x, y0, rw, rh, kind, side < 0 ? 's' : 'n');
      x += rw + 1 + Math.floor(rnd() * 3);
    }
  }

  // The base: cleared ground, a concrete floor inside the wall ring.
  const ring = { x0: cx - 14, y0: cy - 14, x1: cx + 14, y1: cy + 14 };
  for (let y = cy - 34; y <= cy + 34; y++) for (let x = cx - 40; x <= cx + 40; x++) {
    const v = get(x, y);
    if (v >= Tile.Water && Math.hypot((x - cx) / 40, (y - cy) / 34) < 1) set(x, y, Tile.Grass);
  }
  for (let y = ring.y0 + 1; y < ring.y1; y++) for (let x = ring.x0 + 1; x < ring.x1; x++) {
    const corner = (x < ring.x0 + 3 || x > ring.x1 - 3) && (y < ring.y0 + 3 || y > ring.y1 - 3);
    if (!corner) set(x, y, Tile.Floor);
  }
  return { tiles: t, spawns, ring, houses, station, church, places };
}

const RUIN_ODDS = [22, 15, 13, 9, 11, 16, 6, 8];
const RUIN_SIZE = [[4, 6, 4, 5], [7, 4, 6, 3], [7, 4, 7, 3], [10, 4, 7, 3], [4, 2, 4, 2], [5, 6, 5, 5], [11, 4, 5, 2], [6, 5, 5, 4]];

function pickRuin(rnd: () => number): Ruin {
  let r = Math.floor(rnd() * 100);
  for (let k = 0; k < RUIN_ODDS.length; k++) { if (r < RUIN_ODDS[k]) return k as Ruin; r -= RUIN_ODDS[k]; }
  return Ruin.Cottage;
}

// A ruined house of kind k over the box bx, by, bw, bh, its middle open floor (ruins.go house).
// front, when given, is the side its first door is on: a hamlet's, to the street.
function house(t: Uint8Array, w: number, rnd: () => number, bx: number, by: number, bw: number, bh: number, k: Ruin, front?: 'n' | 's'): void {
  const ri = (n: number) => Math.floor(rnd() * n);
  const mx = bx + (bw >> 1), my = by + (bh >> 1);
  let cx0 = 0, cy0 = 0, cx1 = -1, cy1 = -1;
  if (k === Ruin.L) {
    const cw = 2 + ri((bw >> 1) - 2), ch = 2 + ri((bh >> 1) - 2);
    cx0 = ri(2) ? bx : bx + bw - cw; cy0 = ri(2) ? by : by + bh - ch;
    cx1 = cx0 + cw - 1; cy1 = cy0 + ch - 1;
  }
  const inside = (x: number, y: number) => x >= bx && y >= by && x < bx + bw && y < by + bh && !(x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1);
  const floor = k === Ruin.L || k === Ruin.TwoRoom || k === Ruin.Terrace ? Tile.Floor : Tile.Dirt;
  for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
    if (!inside(x, y)) continue;
    let edge = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!inside(x + dx, y + dy)) edge = true;
    t[y * w + x] = edge ? Tile.Rock : floor;
  }
  if (k === Ruin.TwoRoom) {
    if (bw >= bh) {
      const px = bx + Math.floor(bw / 3), gap = by + 1 + ri(bh - 3);
      for (let y = by + 1; y < by + bh - 1; y++) if (y !== gap && y !== gap + 1) t[y * w + px] = Tile.Rock;
    } else {
      const py = by + Math.floor(bh / 3), gap = bx + 1 + ri(bw - 3);
      for (let x = bx + 1; x < bx + bw - 1; x++) if (x !== gap && x !== gap + 1) t[py * w + x] = Tile.Rock;
    }
  }
  const rock = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y * w + x < t.length && t[y * w + x] === Tile.Rock;
  const open = (x: number, y: number) => { t[y * w + x] = Tile.Dirt; };
  // The way a straight run of outer wall at x, y runs, open floor one side and outside the other.
  const door = (x: number, y: number): [number, number] | null => {
    if (!rock(x, y) || !inside(x, y)) return null;
    if (rock(x - 1, y) && rock(x + 1, y) && inside(x, y - 1) !== inside(x, y + 1) && !rock(x, y - 1) && !rock(x, y + 1)) return [1, 0];
    if (rock(x, y - 1) && rock(x, y + 1) && inside(x - 1, y) !== inside(x + 1, y) && !rock(x - 1, y) && !rock(x + 1, y)) return [0, 1];
    return null;
  };
  const doors: [number, number][] = [];
  for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) if (door(x, y)) doors.push([x, y]);
  const fronts = doors.filter(([, y]) => front === 'n' ? y === by : front === 's' ? y === by + bh - 1 : false);
  const opening = () => {
    if (!doors.length) return;
    const pick = fronts.length ? fronts.splice(ri(fronts.length), 1)[0] : doors[ri(doors.length)];
    const [x, y] = pick, d = door(x, y);
    if (!d) return;
    const two = door(x + d[0], y + d[1]);
    open(x, y);
    if (two) open(x + d[0], y + d[1]);
  };
  const rubble = (n: number) => {
    for (let i = 0; i < n * 4 && n > 0; i++) {
      const x = bx + 1 + ri(bw - 2), y = by + 1 + ri(bh - 2);
      if ((Math.abs(x - mx) <= 1 && Math.abs(y - my) <= 1) || t[y * w + x] !== floor) continue;
      t[y * w + x] = Tile.Rock; n--;
    }
  };
  switch (k) {
    case Ruin.Barn:
      for (let o = -1; o <= 1; o++) {
        if (bw >= bh) { open(bx, my + o); open(bx + bw - 1, my + o); } else { open(mx + o, by); open(mx + o, by + bh - 1); }
      }
      rubble(2 + ri(3));
      break;
    case Ruin.Collapsed:
      opening();
      for (let i = 0, n = 2 + ri(3); i < n && doors.length; i++) {
        const [x0, y0] = doors[ri(doors.length)], d = door(x0, y0);
        let ok = !!d;
        for (let j = 0, m = 1 + ri(3); d && ok && j < m; j++) {
          const x = x0 + d[0] * j, y = y0 + d[1] * j;
          ok = !!door(x + d[0], y + d[1]);
          open(x, y);
        }
      }
      rubble(1 + ri(3));
      break;
    case Ruin.TwoRoom: case Ruin.L:
      opening();
      if (ri(2) === 0) opening();
      break;
    case Ruin.Terrace: {
      // Three houses in a row under one roof that is gone: party walls, a door each to the front.
      const along = bw >= bh, n = along ? bw : bh;
      for (const f of [Math.floor(n / 3), Math.floor(2 * n / 3)]) {
        for (let j = 1; j < (along ? bh : bw) - 1; j++) t[along ? (by + j) * w + bx + f : (by + f) * w + bx + j] = Tile.Rock;
      }
      const fy = front === 'n' ? by : by + bh - 1;
      for (const m of [Math.floor(n / 6), Math.floor(n / 2), Math.floor(5 * n / 6)]) if (along) open(bx + m, fy);
      if (!along) { opening(); opening(); }
      break;
    }
    case Ruin.Shell: {
      // Burnt out: only stubs of wall left by the corners, rubble inside.
      for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
        if (!rock(x, y)) continue;
        const cx2 = Math.min(x - bx, bx + bw - 1 - x), cy2 = Math.min(y - by, by + bh - 1 - y);
        if (Math.max(cx2, cy2) > 1 + ri(2)) open(x, y);
      }
      rubble(2 + ri(3));
      break;
    }
    default:
      opening();
  }
}
