import * as THREE from 'three/webgpu';
import {
  abs, attribute, cos, float, floor, Fn, fract, instancedDynamicBufferAttribute, int, max, mix, normalGeometry, normalLocal,
  positionGeometry, select, sin, smoothstep, step, time, uniform, uniformArray, vec3, vertexColor,
} from 'three/tsl';
import {
  CF_ASLEEP, CF_BURNING, CX_FRENZY, CX_SAPPER, CX_SPLITTER, CX_SUNDER, CX_AIR, CX_HELD, CF_HUNTING, CF_SIEGE, CF_SLOWED, CF_STRIKE, CF_WINDUP, type CreepDef, K_CATAPULT, MAX_CREEPS, PF_ALIVE,
} from '../protocol';
import { LENS } from '../camera';
import type { Game } from '../state';
import { type CreepRig, creepRig } from './creepModels';
import { FAR } from './detail';
import { painted } from './paint';
import { farParts, indexed, J, JOINTS, mergeRig, turnTowards } from './rig';
import { box, lin, merge, octa, part, writeMatrix } from './util';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// The picture's dead wear what they died in, worn, torn and stained: off-white shirts gone dirty
// (six in fourteen, one of them a dirty grey-blue), a faded blue, a denim shirt, a teal gone
// grey, khaki, a red-brown plaid, olive, rust, a dark vest. Each value is chosen against the skins below: a pale shirt is
// clearly lighter than any dead skin (luma 145 to 170 against 100 to 127), a coloured one clearly
// another hue or darker, so the shirt, the arms and the face never run together into one pale
// figure (a grey shirt on grey skin did: the crawler, sleeved to the wrists, went one grey).
// (The order puts #lab=art's walker and grabber in the picture's pale shirts, its runner in a dark vest.)
const CLOTHES = [0xa49e86, 0x76889a, 0x52626c, 0xa69a7a, 0x4c6660, 0x7a6a44, 0xbab090, 0x6a3a2a, 0x9aa0a0, 0x55583a, 0x3a3a36, 0x7a4a2c, 0xb4aa88, 0xa89c80];
// Dark worn trousers: dark denim, near black, brown, dark khaki, dark grey, faded denim, olive,
// a grey-brown. None lighter than luma 80, so the legs always sit under the shirt.
const PANTS = [0x343e4a, 0x2a2824, 0x433426, 0x4a4434, 0x3c3a36, 0x46525c, 0x3a3c28, 0x3e3830];
// Dead skin, how far gone: grey-green, ashen tan, a darker grey-green, dead brown, grey, sickly
// green, bruised tan, a dark grey. Never a living colour, never bright: luma 100 to 127, below
// every pale shirt and above every pair of trousers.
const SKINS = [0x7e7c5a, 0x8a7a58, 0x6e7254, 0x7c6c50, 0x848268, 0x767a5c, 0x86745a, 0x6a6650];
// Hair, matted and dark; the last is bald, the scalp the skin.
const HAIRS = [0x1c1812, 0x2e2418, 0x3a2a1a, 0x4a3822, 0x3c3832, 0x5a4a30, 0x2a2420, -1];

// Floats per instance: seven vec4s.
//   st  burning, slowed, flash, hovered
//   an  gait phase, how much it is walking, shirt, seed
//   mo  asleep, hunting you, at a structure, which arm leads
//   at  winding up, striking, flinching, head tilt
//   va  limp, arms hanging rather than reaching, an arm gone, trousers
//   de  dying 0..1, falls forward (1) or back (-1), sunk, thrown (the living: sundered)
//   pl  x, y, z, heading
const STRIDE = 28;
// The "z"s over sleeping guards.
const MARKS = 2048;
// The dead lie a while, then sink away.
const CORPSES = 1024, LIE = 3.4, SINK = 1.3, FALL = 0.7;
// How much of its fold a body lets go of as it comes to lie on the ground: the trunk and legs,
// the arms.
const SETTLE = 0.7, SETTLE_ARM = 0.3;

// One kind's figures at one level of detail.
interface Lod { mesh: THREE.InstancedMesh; fx: Float32Array; buf: THREE.InstancedInterleavedBuffer; n: number }
// A kind: its figures up close, and far off without their smallest parts.
interface KindMesh { near: Lod; far: Lod; scale: number; top: number; rig: CreepRig; def: CreepDef }

// Either side of where the far model starts (FAR, or closer as the detail governor has it),
// so a creep on the line does not flicker between the two.
const HYST = 2;

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
    for (const v of [d?.walk, d?.flex, d?.wind, d?.strike, d?.die, d?.misc, d?.tilt]) pars.push(new THREE.Vector4(...(v ?? [0, 0, 0, 0])));
  }
  const uPiv = uniformArray<'vec3'>(pivots, 'vec3'), uPar = uniformArray<'vec4'>(pars, 'vec4');

  const phase = an.x, move = an.y, seed = an.w;
  const wind = at.x, strike = at.y, flinch = at.z;
  // Dying crumples: the knees give and the body folds (the joints' die pose, dieJ), then it
  // tips over (tip) and, as it goes down, the fold lets go to lie on the ground. A rig that does
  // not tip (fall 0) just collapses where it is.
  // The tip speeds up as it goes, as a fall does, and stops on the ground.
  const die = de.x, dieJ = smoothstep(0, 0.45, die), tip = die.sub(0.32).div(0.68).clamp(0, 1);
  const tipDown = tip.mul(tip);
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
      const b = i.mul(7);
      const P0 = uPar.element(b), P1 = uPar.element(b.add(1)), P2 = uPar.element(b.add(2));
      const P3 = uPar.element(b.add(3)), P4 = uPar.element(b.add(4)), P5 = uPar.element(b.add(5)), P6 = uPar.element(b.add(6));
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
      // Held off true: a constant roll and twist, and a slow loll in each, out of step joint to joint.
      const loll = time.mul(1.1).add(seed.mul(9.1)).add(id.mul(2.3));
      let a: V3 = vec3(z, P0.z.mul(s).mul(move).add(at.w.mul(head)).add(P6.x).add(P6.z.mul(sin(loll))),
        P1.z.mul(s).mul(move).add(P6.y).add(P6.w.mul(cos(loll.mul(0.8)))));
      // Down on the ground the limbs and the trunk keep a little of the fold, the arms more.
      const slump = (r.fall ?? 1) > 0 ? dieJ.mul(float(1).sub(tipDown.mul(float(SETTLE).sub(arm.mul(SETTLE - SETTLE_ARM))))).add(mo.x.mul(0.3)) : dieJ.add(mo.x.mul(0.3));
      a = a.add(P2.xyz.mul(wind).mul(lead)).add(P3.xyz.mul(strike).mul(lead)).add(P4.xyz.mul(slump))
        .add(vec3(P5.x.mul(flinch), P5.y.mul(flail).mul(0.5), P5.y.mul(flail).mul(0.3)));
      const k = float(1).add(P2.w.mul(wind)).add(P3.w.mul(strike)).add(P4.w.mul(slump));
      const piv = uPiv.element(i);
      const q = rot(p.sub(piv), a).mul(k).add(piv);
      p = mix(p, q, ok);
      n = mix(n, rot(n, a), ok);
    }
    // The pelvis: a rise and fall with each step, sinking as the knees give.
    // Winding up it crouches, if its rig says so, and the blow carries it forward.
    const bob = abs(sin(phase)).oneMinus().mul(move).mul(r.bob);
    p = p.add(vec3(strike.mul(r.lunge ?? 0), bob.sub(dieJ.add(mo.x.mul(0.3)).mul(r.drop)).sub(wind.mul(r.crouch ?? 0)), 0));
    // Falling: over the front or back edge, flung high when blown off its feet.
    const thrown = de.w, dir = de.y;
    const fall = tipDown.mul(dir.negate()).mul(float(r.fall ?? 1.45).add(thrown.mul(1.6)));
    const edge = vec3(dir.mul(r.edge ?? 0.32), 0, 0);
    const fz = vec3(fall, 0, 0);
    p = rot(p.sub(edge), fz).add(edge);
    n = rot(n, fz);
    p = p.add(vec3(0, sin(min1(die.mul(1.3)).mul(Math.PI)).mul(thrown).mul(0.9).sub(de.z).sub(tipDown.mul(r.lie ?? 0)), 0));
    // Scaled to its size and placed, heading 0 facing +x and turning towards +z.
    const c = cos(pl.w), sn = sin(pl.w);
    const turn = (v: V3) => vec3(v.x.mul(c).sub(v.z.mul(sn)), v.y, v.x.mul(sn).add(v.z.mul(c)));
    normalLocal.assign(turn(n));
    return turn(p.mul(scale)).add(pl.xyz);
  })();

  const mat = painted(new THREE.MeshLambertNodeMaterial());
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
  // Burning: a warm cast, weak enough that the clothes and skin keep their own colours.
  col = mix(col, col.mul(vec3(1.35, 0.85, 0.55)).add(vec3(0.06, 0.015, 0)), st.x.mul(0.4));
  // Slowed by the frost tower: a cold cast that only multiplies, so the darks stay dark and the
  // figure keeps its shirt, skin and trousers. (It added a pale blue too, which lifted trousers,
  // hair and outlines up to the shirt: slowed creeps went a flat blue-white.)
  col = mix(col, col.mul(vec3(0.72, 0.88, 1.2)), st.y.mul(0.6));
  // Hit: a flash that brightens what is there rather than painting over it. It was 45% of the
  // way to white with a white glow on top, and a creep hit again within 90 ms (a frost tower's
  // pulse, a burn, a turret's stream) stayed lit the whole time: a solid white silhouette.
  col = mix(col, col.mul(1.6).add(vec3(0.03, 0.025, 0.015)), st.z.mul(0.6));
  // Hunting you: a light red cast so you see what you pulled, weak enough that the shirt, skin
  // and trousers keep their own colours; asleep, or dead, a little darker.
  col = mix(col, col.mul(vec3(1.3, 0.7, 0.65)).add(vec3(0.04, 0, 0)), mo.y.mul(0.3));
  col = col.mul(float(1).sub(mo.x.mul(0.18)).sub(dieJ.mul(0.2)));
  // Sundered by a greatsword: the hide darkened and split, cracks glowing ember-orange through
  // it. Only the living: a corpse's de.w is how it was thrown.
  const sunder = de.w.mul(float(1).sub(step(0.0001, die)));
  const g = positionGeometry;
  const seam = abs(sin(g.x.mul(29).add(sin(g.y.mul(21)).mul(2.2)).add(g.z.mul(17))));
  const cracks = float(1).sub(smoothstep(0.03, 0.12, seam)).mul(step(0.1, sin(g.y.mul(11).add(g.x.mul(5)).add(g.z.mul(3))))).mul(sunder);
  col = mix(col, col.mul(0.55), sunder.mul(0.5));
  mat.colorNode = col;
  const flicker = sin(time.mul(23).add(an.x.mul(7))).mul(0.25).add(0.75);
  // The glows are added light: any more than this and trousers, hair and outlines all rise to one
  // flat orange or red, the figure a single colour.
  mat.emissiveNode = vec3(0.9, 0.3, 0.05).mul(st.x.mul(flicker).mul(0.035))
    .add(vec3(1, 0.9, 0.7).mul(st.z.mul(0.06)))
    .add(vec3(0.5, 0.45, 0.2).mul(st.w.mul(uHover)))
    .add(vec3(0.02, 0.001, 0).mul(mo.y.mul(sin(time.mul(9)).mul(0.3).add(0.7))))
    .add(vec3(1, 0.42, 0.08).mul(cracks.mul(sin(time.mul(6)).mul(0.2).add(0.8))));
  return mat;
}

const min1 = (v: F) => v.min(1);

// The top of a model in its rest pose, model units: each vertex turned through its joints' rest
// angles and held tilt as the shader turns it standing still (the stoop, the hung head), so a
// stooped figure's height is its head's, not the upright model's it was built as.
function restTop(geo: THREE.BufferGeometry, r: CreepRig): number {
  const pos = geo.getAttribute('position'), rj = geo.getAttribute('rj');
  const v = new THREE.Vector3(), q = new THREE.Vector3();
  const turn = (p: THREE.Vector3, a: [number, number, number]) => {
    const cz = Math.cos(a[0]), sz = Math.sin(a[0]), cx = Math.cos(a[1]), sx = Math.sin(a[1]), cy = Math.cos(a[2]), sy = Math.sin(a[2]);
    const x1 = p.x * cz - p.y * sz, y1 = p.x * sz + p.y * cz;
    const y2 = y1 * cx - p.z * sx, z2 = y1 * sx + p.z * cx;
    p.set(x1 * cy + z2 * sy, y2, -x1 * sy + z2 * cy);
  };
  let top = 0;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    for (const id of [rj.getX(i), rj.getY(i), rj.getZ(i)]) {
      const d = id >= 0 ? r.joints[id] : undefined;
      if (!d) continue;
      q.set(...d.p);
      v.sub(q);
      turn(v, [d.walk?.[3] ?? 0, d.tilt?.[0] ?? 0, d.tilt?.[1] ?? 0]);
      v.add(q);
    }
    top = Math.max(top, v.y);
  }
  return top;
}

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
  // Over a sapper a blinking charge, over a splitter a swollen green pustule: what the wave's
  // affixes made of it.
  private tags: THREE.InstancedMesh;
  // The burster's kind, which wears a charge whatever its wave's affixes: -1 if the host has none.
  private burster = -1;

  // Per creep id.
  private phase = new Float32Array(MAX_CREEPS);
  private yaw = new Float32Array(MAX_CREEPS);
  // Seconds since a catapult threw it, -1 on the ground; seconds since it came down, while
  // it lies stunned, -1 otherwise.
  private airT = new Float32Array(MAX_CREEPS).fill(-1);
  private landT = new Float32Array(MAX_CREEPS).fill(-1);
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
  // Per creep id and per corpse: drawn in the far model.
  private farId = new Uint8Array(MAX_CREEPS);
  private farCorpse = new Uint8Array(CORPSES);
  // Where the far model starts, and whether creeps throw shadows at each distance: what the
  // detail governor turns down on a machine that cannot keep up.
  farFrom = FAR;
  nearShadows = true;
  farShadows = true;
  // Figures drawn in each model, the last frame, for F3.
  drawnNear = 0;
  drawnFar = 0;

  // The dead.
  private cK = new Uint8Array(CORPSES); private cId = new Uint16Array(CORPSES);
  private cX = new Float32Array(CORPSES); private cY = new Float32Array(CORPSES); private cYaw = new Float32Array(CORPSES);
  private cT = new Float32Array(CORPSES); private cDir = new Float32Array(CORPSES); private cThrown = new Float32Array(CORPSES);
  private cArm = new Uint8Array(CORPSES); private cBurn = new Uint8Array(CORPSES);
  private nCorpse = 0; private headCorpse = 0;
  private view = new THREE.Frustum();
  private viewM = new THREE.Matrix4();
  private ball = new THREE.Sphere();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    const zm = new THREE.MeshBasicNodeMaterial({ color: 0xd8e4ff, transparent: true, opacity: 0.85, depthWrite: false });
    zm.fog = false;
    this.zs = new THREE.InstancedMesh(merge([
      part(box(0.26, 0.06, 0.04), 0), part(box(0.26, 0.06, 0.04), 0, 0, -0.24, 0), part(box(0.06, 0.32, 0.04), 0, 0, -0.12, 0, 0, 0, -0.9),
    ]), zm, MARKS);
    this.zs.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.zs.count = 0; this.zs.frustumCulled = false; this.zs.renderOrder = 4;
    const tm = new THREE.MeshBasicNodeMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
    tm.fog = false;
    this.tags = new THREE.InstancedMesh(merge([part(octa(0.13), 0xffffff)]), tm, MARKS);
    this.tags.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.tags.count = 0; this.tags.frustumCulled = false; this.tags.renderOrder = 4;
    this.tags.setColorAt(0, new THREE.Color());
  }

  setup(defs: CreepDef[]): void {
    for (const k of this.kinds) for (const l of [k.near, k.far]) { l.mesh.geometry.dispose(); (l.mesh.material as THREE.Material).dispose(); }
    this.kinds = [];
    this.group.clear();
    this.group.add(this.zs);
    this.group.add(this.tags);
    this.nPrev = 0; this.nCorpse = 0; this.headCorpse = 0;
    this.lastT.fill(-1e9);
    this.burster = defs.findIndex((d) => d.name === 'burster');
    defs.forEach((d, i) => {
      const cap = MAX_CREEPS + CORPSES;
      const r = creepRig(i, d.name);
      const geo = indexed(mergeRig(r.parts));
      // Fit the model's footprint to the creep's diameter, a little larger so crowds read as solid.
      // Its length counts for less than its breadth, or a crawler would shrink to a rat.
      const bb = geo.boundingBox!;
      const foot = Math.max((bb.max.x - bb.min.x) * 0.6, bb.max.z - bb.min.z, 0.3);
      // A rig that states its own scale is built in the survivors' units and stands beside them
      // at its true size, whatever its radius in the sim.
      const scale = r.scale ?? (d.radius * 2.3) / foot;
      const lod = (g: THREE.BufferGeometry): Lod => {
        const fx = new Float32Array(cap * STRIDE);
        const buf = new THREE.InstancedInterleavedBuffer(fx, STRIDE, 1);
        buf.setUsage(THREE.DynamicDrawUsage);
        const mesh = new THREE.InstancedMesh(g, material(r, scale, buf, this.uHover), cap);
        // Placement is in the state buffer; the instance matrices stay the identity.
        mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        mesh.count = 0;
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        this.group.add(mesh);
        return { mesh, fx, buf, n: 0 };
      };
      // Hung on the same joints and posed by the same shader, so the two only differ in what
      // is too small to see where the far one is drawn.
      this.kinds.push({ near: lod(geo), far: lod(indexed(mergeRig(farParts(r.parts)))), scale, top: restTop(geo, r) * scale, rig: r, def: d });
    });
  }

  // How tall a kind stands as drawn, in the world: where its health bar goes. 0 for one the
  // host has not described.
  top(kind: number): number { return this.kinds[kind]?.top ?? 0; }

  // Which model a figure at squared distance d2 from the camera takes, from the one it had.
  // farFrom is a distance through the 42° lens it was set for; the long lens stands LENS
  // times further back for the same figure on screen.
  private farAt(d2: number, was: number): number {
    const f = this.farFrom;
    d2 /= LENS * LENS;
    return d2 > (was ? f - HYST : f + HYST) ** 2 ? 1 : 0;
  }


  update(game: Game, now: number, dt: number, cam?: THREE.Camera): void {
    const f = game.cur;
    const kinds = this.kinds;
    for (const k of kinds) { k.near.n = 0; k.far.n = 0; }
    const sec = now / 1000;
    this.uHover.value = 0.6 + 0.4 * Math.sin(sec * 8);
    const you = game.welcome?.you ?? -1;
    // Markers turn to face the camera round the vertical.
    const e = cam?.matrixWorld.elements;
    const face = e ? Math.atan2(-e[8], e[10]) : 0;
    const za = this.zs.instanceMatrix.array as Float32Array;
    let nz = 0;
    const ta = this.tags.instanceMatrix.array as Float32Array, tc = this.tags.instanceColor!.array as Float32Array;
    let nt = 0;
    const newFrame = game.frames !== this.lastFrames;
    // Only those in view, or near enough to throw a shadow into it, are drawn.
    let ex = 0, ey = 0, ez = 0;
    if (cam) {
      cam.updateMatrixWorld();
      ex = e![12]; ey = e![13]; ez = e![14];
      this.viewM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this.view.setFromProjectionMatrix(this.viewM, cam.coordinateSystem);
    }
    const seen = (km: KindMesh, x: number, y: number) => {
      if (!cam) return true;
      this.ball.center.set(x, km.top * 0.5, y);
      this.ball.radius = km.top + 1.5;
      return this.view.intersectsSphere(this.ball);
    };
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
        this.airT[id] = -1; this.landT[id] = -1;
      }
      // A catapult's throw, kept up off screen too, so the arc and the landing go by the time
      // the host gave them.
      const air = (f.cFx[i] & CX_AIR) !== 0;
      if (air) { this.airT[id] = this.airT[id] < 0 ? 0 : this.airT[id] + dt; this.landT[id] = -1; }
      else {
        if (this.airT[id] >= 0) this.landT[id] = 0;
        else if (this.landT[id] >= 0) this.landT[id] += dt;
        this.airT[id] = -1;
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
      if (!seen(km, x, y)) continue;

      const far = this.farId[id] = this.farAt((x - ex) ** 2 + ey * ey + (y - ez) ** 2, this.farId[id]);
      const lod = far ? km.far : km.near;
      const j = lod.n++;
      const fx = lod.fx, o = j * STRIDE;
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
      // A frenzied creep, done walking the maze, burns a duller red than one hunting you.
      fx[o + 9] = me ? 1 : f.cFx[i] & CX_FRENZY ? 0.6 : 0;
      fx[o + 10] = fl & CF_SIEGE && !(fl & CF_HUNTING) ? 1 : 0;
      fx[o + 11] = this.lead[id];
      fx[o + 12] = this.wind[id] * (1 - strike);
      fx[o + 13] = strike;
      fx[o + 14] = flinch;
      fx[o + 15] = (hash(id, 7) - 0.5) * 0.6;
      this.variety(fx, o, id, kind);
      fx[o + 20] = 0; fx[o + 21] = 1; fx[o + 22] = 0; fx[o + 23] = f.cFx[i] & CX_SUNDER ? 1 : 0;
      // Thrown, it goes up in an arc for as long as the host says it flies, tumbling; down, it
      // lies flat on its back or its face for the stun and gets up as it ends; held in a bait
      // pit's knot, it shivers.
      let lift = 0, yaw = this.yaw[id];
      const cat = game.welcome?.structs[K_CATAPULT];
      if (air) {
        const u = Math.min(1, this.airT[id] / (cat?.air ?? 0.9));
        lift = 10 * u * (1 - u);
        yaw += u * Math.PI * 4;
      } else if (this.landT[id] >= 0) {
        const lt = this.landT[id], stun = cat?.stun ?? 1;
        if (lt >= stun) this.landT[id] = -1;
        else {
          fx[o + 20] = 0.85 * (lt < 0.1 ? lt / 0.1 : lt > stun - 0.35 ? (stun - lt) / 0.35 : 1);
          fx[o + 21] = hash(id, 8) < 0.5 ? 1 : -1;
          fx[o + 5] = 0;
        }
      } else if (f.cFx[i] & CX_HELD) yaw += Math.sin(sec * 23 + id) * 0.15;
      fx[o + 24] = x; fx[o + 25] = lift; fx[o + 26] = y; fx[o + 27] = yaw;
      const cx = f.cFx[i];
      const lit = kind === this.burster;
      if ((cx & (CX_SAPPER | CX_SPLITTER) || lit) && nt < MARKS) {
        // A burster's charge blinks slowly as it runs, and fast and swelling once its fuse is lit.
        const fuse = lit && fl & (CF_WINDUP | CF_STRIKE);
        const sap = lit || (cx & CX_SAPPER) !== 0, blink = sap ? (Math.sin(sec * (fuse ? 40 : lit ? 5 : 10) + id) > 0 ? 1 : 0.35) : 0.8;
        writeMatrix(ta, nt * 16, x, km.top + 0.35, y, sec * 2 + id, fuse ? 1.6 : 1);
        tc[nt * 3] = (sap ? 1 : 0.55) * blink; tc[nt * 3 + 1] = (sap ? 0.25 : 0.9) * blink; tc[nt * 3 + 2] = (sap ? 0.1 : 0.2) * blink;
        nt++;
      }
      if (asleep && nz < MARKS) {
        const u = (sec * 0.45 + fx[o + 7]) % 1;
        const s = 1 + u * 1.1;
        writeMatrix(za, nz++ * 16, x + u * 0.35, km.top * 0.75 + 0.3 + u * 0.9, y, face, s * (1 - u * u * u));
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
      if (!km || !seen(km, this.cX[s], this.cY[s])) continue;
      const id = this.cId[s];
      const far = this.farCorpse[s] = this.farAt((this.cX[s] - ex) ** 2 + ey * ey + (this.cY[s] - ez) ** 2, this.farCorpse[s]);
      const lod = far ? km.far : km.near;
      const j = lod.n++;
      const fx = lod.fx, o = j * STRIDE;
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

    this.zs.count = nz;
    if (nz) this.zs.instanceMatrix.needsUpdate = true;
    this.tags.count = nt;
    if (nt) { this.tags.instanceMatrix.needsUpdate = true; this.tags.instanceColor!.needsUpdate = true; }
    let nn = 0, nf = 0;
    for (const k of kinds) {
      nn += k.near.n; nf += k.far.n;
      for (const l of [k.near, k.far]) {
        l.mesh.count = l.n;
        // A kind with none in view is left out of the drawing altogether, not drawn empty.
        l.mesh.visible = l.n > 0;
        l.mesh.castShadow = l === k.near ? this.nearShadows : this.farShadows;
        if (l.n === 0) continue;
        l.buf.clearUpdateRanges(); l.buf.addUpdateRange(0, l.n * STRIDE); l.buf.needsUpdate = true;
      }
    }
    this.drawnNear = nn; this.drawnFar = nf;
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
    this.farCorpse[s] = this.farId[id];
  }
}
