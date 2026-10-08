import * as THREE from 'three/webgpu';
import {
  abs, float, floor, instancedDynamicBufferAttribute, mix, positionGeometry, positionLocal, select, sin, cos, step, time,
  uniform, vec3, vertexColor,
} from 'three/tsl';
import { CF_ASLEEP, CF_BURNING, CF_HUNTING, CF_SIEGE, CF_SLOWED, type CreepDef, MAX_CREEPS } from '../protocol';
import type { Game } from '../state';
import { box, cone, dodeca, lin, merge, part, setEmissive, sphere, writeMatrix, type Part } from './util';

// Models are built facing +x, about 1 unit wide, standing on y = 0. Parts painted SHIRT take
// a per-instance colour, so a horde is a crowd of different people.
const SHIRT = 0xff00ff;
const SKIN = 0x8c9478, SKIN_DARK = 0x6e7860, JEANS = 0x3a4458, SHOE = 0x2a2420, BLOOD = 0x4a0c0a, HAIR = 0x2e2620;

// The shuffling dead: legs, a slumped torso, a lolling head, arms reaching forward.
function shambler(p: Part[], lean: number, armsUp: boolean, w = 1): void {
  p.push(part(box(0.17, 0.5, 0.17), JEANS, -0.02, 0.25, 0.12 * w));
  p.push(part(box(0.17, 0.5, 0.17), JEANS, 0.04, 0.25, -0.12 * w, 0, 0, 0.15));
  p.push(part(box(0.24, 0.06, 0.18), SHOE, 0.05, 0.03, 0.12 * w));
  p.push(part(box(0.3, 0.52, 0.46 * w), SHIRT, 0.02, 0.76, 0, 0, 0, -lean));
  p.push(part(box(0.04, 0.16, 0.12), BLOOD, 0.17 + lean * 0.3, 0.8, 0.08, 0, 0, -lean));
  p.push(part(box(0.24, 0.26, 0.24), SKIN, 0.1 + lean * 0.5, 1.14, 0.03, 0.25, 0, -0.2));
  p.push(part(box(0.25, 0.08, 0.25), HAIR, 0.08 + lean * 0.5, 1.28, 0.03, 0.25, 0, -0.2));
  p.push(part(box(0.06, 0.06, 0.2), 0x3a1410, 0.22 + lean * 0.5, 1.1, 0.03, 0.25, 0, -0.2));
  for (const z of [0.29 * w, -0.29 * w]) {
    p.push(part(box(0.16, 0.14, 0.14), SHIRT, 0.04, 0.95, z));
    if (armsUp) p.push(part(box(0.46, 0.11, 0.11), SKIN_DARK, 0.3, 0.94, z * 0.9, 0, z > 0 ? -0.15 : 0.1, 0.12));
    else p.push(part(box(0.11, 0.46, 0.11), SKIN_DARK, 0.04, 0.68, z, 0.2 * Math.sign(z), 0, 0.3));
  }
}

function model(kind: number, def: CreepDef): THREE.BufferGeometry {
  const p: Part[] = [];
  switch (def.name === 'abomination' ? 5 : kind) {
    case 0: // walker
      shambler(p, 0.15, true);
      break;
    case 1: // runner: leaning hard into a sprint, arms pumping
      shambler(p, 0.45, false, 0.9);
      break;
    case 2: // swarmer: a crawler dragging itself along
      p.push(part(box(0.62, 0.22, 0.4), SHIRT, -0.05, 0.16, 0));
      p.push(part(box(0.5, 0.16, 0.14), JEANS, -0.6, 0.09, 0.1, 0, 0.15, 0));
      p.push(part(box(0.5, 0.16, 0.14), JEANS, -0.58, 0.09, -0.11, 0, -0.1, 0));
      p.push(part(box(0.24, 0.24, 0.24), SKIN, 0.36, 0.24, 0, 0, 0, 0.3));
      p.push(part(box(0.25, 0.07, 0.25), HAIR, 0.38, 0.37, 0, 0, 0, 0.3));
      p.push(part(box(0.44, 0.1, 0.1), SKIN_DARK, 0.45, 0.08, 0.2, 0, -0.3, 0));
      p.push(part(box(0.44, 0.1, 0.1), SKIN_DARK, 0.42, 0.08, -0.2, 0, 0.4, 0));
      p.push(part(box(0.2, 0.03, 0.2), BLOOD, -0.1, 0.28, 0.05));
      break;
    case 3: // brute: a huge, bloated man in a torn work shirt
      p.push(part(box(0.3, 0.6, 0.3), JEANS, 0, 0.3, 0.24));
      p.push(part(box(0.3, 0.6, 0.3), JEANS, 0.05, 0.3, -0.24));
      p.push(part(box(0.75, 0.85, 1.0), SHIRT, 0, 1.0, 0));
      p.push(part(box(0.6, 0.35, 0.85), SKIN, 0.12, 0.72, 0));
      p.push(part(box(0.06, 0.3, 0.3), BLOOD, 0.38, 1.05, -0.15));
      p.push(part(box(0.34, 0.32, 0.34), SKIN, 0.22, 1.56, 0, 0, 0, -0.2));
      p.push(part(box(0.3, 0.75, 0.26), SKIN_DARK, 0.15, 0.85, 0.66, 0, 0, 0.2));
      p.push(part(box(0.3, 0.75, 0.26), SKIN_DARK, 0.15, 0.85, -0.66, 0, 0, 0.2));
      break;
    case 4: // spitter: swollen with bile, boils on the belly
      p.push(part(box(0.17, 0.45, 0.17), JEANS, 0, 0.22, 0.13));
      p.push(part(box(0.17, 0.45, 0.17), JEANS, 0, 0.22, -0.13));
      p.push(part(sphere(0.38, 7, 5), 0x8a9a4a, 0.04, 0.72, 0, 0, 0, 0, 1, 0.95, 1.1));
      p.push(part(box(0.3, 0.2, 0.48), SHIRT, -0.05, 0.98, 0));
      for (const [y, z] of [[0.6, 0.2], [0.8, -0.18], [0.55, -0.05]]) p.push(part(sphere(0.08, 5, 3), 0xb8c050, 0.36, y, z));
      p.push(part(box(0.24, 0.24, 0.24), 0x9aa070, 0.12, 1.2, 0, 0, 0, -0.35));
      p.push(part(box(0.1, 0.08, 0.14), 0x6a8a1a, 0.26, 1.13, 0, 0, 0, -0.35));
      p.push(part(box(0.11, 0.42, 0.11), SKIN_DARK, 0, 0.75, 0.36, 0.3, 0, 0));
      p.push(part(box(0.11, 0.42, 0.11), SKIN_DARK, 0, 0.75, -0.36, -0.3, 0, 0));
      break;
    default: // abomination: a mound of fused bodies, bone breaking through
      p.push(part(dodeca(0.75), 0x7a3a32, 0, 0.95, 0, 0, 0, 0, 1, 1.1, 1));
      p.push(part(dodeca(0.45), 0x8c4a3e, 0.45, 1.45, 0.2));
      p.push(part(dodeca(0.4), 0x5a2620, -0.35, 1.35, -0.35));
      p.push(part(box(0.26, 0.26, 0.26), SKIN, 0.7, 1.4, 0.05, 0.3, 0, -0.3));
      p.push(part(box(0.22, 0.22, 0.22), SKIN_DARK, 0.3, 1.15, 0.62, 0.6, 0, 0.2));
      p.push(part(box(0.22, 0.22, 0.22), SKIN, -0.2, 1.75, 0.2, -0.3, 0.5, 0));
      for (const a of [0.4, 1.6, 2.8, 4.0, 5.2]) p.push(part(cone(0.1, 0.5, 4), 0xd8ccb0, Math.cos(a) * 0.45, 1.7, Math.sin(a) * 0.45, Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6));
      p.push(part(box(0.5, 0.5, 0.5), SHIRT, -0.1, 0.95, 0.35, 0.3, 0.4, 0));
      p.push(part(box(0.35, 0.6, 0.35), 0x4a1c18, 0, 0.3, 0.4));
      p.push(part(box(0.35, 0.6, 0.35), 0x4a1c18, 0, 0.3, -0.4));
      p.push(part(box(0.6, 0.12, 0.12), SKIN_DARK, 0.6, 0.8, -0.55, 0, 0.4, 0.3));
  }
  return merge(p);
}

// Drab clothes: rust, navy, khaki, olive, grey, off-white, black, brown, faded blue.
const CLOTHES = [0x6a2a24, 0x2e3a56, 0x8a7e62, 0x4a5636, 0x5a5a58, 0x9a968a, 0x26262a, 0x5e4a32, 0x4e6a80];

const STRIDE = 12;
// Markers over creeps: a "z" over sleeping guards, a "!" over those hunting you.
const MARKS = 2048;

interface KindMesh { mesh: THREE.InstancedMesh; fx: Float32Array; buf: THREE.InstancedInterleavedBuffer; scale: number; top: number; n: number }

// One InstancedMesh per creep kind. Matrices are written straight into instanceMatrix; the
// per-instance effects buffer drives the TSL material: bob/wobble and the status tints.
export class Creeps {
  group = new THREE.Group();
  private kinds: KindMesh[] = [];
  hovered = -1;
  private uHover = uniform(0);
  private zs: THREE.InstancedMesh;
  private bangs: THREE.InstancedMesh;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    const zm = new THREE.MeshBasicNodeMaterial({ color: 0xd8e4ff, transparent: true, opacity: 0.85, depthWrite: false });
    zm.fog = false;
    this.zs = new THREE.InstancedMesh(merge([
      part(box(0.26, 0.06, 0.04), 0), part(box(0.26, 0.06, 0.04), 0, 0, -0.24, 0), part(box(0.06, 0.32, 0.04), 0, 0, -0.12, 0, 0, 0, -0.9),
    ]), zm, MARKS);
    const bm = new THREE.MeshBasicNodeMaterial();
    bm.colorNode = vec3(1, 0.16, 0.08).mul(sin(time.mul(9)).mul(0.25).add(1.05));
    bm.fog = false;
    this.bangs = new THREE.InstancedMesh(merge([part(box(0.1, 0.3, 0.06), 0, 0, 0.1, 0), part(box(0.1, 0.1, 0.06), 0, 0, -0.17, 0)]), bm, MARKS);
    for (const m of [this.zs, this.bangs]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0; m.frustumCulled = false; m.renderOrder = 4;
    }
  }

  setup(defs: CreepDef[]): void {
    for (const k of this.kinds) { k.mesh.geometry.dispose(); (k.mesh.material as THREE.Material).dispose(); }
    this.kinds = [];
    this.group.clear();
    this.group.add(this.zs, this.bangs);
    defs.forEach((d, i) => {
      const cap = MAX_CREEPS;
      const geo = model(i, d);
      const fx = new Float32Array(cap * STRIDE);
      const buf = new THREE.InstancedInterleavedBuffer(fx, STRIDE, 1);
      buf.setUsage(THREE.DynamicDrawUsage);
      // fx: burning, slowed, flash, hovered | phase, bob amplitude, walk speed, clothes |
      //     asleep, hunting you, siege, -
      const st = instancedDynamicBufferAttribute<'vec4'>(buf, 'vec4', STRIDE, 0);
      const an = instancedDynamicBufferAttribute<'vec4'>(buf, 'vec4', STRIDE, 4);
      const mo = instancedDynamicBufferAttribute<'vec4'>(buf, 'vec4', STRIDE, 8);
      const mat = new THREE.MeshLambertNodeMaterial();
      const t = time.mul(an.z).add(an.x);
      const gy = positionGeometry.y;
      const bob = abs(sin(t)).mul(an.y);
      const sway = vec3(sin(t.mul(0.5)), float(0), cos(t.mul(0.5))).mul(gy.mul(an.y).mul(0.35));
      // Asleep: slumped low and forward, breathing; at a structure: leaning into it.
      const breathe = sin(time.mul(1.6).add(an.x)).mul(0.03);
      const slump = vec3(gy.mul(0.22).add(breathe), gy.mul(-0.3).add(breathe.mul(0.5)), float(0)).mul(mo.x);
      const lean = vec3(gy.mul(0.18), gy.mul(-0.06), float(0)).mul(mo.z);
      mat.positionNode = positionLocal.add(sway).add(vec3(0, bob, 0)).add(slump).add(lean);
      let c = vertexColor().rgb;
      // Shirts: an exact magenta in the model, a colour picked per creep from fx.w.
      const pick = floor(an.w.mul(CLOTHES.length));
      const cl = (hex: number) => { const k = lin(hex); return vec3(k.r, k.g, k.b); };
      let shirt: THREE.Node<'vec3'> = cl(CLOTHES[0]);
      for (let k = 1; k < CLOTHES.length; k++) shirt = select(pick.greaterThanEqual(k), cl(CLOTHES[k]), shirt);
      const isShirt = step(0.9, c.r).mul(step(c.g, 0.1)).mul(step(0.9, c.b));
      c = mix(c, shirt, isShirt);
      c = mix(c, c.mul(vec3(1.5, 0.75, 0.35)).add(vec3(0.15, 0.04, 0)), st.x.mul(0.8));
      c = mix(c, c.mul(vec3(0.6, 0.85, 1.25)).add(vec3(0.01, 0.04, 0.1)), st.y.mul(0.7));
      c = mix(c, vec3(1, 0.95, 0.85), st.z.mul(0.45));
      // Hunting you: a red cast so you see what you pulled; asleep: a little darker.
      c = mix(c, c.mul(vec3(1.5, 0.45, 0.4)).add(vec3(0.08, 0, 0)), mo.y.mul(0.6));
      c = c.mul(float(1).sub(mo.x.mul(0.18)));
      mat.colorNode = c;
      const flicker = sin(time.mul(23).add(an.x.mul(7))).mul(0.25).add(0.75);
      setEmissive(mat, vec3(0.9, 0.3, 0.05).mul(st.x.mul(flicker).mul(0.45))
        .add(vec3(1, 0.9, 0.7).mul(st.z.mul(0.3)))
        .add(vec3(0.5, 0.45, 0.2).mul(st.w.mul(this.uHover)))
        .add(vec3(0.35, 0.02, 0).mul(mo.y.mul(sin(time.mul(9)).mul(0.3).add(0.7)))));
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      // Fit the model's footprint to the creep's diameter, a little larger so crowds read as solid.
      geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      const foot = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, 0.3);
      const scale = (d.radius * 2.3) / foot;
      this.kinds.push({ mesh, fx, buf, scale, top: bb.max.y * scale, n: 0 });
    });
  }

  update(game: Game, now: number, dt: number, cam?: THREE.Camera): void {
    const f = game.cur;
    const kinds = this.kinds;
    for (const k of kinds) k.n = 0;
    const sec = now / 1000;
    this.uHover.value = 0.6 + 0.4 * Math.sin(sec * 8);
    const you = game.welcome?.you ?? -1;
    // Markers turn to face the camera round the vertical.
    const e = cam?.matrixWorld.elements;
    const face = e ? Math.atan2(-e[8], e[10]) : 0;
    const za = this.zs.instanceMatrix.array as Float32Array, ba = this.bangs.instanceMatrix.array as Float32Array;
    let nz = 0, nb = 0;
    for (let i = 0; i < f.nCreeps; i++) {
      const kind = f.cKind[i];
      const km = kinds[kind];
      if (!km) continue;
      const id = f.cId[i];
      const j = km.n++;
      const mat = km.mesh.instanceMatrix.array as Float32Array;
      writeMatrix(mat, j * 16, game.rx[i], 0, game.ry[i], game.heading[id], km.scale);
      const fx = km.fx, o = j * STRIDE;
      const fl = f.cFlags[i];
      fx[o] = fl & CF_BURNING ? 1 : 0;
      fx[o + 1] = fl & CF_SLOWED ? 1 : 0;
      fx[o + 2] = Math.max(0, Math.min(1, (game.flashUntil[id] - now) / 90));
      fx[o + 3] = id === this.hovered ? 1 : 0;
      fx[o + 4] = (id * 0.618) % 1 * 6.28;
      fx[o + 5] = 0.06 * km.scale;
      fx[o + 6] = (fl & CF_SLOWED ? 5 : 10) / Math.max(0.6, km.scale);
      fx[o + 7] = (id * 0.7548776662) % 1;
      const asleep = (fl & CF_ASLEEP) !== 0, me = (fl & CF_HUNTING) !== 0 && f.cTarget[i] === you;
      fx[o + 8] = asleep ? 1 : 0;
      fx[o + 9] = me ? 1 : 0;
      fx[o + 10] = fl & CF_SIEGE && !(fl & CF_HUNTING) ? 1 : 0;
      if (asleep) {
        fx[o + 5] = 0;
        if (nz < MARKS) {
          const u = (sec * 0.45 + fx[o + 7]) % 1;
          const s = 1 + u * 1.1;
          writeMatrix(za, nz++ * 16, game.rx[i] + u * 0.35, km.top * 0.75 + 0.3 + u * 0.9, game.ry[i], face, s * (1 - u * u * u));
        }
      } else if (me && nb < MARKS) {
        const s = 1.5 + 0.2 * Math.sin(sec * 9 + fx[o + 4]);
        writeMatrix(ba, nb++ * 16, game.rx[i], km.top + 0.5, game.ry[i], face, s);
      }
    }
    this.zs.count = nz; this.bangs.count = nb;
    if (nz) this.zs.instanceMatrix.needsUpdate = true;
    if (nb) this.bangs.instanceMatrix.needsUpdate = true;
    void dt;
    for (const k of kinds) {
      k.mesh.count = k.n;
      if (k.n === 0) continue;
      const im = k.mesh.instanceMatrix;
      im.clearUpdateRanges(); im.addUpdateRange(0, k.n * 16); im.needsUpdate = true;
      k.buf.clearUpdateRanges(); k.buf.addUpdateRange(0, k.n * STRIDE); k.buf.needsUpdate = true;
    }
  }
}
