import { Tile } from '../protocol';

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
  houses: { x: number; y: number; w: number; h: number }[];
  // The gas station by the west road: its shop, walls included, and its fuel pumps' tiles.
  station?: { x: number; y: number; w: number; h: number; pumps: [number, number][] };
}

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

  // Ruins: hollow rock rectangles with collapsed gaps and an old floor.
  const houses: DemoMap['houses'] = [];
  for (let n = 0; n < 22; n++) {
    const rw = 5 + Math.floor(rnd() * 8), rh = 4 + Math.floor(rnd() * 6);
    const x0 = 6 + Math.floor(rnd() * (w - rw - 12)), y0 = 6 + Math.floor(rnd() * (h - rh - 12));
    if (Math.hypot(x0 + rw / 2 - cx, y0 + rh / 2 - cy) < 40) continue;
    if (houses.some((o) => x0 < o.x + o.w + 1 && o.x < x0 + rw + 1 && y0 < o.y + o.h + 1 && o.y < y0 + rh + 1)) continue;
    houses.push({ x: x0, y: y0, w: rw, h: rh });
    for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) {
      const edge = x === x0 || y === y0 || x === x0 + rw - 1 || y === y0 + rh - 1;
      if (edge) set(x, y, rnd() < 0.78 ? Tile.Rock : Tile.Dirt);
      else set(x, y, rnd() < 0.85 ? Tile.Floor : Tile.Dirt);
    }
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
  return { tiles: t, spawns, ring, houses, station };
}
