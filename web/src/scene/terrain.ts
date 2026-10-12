import * as THREE from 'three/webgpu';
import { color, dot, floor, fract, mix, normalWorld, positionWorld, sin, smoothstep, time, vec2, vec3, vertexColor, float } from 'three/tsl';
import { Ruin, SiteKind, Tile, type SiteDef } from '../protocol';
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

// One prop's instances over the whole map, sorted into blocks of it. Only the blocks in view,
// or near enough to throw a shadow into it, are packed into the mesh and drawn. One mesh per
// prop rather than one per block: three builds every instanced mesh its own shaders, so a
// mesh per block meant a burst of shader builds whenever zooming out brought new blocks in.
const BLOCK = 32, REACH = 3, TALL = 4;
class Scatter {
  private mats: number[] = []; private cols: number[] = []; private keys: number[] = [];
  private m = new Float32Array(16);
  private mesh: THREE.InstancedMesh | null = null;
  private allM = new Float32Array(0); private allC: Float32Array | null = null;
  // Per block: its first instance, its end, and its box grown by how far a shadow reaches.
  private blocks: { from: number; to: number; box: THREE.Box3 }[] = [];
  private shown = '';

  add(x: number, z: number, heading: number, s: number, sy = s, col?: number[]): void {
    writeMatrix(this.m, 0, x, 0, z, heading, s, sy);
    for (let i = 0; i < 16; i++) this.mats.push(this.m[i]);
    if (col) this.cols.push(col[0], col[1], col[2]);
    this.keys.push(Math.floor(x / BLOCK) * 1024 + Math.floor(z / BLOCK));
  }

  build(group: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean): void {
    const n = this.keys.length;
    if (!n) return;
    const order = [...this.keys.keys()].sort((a, b) => this.keys[a] - this.keys[b]);
    const tinted = this.cols.length > 0;
    this.allM = new Float32Array(n * 16);
    this.allC = tinted ? new Float32Array(n * 3) : null;
    order.forEach((i, j) => {
      for (let e = 0; e < 16; e++) this.allM[j * 16 + e] = this.mats[i * 16 + e];
      if (this.allC) for (let e = 0; e < 3; e++) this.allC[j * 3 + e] = this.cols[i * 3 + e];
      const k = this.keys[i];
      if (j === 0 || this.keys[order[j - 1]] !== k) {
        const bx = Math.floor(k / 1024) * BLOCK, bz = (k - Math.floor(k / 1024) * 1024) * BLOCK;
        this.blocks.push({ from: j, to: j, box: new THREE.Box3(new THREE.Vector3(bx - REACH, 0, bz - REACH), new THREE.Vector3(bx + BLOCK + REACH, TALL, bz + BLOCK + REACH)) });
      }
      this.blocks[this.blocks.length - 1].to = j + 1;
    });
    this.mats = []; this.cols = []; this.keys = [];
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.castShadow = shadow; m.receiveShadow = true;
    // Culled here, block by block, for the view and the sun's frustum at once.
    m.frustumCulled = false;
    (m.instanceMatrix.array as Float32Array).set(this.allM);
    if (this.allC) m.instanceColor = new THREE.InstancedBufferAttribute(this.allC.slice(), 3);
    group.add(m);
    this.mesh = m;
  }

  // Packs the blocks the frustum touches to the front of the mesh, when that set changes.
  cull(fr: THREE.Frustum): void {
    const m = this.mesh;
    if (!m) return;
    let shown = '';
    for (let b = 0; b < this.blocks.length; b++) if (fr.intersectsBox(this.blocks[b].box)) shown += b + ',';
    if (shown === this.shown) return;
    this.shown = shown;
    const a = m.instanceMatrix.array as Float32Array, c = m.instanceColor?.array as Float32Array | undefined;
    let n = 0;
    for (const b of shown.split(',')) {
      if (!b) continue;
      const { from, to } = this.blocks[+b];
      a.set(this.allM.subarray(from * 16, to * 16), n * 16);
      if (c && this.allC) c.set(this.allC.subarray(from * 3, to * 3), n * 3);
      n += to - from;
    }
    m.count = n;
    m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, n * 16); m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) { m.instanceColor.clearUpdateRanges(); m.instanceColor.addUpdateRange(0, n * 3); m.instanceColor.needsUpdate = true; }
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
  private scatters: Scatter[] = [];
  private frustum = new THREE.Frustum(); private pv = new THREE.Matrix4();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  clear(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.scatters = [];
    this.group.clear();
  }

  build(tiles: Uint8Array, w: number, h: number, sites: SiteDef[]): void {
    this.clear();
    this.buildGround(tiles, w, h);
    this.buildWater(w, h);
    this.buildTrees(tiles, w, h);
    this.buildRocks(tiles, w, h, sites);
    this.buildScrub(tiles, w, h);
  }

  // Per frame, before drawing: the props in view, and those that shadow it, only.
  cull(cam: THREE.Camera): void {
    cam.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    for (const sc of this.scatters) sc.cull(this.frustum);
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
    this.scatters.push(...scatters);
    this.disposables.push(geoPine, geoRound, mat);
  }

  private buildRocks(tiles: Uint8Array, w: number, h: number, sites: SiteDef[]): void {
    const isRock = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && tiles[y * w + x] === Tile.Rock;
    const walls: number[] = [], boulders: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!isRock(x, y)) continue;
      // Rock tiles in a line are ruined walls; lone ones are boulders.
      const line = isRock(x - 1, y) || isRock(x + 1, y) || isRock(x, y - 1) || isRock(x, y + 1);
      (line ? walls : boulders).push(x, y);
    }
    const style = wallStyles(tiles, w, h, sites);
    // Lone rocks are junk: a rubble heap with a dumped crate.
    const boulderGeo = merge([
      part(dodeca(0.5), 0x6c665a, 0, 0.2, 0, 0, 0, 0, 1, 0.6, 1),
      part(dodeca(0.28), 0x7a6e5a, 0.3, 0.12, 0.2),
      part(box(0.4, 0.32, 0.4), 0x6a4a2c, -0.18, 0.36, -0.12, 0, 0.5, 0.15),
      part(box(0.7, 0.05, 0.12), 0x7a5a36, 0.05, 0.3, 0.25, 0, 0.9, 0.25),
    ]);
    const mat = propMaterial();
    const wallGeos = WALLS.map((s) => s.geo());
    const scs = WALLS.map(() => new Scatter());
    for (let i = 0; i < walls.length; i += 2) {
      const x = walls[i], y = walls[i + 1], st = style[y * w + x], S = WALLS[st];
      const b = 0.82 + hash(x, y, 11) * 0.3;
      // Each block runs along its wall; a corner or a stub faces any way.
      const across = isRock(x, y - 1) || isRock(x, y + 1), along = isRock(x - 1, y) || isRock(x + 1, y);
      const heading = across && !along ? Math.PI / 2 : along && !across ? (hash(x, y, 14) < 0.5 ? 0 : Math.PI) : Math.floor(hash(x, y, 14) * 4) * Math.PI / 2;
      // Ruins are broken: each block has its own height, but never low enough to look like
      // something a shot would clear, since every wall tile stops bullets.
      const hgt = S.lo + hash(x, y, 13) * (S.hi - S.lo);
      scs[st].add(x + 0.5, y + 0.5, heading, 1, hgt, [b, b * 0.98, b * 0.94]);
    }
    scs.forEach((sc, k) => { sc.build(this.group, wallGeos[k], mat, true); this.scatters.push(sc); });
    const sc = new Scatter();
    for (let i = 0; i < boulders.length; i += 2) {
      const x = boulders[i], y = boulders[i + 1], b = 0.82 + hash(x, y, 11) * 0.3;
      const s = 0.9 + hash(x, y, 15) * 0.5;
      sc.add(x + 0.5, y + 0.5, hash(x, y, 16) * 6.28, s, s * (0.8 + hash(x, y, 17) * 0.6), [b, b * 0.98, b * 0.94]);
    }
    sc.build(this.group, boulderGeo, mat, true);
    this.scatters.push(sc);
    this.disposables.push(...wallGeos, boulderGeo, mat);
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
      this.scatters.push(sc);
    });
    this.disposables.push(bush, weeds, mat);
  }
}

// Ruined walls come in styles, each block of one built along +x, a tile long. lo..hi is how
// tall a block of it stands, before the break.
const enum Wall { Siding = 0, Brick, Stone, Cinder, Timber, Fort, Shop }
const WALLS: { lo: number; hi: number; geo: () => THREE.BufferGeometry }[] = [
  // Siding: a brick footing, faded clapboard, a broken top.
  { lo: 0.8, hi: 1.6, geo: () => merge([
    part(box(1, 0.3, 1), 0x6e3e30, 0, 0.15, 0),
    part(box(0.96, 0.7, 0.96), 0xb3a88c, 0, 0.65, 0),
    part(box(1, 0.06, 1), 0x8a8270, 0, 0.62, 0),
    part(box(0.98, 0.08, 0.98), 0x6a6458, 0, 1.0, 0),
    part(box(0.45, 0.3, 0.45), 0x9c9178, 0.22, 1.12, 0.18, 0, 0.4, 0),
  ]) },
  // Brick: red courses with pale mortar, the top fallen away in steps.
  { lo: 0.85, hi: 1.5, geo: () => merge([
    part(box(1, 0.9, 0.72), 0x8e4a34, 0, 0.45, 0),
    part(box(1.01, 0.035, 0.73), 0xb0a090, 0, 0.22, 0),
    part(box(1.01, 0.035, 0.73), 0xb0a090, 0, 0.45, 0),
    part(box(1.01, 0.035, 0.73), 0xb0a090, 0, 0.68, 0),
    part(box(0.6, 0.2, 0.72), 0x7a3c2a, -0.2, 1.0, 0),
    part(box(0.28, 0.14, 0.72), 0x8e4a34, -0.36, 1.17, 0),
    part(box(0.26, 0.12, 0.2), 0x8e4a34, 0.28, 0.06, 0.46, 0, 0.6, 0),
  ]) },
  // Fieldstone: an old farmhouse's grey stones, lumpy, with a capstone or two left.
  { lo: 0.8, hi: 1.3, geo: () => merge([
    part(box(1, 0.86, 0.8), 0x737064, 0, 0.43, 0),
    part(dodeca(0.24), 0x878374, -0.3, 0.22, 0.32, 0.3, 0, 0, 1.3, 0.8, 0.6),
    part(dodeca(0.22), 0x66635a, 0.22, 0.5, 0.33, 0, 0.5, 0, 1.4, 0.8, 0.6),
    part(dodeca(0.2), 0x8f8a7a, -0.12, 0.7, -0.33, 0.4, 0, 0, 1.3, 0.8, 0.6),
    part(dodeca(0.22), 0x6e6b5e, 0.3, 0.2, -0.33, 0, 0.3, 0, 1.2, 0.9, 0.6),
    part(dodeca(0.26), 0x7d7a6c, -0.18, 0.92, 0, 0.2, 0.4, 0, 1.3, 0.6, 1.1),
    part(dodeca(0.2), 0x8a8676, 0.26, 0.9, 0.05, 0, 0.9, 0, 1, 0.6, 1.2),
  ]) },
  // Cinder block: grey blocks with their seams, a stained foot, rusted rebar out of the top.
  { lo: 0.9, hi: 1.5, geo: () => merge([
    part(box(1, 1, 0.62), 0x8e8b84, 0, 0.5, 0),
    part(box(1.01, 0.16, 0.63), 0x6a675f, 0, 0.08, 0),
    part(box(1.01, 0.025, 0.63), 0x6e6c66, 0, 0.36, 0),
    part(box(1.01, 0.025, 0.63), 0x6e6c66, 0, 0.68, 0),
    part(box(0.025, 0.3, 0.63), 0x6e6c66, -0.2, 0.52, 0),
    part(box(0.025, 0.3, 0.63), 0x6e6c66, 0.3, 0.84, 0),
    part(box(0.04, 0.42, 0.04), 0x6a3a22, 0.22, 1.18, 0.05, 0, 0, 0.15),
    part(box(0.04, 0.32, 0.04), 0x6a3a22, -0.3, 1.12, -0.06, 0.2, 0, -0.1),
  ]) },
  // Timber: a barn's or a shed's grey-brown boards between posts, some fallen short.
  { lo: 0.85, hi: 1.2, geo: () => merge([
    part(box(1, 0.62, 0.3), 0x5a4430, 0, 0.31, 0),
    part(box(0.16, 1.15, 0.36), 0x46382a, -0.42, 0.575, 0),
    part(box(0.3, 1.0, 0.26), 0x6b5038, -0.2, 0.5, 0),
    part(box(0.3, 0.78, 0.26), 0x5d4631, 0.1, 0.39, 0),
    part(box(0.26, 0.94, 0.26), 0x74593f, 0.37, 0.47, 0),
    part(box(1, 0.08, 0.34), 0x4a3b2b, 0, 0.3, 0),
    part(box(1, 0.08, 0.34), 0x4a3b2b, 0, 0.82, 0, 0.05, 0, 0.04),
    part(box(0.14, 0.6, 0.06), 0x6b5038, 0.06, 0.1, 0.34, 1.35, 0.3, 0),
  ]) },
  // An outpost's wall: poured concrete, a dark stripe, a row of sandbags along the top.
  { lo: 1.1, hi: 1.3, geo: () => merge([
    part(box(1, 0.95, 0.85), 0x8c8b84, 0, 0.475, 0),
    part(box(1.01, 0.1, 0.86), 0x56554f, 0, 0.22, 0),
    part(dodeca(0.2), 0x8f8058, -0.3, 1.0, 0, 0, 0.2, 0, 1.5, 0.6, 1.4),
    part(dodeca(0.2), 0x9a8a62, 0.02, 1.0, 0.04, 0, -0.1, 0, 1.5, 0.6, 1.4),
    part(dodeca(0.2), 0x857652, 0.33, 1.0, -0.03, 0, 0.3, 0, 1.4, 0.6, 1.4),
  ]) },
  // The gas station's shop: painted block, a teal band where the sign ran, a grimy foot.
  { lo: 1.2, hi: 1.35, geo: () => merge([
    part(box(1, 1, 0.64), 0xc4bfae, 0, 0.5, 0),
    part(box(1.01, 0.18, 0.65), 0x66635a, 0, 0.09, 0),
    part(box(1.01, 0.15, 0.65), 0x2f7472, 0, 0.78, 0),
    part(box(1.02, 0.05, 0.7), 0x8a867a, 0, 1.0, 0),
  ]) },
];

// Which style each wall tile is built in: an outpost's and the gas station's their own, a
// house's to suit its shape, and any other ruin one of the house styles by its look.
function wallStyles(tiles: Uint8Array, w: number, h: number, sites: SiteDef[]): Uint8Array {
  const out = new Uint8Array(w * h).fill(255);
  const paint = (x0: number, y0: number, sw: number, sh: number, st: number) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y0 + sh); y++) for (let x = Math.max(0, x0); x < Math.min(w, x0 + sw); x++) {
      if (tiles[y * w + x] === Tile.Rock && out[y * w + x] === 255) out[y * w + x] = st;
    }
  };
  // Outposts and the station first: a house that overlaps one keeps to its own ground.
  for (const s of sites) if (s.kind === SiteKind.Outpost) paint(s.x, s.y, s.w, s.h, Wall.Fort);
  for (const s of sites) if (s.kind === SiteKind.Station) paint(s.x, s.y, s.w, s.h, Wall.Shop);
  for (const s of sites) {
    if (s.kind !== SiteKind.House) continue;
    const r = hash(s.x, s.y, 51);
    let st: Wall;
    switch (s.ruin ?? Math.floor(hash(s.x, s.y, 50) * 6)) {
      case Ruin.Barn: st = Wall.Timber; break;
      case Ruin.Shed: st = r < 0.65 ? Wall.Timber : Wall.Cinder; break;
      case Ruin.Collapsed: st = r < 0.5 ? Wall.Stone : r < 0.8 ? Wall.Brick : Wall.Siding; break;
      case Ruin.TwoRoom: st = r < 0.45 ? Wall.Brick : r < 0.8 ? Wall.Siding : Wall.Cinder; break;
      case Ruin.L: st = r < 0.4 ? Wall.Siding : r < 0.7 ? Wall.Cinder : Wall.Brick; break;
      default: st = r < 0.4 ? Wall.Siding : r < 0.65 ? Wall.Brick : r < 0.85 ? Wall.Stone : Wall.Timber;
    }
    paint(s.x, s.y, s.w, s.h, st);
  }
  // The rest, a run of wall at a time, take one look each.
  const q: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (tiles[i] !== Tile.Rock || out[i] !== 255) continue;
    const st = [Wall.Siding, Wall.Brick, Wall.Stone, Wall.Cinder][Math.floor(hash(i % w, Math.floor(i / w), 52) * 4)];
    out[i] = st; q.push(i);
    while (q.length) {
      const j = q.pop()!, x = j % w, y = (j - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || tiles[k] !== Tile.Rock || out[k] !== 255) continue;
        out[k] = st; q.push(k);
      }
    }
  }
  return out;
}
