import * as THREE from 'three/webgpu';
import { float, max, mix, normalWorld, positionWorld, sin, smoothstep, step, texture, time, vec2, vec3, vertexColor } from 'three/tsl';
import { Ruin, SiteKind, Tile, type SiteDef } from '../protocol';
import { indexed } from './rig';
import { painted } from './paint';
import { blend, darker, lighter, mute, PAL } from './palette';
import { SHRINE_PLAN, shrineTile } from './shrine';
import { box, cyl, dodeca, ico, merge, part, writeMatrix, type Part } from './util';
import { uSnow, uWet } from './weather';

function hash(x: number, y: number, s = 0): number {
  let h = Math.imul(x * 374761393 + y * 668265263 + s * 1442695041, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---- The ground ----
//
// One continuous painted surface, coloured in the shader from world position, so it sticks to
// the world as the camera moves and turns and shows no tile grid. Its colour is the picture's:
// olive and ochre dabs a few scene pixels across, each a flat colour, over patches of metres
// (greener, rustier, damp), with a few green flecks and pebbles. Roads, dry ground, the base's
// yard and the forest floor come from a texture of the tiles' kinds, read through a warp so
// their borders are soft and irregular, then cut hard so each dab is still one colour.

// A tiling field of four independent noises, one a channel, NOISE texels a side and read
// bilinear: smooth value noise at any scale for one texture fetch, far cheaper than hashing
// in the shader. Bilinear noise cut at a level makes the picture's diamond-ish dabs.
const NOISE = 256;
let noiseTex: THREE.DataTexture | null = null;
function noiseTexture(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const d = new Uint8Array(NOISE * NOISE * 4);
  for (let i = 0; i < d.length; i++) d[i] = Math.floor(hash(i, 7, 3) * 256);
  const t = new THREE.DataTexture(d, NOISE, NOISE, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return (noiseTex = t);
}

// The noise field at `perMetre` cells a metre, turned by `angle` so no layer lines up with the
// tiles or with another, and moved by `off` so layers at one scale differ.
function field(perMetre: number, angle: number, off: number): THREE.Node<'vec4'> {
  const p = positionWorld.xz, c = Math.cos(angle) * perMetre / NOISE, s = Math.sin(angle) * perMetre / NOISE;
  return texture(noiseTexture(), vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))).add(off)) as unknown as THREE.Node<'vec4'>;
}

const C = (hex: number): THREE.Node<'vec3'> => { const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace); return vec3(c.r, c.g, c.b); };
// Flat colours by level: cols[0] below the first edge, cols[i] from edges[i - 1] up.
function levels(v: THREE.Node<'float'>, cols: number[], edges: number[]): THREE.Node<'vec3'> {
  let c: THREE.Node<'vec3'> = C(cols[0]);
  edges.forEach((e, i) => { c = mix(c, C(cols[i + 1]), step(e, v)); });
  return c;
}

// The tiles' kinds as a texture: red road, green the base's yard (concrete), blue dry ground,
// alpha damp (a forest's floor some, a lake's bed and shore all).
export interface GroundKinds { tex: THREE.DataTexture; w: number; h: number }

function kindTexture(tiles: Uint8Array, w: number, h: number): GroundKinds {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const t = tiles[i];
    d[i * 4] = t === Tile.Dirt ? 255 : t === Tile.Rock ? 150 : 0;
    d[i * 4 + 1] = t === Tile.Floor ? 255 : 0;
    d[i * 4 + 2] = t === Tile.Sand ? 255 : 0;
    d[i * 4 + 3] = t === Tile.Water ? 255 : t === Tile.Tree ? 140 : 0;
  }
  const tex = new THREE.DataTexture(d, w, h, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, w, h };
}

// The ground's colour at a point, as painted (before light and weather). With no kinds, open
// ground everywhere: the lab's stage.
function groundColor(kinds: GroundKinds | null): THREE.Node<'vec3'> {
  // Zones of tens of metres, patches of a couple, dabs of about 12 cm, flecks of 5.
  const zone = field(0.07, 0.4, 0.13), patch = field(0.5, 1.1, 0.71), dab = field(8.5, 0.52, 0.37), fleck = field(20, 2.3, 0.59);
  const v = dab.r.mul(0.6).add(fleck.r.mul(0.3)).add(patch.r.mul(0.25)).sub(0.075);
  let damp: THREE.Node<'float'> = float(0), mud: THREE.Node<'float'> = float(0);
  let road: THREE.Node<'float'> = float(0), yard: THREE.Node<'float'> = float(0), dry: THREE.Node<'float'> = float(0);
  let yardK: THREE.Node<'float'> = float(0);
  if (kinds) {
    // Read through a warp of about a metre, then cut with a little dab noise: borders wander
    // and break into dabs instead of following the tiles.
    const warp = field(0.9, 0.8, 0.21);
    const uv = positionWorld.xz.add(warp.xy.sub(0.5).mul(1.3)).add(dab.zw.sub(0.5).mul(0.35)).div(vec2(kinds.w, kinds.h));
    const k = texture(kinds.tex, uv) as unknown as THREE.Node<'vec4'>;
    const jit = fleck.b.sub(0.5).mul(0.22);
    road = step(0.5, k.r.add(jit)); yardK = k.g.add(jit.mul(0.4)); yard = step(0.5, yardK); dry = step(0.5, k.b.add(jit));
    // Beyond the map's edge, under the forest there: its damp floor, darker the deeper in.
    const p = positionWorld.xz, out = max(max(p.x.negate(), p.x.sub(kinds.w)), max(p.y.negate(), p.y.sub(kinds.h)));
    const wood = smoothstep(0.5, 4, out.add(warp.z.sub(0.5).mul(2)));
    damp = max(k.a.mul(float(1).sub(wood)), wood.mul(0.8)); mud = step(0.75, k.a.add(jit)).mul(float(1).sub(wood));
    road = road.mul(float(1).sub(wood)); yard = yard.mul(float(1).sub(wood)); dry = dry.mul(float(1).sub(wood));
  }

  // Open ground: olive ochre in four values, then green, rust and damp dabs over it.
  let g = levels(v, [0x4c4224, 0x5a4e29, 0x63552c, 0x6d5c30], [0.36, 0.62, 0.75]);
  const gv = dab.g.mul(0.6).add(fleck.g.mul(0.4)), rv = dab.b.mul(0.6).add(fleck.b.mul(0.4));
  g = mix(g, mix(C(0x4f5129), C(0x5a5e30), step(0.6, v)), step(float(0.79).sub(zone.r.mul(0.3)), gv));
  g = mix(g, C(0x57432a), step(float(0.82).sub(zone.g.mul(0.22)).sub(damp.mul(0.12)), rv));
  const wet = patch.b.mul(0.55).add(zone.b.mul(0.45)).add(dab.a.sub(0.5).mul(0.35)).add(damp.mul(0.3));
  g = mix(g, C(0x463c22), step(0.71, wet));
  g = mix(g, C(0x3e3520), step(0.81, wet));
  // A blade of green and a pebble here and there, a scene pixel or two each.
  g = mix(g, C(0x66723a), step(0.972, dab.a).mul(step(0.45, zone.r)));
  g = mix(g, C(0x77705c), step(0.962, fleck.a).mul(step(0.55, patch.a)));

  // Dry ground: paler, sandier ochre with grass dabs left in it.
  let s = levels(v, [0x5c4e29, 0x695830, 0x746238, 0x7f6d40], [0.38, 0.62, 0.76]);
  s = mix(s, C(0x5a5a30), step(0.74, gv));
  // A road: trodden dirt, browner, with more stones.
  let d = levels(v, [0x463722, 0x544228, 0x5f4b2c, 0x6a5533], [0.36, 0.6, 0.76]);
  d = mix(d, C(0x766e5a), step(0.935, fleck.a));
  d = mix(d, C(0x3f3220), step(0.73, wet));

  // The yard of a camp: the same ground trodden bare. The open ground's olive and ochre with
  // its green worn out of it, in flatter, broader dabs: darker scuffs, paler ochre where it has
  // dried, browner bare dirt where it is walked most, now and then a dark crack in the hardpan.
  let y = levels(v, [PAL.groundDark, PAL.ground, PAL.ground, PAL.groundLight], [0.34, 0.5, 0.72]);
  y = mix(y, C(0x544a27), step(0.66, patch.a.mul(0.6).add(dab.b.mul(0.4))));
  const drift = patch.g.mul(0.62).add(dab.g.mul(0.25)).add(fleck.g.mul(0.13));
  y = mix(y, levels(v, [0x5e4d2a, PAL.groundDry, 0x726033], [0.42, 0.68]), step(0.62, drift));
  const bare = patch.r.mul(0.55).add(zone.g.mul(0.25)).add(dab.r.mul(0.2));
  y = mix(y, levels(v, [PAL.dirtDark, PAL.dirt, 0x60502c], [0.4, 0.66]), step(0.64, bare));
  const crack = field(1.2, 0.3, 0.9), gate = field(0.8, 1.7, 0.33);
  const line = float(1).sub(step(0.008, crack.r.sub(0.5).abs())).mul(step(0.74, gate.b));
  y = mix(y, C(0x463c22), line.mul(float(1).sub(step(0.62, drift))));
  // At its edges the grass holds on: a tuft and a stone here and there where the yard meets it.
  const rim = step(0.5, yardK).mul(float(1).sub(step(0.82, yardK)));
  y = mix(y, mix(C(PAL.grass), C(PAL.grassLit), step(0.5, fleck.g)), step(0.9, dab.a).mul(rim));
  y = mix(y, C(PAL.stone), step(float(0.975).sub(rim.mul(0.03)), fleck.a).mul(step(0.5, patch.a)));

  let c = mix(g, s, dry);
  c = mix(c, d, road);
  c = mix(c, mix(C(0x3b301d), C(0x45381f), step(0.5, v)), mud);
  return mix(c, y, yard);
}

// Weather on a colour: wet darkens it, snow settles white on whatever faces up. n is a noise.
// Snow goes at most about half way, unevenly, so the ground's mottle and colours show through.
function weathered(c: THREE.Node<'vec3'>, up: THREE.Node<'float'>, n: THREE.Node<'float'>): THREE.Node<'vec3'> {
  const wet = c.mul(float(1).sub(uWet.mul(0.28)));
  return mix(wet, vec3(0.84, 0.87, 0.9).mul(n.mul(0.1).add(0.92)), uSnow.mul(0.5).mul(smoothstep(0.35, 0.8, up)).mul(n.mul(0.6).add(0.4)));
}

// The ground's material: painted light, the ground's colour, the weather, and puddles in rain.
export function groundMaterial(kinds: GroundKinds | null = null): THREE.MeshLambertNodeMaterial {
  const mat = painted(new THREE.MeshLambertNodeMaterial());
  const patch = field(0.5, 1.1, 0.71), zone = field(0.07, 0.4, 0.13), n = field(3, 0.9, 0.5).r;
  // Rain leaves puddles in the low spots: dark, with a cold sheen that ripples.
  const puddle = smoothstep(0.6, 0.72, patch.a.mul(0.55).add(zone.a.mul(0.45))).mul(uWet);
  const ripple = sin(time.mul(7).add(field(8, 0.2, 0.4).a.mul(40))).mul(0.5).add(0.5);
  const sheen = vec3(0.24, 0.28, 0.32).mul(ripple.mul(0.25).add(0.85));
  mat.colorNode = mix(weathered(groundColor(kinds), float(1), n), sheen.mul(0.4), puddle.mul(float(1).sub(uSnow)).mul(0.8));
  return mat;
}

// A lit material for instanced props that takes the weather. No vertexColors flag: the colour
// node already is the vertex colour, and the flag would multiply it in a second time; the
// instance's tint is multiplied in by three.
function propMaterial(): THREE.MeshLambertNodeMaterial {
  const m = painted(new THREE.MeshLambertNodeMaterial());
  m.colorNode = weathered(vertexColor().rgb, normalWorld.y, field(3, 0.9, 0.5).r);
  // Crowns are open cones: their shadows are cast from both faces.
  m.shadowSide = THREE.DoubleSide;
  return m;
}

const WATER_Y = -0.24;
// The ground beyond the map, a little under the map's own; it frames the map and never lies
// under it, or it would cover the lakes below it.
const OUTER_Y = -0.12;
// The ground's pieces, in tiles a side.
const GROUND_PIECE = 64;
// How many tiles of forest stand beyond the map's edge.
const BEYOND = 22;

// One prop's instances over the whole map, sorted into blocks of it. Only the blocks in view,
// or near enough to throw a shadow into it, are packed into the mesh and drawn. One mesh per
// prop rather than one per block: three builds every instanced mesh its own shaders, so a
// mesh per block meant a burst of shader builds whenever zooming out brought new blocks in.
// KEY0 shifts a block's key so the forest beyond the map's edge, at negative x and z, keys too.
const BLOCK = 32, REACH = 4, TALL = 5, KEY0 = 8;
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
    this.keys.push((Math.floor(x / BLOCK) + KEY0) * 1024 + Math.floor(z / BLOCK) + KEY0);
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
        const bx = (Math.floor(k / 1024) - KEY0) * BLOCK, bz = (k % 1024 - KEY0) * BLOCK;
        this.blocks.push({ from: j, to: j, box: new THREE.Box3(new THREE.Vector3(bx - REACH, 0, bz - REACH), new THREE.Vector3(bx + BLOCK + REACH, TALL, bz + BLOCK + REACH)) });
      }
      this.blocks[this.blocks.length - 1].to = j + 1;
    });
    this.mats = []; this.cols = []; this.keys = [];
    // Indexed, so a flat face's shared corners run the vertex shader once, not once a
    // triangle: a thousand trees in a zoomed-out view, and their shadows, are half the work.
    const m = new THREE.InstancedMesh(indexed(geo), mat, n);
    m.castShadow = shadow; m.receiveShadow = true;
    // Culled here, block by block, for the view and the sun's frustum at once.
    m.frustumCulled = false;
    (m.instanceMatrix.array as Float32Array).set(this.allM);
    if (this.allC) m.instanceColor = new THREE.InstancedBufferAttribute(this.allC.slice(), 3);
    group.add(m);
    this.mesh = m;
  }

  // The indexed copy of the geometry is this prop's own.
  dispose(): void { this.mesh?.geometry.dispose(); }

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

// ---- The props: trees, bushes, rocks, tufts, logs, stumps ----
//
// Built against a 1.8 m person, facing +x on y = 0, in the picture's muted greens and browns.
// Every face is lit by painted light, so a crown's clumps show a lit side and a shaded one.

const BARK = 0x4a3626, BARK_DARK = 0x35281c, CUT = 0x86704c, DEADWOOD = 0x6a604c;
const NEEDLE = [0x363b23, 0x41472a, 0x4c5230, 0x575d36];
const LEAF = { dark: 0x3e4424, mid: 0x495028, lit: 0x555c2e, top: 0x606533 };

// An open cone or frustum: crowns are seen from above, so their undersides are left off.
const shell = (rt: number, rb: number, h: number, seg: number) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, true);

// A limb from (x, y, z), leaning `pitch` from upright towards heading `yaw`, len long.
function limb(x: number, y: number, z: number, yaw: number, pitch: number, len: number, r0: number, r1: number, col: number, seg = 4): Part {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true);
  g.rotateZ(-pitch); g.rotateY(yaw);
  const sp = Math.sin(pitch);
  g.translate(x + sp * Math.cos(yaw) * len / 2, y + Math.cos(pitch) * len / 2, z - sp * Math.sin(yaw) * len / 2);
  return part(g, col);
}

// A lump of foliage or stone: a low icosahedron squashed and turned.
const lump = (r: number, col: number, x: number, y: number, z: number, sy = 0.78, ry = 0) => part(ico(r), col, x, y, z, 0, ry, 0, 1, sy, 1);

// A ring of n lumps of radius r, `out` from the middle at height y: a crown or a bush is a
// few of these, darker below and lit above.
function clumps(n: number, r: number, out: number, y: number, col: number, turn: number): Part[] {
  const ps: Part[] = [];
  for (let i = 0; i < n; i++) {
    const a = turn + i * 2 * Math.PI / n, k = 0.85 + ((i * 7) % 5) * 0.07;
    ps.push(lump(r * k, i % 3 === 0 ? darker(col, 0.88) : col, Math.cos(a) * out * k, y + ((i * 3) % 4) * 0.05, Math.sin(a) * out * k, 0.75, a));
  }
  return ps;
}

// A dry pine, about 3.3 m: a bare lower trunk and tiers of drooping boughs, each a flared
// skirt under a cone, darker at the bottom and lit at the top. `sparse` leaves gaps and dead
// stubs, a pine dying of the drought.
function pine(sparse: boolean): THREE.BufferGeometry {
  const parts: Part[] = [
    part(cyl(0.045, 0.12, 2.9, 6), BARK, 0, 1.45, 0),
    part(cyl(0.12, 0.19, 0.18, 6), BARK_DARK, 0, 0.09, 0),
  ];
  const tiers = 5;
  for (let i = 0; i < tiers; i++) {
    if (sparse && (i === 1 || i === 3)) continue;
    const t = i / (tiers - 1), r = 0.82 - t * 0.56, y = 1.0 + t * 1.95, hh = 0.68 - t * 0.18;
    const col = sparse && i === 0 ? 0x4f4a2a : NEEDLE[Math.min(3, Math.floor(t * 3.2))];
    const ox = Math.sin(i * 2.3) * 0.06, oz = Math.cos(i * 1.7) * 0.06;
    parts.push(part(shell(r * 0.32, r, hh * 0.5, 7), darker(col, 0.85), ox, y, oz, Math.sin(i) * 0.08, i * 0.9, Math.cos(i * 1.3) * 0.08));
    parts.push(part(shell(0, r * 0.5, hh * 0.62, 6), col, ox * 0.5, y + hh * 0.5, oz * 0.5, 0, i * 1.4, 0));
  }
  parts.push(part(shell(0, 0.1, 0.45, 5), NEEDLE[3], 0, 3.3, 0));
  if (sparse) {
    parts.push(limb(0, 1.5, 0, 0.6, 1.25, 0.55, 0.03, 0.01, DEADWOOD));
    parts.push(limb(0, 2.3, 0, 3.4, 1.2, 0.45, 0.025, 0.01, DEADWOOD));
    parts.push(limb(0, 1.7, 0, 4.9, 1.3, 0.4, 0.025, 0.01, DEADWOOD));
  }
  return merge(parts);
}

// A broadleaf, about 3 m: a short trunk forking into three limbs, a crown of eleven lumps.
function broadleaf(): THREE.BufferGeometry {
  return merge([
    part(cyl(0.08, 0.14, 1.6, 6), BARK, 0, 0.8, 0),
    part(cyl(0.14, 0.21, 0.16, 6), BARK_DARK, 0, 0.08, 0),
    limb(0, 1.4, 0, 0.3, 0.6, 0.85, 0.07, 0.035, BARK),
    limb(0, 1.35, 0, 2.5, 0.55, 0.8, 0.07, 0.035, BARK),
    limb(0, 1.5, 0, 4.4, 0.45, 0.75, 0.06, 0.03, BARK),
    ...clumps(6, 0.42, 0.58, 1.95, LEAF.dark, 0.2),
    ...clumps(3, 0.42, 0.32, 2.4, LEAF.mid, 1.0),
    lump(0.36, LEAF.lit, -0.12, 2.75, -0.08, 0.8, 0.5),
    lump(0.28, LEAF.top, 0.2, 2.85, 0.12, 0.8, 1.7),
  ]);
}

// A dead tree, about 3 m: a grey trunk and a few bare limbs, one broken short.
function deadTree(): THREE.BufferGeometry {
  return merge([
    part(cyl(0.05, 0.12, 2.8, 6), DEADWOOD, 0, 1.4, 0, 0.04, 0, 0.03),
    part(cyl(0.12, 0.19, 0.16, 6), darker(DEADWOOD, 0.7), 0, 0.08, 0),
    limb(0, 1.3, 0, 0.4, 0.8, 1.0, 0.05, 0.015, DEADWOOD),
    limb(0, 1.8, 0, 2.6, 0.7, 0.85, 0.04, 0.012, DEADWOOD),
    limb(0, 2.2, 0, 4.6, 0.6, 0.75, 0.035, 0.01, darker(DEADWOOD, 0.85)),
    limb(0, 2.5, 0, 1.4, 0.45, 0.6, 0.03, 0.01, DEADWOOD),
    limb(0, 0.9, 0, 3.8, 1.1, 0.32, 0.04, 0.03, darker(DEADWOOD, 0.85)),
    limb(0.28, 2.0, -0.13, 0.4, 0.2, 0.4, 0.015, 0.008, DEADWOOD),
  ]);
}

// A bush, knee high and a metre across: lumps of dusty olive, lit on top.
function bush(): THREE.BufferGeometry {
  return merge([
    ...clumps(6, 0.22, 0.28, 0.2, LEAF.dark, 0.4),
    lump(0.3, LEAF.mid, 0, 0.32, 0, 0.8),
    lump(0.18, LEAF.lit, 0.12, 0.5, -0.06, 0.8, 0.9),
  ]);
}

// A tuft of grass a hand or two high: five blades leaning out.
function tuft(cols: number[]): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 5; i++) {
    const a = i * 2.4, r = 0.02 + (i % 3) * 0.025, h = 0.17 + ((i * 5) % 7) * 0.025;
    const g = new THREE.ConeGeometry(0.024, h, 3, 1, true);
    g.translate(0, h / 2, 0);
    g.rotateZ(-(0.25 + (i % 4) * 0.1)); g.rotateY(a);
    g.translate(Math.cos(a) * r, 0, -Math.sin(a) * r);
    parts.push(part(g, cols[i % cols.length]));
  }
  return merge(parts);
}

// A few stones, fist to head sized.
function stones(): THREE.BufferGeometry {
  return merge([
    lump(0.1, PAL.stone, 0, 0.035, 0, 0.55),
    lump(0.065, PAL.stoneDark, 0.15, 0.025, 0.08, 0.6, 1),
    lump(0.05, lighter(PAL.stone, 0.15), -0.11, 0.02, 0.1, 0.6, 2),
  ]);
}

// A fallen log, 1.7 m: bark with its cut ends showing pale, a stub of a branch, moss.
function log(): THREE.BufferGeometry {
  return merge([
    part(cyl(0.15, 0.17, 1.7, 7), BARK, 0, 0.15, 0, 0, 0, Math.PI / 2),
    part(cyl(0.12, 0.12, 0.02, 7), CUT, 0.86, 0.15, 0, 0, 0, Math.PI / 2),
    part(cyl(0.13, 0.13, 0.02, 7), darker(CUT, 0.75), -0.86, 0.15, 0, 0, 0, Math.PI / 2),
    limb(0.3, 0.2, 0, 1.2, 0.9, 0.35, 0.04, 0.02, BARK),
    lump(0.13, LEAF.dark, -0.3, 0.27, 0.02, 0.45, 0.5),
  ]);
}

// A stump, knee low, its sawn top pale, roots spreading.
function stump(): THREE.BufferGeometry {
  return merge([
    part(cyl(0.19, 0.25, 0.38, 7), BARK, 0, 0.19, 0),
    part(cyl(0.17, 0.17, 0.02, 7), CUT, 0, 0.385, 0),
    limb(0, 0.02, 0, 0.3, 1.25, 0.38, 0.07, 0.03, BARK_DARK),
    limb(0, 0.02, 0, 2.4, 1.3, 0.34, 0.06, 0.03, BARK_DARK),
    limb(0, 0.02, 0, 4.3, 1.25, 0.32, 0.06, 0.03, BARK_DARK),
  ]);
}

// A boulder of a metre with a smaller one at its foot, lichen on top.
function boulder(): THREE.BufferGeometry {
  return merge([
    part(dodeca(0.44), PAL.stone, 0, 0.24, 0, 0.2, 0.3, 0.1, 1, 0.65, 1),
    part(dodeca(0.26), PAL.stoneDark, 0.38, 0.12, 0.24, 0.4, 0.9, 0, 1, 0.7, 1),
    lump(0.15, lighter(PAL.stone, 0.1), -0.32, 0.07, -0.26, 0.7, 0.4),
    lump(0.11, 0x5d5f3a, -0.05, 0.5, 0.05, 0.4),
  ]);
}

// A heap of rubble: broken slabs of concrete, rebar out of them, a plank.
function rubble(): THREE.BufferGeometry {
  return merge([
    part(box(0.55, 0.16, 0.42), PAL.concrete, 0, 0.1, 0, 0.2, 0.4, 0.15),
    part(box(0.38, 0.2, 0.32), darker(PAL.concrete, 0.85), 0.3, 0.16, 0.2, -0.3, 1.1, 0.2),
    part(box(0.32, 0.12, 0.26), lighter(PAL.concrete, 0.1), -0.28, 0.1, 0.22, 0.15, 2.2, -0.2),
    part(dodeca(0.2), PAL.stoneDark, -0.2, 0.1, -0.28, 0, 0, 0, 1, 0.7, 1),
    part(box(0.03, 0.03, 0.65), PAL.rust, 0.08, 0.28, 0.05, 0.5, 0.6, 0),
    part(box(0.03, 0.03, 0.5), PAL.rust, -0.1, 0.24, 0.1, -0.4, 1.9, 0.3),
    part(box(0.75, 0.04, 0.13), blend(PAL.wood, PAL.stone, 0.3), 0.05, 0.22, -0.25, 0, 0.3, 0.12),
  ]);
}

// An instance tint: brightness b times a colour cast.
const tint = (b: number, r = 1, g = 1, bl = 1) => [b * r, b * g, b * bl];

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
    for (const sc of this.scatters) sc.dispose();
    this.disposables = [];
    this.scatters = [];
    this.group.clear();
  }

  build(tiles: Uint8Array, w: number, h: number, sites: SiteDef[]): void {
    this.clear();
    const mat = propMaterial();
    this.disposables.push(mat);
    this.buildGround(tiles, w, h);
    this.buildWater(w, h);
    this.buildTrees(tiles, w, h, mat);
    this.buildRocks(tiles, w, h, sites, mat);
    this.buildScrub(tiles, w, h, mat);
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
      // The map's rim meets the ground beyond it, so no step shows (the outline pass drew one
      // as a black line along the edge): land comes down to it, and a lake that runs to the
      // edge rises to it as a bank, not cut off square with the ground beyond above its water.
      if (x === 0 || y === 0 || x === w || y === h) ch[y * (w + 1) + x] = OUTER_Y;
    }
    const kinds = kindTexture(tiles, w, h);
    const mat = groundMaterial(kinds);
    this.disposables.push(mat, kinds.tex);
    // In square pieces, so three's frustum culling draws only those in view: the whole map
    // as one mesh was its every tile, 128k triangles on a 256 map, however close the camera.
    for (let y0 = 0; y0 < h; y0 += GROUND_PIECE) for (let x0 = 0; x0 < w; x0 += GROUND_PIECE) {
      const pw = Math.min(GROUND_PIECE, w - x0), ph = Math.min(GROUND_PIECE, h - y0);
      const geo = this.groundPiece(ch, w, x0, y0, pw, ph);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.name = 'ground';
      this.group.add(mesh);
      this.disposables.push(geo);
    }

    // The world beyond the map edge, so the fog has something to fade: the same ground, its
    // kinds those of the map's edge carried on. A frame around the map, not a sheet under it:
    // a sheet at OUTER_Y lay over the lakes (their water at WATER_Y, their beds lower still)
    // and drew them as flat brown ground.
    const outer = new THREE.Mesh(this.outerFrame(w, h), mat);
    outer.receiveShadow = true;
    this.group.add(outer);
    this.disposables.push(outer.geometry);
  }

  // A flat ring at OUTER_Y from 2.5 maps out to the map's own edge, where the rim's corners
  // come down to meet it: four strips, south and north the full width, west and east between.
  private outerFrame(w: number, h: number): THREE.BufferGeometry {
    const x0 = -w * 2.5, x1 = w * 3.5, z0 = -h * 2.5, z1 = h * 3.5;
    const rects = [[x0, z0, x1, 0], [x0, h, x1, z1], [x0, 0, 0, h], [w, 0, x1, h]];
    const pos: number[] = [], nrm: number[] = [];
    for (const [ax, az, bx, bz] of rects) {
      // Wound to face up, as the ground's pieces are.
      for (const [x, z] of [[ax, az], [ax, bz], [bx, az], [bx, az], [ax, bz], [bx, bz]]) {
        pos.push(x, OUTER_Y, z);
        nrm.push(0, 1, 0);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.computeBoundingSphere();
    return geo;
  }

  // The ground of tiles x0..x0+pw, y0..y0+ph, one shared corner a grid point; ch holds the
  // corner heights of the whole map. Its colour is all in the material.
  private groundPiece(ch: Float32Array, w: number, x0: number, y0: number, pw: number, ph: number): THREE.BufferGeometry {
    const cw = pw + 1;
    const pos = new Float32Array(cw * (ph + 1) * 3);
    for (let y = 0; y <= ph; y++) for (let x = 0; x <= pw; x++) {
      const v = (y * cw + x) * 3;
      pos[v] = x0 + x; pos[v + 1] = ch[(y0 + y) * (w + 1) + x0 + x]; pos[v + 2] = y0 + y;
    }
    const idx = new Uint32Array(pw * ph * 6);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const a = y * cw + x;
      idx.set([a, a + cw, a + 1, a + 1, a + cw, a + cw + 1], (y * pw + x) * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  private buildWater(w: number, h: number): void {
    const geo = new THREE.PlaneGeometry(w, h);
    geo.rotateX(-Math.PI / 2);
    // Murky olive water, a dull sky sheen on it.
    const mat = new THREE.MeshPhongNodeMaterial({ transparent: true, shininess: 60, specular: 0x6a7262 });
    const p = positionWorld;
    const wave = sin(p.x.mul(1.7).add(time.mul(1.3))).mul(sin(p.z.mul(1.3).sub(time.mul(1.1)))).mul(0.5).add(0.5);
    const ripple = sin(p.x.add(p.z).mul(4.0).add(time.mul(2.5))).mul(0.5).add(0.5);
    mat.colorNode = mix(C(0x29322a), C(0x3b4838), step(0.62, wave.mul(0.7).add(ripple.mul(0.3))));
    mat.emissiveNode = vec3(0.015, 0.02, 0.015).mul(ripple);
    mat.opacityNode = float(0.84);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(w / 2, WATER_Y, h / 2);
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  // One tree a tree tile: pines mostly, broadleaves in their own stands, a few dry or dead.
  private buildTrees(tiles: Uint8Array, w: number, h: number, mat: THREE.Material): void {
    const geos = [pine(false), pine(true), broadleaf(), deadTree()];
    const scs = geos.map(() => new Scatter());
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (tiles[y * w + x] !== Tile.Tree) continue;
      const stand = hash(x >> 3, y >> 3, 5), r = hash(x, y, 18);
      const k = r < 0.06 ? 3 : r < 0.16 ? 1 : stand < 0.62 ? 0 : 2;
      const s = 0.8 + hash(x, y, 1) * 0.3;
      // Each crown its own shade: a little lighter or darker, greener or drier.
      const b = 0.88 + hash(x, y, 8) * 0.24, dryness = hash(x, y, 7);
      const col = k === 3 ? tint(b) : tint(b, 1 + dryness * 0.14, 1, 0.92 - dryness * 0.1);
      scs[k].add(x + 0.5 + (hash(x, y, 2) - 0.5) * 0.4, y + 0.5 + (hash(x, y, 3) - 0.5) * 0.4, hash(x, y, 4) * 6.28,
        s, s * (0.9 + hash(x, y, 6) * 0.2), col);
    }
    // Beyond the map's edge the world goes on as a forest, close and dark: thin for a tile or
    // two, then shoulder to shoulder, so the edge reads as a treeline and not a cut.
    for (let y = -BEYOND; y < h + BEYOND; y++) for (let x = -BEYOND; x < w + BEYOND; x++) {
      const out = Math.max(-x, x + 1 - w, -y, y + 1 - h);
      if (out <= 0) continue;
      // How deep in, wandering by a few tiles so neither side of the band is a ruled line.
      const e = out + (hash(x >> 2, y >> 2, 21) - 0.5) * 3 + (hash(x >> 1, y >> 1, 22) - 0.5) * 1.5;
      const p = e < 0.6 ? 0 : Math.min(0.9, 0.2 + e * 0.2) * Math.min(1, (BEYOND - e) / 5);
      if (hash(x, y, 19) > p) continue;
      const stand = hash(x >> 3, y >> 3, 5), r = hash(x, y, 18);
      const k = r < 0.04 ? 3 : r < 0.12 ? 1 : stand < 0.7 ? 0 : 2;
      const s = 0.85 + hash(x, y, 1) * 0.35, b = 0.78 + hash(x, y, 8) * 0.16;
      scs[k].add(x + 0.5 + (hash(x, y, 2) - 0.5) * 0.6, y + 0.5 + (hash(x, y, 3) - 0.5) * 0.6, hash(x, y, 4) * 6.28,
        s, s * (0.9 + hash(x, y, 6) * 0.25), tint(b, 1, 1, 0.94));
    }
    scs.forEach((sc, k) => { sc.build(this.group, geos[k], mat, true); this.scatters.push(sc); });
    this.disposables.push(...geos);
  }

  private buildRocks(tiles: Uint8Array, w: number, h: number, sites: SiteDef[], mat: THREE.Material): void {
    const isRock = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && tiles[y * w + x] === Tile.Rock;
    const walls: number[] = [], lone: number[] = [];
    const style = wallStyles(tiles, w, h, sites);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!isRock(x, y)) continue;
      // Rock tiles in a line are ruined walls; lone ones are boulders or rubble, but for a
      // shrine's pillars and gate posts.
      const line = isRock(x - 1, y) || isRock(x + 1, y) || isRock(x, y - 1) || isRock(x, y + 1) || style[y * w + x] === Wall.Pillar;
      (line ? walls : lone).push(x, y);
    }
    const wallGeos = WALLS.map((s) => s.geo());
    const scs = WALLS.map(() => new Scatter());
    for (let i = 0; i < walls.length; i += 2) {
      const x = walls[i], y = walls[i + 1], st = style[y * w + x], S = WALLS[st];
      const b = 0.86 + hash(x, y, 11) * 0.22;
      // Each block runs along its wall; a corner or a stub faces any way.
      const across = isRock(x, y - 1) || isRock(x, y + 1), along = isRock(x - 1, y) || isRock(x + 1, y);
      const heading = across && !along ? Math.PI / 2 : along && !across ? (hash(x, y, 14) < 0.5 ? 0 : Math.PI) : Math.floor(hash(x, y, 14) * 4) * Math.PI / 2;
      // Ruins are broken: each block has its own height, but never low enough to look like
      // something a shot would clear, since every wall tile stops bullets.
      const hgt = S.lo + hash(x, y, 13) * (S.hi - S.lo);
      scs[st].add(x + 0.5, y + 0.5, heading, 1, hgt, tint(b, 1, 0.98, 0.94));
    }
    scs.forEach((sc, k) => { sc.build(this.group, wallGeos[k], mat, true); this.scatters.push(sc); });
    const loneGeos = [boulder(), rubble()], lsc = [new Scatter(), new Scatter()];
    for (let i = 0; i < lone.length; i += 2) {
      const x = lone[i], y = lone[i + 1], b = 0.88 + hash(x, y, 11) * 0.22;
      const s = 0.9 + hash(x, y, 15) * 0.35;
      lsc[hash(x, y, 19) < 0.65 ? 0 : 1].add(x + 0.5, y + 0.5, hash(x, y, 16) * 6.28, s, s * (0.85 + hash(x, y, 17) * 0.35), tint(b));
    }
    lsc.forEach((sc, k) => { sc.build(this.group, loneGeos[k], mat, true); this.scatters.push(sc); });
    this.disposables.push(...wallGeos, ...loneGeos);
  }

  // Bushes, tufts, stones, fallen logs and stumps on open ground, purely for looks: none
  // stands where a tile blocks, and none is tall enough to hide a creep.
  private buildScrub(tiles: Uint8Array, w: number, h: number, mat: THREE.Material): void {
    const nearTree = (x: number, y: number) => {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const tx = x + dx, ty = y + dy;
        if (tx >= 0 && ty >= 0 && tx < w && ty < h && tiles[ty * w + tx] === Tile.Tree) return true;
      }
      return false;
    };
    const enum S { Bush, Tuft, DryTuft, Stones, Log, Stump }
    const geos = [
      bush(),
      tuft([PAL.grassLit, PAL.grass, 0x62703a, PAL.grassDark]),
      tuft([0x7a6e3e, 0x6b6236, 0x857844, 0x5e5a30]),
      stones(), log(), stump(),
    ];
    // Knee high at most: only the bushes, logs and stumps are worth drawing into the shadow map.
    const shadow = [true, false, false, false, true, true];
    const scs = geos.map(() => new Scatter());
    const jx = (x: number, y: number, s: number) => x + 0.15 + hash(x, y, s) * 0.7;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = tiles[y * w + x];
      if (t !== Tile.Grass && t !== Tile.Sand && t !== Tile.Dirt && t !== Tile.Floor) continue;
      const r = hash(x, y, 31), r2 = hash(x, y, 36), b = 0.88 + hash(x, y, 37) * 0.24, head = hash(x, y, 35) * 6.28;
      const px = jx(x, y, 33), pz = jx(y, x, 34), s = 0.8 + hash(x, y, 32) * 0.5;
      if (t === Tile.Floor) {
        // The yard is trodden bare, but along its edge a tuft or a stone holds on.
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => tiles[(y + dy) * w + x + dx] !== Tile.Floor);
        if (edge && r < 0.06) scs[S.Stones].add(px, pz, head, s * 0.8, s * 0.8, tint(b));
        if (edge && r2 < 0.25) scs[S.DryTuft].add(jx(x, y, 39), jx(y, x, 40), head, 0.7 + hash(x, y, 41) * 0.5, 0.6 + hash(x, y, 42) * 0.5, tint(b));
        continue;
      }
      if (t === Tile.Dirt) {
        if (r < 0.05) scs[S.Stones].add(px, pz, head, s, s, tint(b));
        continue;
      }
      const wood = nearTree(x, y);
      if (t === Tile.Grass && r < 0.03) scs[S.Bush].add(px, pz, head, s, s * (0.85 + r2 * 0.3), tint(b, 1 + r2 * 0.12, 1, 0.92));
      else if (wood && r < 0.045) scs[S.Log].add(px, pz, head, 0.8 + r2 * 0.35, 1, tint(b));
      else if (wood ? r < 0.075 : r < 0.034) scs[S.Stump].add(px, pz, head, 0.8 + r2 * 0.4, 0.8 + r2 * 0.4, tint(b));
      else if (r < 0.09) scs[S.Stones].add(px, pz, head, s, s, tint(b));
      // Tufts are the commonest thing on the ground, greener in the grass than on dry ground.
      if (r2 < (t === Tile.Grass ? 0.22 : 0.12)) {
        const dry = t === Tile.Sand || hash(x >> 2, y >> 2, 38) < 0.3;
        scs[dry ? S.DryTuft : S.Tuft].add(jx(x, y, 39), jx(y, x, 40), head, 0.8 + hash(x, y, 41) * 0.6, 0.7 + hash(x, y, 42) * 0.7, tint(b));
      }
    }
    scs.forEach((sc, k) => { sc.build(this.group, geos[k], mat, shadow[k]); this.scatters.push(sc); });
    this.disposables.push(...geos);
  }
}

// A ruin's parts merged, their colours worn into the picture's: a little less saturated, no
// paint brighter than old cloth, the ground's dust over all.
const ruin = (ps: Part[]) => merge(ps.map((p) => ({ geo: p.geo, color: mute(p.color, 0.8, 0.18) })));

// Ruined walls come in styles, each block of one built along +x, a tile long. lo..hi is how
// tall a block of it stands, before the break.
const enum Wall { Siding = 0, Brick, Stone, Cinder, Timber, Fort, Shop, Chapel, Shrine, Pillar, Altar }
const WALLS: { lo: number; hi: number; geo: () => THREE.BufferGeometry }[] = [
  // Siding: a brick footing, faded clapboard, a broken top.
  { lo: 0.8, hi: 1.6, geo: () => ruin([
    part(box(1, 0.3, 1), 0x6e3e30, 0, 0.15, 0),
    part(box(0.96, 0.7, 0.96), 0xb3a88c, 0, 0.65, 0),
    part(box(1, 0.06, 1), 0x8a8270, 0, 0.62, 0),
    part(box(0.98, 0.08, 0.98), 0x6a6458, 0, 1.0, 0),
    part(box(0.45, 0.3, 0.45), 0x9c9178, 0.22, 1.12, 0.18, 0, 0.4, 0),
  ]) },
  // Brick: red courses with pale mortar, the top fallen away in steps.
  { lo: 0.85, hi: 1.5, geo: () => ruin([
    part(box(1, 0.9, 0.72), 0x8e4a34, 0, 0.45, 0),
    part(box(1.01, 0.035, 0.73), 0xb0a090, 0, 0.22, 0),
    part(box(1.01, 0.035, 0.73), 0xb0a090, 0, 0.45, 0),
    part(box(1.01, 0.035, 0.73), 0xb0a090, 0, 0.68, 0),
    part(box(0.6, 0.2, 0.72), 0x7a3c2a, -0.2, 1.0, 0),
    part(box(0.28, 0.14, 0.72), 0x8e4a34, -0.36, 1.17, 0),
    part(box(0.26, 0.12, 0.2), 0x8e4a34, 0.28, 0.06, 0.46, 0, 0.6, 0),
  ]) },
  // Fieldstone: an old farmhouse's grey stones, lumpy, with a capstone or two left.
  { lo: 0.8, hi: 1.3, geo: () => ruin([
    part(box(1, 0.86, 0.8), 0x737064, 0, 0.43, 0),
    part(dodeca(0.24), 0x878374, -0.3, 0.22, 0.32, 0.3, 0, 0, 1.3, 0.8, 0.6),
    part(dodeca(0.22), 0x66635a, 0.22, 0.5, 0.33, 0, 0.5, 0, 1.4, 0.8, 0.6),
    part(dodeca(0.2), 0x8f8a7a, -0.12, 0.7, -0.33, 0.4, 0, 0, 1.3, 0.8, 0.6),
    part(dodeca(0.22), 0x6e6b5e, 0.3, 0.2, -0.33, 0, 0.3, 0, 1.2, 0.9, 0.6),
    part(dodeca(0.26), 0x7d7a6c, -0.18, 0.92, 0, 0.2, 0.4, 0, 1.3, 0.6, 1.1),
    part(dodeca(0.2), 0x8a8676, 0.26, 0.9, 0.05, 0, 0.9, 0, 1, 0.6, 1.2),
  ]) },
  // Cinder block: grey blocks with their seams, a stained foot, rusted rebar out of the top.
  { lo: 0.9, hi: 1.5, geo: () => ruin([
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
  { lo: 0.85, hi: 1.2, geo: () => ruin([
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
  { lo: 1.1, hi: 1.3, geo: () => ruin([
    part(box(1, 0.95, 0.85), 0x8c8b84, 0, 0.475, 0),
    part(box(1.01, 0.1, 0.86), 0x56554f, 0, 0.22, 0),
    part(dodeca(0.2), 0x8f8058, -0.3, 1.0, 0, 0, 0.2, 0, 1.5, 0.6, 1.4),
    part(dodeca(0.2), 0x9a8a62, 0.02, 1.0, 0.04, 0, -0.1, 0, 1.5, 0.6, 1.4),
    part(dodeca(0.2), 0x857652, 0.33, 1.0, -0.03, 0, 0.3, 0, 1.4, 0.6, 1.4),
  ]) },
  // The gas station's shop: painted block, a teal band where the sign ran, a grimy foot.
  { lo: 1.2, hi: 1.35, geo: () => ruin([
    part(box(1, 1, 0.64), 0xc4bfae, 0, 0.5, 0),
    part(box(1.01, 0.18, 0.65), 0x66635a, 0, 0.09, 0),
    part(box(1.01, 0.15, 0.65), 0x2f7472, 0, 0.78, 0),
    part(box(1.02, 0.05, 0.7), 0x8a867a, 0, 1.0, 0),
  ]) },
  // The church: tall pale ashlar on a dark plinth, a string course, the top broken off unevenly.
  { lo: 1.7, hi: 2.4, geo: () => ruin([
    part(box(1, 1, 0.8), 0xb9b2a0, 0, 0.5, 0),
    part(box(1.02, 0.22, 0.84), 0x6e6a5e, 0, 0.11, 0),
    part(box(1.01, 0.03, 0.81), 0x9a9482, 0, 0.42, 0),
    part(box(1.01, 0.03, 0.81), 0x9a9482, 0, 0.72, 0),
    part(box(1.03, 0.07, 0.86), 0xa49d8a, 0, 0.98, 0),
    part(box(0.4, 0.16, 0.8), 0xb0a996, -0.24, 1.06, 0),
  ]) },
  // A shrine's wall: old grey-green ashlar, older than the church, worn round, moss along the
  // broken top and ivy down its faces.
  { lo: 0.7, hi: 1.9, geo: () => ruin([
    part(box(1, 1, 0.78), 0x868a7a, 0, 0.5, 0),
    part(box(1.02, 0.18, 0.82), 0x5e6256, 0, 0.09, 0),
    part(box(0.48, 0.42, 0.8), 0x7a7e6e, -0.25, 0.4, 0),
    part(box(0.5, 0.3, 0.8), 0x929684, 0.24, 0.72, 0),
    part(box(1.01, 0.025, 0.79), 0x6a6e60, 0, 0.6, 0),
    part(box(1.0, 0.07, 0.8), 0x4a6a2e, 0, 1.0, 0),
    part(dodeca(0.16), 0x55783a, 0.3, 1.02, 0.12, 0, 0, 0, 1.4, 0.5, 1.2),
    part(box(0.07, 0.55, 0.03), 0x3e5a26, -0.3, 0.72, 0.4),
    part(box(0.06, 0.35, 0.03), 0x3e5a26, 0.12, 0.82, -0.4),
  ]) },
  // A shrine's pillar: a drum column on a plinth, the drums a little off true, a heavy
  // capital, moss on top.
  { lo: 2.3, hi: 3.3, geo: () => ruin([
    part(box(0.9, 0.12, 0.9), 0x6a6e60, 0, 0.06, 0),
    part(cyl(0.28, 0.3, 0.3, 8), 0x8a8e7e, 0, 0.27, 0),
    part(cyl(0.27, 0.28, 0.3, 8), 0x92968a, 0.02, 0.57, 0, 0, 0.2, 0),
    part(cyl(0.27, 0.27, 0.28, 8), 0x868a7a, -0.02, 0.86, 0.01, 0, 0.4, 0),
    part(box(0.72, 0.08, 0.72), 0x7a7e6e, 0, 0.96, 0),
    part(box(0.6, 0.05, 0.6), 0x4a6a2e, 0, 1.0, 0),
    part(box(0.05, 0.4, 0.04), 0x3e5a26, 0.26, 0.62, 0.1),
  ]) },
  // The altar: a long block on two steps, a band of gold leaf worn through round it.
  { lo: 0.8, hi: 0.85, geo: () => ruin([
    part(box(1, 0.2, 1), 0x6e7264, 0, 0.1, 0),
    part(box(1, 0.8, 0.8), 0x9a9c8c, 0, 0.5, 0),
    part(box(1.01, 0.06, 0.82), 0x9a7a30, 0, 0.74, 0),
    part(box(1.02, 0.08, 0.86), 0xa8aa98, 0, 0.98, 0),
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
  // A shrine's walls, pillars and altar by its plan.
  for (const s of sites) {
    if (s.kind !== SiteKind.Shrine) continue;
    SHRINE_PLAN.forEach((row, ly) => [...row].forEach((c, lx) => {
      const st = c === '#' ? Wall.Shrine : c === 'o' ? Wall.Pillar : c === 'A' ? Wall.Altar : -1;
      if (st >= 0) { const [x, y] = shrineTile(s, lx, ly); paint(x, y, 1, 1, st); }
    }));
  }
  // The church's nave and the foot of its tower, which stands on past the nave towards yaw.
  for (const s of sites) {
    if (s.kind !== SiteKind.Church) continue;
    const fx = Math.round(Math.cos(s.yaw ?? 0)), fy = Math.round(Math.sin(s.yaw ?? 0));
    paint(Math.min(s.x, s.x + fx * 3), Math.min(s.y, s.y + fy * 3), s.w + Math.abs(fx) * 3, s.h + Math.abs(fy) * 3, Wall.Chapel);
  }
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
