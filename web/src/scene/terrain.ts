import * as THREE from 'three/webgpu';
import { color, dot, floor, fract, mix, normalWorld, positionWorld, sin, smoothstep, time, vec2, vec3, vertexColor, float } from 'three/tsl';
import { Tile } from '../protocol';
import { box, cone, cyl, dodeca, merge, part, setEmissive, writeMatrix } from './util';
import { uSnow, uWet } from './weather';

function hash(x: number, y: number, s = 0): number {
  let h = Math.imul(x * 374761393 + y * 668265263 + s * 1442695041, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Overgrown suburbia: olive grass, trodden dirt, cracked concrete, murky ponds.
const GROUND: Record<number, number> = {
  [Tile.Grass]: 0x5c7a32, [Tile.Dirt]: 0x76603f, [Tile.Floor]: 0x7f7c72, [Tile.Sand]: 0xab9a6c,
  [Tile.Water]: 0x3c4a3a, [Tile.Tree]: 0x4e6a2c, [Tile.Rock]: 0x6a6456,
};

// Per-texel noise in world space, four texels to a tile: chunky ground texture with no image.
function texelNoise(perTile: number, seed: number) {
  const cell = floor(positionWorld.xz.mul(perTile));
  return fract(sin(dot(cell.add(seed), vec2(12.9898, 78.233))).mul(43758.5453));
}

export const WATER_Y = -0.24;

// One prop's instances over the whole map, built in blocks of it so those out of view, or out
// of the sun's shadow frustum, are skipped rather than drawn.
const BLOCK = 32;
class Scatter {
  private mats: number[] = []; private cols: number[] = []; private keys: number[] = [];
  private m = new Float32Array(16);

  add(x: number, z: number, heading: number, s: number, sy = s, col?: number[]): void {
    writeMatrix(this.m, 0, x, 0, z, heading, s, sy);
    for (let i = 0; i < 16; i++) this.mats.push(this.m[i]);
    if (col) this.cols.push(col[0], col[1], col[2]);
    this.keys.push(Math.floor(x / BLOCK) * 1024 + Math.floor(z / BLOCK));
  }

  build(group: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean): void {
    const blocks = new Map<number, number[]>();
    this.keys.forEach((k, i) => { let l = blocks.get(k); if (!l) blocks.set(k, l = []); l.push(i); });
    const tinted = this.cols.length > 0;
    for (const list of blocks.values()) {
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      m.castShadow = shadow; m.receiveShadow = true;
      const a = m.instanceMatrix.array as Float32Array;
      const c = tinted ? new Float32Array(list.length * 3) : null;
      list.forEach((i, j) => {
        for (let e = 0; e < 16; e++) a[j * 16 + e] = this.mats[i * 16 + e];
        if (c) for (let e = 0; e < 3; e++) c[j * 3 + e] = this.cols[i * 3 + e];
      });
      if (c) m.instanceColor = new THREE.InstancedBufferAttribute(c, 3);
      m.computeBoundingSphere();
      group.add(m);
    }
  }
}

// Weather on a colour: wet darkens it, snow settles white on whatever faces up.
function weathered(c: THREE.Node<'vec3'>, up: THREE.Node<'float'>): THREE.Node<'vec3'> {
  const n = texelNoise(3, 41);
  const wet = c.mul(float(1).sub(uWet.mul(0.28)));
  return mix(wet, vec3(0.84, 0.87, 0.9).mul(n.mul(0.1).add(0.92)), uSnow.mul(0.85).mul(smoothstep(0.35, 0.8, up)).mul(n.mul(0.35).add(0.65)));
}

// A lit material for instanced props that takes the weather.
function propMaterial(): THREE.MeshLambertNodeMaterial {
  const m = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
  m.colorNode = weathered(vertexColor().rgb, normalWorld.y);
  return m;
}

export class Terrain {
  group = new THREE.Group();
  private disposables: { dispose(): void }[] = [];

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  clear(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.group.clear();
  }

  build(tiles: Uint8Array, w: number, h: number): void {
    this.clear();
    this.buildGround(tiles, w, h);
    this.buildWater(w, h);
    this.buildTrees(tiles, w, h);
    this.buildRocks(tiles, w, h);
    this.buildScrub(tiles, w, h);
  }

  private tileHeight(t: number, x: number, y: number): number {
    switch (t) {
      case Tile.Water: return -0.75;
      case Tile.Dirt: return -0.03;
      case Tile.Floor: return 0.03;
      default: return (hash(x, y, 9) - 0.5) * 0.08;
    }
  }

  private buildGround(tiles: Uint8Array, w: number, h: number): void {
    // Corner heights average the tiles around them, which slopes the shores.
    const ch = new Float32Array((w + 1) * (h + 1));
    for (let y = 0; y <= h; y++) for (let x = 0; x <= w; x++) {
      let s = 0, n = 0, water = 0;
      for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) {
        const tx = x + dx, ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const t = tiles[ty * w + tx];
        s += this.tileHeight(t, tx, ty); n++;
        if (t === Tile.Water) water++;
      }
      ch[y * (w + 1) + x] = n ? (water && water < n ? Math.min(s / n, -0.3) : s / n) : 0;
    }
    const n = w * h;
    const pos = new Float32Array(n * 12), col = new Float32Array(n * 12);
    const idx = new Uint32Array(n * 6);
    const c = new THREE.Color();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, t = tiles[i];
      const v = i * 4;
      const hs = [ch[y * (w + 1) + x], ch[y * (w + 1) + x + 1], ch[(y + 1) * (w + 1) + x + 1], ch[(y + 1) * (w + 1) + x]];
      const xs = [x, x + 1, x + 1, x], ys = [y, y, y + 1, y + 1];
      for (let k = 0; k < 4; k++) { pos[(v + k) * 3] = xs[k]; pos[(v + k) * 3 + 1] = hs[k]; pos[(v + k) * 3 + 2] = ys[k]; }
      c.setHex(GROUND[t] ?? GROUND[Tile.Grass], THREE.SRGBColorSpace);
      // Per-tile noise, plus a slab pattern on concrete and darker wheel ruts on roads.
      let m = 0.94 + hash(x, y) * 0.1;
      if (t === Tile.Floor) m *= ((x >> 1) + (y >> 1)) & 1 ? 1.03 : 0.97;
      if (t === Tile.Grass) {
        // Patches of dry, yellowed grass and darker, lusher ground.
        const big = hash(x >> 3, y >> 3, 3), mid = hash(x >> 1, y >> 1, 4);
        m *= 0.9 + big * 0.14 + (mid - 0.5) * 0.06;
        c.offsetHSL((big - 0.5) * 0.045 - (mid > 0.85 ? 0.03 : 0), mid > 0.85 ? -0.12 : 0, 0);
      }
      if (t === Tile.Floor && hash(x, y, 21) < 0.08) m *= 0.82;
      for (let k = 0; k < 4; k++) { col[(v + k) * 3] = c.r * m; col[(v + k) * 3 + 1] = c.g * m; col[(v + k) * 3 + 2] = c.b * m; }
      idx.set([v, v + 3, v + 1, v + 1, v + 3, v + 2], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
    const fine = texelNoise(4, 0), coarse = texelNoise(2, 7);
    const base = vertexColor().rgb.mul(fine.mul(0.07).add(0.965)).mul(coarse.mul(0.06).add(0.97));
    // Rain leaves puddles in the low spots: dark, with a cold sheen that ripples.
    const puddle = smoothstep(0.55, 0.75, texelNoise(0.5, 13).mul(0.6).add(texelNoise(1, 17).mul(0.4))).mul(uWet);
    const ripple = sin(time.mul(7).add(texelNoise(6, 23).mul(40))).mul(0.5).add(0.5);
    const sheen = vec3(0.24, 0.28, 0.32).mul(ripple.mul(0.25).add(0.85));
    mat.colorNode = mix(weathered(base, float(1)), sheen, puddle.mul(float(1).sub(uSnow)).mul(0.8));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'ground';
    this.group.add(mesh);

    // The world beyond the map edge, so the fog has something to fade.
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(w * 6, h * 6), new THREE.MeshLambertNodeMaterial({ color: 0x3e4f26 }));
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(w / 2, -0.12, h / 2);
    outer.receiveShadow = true;
    this.group.add(outer);
    this.disposables.push(geo, mat, outer.geometry, outer.material as THREE.Material);
  }

  private buildWater(w: number, h: number): void {
    const geo = new THREE.PlaneGeometry(w, h);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshPhongNodeMaterial({ transparent: true, shininess: 80, specular: 0x99bbcc });
    const p = positionWorld;
    const wave = sin(p.x.mul(1.7).add(time.mul(1.3))).mul(sin(p.z.mul(1.3).sub(time.mul(1.1)))).mul(0.5).add(0.5);
    const ripple = sin(p.x.add(p.z).mul(4.0).add(time.mul(2.5))).mul(0.5).add(0.5);
    mat.colorNode = mix(color(0x23383a), color(0x41605a), wave.mul(0.7).add(ripple.mul(0.3)));
    setEmissive(mat, vec3(0.02, 0.035, 0.03).mul(ripple));
    mat.opacityNode = float(0.8);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(w / 2, WATER_Y, h / 2);
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  private buildTrees(tiles: Uint8Array, w: number, h: number): void {
    let n = 0;
    for (let i = 0; i < tiles.length; i++) if (tiles[i] === Tile.Tree) n++;
    if (!n) return;
    const geoPine = merge([
      part(cyl(0.08, 0.12, 0.5, 5), 0x4a3524, 0, 0.25, 0),
      part(cone(0.6, 0.9, 6), 0x2c4524, 0, 0.85, 0),
      part(cone(0.46, 0.75, 6), 0x324e28, 0, 1.25, 0),
      part(cone(0.28, 0.6, 6), 0x3a582c, 0, 1.65, 0),
    ]);
    // Broad suburban shade trees: a heavy, lumpy crown on a dark trunk.
    const geoRound = merge([
      part(cyl(0.1, 0.15, 0.9, 5), 0x4a3524, 0, 0.45, 0),
      part(box(0.42, 0.08, 0.08), 0x4a3524, 0.2, 0.85, 0, 0, 0, 0.6),
      part(dodeca(0.62), 0x3c5a26, 0, 1.25, 0, 0.3, 0.2, 0, 1.1, 0.8, 1.05),
      part(dodeca(0.42), 0x46662c, 0.32, 1.5, 0.12),
      part(dodeca(0.4), 0x354f22, -0.3, 1.4, -0.2),
      part(dodeca(0.3), 0x50702f, 0.05, 1.72, -0.05),
    ]);
    const mat = propMaterial();
    const kinds = [geoPine, geoRound];
    const scatters = [new Scatter(), new Scatter()];
    const tint = new THREE.Color();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (tiles[y * w + x] !== Tile.Tree) continue;
      const k = hash(x >> 2, y >> 2, 5) < 0.6 ? 0 : 1;
      const s = 0.8 + hash(x, y, 1) * 0.5;
      // A few crowns are turning: autumn rust among the greens.
      const autumn = hash(x >> 1, y >> 1, 19) < 0.07;
      tint.setHSL(autumn ? 0.14 : 0.27 + (hash(x, y, 7) - 0.5) * 0.08, 0.5, 0.5);
      const b = 0.8 + hash(x, y, 8) * 0.35;
      const a = autumn ? [1.9, 1.05, 0.55] : [0.9 + (tint.r - 0.5) * 0.4, 1, 0.9 + (tint.b - 0.5) * 0.4];
      scatters[k].add(x + 0.5 + (hash(x, y, 2) - 0.5) * 0.3, y + 0.5 + (hash(x, y, 3) - 0.5) * 0.3, hash(x, y, 4) * 6.28,
        s, s * (0.85 + hash(x, y, 6) * 0.35), [b * a[0], b * a[1], b * a[2]]);
    }
    kinds.forEach((g, k) => scatters[k].build(this.group, g, mat, true));
    this.disposables.push(geoPine, geoRound, mat);
  }

  private buildRocks(tiles: Uint8Array, w: number, h: number): void {
    const isRock = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && tiles[y * w + x] === Tile.Rock;
    const walls: number[] = [], boulders: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!isRock(x, y)) continue;
      // Rock tiles in a line are ruined walls; lone ones are boulders.
      const line = isRock(x - 1, y) || isRock(x + 1, y) || isRock(x, y - 1) || isRock(x, y + 1);
      (line ? walls : boulders).push(x, y);
    }
    // Rock lines are the shells of houses: a brick footing, faded siding, a broken top.
    const wallGeo = merge([
      part(box(1, 0.3, 1), 0x6e3e30, 0, 0.15, 0),
      part(box(0.96, 0.7, 0.96), 0xb3a88c, 0, 0.65, 0),
      part(box(1, 0.06, 1), 0x8a8270, 0, 0.62, 0),
      part(box(0.98, 0.08, 0.98), 0x6a6458, 0, 1.0, 0),
      part(box(0.45, 0.3, 0.45), 0x9c9178, 0.22, 1.12, 0.18, 0, 0.4, 0),
    ]);
    // Lone rocks are junk: a rubble heap with a dumped crate.
    const boulderGeo = merge([
      part(dodeca(0.5), 0x6c665a, 0, 0.2, 0, 0, 0, 0, 1, 0.6, 1),
      part(dodeca(0.28), 0x7a6e5a, 0.3, 0.12, 0.2),
      part(box(0.4, 0.32, 0.4), 0x6a4a2c, -0.18, 0.36, -0.12, 0, 0.5, 0.15),
      part(box(0.7, 0.05, 0.12), 0x7a5a36, 0.05, 0.3, 0.25, 0, 0.9, 0.25),
    ]);
    const mat = propMaterial();
    const make = (geo: THREE.BufferGeometry, list: number[], place: (sc: Scatter, x: number, y: number, col: number[]) => void) => {
      const sc = new Scatter();
      for (let i = 0; i < list.length; i += 2) {
        const x = list[i], y = list[i + 1], b = 0.82 + hash(x, y, 11) * 0.3;
        place(sc, x, y, [b, b * 0.98, b * 0.94]);
      }
      sc.build(this.group, geo, mat, true);
    };
    make(wallGeo, walls, (sc, x, y, col) => {
      // Ruins are broken: each block has its own height, but never low enough to look like
      // something a shot would clear, since every wall tile stops bullets.
      const hgt = 0.8 + hash(x, y, 13) * 0.8;
      sc.add(x + 0.5, y + 0.5, Math.floor(hash(x, y, 14) * 4) * Math.PI / 2, 1, hgt, col);
    });
    make(boulderGeo, boulders, (sc, x, y, col) => {
      const s = 0.9 + hash(x, y, 15) * 0.5;
      sc.add(x + 0.5, y + 0.5, hash(x, y, 16) * 6.28, s, s * (0.8 + hash(x, y, 17) * 0.6), col);
    });
    this.disposables.push(wallGeo, boulderGeo, mat);
  }

  // Bushes and weeds on open grass, purely for looks.
  private buildScrub(tiles: Uint8Array, w: number, h: number): void {
    const spots: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (tiles[y * w + x] !== Tile.Grass) continue;
      const r = hash(x, y, 31);
      if (r < 0.035) spots.push(x, y, 0);
      else if (r < 0.08) spots.push(x, y, 1);
    }
    const bush = merge([
      part(dodeca(0.3), 0x3a5424, 0, 0.18, 0, 0, 0, 0, 1.2, 0.7, 1),
      part(dodeca(0.22), 0x46622a, 0.2, 0.22, 0.12),
      part(dodeca(0.2), 0x324a20, -0.15, 0.16, -0.16),
    ]);
    const weeds = merge([
      part(cone(0.06, 0.32, 3), 0x6a7a36, 0, 0.16, 0, 0.2, 0, 0.1),
      part(cone(0.05, 0.26, 3), 0x7a8442, 0.12, 0.13, 0.06, -0.2, 0, -0.15),
      part(cone(0.05, 0.28, 3), 0x5e6e30, -0.1, 0.14, -0.08, 0.1, 0, -0.25),
      part(box(0.05, 0.05, 0.05), 0xc8b860, 0.12, 0.28, 0.06),
    ]);
    const mat = propMaterial();
    // Knee high at most: their shadows are not worth drawing them twice.
    [bush, weeds].forEach((geo, k) => {
      const sc = new Scatter();
      for (let i = 0; i < spots.length; i += 3) {
        if (spots[i + 2] !== k) continue;
        const x = spots[i], y = spots[i + 1], s = 0.8 + hash(x, y, 32) * 0.6;
        sc.add(x + 0.2 + hash(x, y, 33) * 0.6, y + 0.2 + hash(x, y, 34) * 0.6, hash(x, y, 35) * 6.28, s);
      }
      sc.build(this.group, geo, mat, false);
    });
    this.disposables.push(bush, weeds, mat);
  }
}
