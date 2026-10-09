import * as THREE from 'three/webgpu';
import {
  abs, attribute, cos, float, floor, Fn, fract, instancedDynamicBufferAttribute, int, max, mix, normalGeometry, normalLocal,
  positionGeometry, select, sin, smoothstep, step, time, uniform, uniformArray, vec3, vertexColor,
} from 'three/tsl';
import {
  CF_ASLEEP, CF_BURNING, CF_HUNTING, CF_SIEGE, CF_SLOWED, CF_STRIKE, CF_WINDUP, type CreepDef, MAX_CREEPS, PF_ALIVE,
} from '../protocol';
import type { Game } from '../state';
import { type CreepRig, creepRig } from './creepModels';
import { J, JOINTS, mergeRig, turnTowards } from './rig';
import { box, lin, merge, part, setEmissive, writeMatrix } from './util';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// Drab clothes: rust, navy, khaki, olive, grey, off-white, black, brown, faded blue, hi-vis
// orange gone brown, a hospital gown, a white shirt.
const CLOTHES = [0x6a2a24, 0x2e3a56, 0x8a7e62, 0x4a5636, 0x5a5a58, 0x9a968a, 0x26262a, 0x5e4a32, 0x4e6a80, 0x9a5a22, 0x7a96a4, 0xb4b0a4];
// Jeans, black, khaki, grey, brown, navy, olive, faded denim.
const PANTS = [0x3a4458, 0x26262a, 0x7a6e52, 0x55555a, 0x4e3e2c, 0x2a3046, 0x4a5236, 0x56687e];
// How far gone: grey-green, pallid, grey, dead brown, dark green, waxen, dark, bruised blue.
const SKINS = [0x8c9478, 0x9a9a88, 0x7a7a6a, 0x8a7e6a, 0x6e7a6a, 0xa09888, 0x5e5a4e, 0x7e8a80];
// Hair; the last is bald, the scalp the skin.
const HAIRS = [0x2e2620, 0x16120f, 0x4e3220, 0x8e8a82, 0xa88a52, 0x6a2e1a, 0x2e2620, -1];

// Floats per instance: seven vec4s.
//   st  burning, slowed, flash, hovered
//   an  gait phase, how much it is walking, shirt, seed
//   mo  asleep, hunting you, at a structure, which arm leads
//   at  winding up, striking, flinching, head tilt
//   va  limp, arms hanging rather than reaching, an arm gone, trousers
//   de  dying 0..1, falls forward (1) or back (-1), sunk, thrown
//   pl  x, y, z, heading
const STRIDE = 28;
// Markers over creeps: a "z" over sleeping guards, a "!" over those hunting you.
const MARKS = 2048;
// The dead lie a while, then sink away.
const CORPSES = 1024, LIE = 3.4, SINK = 1.3, FALL = 0.7;

interface KindMesh { mesh: THREE.InstancedMesh; fx: Float32Array; buf: THREE.InstancedInterleavedBuffer; scale: number; top: number; n: number; rig: CreepRig; def: CreepDef }

const hash = (id: number, salt: number) => {
  let h = Math.imul(id ^ Math.imul(salt, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

// The shader: the vertex's joints posed from the instance's state, outermost last, then the
// whole figure bobbed, felled, scaled and placed.
function material(r: CreepRig, scale: number, buf: THREE.InstancedInterleavedBuffer, uHover: THREE.UniformNode<'float', number>): THREE.MeshLambertNodeMaterial {
  const v4 = (o: number) => instancedDynamicBufferAttribute<'vec4'>(buf, 'vec4', STRIDE, o);
  const st = v4(0), an = v4(4), mo = v4(8), at = v4(12), va = v4(16), de = v4(20), pl = v4(24);
  const pivots: THREE.Vector3[] = [], pars: THREE.Vector4[] = [];
  for (let j = 0; j < JOINTS; j++) {
    const d = r.joints[j];
    pivots.push(new THREE.Vector3(...(d?.p ?? [0, 0, 0])));
    for (const v of [d?.walk, d?.flex, d?.wind, d?.strike, d?.die, d?.misc]) pars.push(new THREE.Vector4(...(v ?? [0, 0, 0, 0])));
  }
  const uPiv = uniformArray<'vec3'>(pivots, 'vec3'), uPar = uniformArray<'vec4'>(pars, 'vec4');

  const phase = an.x, move = an.y, seed = an.w;
  const wind = at.x, strike = at.y, flinch = at.z;
  const die = de.x, dieJ = smoothstep(0, 0.45, die);
  const flail = st.x.mul(sin(time.mul(17).add(seed.mul(40))));

  const rot = (v: V3, a: V3): V3 => {
    const cz = cos(a.x), sz = sin(a.x), cx = cos(a.y), sx = sin(a.y), cy = cos(a.z), sy = sin(a.z);
    const x1 = v.x.mul(cz).sub(v.y.mul(sz)), y1 = v.x.mul(sz).add(v.y.mul(cz));
    const y2 = y1.mul(cx).sub(v.z.mul(sx)), z2 = y1.mul(sx).add(v.z.mul(cx));
    return vec3(x1.mul(cy).add(z2.mul(sy)), y2, x1.mul(sy).negate().add(z2.mul(cy)));
  };

  const pose = Fn(() => {
    const rj = attribute<'vec3'>('rj', 'vec3');
    let p: V3 = positionGeometry, n: V3 = normalGeometry;
    // An arm gone: the left arm's parts all collapse into its shoulder.
    const own = rj.x;
    const lost = float(1).sub(step(0.5, abs(own.sub(J.UARM_L)))).add(float(1).sub(step(0.5, abs(own.sub(J.FARM_L))))).mul(va.z);
    p = mix(p, uPiv.element(J.UARM_L), lost);
    for (const id of [rj.x, rj.y, rj.z] as F[]) {
      const ok = step(-0.5, id);
      const i = int(max(id, 0));
      const b = i.mul(6);
      const P0 = uPar.element(b), P1 = uPar.element(b.add(1)), P2 = uPar.element(b.add(2));
      const P3 = uPar.element(b.add(3)), P4 = uPar.element(b.add(4)), P5 = uPar.element(b.add(5));
      const cls = P5.w, side = P5.z;
      const arm = step(0.5, cls).mul(step(cls, 1.5)), leg = step(1.5, cls);
      const ph = phase.add(P0.y);
      const limp = float(1).add(va.x.mul(side).mul(leg).mul(0.5));
      const lead = float(1).add(mo.w.mul(side).mul(arm).mul(0.55));
      const s = sin(ph);
      const idle = sin(time.mul(1.7).add(seed.mul(6.28)).add(id)).mul(P1.w);
      const z = P0.w.mul(float(1).sub(va.y.mul(arm)))
        .add(P0.x.mul(s).mul(move).mul(limp))
        .add(P1.x.mul(max(sin(ph.add(P1.y)), 0)).mul(move).mul(limp))
        .add(idle);
      const head = float(1).sub(step(0.5, abs(id.sub(J.HEAD))));
      let a: V3 = vec3(z, P0.z.mul(s).mul(move).add(at.w.mul(head)), P1.z.mul(s).mul(move));
      const slump = dieJ.add(mo.x.mul(0.3));
      a = a.add(P2.xyz.mul(wind).mul(lead)).add(P3.xyz.mul(strike).mul(lead)).add(P4.xyz.mul(slump))
        .add(vec3(P5.x.mul(flinch), P5.y.mul(flail).mul(0.5), P5.y.mul(flail).mul(0.3)));
      const k = float(1).add(P2.w.mul(wind)).add(P3.w.mul(strike)).add(P4.w.mul(slump));
      const piv = uPiv.element(i);
      const q = rot(p.sub(piv), a).mul(k).add(piv);
      p = mix(p, q, ok);
      n = mix(n, rot(n, a), ok);
    }
    // The pelvis: a rise and fall with each step, sinking as the knees give.
    const bob = abs(sin(phase)).oneMinus().mul(move).mul(r.bob);
    p = p.add(vec3(0, bob.sub(dieJ.add(mo.x.mul(0.3)).mul(r.drop)), 0));
    // Falling: over the front or back edge, flung high when blown off its feet.
    const thrown = de.w, dir = de.y;
    const fall = smoothstep(0.3, 1, die).mul(dir.negate()).mul(float(1.45).add(thrown.mul(1.6)));
    const edge = vec3(dir.mul(0.32), 0, 0);
    const fz = vec3(fall, 0, 0);
    p = rot(p.sub(edge), fz).add(edge);
    n = rot(n, fz);
    p = p.add(vec3(0, sin(min1(die.mul(1.3)).mul(Math.PI)).mul(thrown).mul(0.9).sub(de.z), 0));
    // Scaled to its size and placed, heading 0 facing +x and turning towards +z.
    const c = cos(pl.w), sn = sin(pl.w);
    const turn = (v: V3) => vec3(v.x.mul(c).sub(v.z.mul(sn)), v.y, v.x.mul(sn).add(v.z.mul(c)));
    normalLocal.assign(turn(n));
    return turn(p.mul(scale)).add(pl.xyz);
  })();

  const mat = new THREE.MeshLambertNodeMaterial();
  mat.positionNode = pose;
  let col = vertexColor().rgb;
  const cl = (hex: number) => { const k = lin(hex); return vec3(k.r, k.g, k.b); };
  const pick = (list: number[], u: F, bald?: V3): V3 => {
    const at = floor(u.mul(list.length));
    let c: V3 = list[0] < 0 && bald ? bald : cl(list[0]);
    for (let k = 1; k < list.length; k++) c = select(at.greaterThanEqual(k), list[k] < 0 && bald ? bald : cl(list[k]), c);
    return c;
  };
  const skin = pick(SKINS, fract(seed.mul(7.13)));
  const hi = step(0.9, col.r), lo = step(col.r, 0.1), gHi = step(0.9, col.g), gLo = step(col.g, 0.1), bHi = step(0.9, col.b), bLo = step(col.b, 0.1);
  col = mix(col, pick(CLOTHES, an.z), hi.mul(gLo).mul(bHi));
  col = mix(col, pick(PANTS, va.w), lo.mul(gHi).mul(bLo));
  col = mix(col, skin, lo.mul(gHi).mul(bHi));
  col = mix(col, pick(HAIRS, fract(seed.mul(13.7)), skin.mul(0.92)), hi.mul(gHi).mul(bLo));
  col = mix(col, col.mul(vec3(1.5, 0.75, 0.35)).add(vec3(0.15, 0.04, 0)), st.x.mul(0.8));
  col = mix(col, col.mul(vec3(0.6, 0.85, 1.25)).add(vec3(0.01, 0.04, 0.1)), st.y.mul(0.7));
  col = mix(col, vec3(1, 0.95, 0.85), st.z.mul(0.45));
  // Hunting you: a red cast so you see what you pulled; asleep, or dead, a little darker.
  col = mix(col, col.mul(vec3(1.5, 0.45, 0.4)).add(vec3(0.08, 0, 0)), mo.y.mul(0.6));
  col = col.mul(float(1).sub(mo.x.mul(0.18)).sub(dieJ.mul(0.2)));
  mat.colorNode = col;
  const flicker = sin(time.mul(23).add(an.x.mul(7))).mul(0.25).add(0.75);
  setEmissive(mat, vec3(0.9, 0.3, 0.05).mul(st.x.mul(flicker).mul(0.45))
    .add(vec3(1, 0.9, 0.7).mul(st.z.mul(0.3)))
    .add(vec3(0.5, 0.45, 0.2).mul(st.w.mul(uHover)))
    .add(vec3(0.35, 0.02, 0).mul(mo.y.mul(sin(time.mul(9)).mul(0.3).add(0.7)))));
  return mat;
}

const min1 = (v: F) => v.min(1);

// One InstancedMesh per creep kind, posed in its material from a per-instance state buffer the
// CPU keeps up: the gait locked to the ground covered, blows wound up and struck in time with
// the host, flinches when hit, turning to what it attacks; and the dead falling and sinking.
export class Creeps {
  group = new THREE.Group();
  private kinds: KindMesh[] = [];
  hovered = -1;
  // A creep lost an arm to the damage it took; a blow landed on something (x, y, its kind).
  onGib: ((x: number, y: number) => void) | null = null;
  onBlow: ((x: number, y: number, kind: number, heading: number, radius: number) => void) | null = null;
  private uHover = uniform(0);
  private zs: THREE.InstancedMesh;
  private bangs: THREE.InstancedMesh;

  // Per creep id.
  private phase = new Float32Array(MAX_CREEPS);
  private yaw = new Float32Array(MAX_CREEPS);
  private wind = new Float32Array(MAX_CREEPS);
  private since = new Float32Array(MAX_CREEPS); // seconds since its last blow
  private lead = new Float32Array(MAX_CREEPS);
  private hitT = new Float32Array(MAX_CREEPS);
  private hitAt = new Float32Array(MAX_CREEPS);
  private lastT = new Float32Array(MAX_CREEPS);
  private px = new Float32Array(MAX_CREEPS);
  private py = new Float32Array(MAX_CREEPS);
  private mv = new Float32Array(MAX_CREEPS);
  private fl = new Uint8Array(MAX_CREEPS);
  private kindOf = new Uint8Array(MAX_CREEPS);
  private armless = new Uint8Array(MAX_CREEPS);
  private stamp = new Uint32Array(MAX_CREEPS);
  private prevIds = new Uint16Array(MAX_CREEPS);
  private nPrev = 0;
  private lastFrames = 0;

  // The dead.
  private cK = new Uint8Array(CORPSES); private cId = new Uint16Array(CORPSES);
  private cX = new Float32Array(CORPSES); private cY = new Float32Array(CORPSES); private cYaw = new Float32Array(CORPSES);
  private cT = new Float32Array(CORPSES); private cDir = new Float32Array(CORPSES); private cThrown = new Float32Array(CORPSES);
  private cArm = new Uint8Array(CORPSES); private cBurn = new Uint8Array(CORPSES);
  private nCorpse = 0; private headCorpse = 0;

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
    this.nPrev = 0; this.nCorpse = 0; this.headCorpse = 0;
    this.lastT.fill(-1e9);
    defs.forEach((d, i) => {
      const cap = MAX_CREEPS + CORPSES;
      const r = creepRig(i, d.name);
      const geo = mergeRig(r.parts);
      // Fit the model's footprint to the creep's diameter, a little larger so crowds read as solid.
      // Its length counts for less than its breadth, or a crawler would shrink to a rat.
      geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      const foot = Math.max((bb.max.x - bb.min.x) * 0.6, bb.max.z - bb.min.z, 0.3);
      const scale = (d.radius * 2.3) / foot;
      const fx = new Float32Array(cap * STRIDE);
      const buf = new THREE.InstancedInterleavedBuffer(fx, STRIDE, 1);
      buf.setUsage(THREE.DynamicDrawUsage);
      const mesh = new THREE.InstancedMesh(geo, material(r, scale, buf, this.uHover), cap);
      // Placement is in the state buffer; the instance matrices stay the identity.
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      this.kinds.push({ mesh, fx, buf, scale, top: bb.max.y * scale, n: 0, rig: r, def: d });
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
    const newFrame = game.frames !== this.lastFrames;
    for (let i = 0; i < f.nCreeps; i++) {
      const kind = f.cKind[i];
      const km = kinds[kind];
      if (!km) continue;
      const id = f.cId[i], r = km.rig, d = km.def;
      const x = game.rx[i], y = game.ry[i];
      const fl = f.cFlags[i];
      this.stamp[id] = game.frames;
      // Unseen a while, or jumped (the id went to a new creep): start afresh, and leave the
      // old one where it fell.
      const jumped = Math.abs(x - this.px[id]) + Math.abs(y - this.py[id]) > 3;
      if (sec - this.lastT[id] > 0.3 || jumped || this.kindOf[id] !== kind) {
        if (jumped && sec - this.lastT[id] <= 0.3) this.corpse(id, now, false, false);
        this.phase[id] = hash(id, 1) * 6.28; this.yaw[id] = game.heading[id];
        this.wind[id] = 0; this.since[id] = 9; this.lead[id] = hash(id, 2) < 0.5 ? 1 : -1;
        this.hitT[id] = 9; this.hitAt[id] = game.flashUntil[id];
        this.px[id] = x; this.py[id] = y; this.mv[id] = 0; this.fl[id] = fl; this.kindOf[id] = kind;
        this.armless[id] = kind <= 1 && hash(id, 3) < 0.08 ? 1 : 0;
      }
      this.lastT[id] = sec;
      // The gait: the phase goes round once per stride covered, so feet do not skate.
      const dx = x - this.px[id], dy = y - this.py[id];
      const dist = Math.hypot(dx, dy);
      this.px[id] = x; this.py[id] = y;
      this.phase[id] = (this.phase[id] + dist / (r.stride * km.scale) * Math.PI * 2) % 6283.18;
      const speed = dt > 0 ? dist / dt : 0;
      const goalMv = Math.min(1.2, speed / Math.max(0.3, d.speed * 0.6));
      this.mv[id] += (goalMv - this.mv[id]) * Math.min(1, dt * 7);

      // Blows: the windup builds while the host says one is coming, the strike snaps in on
      // the tick it lands (or, should that frame be missed, as the windup lets go).
      const was = this.fl[id];
      const windup = d.windup ?? 0.4, rate = d.rate ?? 1;
      if ((fl & CF_STRIKE && !(was & CF_STRIKE)) || (was & CF_WINDUP && !(fl & (CF_WINDUP | CF_STRIKE)) && this.since[id] > 0.3)) {
        this.since[id] = 0;
        this.lead[id] = -this.lead[id];
      }
      this.fl[id] = fl;
      this.since[id] += dt;
      const t = this.since[id];
      const hitIn = Math.min(0.09, windup * 0.4), recover = Math.min(0.45, 0.75 / rate);
      const strike = t < hitIn ? t / hitIn : Math.max(0, 1 - (t - hitIn) / recover) ** 2;
      if (t >= hitIn && t - dt < hitIn && this.onBlow) this.onBlow(x, y, kind, this.yaw[id], d.radius);
      const winding = fl & CF_WINDUP && t > hitIn;
      this.wind[id] += ((winding ? 1 : 0) - this.wind[id]) * Math.min(1, dt * (winding ? 2.2 / windup : 14));
      // Hit: a flinch away from it.
      if (game.flashUntil[id] !== this.hitAt[id] && game.flashUntil[id] > now) { this.hitAt[id] = game.flashUntil[id]; this.hitT[id] = 0; }
      this.hitT[id] += dt;
      const h = this.hitT[id] / 0.28;
      const flinch = h < 1 ? Math.sin(h * Math.PI) * (1 - h) * 1.6 * r.flinch : 0;
      // Down to its last hits, a walker or runner can lose the arm.
      if (!this.armless[id] && kind <= 1 && f.cHp[i] < 70 && hash(id, 4) < 0.3) {
        this.armless[id] = 1;
        this.onGib?.(x, y);
      }

      // Facing: what it attacks while it attacks, else the way it goes.
      let goal = game.heading[id];
      const tg = f.cTarget[i];
      const attacking = fl & (CF_WINDUP | CF_STRIKE) || t < 0.5;
      if (attacking && fl & CF_HUNTING && tg < 128) {
        const p = f.player(tg);
        if (p && p.flags & PF_ALIVE) goal = Math.atan2(game.pry[tg] - y, game.prx[tg] - x);
      } else if (tg >= 128 && tg < 255) goal = (tg - 128) / 127 * Math.PI * 2;
      this.yaw[id] = turnTowards(this.yaw[id], goal, dt * r.turn);

      const j = km.n++;
      const fx = km.fx, o = j * STRIDE;
      const asleep = (fl & CF_ASLEEP) !== 0, me = (fl & CF_HUNTING) !== 0 && tg === you;
      fx[o] = fl & CF_BURNING ? 1 : 0;
      fx[o + 1] = fl & CF_SLOWED ? 1 : 0;
      fx[o + 2] = Math.max(0, Math.min(1, (game.flashUntil[id] - now) / 90));
      fx[o + 3] = id === this.hovered ? 1 : 0;
      fx[o + 4] = this.phase[id];
      fx[o + 5] = asleep ? 0 : this.mv[id];
      fx[o + 6] = hash(id, 5);
      fx[o + 7] = hash(id, 6);
      fx[o + 8] = asleep ? 1 : 0;
      fx[o + 9] = me ? 1 : 0;
      fx[o + 10] = fl & CF_SIEGE && !(fl & CF_HUNTING) ? 1 : 0;
      fx[o + 11] = this.lead[id];
      fx[o + 12] = this.wind[id] * (1 - strike);
      fx[o + 13] = strike;
      fx[o + 14] = flinch;
      fx[o + 15] = (hash(id, 7) - 0.5) * 0.6;
      this.variety(fx, o, id, kind);
      fx[o + 20] = 0; fx[o + 21] = 1; fx[o + 22] = 0; fx[o + 23] = 0;
      fx[o + 24] = x; fx[o + 25] = 0; fx[o + 26] = y; fx[o + 27] = this.yaw[id];
      if (asleep) {
        if (nz < MARKS) {
          const u = (sec * 0.45 + fx[o + 7]) % 1;
          const s = 1 + u * 1.1;
          writeMatrix(za, nz++ * 16, x + u * 0.35, km.top * 0.75 + 0.3 + u * 0.9, y, face, s * (1 - u * u * u));
        }
      } else if (me && nb < MARKS) {
        const s = 1.5 + 0.2 * Math.sin(sec * 9 + this.phase[id]);
        writeMatrix(ba, nb++ * 16, x, km.top + 0.5, y, face, s);
      }
    }

    // Those gone since the last frame died: blown off their feet near a blast, else down
    // where they stood.
    if (newFrame) {
      for (let k = 0; k < this.nPrev; k++) {
        const id = this.prevIds[k];
        if (this.stamp[id] === game.frames) continue;
        // Walked out of sight under fog of war: gone from view, not dead.
        if (game.hiddenAt[id] === game.frames) { this.lastT[id] = -1e9; continue; }
        let thrown = false;
        for (let b = 0; b < f.nBlasts; b++) {
          const kb = f.bKind[b];
          if ((kb === 0 || kb === 4 || kb === 8) && Math.hypot(f.bX[b] - this.px[id], f.bY[b] - this.py[id]) < f.bR[b] + 0.6) { thrown = true; break; }
        }
        this.corpse(id, now, thrown, (this.fl[id] & CF_BURNING) !== 0);
        this.lastT[id] = -1e9;
      }
      this.nPrev = f.nCreeps;
      for (let i = 0; i < f.nCreeps; i++) this.prevIds[i] = f.cId[i];
      this.lastFrames = game.frames;
    }

    // The dead, after the living in each kind's buffer.
    let live = 0;
    for (let c = 0; c < this.nCorpse; c++) {
      const s = (this.headCorpse - this.nCorpse + c + CORPSES) % CORPSES;
      const age = (now - this.cT[s]) / 1000;
      if (age > LIE + SINK) continue;
      live++;
      const km = kinds[this.cK[s]];
      if (!km) continue;
      const id = this.cId[s];
      const j = km.n++;
      const fx = km.fx, o = j * STRIDE;
      fx.fill(0, o, o + STRIDE);
      fx[o] = this.cBurn[s] && age < 1.2 ? 1 : 0;
      fx[o + 4] = hash(id, 1) * 6.28;
      fx[o + 6] = hash(id, 5); fx[o + 7] = hash(id, 6);
      fx[o + 14] = age < 0.3 ? Math.sin(age / 0.3 * Math.PI) : 0;
      fx[o + 15] = (hash(id, 7) - 0.5) * 0.6;
      this.variety(fx, o, id, this.cK[s]);
      fx[o + 18] = this.cArm[s];
      fx[o + 20] = Math.min(1, age / FALL);
      fx[o + 21] = this.cDir[s];
      fx[o + 22] = age > LIE ? (age - LIE) / SINK * 0.7 : 0;
      fx[o + 23] = this.cThrown[s];
      fx[o + 24] = this.cX[s]; fx[o + 26] = this.cY[s]; fx[o + 27] = this.cYaw[s];
    }
    // Drop the oldest that have gone.
    while (this.nCorpse > 0) {
      const s = (this.headCorpse - this.nCorpse + CORPSES) % CORPSES;
      if ((now - this.cT[s]) / 1000 <= LIE + SINK) break;
      this.nCorpse--;
    }
    void live;

    this.zs.count = nz; this.bangs.count = nb;
    if (nz) this.zs.instanceMatrix.needsUpdate = true;
    if (nb) this.bangs.instanceMatrix.needsUpdate = true;
    for (const k of kinds) {
      k.mesh.count = k.n;
      if (k.n === 0) continue;
      k.buf.clearUpdateRanges(); k.buf.addUpdateRange(0, k.n * STRIDE); k.buf.needsUpdate = true;
    }
  }

  // Who it was: limp, arms, the arm it lost, trousers.
  private variety(fx: Float32Array, o: number, id: number, kind: number): void {
    const l = hash(id, 8);
    fx[o + 16] = kind <= 1 && l < 0.35 ? (l < 0.175 ? 1 : -1) * (0.6 + hash(id, 9) * 0.4) : 0;
    fx[o + 17] = kind === 0 && hash(id, 10) < 0.3 ? 0.7 + hash(id, 11) * 0.3 : 0;
    fx[o + 18] = this.armless[id];
    fx[o + 19] = hash(id, 12);
  }

  private corpse(id: number, now: number, thrown: boolean, burning: boolean): void {
    const s = this.headCorpse;
    this.headCorpse = (s + 1) % CORPSES;
    this.nCorpse = Math.min(CORPSES, this.nCorpse + 1);
    this.cK[s] = this.kindOf[id]; this.cId[s] = id;
    this.cX[s] = this.px[id]; this.cY[s] = this.py[id]; this.cYaw[s] = this.yaw[id];
    this.cT[s] = now;
    // Most go down on their faces, the way they were going; some topple back.
    this.cDir[s] = hash(id, 13) < 0.7 ? 1 : -1;
    this.cThrown[s] = thrown ? 0.6 + Math.random() * 0.5 : 0;
    this.cArm[s] = this.armless[id];
    this.cBurn[s] = burning ? 1 : 0;
  }
}
