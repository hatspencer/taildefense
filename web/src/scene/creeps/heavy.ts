import * as THREE from 'three/webgpu';
import { HAIR, PANTS, SHIRT, SKIN, mirror, rig, type CreepRig, type JointDef } from '../creepModels';
import { PAL, blend, darker, lighter } from '../palette';
import { J, rp, type RigPart } from '../rig';
import { box, sphere } from '../util';

// The heavy and the special dead: the brute, the mauler, the hound, the spitter and the
// hurler. They are built the way the common dead are (creeps/common.ts), so all the dead read
// as one family: in the survivors' units (an ordinary man 1.33 tall, seven heads, his hips at
// 0.68 and his shoulders at 1.08), limbs and trunks as tapered prisms between joint points,
// stains, bands and blotches as plates lying on their faces. The stoop, the reach and the hang
// of the arms are the joints' rest angles, so the animation moves the pose they are drawn in.
// Facing +x, standing on y = 0, the joints named L on the +z side.
//
// The far model keeps the parts at least a tenth of the figure's height across (farParts):
// the limbs, the trunk, the head and the hat; every detail is smaller than that and drops out.
const UNIT = 1.8 / 1.33; // a man is built 1.33 of these units tall, and a survivor is 1.8 in the world

// Fixed colours, from the picture's palette. Everything painted in SHIRT, PANTS, SKIN or HAIR
// takes the instance's own.
const BOOT = PAL.leather, SOLE = PAL.leatherDark, BLOOD = PAL.blood, GORE = PAL.bloodFresh, CLOT = PAL.bloodDark;
const MOUTH = 0x2a140c, SOCKET = 0x2e2018, EYE = 0xb8b08a, NAIL = PAL.deadSkinDark, BONE = PAL.bone;

type P3 = [number, number, number];
type V4 = [number, number, number, number];

const UP = new THREE.Vector3(0, 1, 0), OUT = new THREE.Vector3(0, 0, 1);
const side = (s: number, l: number, r: number) => (s > 0 ? l : r);

// The frame of a limb from a to b: its local y runs along it.
function frame(a: P3, b: P3): THREE.Matrix4 {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, B.clone().sub(A).normalize());
  return new THREE.Matrix4().compose(A.add(B).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
}
const len = (a: P3, b: P3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const lerp3 = (a: P3, b: P3, t: number): P3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// An n-sided prism h long up y, radius ra at the bottom and rb at the top, a flat face to +x.
// caps: 1 closes the bottom, 2 the top; an end hidden inside another part is left open, which
// saves n - 2 triangles.
function prism(ra: number, rb: number, h: number, n: number, caps: number): THREE.BufferGeometry {
  const ring = (r: number, y: number) => Array.from({ length: n }, (_, k) => {
    const a = Math.PI / n + (2 * Math.PI * k) / n;
    return [r * Math.cos(a), y, r * Math.sin(a)];
  });
  const lo = ring(ra, -h / 2), hi = ring(rb, h / 2), v: number[] = [];
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    v.push(...lo[k], ...hi[k], ...lo[k1], ...hi[k], ...hi[k1], ...lo[k1]);
  }
  for (let i = 1; i < n - 1; i++) {
    if (caps & 2) v.push(...hi[0], ...hi[i + 1], ...hi[i]);
    if (caps & 1) v.push(...lo[0], ...lo[i], ...lo[i + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

// A tapered prism from a (radius ra) to b (radius rb), its cross-section squashed to fx and fz.
interface Tube { j: number; a: P3; b: P3; ra: number; rb: number; n: number; fx: number; fz: number }
function tube(p: RigPart[], j: number, a: P3, b: P3, ra: number, rb: number, c: number, n = 5, fx = 1, fz = 1, caps = 3): Tube {
  const g = prism(ra, rb, len(a, b), n, caps);
  g.scale(fx, 1, fz);
  g.applyMatrix4(frame(a, b));
  p.push(rp(j, { geo: g, color: c }));
  return { j, a, b, ra, rb, n, fx, fz };
}

// A plate lying on the face of tube T that looks most along dir: t of the way from a to b, s
// across the face (-0.5 to 0.5 its edges), w long along the tube and h across it.
function onTube(p: RigPart[], T: Tube, dir: P3, t: number, s: number, w: number, h: number, col: number, lift = 0.003): void {
  const H = len(T.a, T.b), m = frame(T.a, T.b), rot = new THREE.Matrix4().extractRotation(m);
  const pt = (r: number, y: number, i: number) => {
    const a = Math.PI / T.n + (2 * Math.PI * i) / T.n;
    return new THREE.Vector3(r * Math.cos(a) * T.fx, y, r * Math.sin(a) * T.fz);
  };
  const want = new THREE.Vector3(...dir).normalize();
  let k = 0, best = -2;
  for (let i = 0; i < T.n; i++) {
    const d = pt(1, 0, i).add(pt(1, 0, i + 1)).normalize().applyMatrix4(rot).dot(want);
    if (d > best) { best = d; k = i; }
  }
  const lo = pt(T.ra, -H / 2, k).lerp(pt(T.ra, -H / 2, k + 1), 0.5 + s);
  const hi = pt(T.rb, H / 2, k).lerp(pt(T.rb, H / 2, k + 1), 0.5 + s);
  const at = lo.clone().lerp(hi, t), along = hi.clone().sub(lo).normalize();
  const across = pt(1, 0, k + 1).sub(pt(1, 0, k)).normalize();
  const nrm = new THREE.Vector3().crossVectors(across, along).normalize();
  if (nrm.dot(new THREE.Vector3(at.x, 0, at.z)) < 0) nrm.negate();
  const up = new THREE.Vector3().crossVectors(nrm, across);
  at.addScaledVector(nrm, lift);
  const g = new THREE.PlaneGeometry(h, w);
  g.applyMatrix4(new THREE.Matrix4().makeBasis(across, up, nrm).setPosition(at));
  g.applyMatrix4(m);
  p.push(rp(T.j, { geo: g, color: col }));
}

// A plate w by h, its face along normal n, centred at c.
function plate(p: RigPart[], j: number, c: P3, n: P3, w: number, h: number, col: number, spin = 0): void {
  const g = new THREE.PlaneGeometry(w, h);
  g.rotateZ(spin);
  const q = new THREE.Quaternion().setFromUnitVectors(OUT, new THREE.Vector3(...n).normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...c), q, new THREE.Vector3(1, 1, 1)));
  p.push(rp(j, { geo: g, color: col }));
}
// A box at (x, y, z), turned by rz forward, rx out, ry round.
function bx(p: RigPart[], j: number, w: number, h: number, d: number, c: number, x: number, y: number, z = 0, rz = 0, rx = 0, ry = 0): void {
  const g = box(w, h, d);
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));
  p.push(rp(j, { geo: g, color: c }));
}
// A low-poly ball at c, squashed by s.
function ball(p: RigPart[], j: number, r: number, c: P3, s: P3, col: number, ws = 5, hs = 4): void {
  const g = sphere(r, ws, hs);
  g.scale(...s);
  g.translate(...c);
  p.push(rp(j, { geo: g, color: col }));
}

// A dead head on joint j, the neck's foot at (x, y), k times a man's (the walker's head): the
// jaw hanging (jaw more of it), sunk eyes, short matted hair or a bald blotched scalp.
function head(p: RigPart[], j: number, x: number, y: number, k = 1, o: { bald?: boolean; jaw?: number; neck?: boolean } = {}): void {
  const jaw = (o.jaw ?? 0) * k;
  if (o.neck !== false) bx(p, j, 0.06 * k, 0.07 * k, 0.06 * k, SKIN, x, y + 0.03 * k);
  const cy = y + 0.135 * k, hx = x + 0.015 * k, f = hx + 0.066 * k;
  // Skull and face, a narrower jaw below and forward, the brow and nose a pixel proud.
  bx(p, j, 0.142 * k, 0.12 * k, 0.12 * k, SKIN, hx - 0.006 * k, cy + 0.015 * k);
  bx(p, j, 0.1 * k, 0.055 * k, 0.1 * k, SKIN, hx + 0.012 * k, cy - 0.06 * k - jaw, 0, -0.15);
  bx(p, j, 0.025 * k, 0.025 * k, 0.11 * k, SKIN, f, cy + 0.045 * k);
  bx(p, j, 0.025 * k, 0.035 * k, 0.025 * k, SKIN, f + 0.005 * k, cy);
  for (const s of [1, -1]) {
    plate(p, j, [f + 0.001, cy + 0.022 * k, 0.03 * k * s], [1, 0, 0], 0.04 * k, 0.025 * k, SOCKET);
    plate(p, j, [f + 0.002, cy + 0.022 * k, 0.03 * k * s], [1, 0, 0], 0.012 * k, 0.012 * k, EYE);
  }
  // The mouth hanging open, blood down the chin.
  plate(p, j, [f - 0.006 * k, cy - 0.048 * k - jaw / 2, 0], [1, -0.15, 0], 0.055 * k, 0.03 * k + jaw, MOUTH);
  plate(p, j, [f - 0.01 * k, cy - 0.08 * k - jaw, 0.012 * k], [1, -0.15, 0], 0.025 * k, 0.03 * k, GORE);
  if (!o.bald) {
    bx(p, j, 0.142 * k, 0.025 * k, 0.125 * k, HAIR, hx - 0.009 * k, cy + 0.083 * k);
    bx(p, j, 0.025 * k, 0.09 * k, 0.125 * k, HAIR, hx - 0.064 * k, cy + 0.035 * k);
    bx(p, j, 0.04 * k, 0.03 * k, 0.04 * k, HAIR, hx + 0.045 * k, cy + 0.075 * k, 0.03 * k, -0.3);
  } else {
    plate(p, j, [hx + 0.01 * k, cy + 0.0761 * k, 0.02 * k], [0, 1, 0], 0.06 * k, 0.05 * k, BLOOD, 0.4);
    plate(p, j, [hx - 0.0761 * k, cy + 0.03 * k, -0.02 * k], [-1, 0, 0], 0.04 * k, 0.05 * k, BLOOD);
  }
  plate(p, j, [hx - 0.01 * k, cy - 0.01 * k, 0.0601 * k], [0, 0, 1], 0.05 * k, 0.04 * k, BLOOD);
}

// A hand at the end of a forearm from e to w: a flat palm, the fingers curled to claws. bend
// turns the hand at the wrist, forward (+) or back, so a reaching hand can droop.
function hand(p: RigPart[], j: number, e: P3, w: P3, k = 1, nail: number = NAIL, bend = 0): void {
  const L = len(e, w), d0 = new THREE.Vector3(w[0] - e[0], w[1] - e[1], w[2] - e[2]).divideScalar(L);
  const dir = (a: number) => d0.clone().applyAxisAngle(OUT, a);
  const go = (from: P3, v: THREE.Vector3, t: number): P3 => [from[0] + v.x * t, from[1] + v.y * t, from[2] + v.z * t];
  const palm = dir(bend * 0.5), claw = dir(bend);
  const m = go(w, palm, 0.058 * k);
  tube(p, j, w, go(w, palm, 0.062 * k), 0.028 * k, 0.032 * k, SKIN, 4, 0.7, 1.2, 0);
  tube(p, j, m, go(m, claw, 0.05 * k), 0.03 * k, 0.014 * k, nail, 4, 0.7, 1.1, 2);
}

// The skeleton's rest points.
interface Body {
  hip: number; knee: number; hz: number;        // hip and knee heights, the hips' half width
  sh: P3; el: P3; wr: P3;                       // the left shoulder, elbow and wrist
  waist: number;                                // the chest joint's height
}
// An ordinary man: the walker's frame.
const MAN: Body = { hip: 0.68, knee: 0.37, hz: 0.08, sh: [0, 1.08, 0.18], el: [0, 0.85, 0.19], wr: [0, 0.65, 0.195], waist: 0.74 };
const mir = (v: P3, s: number): P3 => [v[0], v[1], v[2] * s];

// Both legs: trousers to a work boot (or a wellington), thick times a man's; torn knees.
function legs(p: RigPart[], b: Body, thick: number, o: { boot?: number; welly?: number; foot?: number; tear?: boolean } = {}): void {
  const k = o.foot ?? 1;
  for (const s of [1, -1]) {
    const z = b.hz * s, th = side(s, J.THIGH_L, J.THIGH_R), sn = side(s, J.SHIN_L, J.SHIN_R);
    const knee: P3 = [0.01, b.knee, z * 1.05], ankle: P3 = [-0.01, 0.05, z * 1.1];
    const T = tube(p, th, [0, b.hip + 0.04, z], knee, 0.07 * thick, 0.055 * thick, PANTS, 5, 1, 1, 1);
    // A knee worn through to the dead skin, a dark stain down the thigh.
    if (o.tear !== false) onTube(p, T, [1, 0, 0], 0.9, 0, 0.06 * thick, 0.05 * thick, s > 0 ? SKIN : GORE);
    onTube(p, T, [0.3, 0, s], 0.4, 0, 0.1, 0.045, CLOT);
    if (o.welly !== undefined) {
      // Wellingtons to below the knee, the trousers tucked in.
      tube(p, sn, lerp3(knee, ankle, 0.1), ankle, 0.062 * thick, 0.056 * thick, o.welly, 5, 1, 1, 2);
      bx(p, sn, 0.11 * k, 0.06 * k, 0.085 * k, o.welly, 0.035 * k, 0.03, z * 1.1);
      bx(p, sn, 0.115 * k, 0.014, 0.09 * k, SOLE, 0.035 * k, 0.007, z * 1.1);
      continue;
    }
    const S = tube(p, sn, knee, ankle, 0.054 * thick, 0.05 * thick, PANTS, 5, 1, 1, 0);
    onTube(p, S, [0.4, 0, s], 0.6, 0, 0.07, 0.035, BLOOD);
    // A worn work boot: the shaft, the foot, the dark sole under it, the hem bunched over.
    const c = o.boot ?? BOOT;
    bx(p, sn, 0.085 * k, 0.07 * k, 0.07 * k, c, -0.01, 0.055 * k, z * 1.1);
    bx(p, sn, 0.125 * k, 0.045 * k, 0.072 * k, c, 0.035 * k, 0.03 * k, z * 1.1);
    bx(p, sn, 0.12 * k, 0.014, 0.078 * k, SOLE, 0.03 * k, 0.007, z * 1.1);
    bx(p, sn, 0.11 * thick, 0.04, 0.105 * thick, PANTS, -0.01, 0.1 * k, z * 1.1);
  }
}

// The pelvis in the trousers, the belt round it.
function pelvis(p: RigPart[], b: Body, r: number, depth = 0.66, belt = true): void {
  const T = tube(p, -1, [0, b.hip - 0.06, 0], [0, b.waist + 0.02, 0], r, r * 1.02, PANTS, 6, depth, 1, 0);
  if (!belt) return;
  for (const d of [[1, 0, 0.5], [1, 0, -0.5], [-1, 0, 0.5], [-1, 0, -0.5], [0, 0, 1], [0, 0, -1]] as P3[]) onTube(p, T, d, 0.8, 0, 0.03, r * 0.85, PAL.leatherDark);
}

// One arm from shoulder to claw: the upper arm and forearm bare (u, f their radii at each end),
// a sleeve over the upper arm down to cut of its length (0 none, 1 the elbow, 2 the wrist).
function arm(p: RigPart[], s: number, sh: P3, el: P3, wr: P3, u: [number, number], f: [number, number], o: { sleeve?: number; cut?: number; hand?: number; nail?: number; bend?: number; blotch?: boolean } = {}): { U: Tube; F: Tube } {
  const uj = side(s, J.UARM_L, J.UARM_R), fj = side(s, J.FARM_L, J.FARM_R), cut = o.cut ?? 0, c = o.sleeve ?? SHIRT;
  const U = tube(p, uj, sh, el, u[0], u[1], cut >= 1 ? c : SKIN, 5, 1, 1, 0);
  if (cut > 0 && cut < 1) {
    // A short sleeve, torn or rolled: wider than the arm, so it stands proud of it.
    // Its top rounds over the shoulder.
    const end = lerp3(sh, el, cut);
    tube(p, uj, end, [sh[0], sh[1] + 0.04, sh[2] * 0.95], u[0] * 1.2, u[0] * 0.8, c, 5, 1, 1, 2);
  }
  if (cut < 1) onTube(p, U, [0.3, 0, s], 0.75, 0, 0.05, 0.035, BLOOD);
  const F = tube(p, fj, el, wr, f[0], f[1], cut >= 2 ? c : SKIN, 5, 1, 1, 0);
  if (cut < 2 && o.blotch !== false) {
    // Blotches down the forearm: the picture's dead are mottled dark red to the fingers.
    onTube(p, F, [1, 0, 0.4 * s], 0.3, 0, 0.06, 0.035, BLOOD);
    onTube(p, F, [-0.3, 0, -s], 0.65, 0, 0.05, 0.03, CLOT);
    onTube(p, F, [0.2, 0, s], 0.75, 0.1, 0.04, 0.03, BLOOD);
  }
  hand(p, fj, el, wr, o.hand ?? 1, o.nail, o.bend ?? 0);
  return { U, F };
}

// The right twin of a left joint with a rest swing of its own.
const restR = (d: JointDef, rest: number): JointDef => {
  const m = mirror(d);
  return { ...m, walk: m.walk ? [m.walk[0], m.walk[1], m.walk[2], rest] as V4 : undefined };
};
// The legs' joints for a body: the hip swings, the knee folds through the swing.
// split stands the left foot that much ahead of the right at rest, its knee bent to match.
function legJoints(b: Body, swing: number, fold: number, o: { rest?: number; knee?: number; split?: number; thigh?: Partial<JointDef>; shin?: Partial<JointDef> } = {}): Partial<Record<number, JointDef>> {
  const rest = o.rest ?? 0.08, knee = o.knee ?? -0.12, split = o.split ?? 0;
  const thigh: JointDef = { p: [0, b.hip, b.hz], walk: [swing, 0, 0, rest + split], wind: [-0.15, 0, 0, 0], strike: [0.3, 0, 0, 0], die: [1.35, 0, 0, 0], misc: [0, 0.5, 1, 2], ...o.thigh };
  const shin: JointDef = { p: [0.01, b.knee, b.hz * 1.05], walk: [0, 0, 0, knee - split], flex: [-fold, Math.PI / 2, 0, 0], strike: [-0.2, 0, 0, 0], die: [-2.1, 0, 0, 0], misc: [0, 0.4, 1, 2], ...o.shin };
  return { [J.THIGH_L]: thigh, [J.SHIN_L]: shin, [J.THIGH_R]: restR(thigh, rest - split * 0.6), [J.SHIN_R]: restR(shin, knee) };
}

// The picture's grabber, as the one that spits: an ordinary man of a survivor's build leaning
// in with both arms out and grasping, in a torn bloodied shirt and dark trousers; the throat
// swollen into a sac under a dropped jaw, a yellow-green run down the shirt from the mouth. It
// fills its throat, head back, and whips the spit out.
export function spitter(): CreepRig {
  const p: RigPart[] = [], b = MAN;
  const BILE = 0x8e8c3a, BILED = 0x5e6428, SAC = 0x9a9466, SACD = 0x6e6a44;
  legs(p, b, 1, { boot: PAL.leatherDark });
  pelvis(p, b, 0.125);
  // The shirt: a chest over a narrower belly, open at the neck, the hem torn and hanging.
  const top = b.sh[1] + 0.02;
  const lo = tube(p, J.CHEST, [0, b.waist - 0.07, 0], [0, b.waist + 0.14, 0], 0.13, 0.135, SHIRT, 6, 0.66, 1, 0);
  const hi = tube(p, J.CHEST, [0, b.waist + 0.12, 0], [0, top, 0], 0.145, 0.2, SHIRT, 6, 0.6, 1, 2);
  onTube(p, hi, [1, 0.3, 0], 0.85, 0, 0.09, 0.06, SKIN);
  for (const s of [1, -1]) bx(p, J.CHEST, 0.05, 0.022, 0.05, SHIRT, 0.04, top + 0.005, 0.05 * s, 0, 0, 0.5 * s);
  for (const [x, z, h] of [[0.075, 0.07, 0.07], [0.03, -0.11, 0.08], [-0.06, 0.06, 0.06]] as const) bx(p, -1, 0.035, h, 0.05, SHIRT, x, b.waist - 0.08 - h / 2, z);
  // Blood: hands that grabbed at it, a smear down the side, the back.
  onTube(p, hi, [1, 0, 0], 0.45, 0.32, 0.06, 0.05, BLOOD);
  onTube(p, lo, [1, 0, -0.3], 0.5, 0.3, 0.08, 0.05, GORE);
  onTube(p, hi, [0, 0, 1], 0.3, 0, 0.1, 0.06, BLOOD);
  onTube(p, hi, [-1, 0, 0], 0.6, -0.2, 0.08, 0.06, CLOT);
  // The bile: down the front from the collar to the belt, in runs.
  onTube(p, hi, [1, 0, 0], 0.6, -0.05, 0.12, 0.05, BILE);
  onTube(p, hi, [1, 0, 0], 0.15, -0.1, 0.09, 0.035, BILED);
  onTube(p, lo, [1, 0, 0], 0.6, -0.12, 0.12, 0.03, BILED);
  onTube(p, lo, [1, 0, 0], 0.45, 0.12, 0.08, 0.025, BILE);
  // The head thrust out, the jaw slack and dropped, bile running from the mouth.
  const hx = 0.01, hy = b.sh[1] + 0.02;
  head(p, J.HEAD, hx, hy, 1, { jaw: 0.03 });
  plate(p, J.HEAD, [hx + 0.085, hy + 0.04, -0.01], [1, -0.2, 0], 0.025, 0.06, BILE);
  // The throat: a swollen sac under the jaw, veined, on its own joint so it fills.
  ball(p, J.X, 0.058, [0.07, hy + 0.06, 0], [1, 0.85, 1.25], SAC, 6, 4);
  plate(p, J.X, [0.127, hy + 0.065, 0.025], [1, 0, 0.3], 0.012, 0.06, SACD, 0.3);
  plate(p, J.X, [0.126, hy + 0.055, -0.03], [1, 0, -0.3], 0.012, 0.05, SACD, -0.3);
  // Both arms out, sleeves torn short, the forearms bare and blotched, the hands clawing.
  for (const s of [1, -1]) arm(p, s, mir(b.sh, s), mir(b.el, s), [0, 0.65, 0.23 * s], [0.044, 0.036], [0.037, 0.029], { cut: 0.45, nail: BILED, bend: -0.7 });
  const uarm: JointDef = { p: b.sh, walk: [0.16, 0.6, -0.06, 1.05], flex: [0.12, 1.4, 0, 0.09], wind: [-0.6, -0.3, 0, 0], strike: [0.35, 0, 0, 0], die: [-1.4, -0.2, 0, 0], misc: [-0.4, 0.7, 1, 1] };
  const farm: JointDef = { p: b.el, walk: [0.1, 1.4, 0, 0.45], flex: [0.4, 0.8, 0, 0.12], wind: [0.4, 0, 0, 0], strike: [-0.2, 0, 0, 0], die: [-0.3, 0, 0, 0], misc: [0, 0.5, 1, 1] };
  return rig(p, {
    [J.CHEST]: { p: [0, b.waist, 0], walk: [0.05, 0.4, 0.11, -0.36], flex: [0.1, 0.4, 0.16, 0.04], wind: [0.45, 0, 0, 0], strike: [-0.45, 0, 0, 0], die: [-0.8, 0, 0.25, 0], misc: [0.35, 0.3, 0, 0] },
    [J.X]: { p: [0.07, hy + 0.06, 0], flex: [0, 0, 0, 0.03], wind: [0, 0, 0, 0.5], strike: [0, 0, 0, -0.25], die: [0, 0, 0, -0.3], misc: [0.1, 0.2, 0, 0] },
    [J.HEAD]: { p: [hx, hy + 0.01, 0], walk: [0.08, 1.6, -0.13, 0.22], flex: [0, 0, 0, 0.08], wind: [0.7, 0, 0, 0], strike: [-0.9, 0, 0, 0], die: [-0.6, 0.4, 0, 0], misc: [0.5, 0.4, 0, 0] },
    [J.UARM_L]: uarm, [J.FARM_L]: farm,
    [J.UARM_R]: restR(uarm, 0.75), [J.FARM_R]: restR(farm, 0.75),
    ...legJoints(b, 0.34, 0.8, { rest: 0.06, knee: -0.14, split: 0.14 }),
  }, { stride: 0.9, bob: 0.025, drop: 0.36, turn: 5, flinch: 0.8, scale: UNIT });
}

// The picture's brute: a big heavy man a head taller than the rest and broad, his head a
// man's, sloped shoulders and long hanging arms, in a blue-grey work shirt with the sleeves
// rolled, an orange hi-vis vest with pale bands round the belly and up each front, a yellow
// hard hat, work boots, torn knees, blood on all of it. He lumbers, and brings both fists down.
export function brute(): CreepRig {
  const p: RigPart[] = [];
  const VIS = PAL.hiVis, BAND = PAL.hiVisBand, HAT = PAL.hardHat, VISD = darker(PAL.hiVis, 0.6);
  const WORK = blend(PAL.denimLight, PAL.shirtGrey, 0.3);
  const b: Body = { hip: 0.77, knee: 0.42, hz: 0.125, sh: [0, 1.2, 0.235], el: [-0.02, 0.94, 0.305], wr: [0.03, 0.69, 0.28], waist: 0.84 };
  legs(p, b, 1.25, { foot: 1.2 });
  // Cargo pockets on the thighs.
  for (const s of [1, -1]) bx(p, side(s, J.THIGH_L, J.THIGH_R), 0.08, 0.09, 0.03, PANTS, 0.0, 0.6, (b.hz + 0.09) * s);
  pelvis(p, b, 0.175, 0.7);
  // The trunk is the vest: a barrel of a belly and chest, the shoulders sloping off into a
  // thick neck, the shirt showing down its open middle and at the collar.
  const top = b.sh[1] + 0.02;
  const vb = tube(p, J.CHEST, [0, b.waist - 0.075, 0], [0, b.waist + 0.16, 0], 0.185, 0.205, VIS, 6, 0.74, 1, 0);
  const vc = tube(p, J.CHEST, [0, b.waist + 0.14, 0], [0, top - 0.01, 0], 0.205, 0.225, VIS, 6, 0.68, 1, 0);
  const vy = tube(p, J.CHEST, [0, top - 0.015, 0], [0.01, top + 0.075, 0], 0.225, 0.115, VIS, 6, 0.68, 1, 2);
  tube(p, J.CHEST, [0.01, top + 0.04, 0], [0.015, top + 0.1, 0], 0.11, 0.085, WORK, 6, 0.8, 1, 2);
  for (const T of [vb, vc]) onTube(p, T, [1, 0, 0], 0.5, 0, T === vb ? 0.235 : 0.21, 0.06, WORK);
  onTube(p, vy, [1, 0, 0], 0.4, 0, 0.09, 0.06, WORK);
  // The pale bands: up each front and over the shoulder, and round the belly.
  for (const s of [1, -1]) {
    for (const T of [vb, vc]) onTube(p, T, [1, 0, 0], 0.5, 0.32 * s, T === vb ? 0.235 : 0.21, 0.035, BAND, 0.005);
    for (const d of [[1, 0, 1.7 * s], [0.4, 0, s], [-1, 0, 1.7 * s]] as P3[]) onTube(p, vb, d, 0.45, 0, 0.04, 0.12, BAND, 0.005);
    onTube(p, vy, [1, 0.5, 0.5 * s], 0.4, 0.3 * s, 0.1, 0.035, BAND, 0.005);
    onTube(p, vb, [1, 0, 0.35 * s], 0.05, 0.2 * s, 0.03, 0.06, VISD, 0.006);
  }
  for (const s of [1, -1]) onTube(p, vb, [1, 0, 0], 0.45, 0.36 * s, 0.04, 0.05, BAND, 0.006);
  onTube(p, vb, [-1, 0, 0], 0.45, 0, 0.04, 0.2, BAND, 0.005);
  onTube(p, vc, [-1, 0, 0], 0.55, 0, 0.04, 0.2, BAND, 0.005);
  // Blood: down the vest, a hand smeared on the side, the back.
  onTube(p, vc, [1, 0, 0.6], 0.4, 0.1, 0.1, 0.06, BLOOD, 0.006);
  onTube(p, vb, [1, 0, -1.7], 0.6, 0, 0.12, 0.05, CLOT, 0.006);
  onTube(p, vb, [1, 0, 0], 0.3, 0, 0.06, 0.04, GORE, 0.004);
  onTube(p, vc, [-1, 0, 1.7], 0.5, 0, 0.09, 0.07, BLOOD, 0.006);
  // A bull neck, then a man's head on it, heavy in the jaw, a moustache, the hard hat on top.
  const hx = 0.025, hy = top + 0.04;
  tube(p, J.HEAD, [0, top - 0.04, 0], [0.025, hy + 0.12, 0], 0.075, 0.068, SKIN, 5, 1, 1, 0);
  head(p, J.HEAD, hx, hy, 1.04, { bald: true, neck: false, jaw: 0.01 });
  bx(p, J.HEAD, 0.03, 0.02, 0.07, HAIR, hx + 0.093, hy + 0.125);
  // The hat sits up on the crown, tipped back a little, so the face shows under the brim.
  const hc = hy + 0.135 * 1.04, hatY = hc + 0.075;
  tube(p, J.HEAD, [hx - 0.004, hatY, 0], [hx - 0.016, hatY + 0.07, 0], 0.084, 0.055, HAT, 7, 1, 1, 2);
  tube(p, J.HEAD, [hx + 0.006, hatY - 0.01, 0], [hx + 0.004, hatY + 0.004, 0], 0.1, 0.096, HAT, 8, 1, 0.92, 2);
  bx(p, J.HEAD, 0.14, 0.02, 0.022, lighter(HAT, 0.25), hx - 0.01, hatY + 0.068, 0, 0.15);
  // The arms long and hanging, the sleeves rolled above the elbow, hands like shovels.
  for (const s of [1, -1]) {
    const { U } = arm(p, s, mir(b.sh, s), mir(b.el, s), mir(b.wr, s), [0.062, 0.054], [0.056, 0.042], { cut: 0.5, sleeve: WORK, hand: 1.35, bend: 0.3 });
    onTube(p, U, [1, 0, 0], 0.5, 0, 0.03, 0.09, lighter(WORK, 0.18), 0.022);
  }
  const uarm: JointDef = { p: b.sh, walk: [0.3, Math.PI + 0.35, -0.08, 0.2], flex: [0, 0, 0, 0.05], wind: [2.5, -0.15, 0, 0], strike: [0.75, 0.05, 0, 0], die: [-0.5, -0.2, 0, 0], misc: [-0.15, 0.6, 1, 1] };
  const farm: JointDef = { p: b.el, walk: [0.12, Math.PI + 0.9, 0, 0.55], flex: [0.2, 1.0, 0, 0.04], wind: [1.0, 0, 0, 0], strike: [-0.1, 0, 0, 0], die: [-0.2, 0, 0, 0], misc: [0, 0.6, 1, 1] };
  return rig(p, {
    [J.CHEST]: { p: [0, b.waist, 0], walk: [0.04, Math.PI / 2, 0.13, -0.22], flex: [0.06, 0.5, 0.17, 0.03], wind: [0.4, 0, 0, 0], strike: [-0.6, 0, 0, 0], die: [-0.7, 0, 0.2, 0], misc: [0.12, 0.2, 0, 0] },
    [J.HEAD]: { p: [hx, top - 0.01, 0], walk: [0.07, 2.0, -0.1, 0.28], flex: [0, 0, 0, 0.05], wind: [0.25, 0, 0, 0], strike: [-0.2, 0, 0, 0], die: [-0.5, 0.3, 0, 0], misc: [0.2, 0.2, 0, 0] },
    [J.UARM_L]: uarm, [J.FARM_L]: farm,
    [J.UARM_R]: restR(uarm, 0.12), [J.FARM_R]: restR(farm, 0.6),
    ...legJoints(b, 0.27, 0.45, { rest: 0.1, knee: -0.22, split: 0.1, thigh: { die: [1.25, 0, 0, 0], misc: [0, 0.3, 1, 2] }, shin: { die: [-2.0, 0, 0, 0] } }),
  }, { stride: 0.82, bob: 0.075, drop: 0.38, turn: 3.5, flinch: 0.25, scale: UNIT });
}

// A slaughterman: thick in the belly and the neck, bald, hunched with his head sunk forward
// between his shoulders, a long rubber apron bloodied to the knee, bare thick arms,
// wellingtons, a cleaver in his right fist. He charges, and brings the cleaver down.
export function mauler(): CreepRig {
  const p: RigPart[] = [];
  const APRON = 0xa49c80, APROND = darker(APRON, 0.7), WELLY = 0x2c2e24, STEEL = PAL.steelLit, HANDLE = PAL.woodDark;
  const b: Body = { hip: 0.66, knee: 0.36, hz: 0.11, sh: [0.01, 1.07, 0.24], el: [0.02, 0.84, 0.265], wr: [0.05, 0.63, 0.26], waist: 0.72 };
  legs(p, b, 1.35, { welly: WELLY, foot: 1.1, tear: false });
  pelvis(p, b, 0.18, 0.8, false);
  // A belly like a barrel, the chest over it, a hump of shoulders and a neck as wide as the head.
  const top = b.sh[1] + 0.02;
  const bl = tube(p, J.CHEST, [0, b.waist - 0.07, 0], [0.02, b.waist + 0.15, 0], 0.2, 0.235, SHIRT, 6, 0.88, 1, 0);
  const ch = tube(p, J.CHEST, [0.02, b.waist + 0.13, 0], [0, top, 0], 0.235, 0.24, SHIRT, 6, 0.72, 1, 0);
  tube(p, J.CHEST, [0, top - 0.005, 0], [0.03, top + 0.08, 0], 0.24, 0.12, SHIRT, 6, 0.72, 1, 2);
  onTube(p, ch, [-1, 0, 0], 0.5, 0, 0.12, 0.12, CLOT);
  onTube(p, bl, [0, 0, 1], 0.5, 0, 0.1, 0.08, BLOOD);
  // The apron: the bib on the chest, the skirt from the belly to the knees, ties round the back.
  const bib = tube(p, J.CHEST, [0.19, b.waist + 0.08, 0], [0.155, top - 0.04, 0], 0.2, 0.17, APRON, 4, 0.1, 1.05, 3);
  const skirt = tube(p, -1, [0.2, b.waist + 0.08, 0], [0.24, b.knee - 0.04, 0], 0.22, 0.24, APRON, 4, 0.1, 1.05, 3);
  for (const s of [1, -1]) {
    bx(p, J.CHEST, 0.1, 0.025, 0.025, APROND, 0.12, top + 0.03, 0.09 * s, -0.8);
    onTube(p, bl, [0, 0, s], 0.6, 0, 0.03, 0.2, APROND, 0.005);
  }
  onTube(p, bib, [1, 0, 0], 0.5, 0.1, 0.16, 0.1, BLOOD, 0.005);
  onTube(p, bib, [1, 0, 0], 0.25, -0.2, 0.08, 0.06, GORE, 0.005);
  onTube(p, skirt, [1, 0, 0], 0.25, -0.15, 0.14, 0.1, BLOOD, 0.005);
  onTube(p, skirt, [1, 0, 0], 0.65, 0.2, 0.18, 0.07, CLOT, 0.005);
  onTube(p, skirt, [1, 0, 0], 0.95, 0, 0.05, 0.3, APROND, 0.005);
  // The neck thick and short, the bald head sunk low and forward on it, jowls, small eyes.
  const hx = 0.06, hy = top - 0.02;
  tube(p, J.HEAD, [0.01, top - 0.06, 0], [hx + 0.01, hy + 0.1, 0], 0.09, 0.075, SKIN, 5, 1, 1, 0);
  head(p, J.HEAD, hx, hy, 1.0, { bald: true, neck: false, jaw: 0.01 });
  for (const s of [1, -1]) bx(p, J.HEAD, 0.07, 0.05, 0.03, SKIN, hx + 0.06, hy + 0.08, 0.055 * s);
  bx(p, J.HEAD, 0.03, 0.06, 0.11, HAIR, hx - 0.065, hy + 0.12);
  // Bare arms as thick as a man's legs, the sleeves torn off at the shoulder, fists hanging.
  for (const s of [1, -1]) arm(p, s, mir(b.sh, s), mir(b.el, s), mir(b.wr, s), [0.08, 0.07], [0.07, 0.052], { cut: 0.22, hand: 1.35 });
  // The cleaver: its handle through the right fist, the blade forward and down.
  const w: P3 = [b.wr[0] + 0.02, b.wr[1] - 0.1, -b.wr[2]];
  bx(p, J.FARM_R, 0.11, 0.03, 0.03, HANDLE, w[0] + 0.02, w[1], w[2]);
  bx(p, J.FARM_R, 0.2, 0.13, 0.016, STEEL, w[0] + 0.17, w[1] - 0.03, w[2], -0.15);
  bx(p, J.FARM_R, 0.09, 0.03, 0.02, GORE, w[0] + 0.22, w[1] - 0.09, w[2], -0.15);
  const uarm: JointDef = { p: b.sh, walk: [0.45, Math.PI + 0.3, -0.08, 0.25], flex: [0, 0, 0, 0.04], wind: [2.4, -0.4, 0, 0], strike: [0.45, 0.15, 0, 0], die: [-0.5, -0.2, 0, 0], misc: [-0.15, 0.6, 1, 1] };
  const farm: JointDef = { p: b.el, walk: [0.15, Math.PI + 0.8, 0, 0.5], flex: [0.45, 1.1, 0, 0.03], wind: [0.9, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [-0.2, 0, 0, 0], misc: [0, 0.6, 1, 1] };
  return rig(p, {
    [J.CHEST]: { p: [0, b.waist, 0], walk: [0.05, Math.PI / 2, 0.12, -0.38], flex: [0.08, 0.5, 0.18, 0.03], wind: [0.6, 0, -0.2, 0], strike: [-0.55, 0, 0.2, 0], die: [-0.7, 0, 0.2, 0], misc: [0.12, 0.2, 0, 0] },
    [J.HEAD]: { p: [hx, top - 0.04, 0], walk: [0.08, 2.0, -0.1, 0.32], flex: [0, 0, 0, 0.05], wind: [0.3, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [-0.5, 0.3, 0, 0], misc: [0.2, 0.2, 0, 0] },
    [J.UARM_L]: uarm, [J.FARM_L]: farm,
    [J.UARM_R]: restR(uarm, 0.35), [J.FARM_R]: restR(farm, 0.6),
    ...legJoints(b, 0.44, 0.9, { rest: 0.14, knee: -0.2, thigh: { wind: [0.25, 0, 0, 0], strike: [-0.2, 0, 0, 0], misc: [0, 0.3, 1, 2] }, shin: { wind: [-0.5, 0, 0, 0] } }),
  }, { stride: 1.12, bob: 0.06, drop: 0.34, turn: 5, flinch: 0.25, scale: UNIT });
}

// A dead dog, a big shepherd-like one gone to bone: a deep chest and a tucked waist, the coat
// tan with a dark saddle (the instance's hair) worn through to the skin, ribs and spine
// showing, a wound in the flank, the head carried low and the lips gone from the teeth. It
// gallops, crouches and leaps.
export function hound(): CreepRig {
  const p: RigPart[] = [];
  const COAT = 0x7a5a36, BELLY = 0x9a8058, PAW = 0x2a221a, NOSE = PAL.ink, TOOTH = PAL.bone;
  // The body along x, standing 0.55 at the withers: the chest deep between the forelegs, the
  // loin tucked up under the spine, the rump; a saddle of darker coat over the back.
  const chest = tube(p, J.CHEST, [-0.04, 0.44, 0], [0.24, 0.45, 0], 0.115, 0.125, COAT, 6, 1, 0.62, 2);
  const loin = tube(p, J.CHEST, [-0.24, 0.46, 0], [-0.02, 0.45, 0], 0.085, 0.095, COAT, 6, 1, 0.66, 0);
  tube(p, J.CHEST, [-0.36, 0.45, 0], [-0.22, 0.47, 0], 0.075, 0.09, COAT, 6, 1, 0.8, 1);
  tube(p, J.CHEST, [-0.3, 0.51, 0], [0.22, 0.53, 0], 0.05, 0.06, HAIR, 4, 0.6, 1.3, 0);
  onTube(p, chest, [0, -1, 0], 0.5, 0, 0.22, 0.07, BELLY);
  // Ribs down each side through the worn hide, a raw patch, a wound in the flank.
  for (const s of [1, -1]) {
    onTube(p, chest, [0, -0.2, s], 0.45, 0, 0.13, 0.07, SKIN, 0.004);
    for (const t of [0.3, 0.42, 0.54]) onTube(p, chest, [0, -0.2, s], t, 0, 0.014, 0.05, BONE, 0.007);
    onTube(p, loin, [0, 0.3, s], 0.4, 0, 0.05, 0.045, s > 0 ? GORE : SKIN, 0.004);
  }
  // The tail, thin and hanging.
  tube(p, J.CHEST, [-0.35, 0.48, 0], [-0.44, 0.3, 0], 0.022, 0.014, COAT, 4, 1, 1, 2);
  // Neck and head, low and forward: the long skull, the muzzle, the jaw open on the teeth, the
  // ears laid back, milky eyes.
  tube(p, J.HEAD, [0.17, 0.48, 0], [0.33, 0.44, 0], 0.07, 0.055, COAT, 5, 1, 0.85, 0);
  const sk = tube(p, J.HEAD, [0.28, 0.45, 0], [0.4, 0.43, 0], 0.058, 0.052, COAT, 5, 1, 0.95, 1);
  tube(p, J.HEAD, [0.38, 0.435, 0], [0.5, 0.41, 0], 0.036, 0.028, SKIN, 5, 1, 1, 2);
  tube(p, J.HEAD, [0.36, 0.395, 0], [0.47, 0.37, 0], 0.024, 0.02, COAT, 4, 1, 1.1, 2);
  bx(p, J.HEAD, 0.025, 0.025, 0.035, NOSE, 0.5, 0.415);
  plate(p, J.HEAD, [0.44, 0.393, 0], [0, -1, 0], 0.05, 0.04, MOUTH);
  for (const s of [1, -1]) {
    plate(p, J.HEAD, [0.45, 0.403, 0.026 * s], [0, 0, s], 0.05, 0.012, TOOTH);
    bx(p, J.HEAD, 0.016, 0.016, 0.016, EYE, 0.39, 0.46, 0.04 * s);
    bx(p, J.HEAD, 0.04, 0.028, 0.02, HAIR, 0.31, 0.49, 0.04 * s, 0.6, 0.3 * s);
  }
  onTube(p, sk, [0, 0, 1], 0.5, 0, 0.04, 0.03, GORE);
  // Forelegs on the arm joints, hind legs on the leg joints: the hind thigh a haunch, the hock
  // turned back.
  for (const s of [1, -1]) {
    const z = 0.065 * s;
    const ua = side(s, J.UARM_L, J.UARM_R), fa = side(s, J.FARM_L, J.FARM_R), th = side(s, J.THIGH_L, J.THIGH_R), sn = side(s, J.SHIN_L, J.SHIN_R);
    tube(p, ua, [0.19, 0.47, z], [0.15, 0.25, z], 0.05, 0.034, COAT, 5, 1, 0.8, 0);
    tube(p, fa, [0.15, 0.26, z], [0.17, 0.04, z], 0.028, 0.022, side(s, COAT, SKIN), 4, 1, 1, 0);
    tube(p, fa, [0.155, 0.02, z], [0.215, 0.02, z], 0.026, 0.02, PAW, 4, 1.1, 1.2, 2);
    tube(p, th, [-0.27, 0.47, z], [-0.2, 0.27, z], 0.075, 0.04, COAT, 5, 1, 0.75, 0);
    tube(p, sn, [-0.2, 0.28, z], [-0.31, 0.13, z], 0.034, 0.024, side(s, COAT, SKIN), 4, 1, 1, 0);
    tube(p, sn, [-0.31, 0.14, z], [-0.28, 0.03, z], 0.022, 0.02, COAT, 4, 1, 1, 0);
    tube(p, sn, [-0.3, 0.02, z], [-0.24, 0.02, z], 0.026, 0.02, PAW, 4, 1.1, 1.2, 2);
  }
  // A gallop: the forelegs nearly together, the hind legs half a stride behind them.
  const leg = (s: number, d: JointDef): JointDef => ({ ...d, misc: [0, 0.5, s, d.misc![3]], walk: [d.walk![0], d.walk![1] + (s > 0 ? 0 : 0.6), 0, d.walk![3]] as V4 });
  const fore: JointDef = { p: [0.19, 0.47, 0.065], walk: [0.6, 0, 0, 0], wind: [-0.6, 0, 0, 0], strike: [1.3, 0, 0, 0], die: [0.9, 0.3, 0, 0], misc: [0, 0.5, 1, 1] };
  const foreLo: JointDef = { p: [0.15, 0.26, 0.065], walk: [0, 0, 0, 0], flex: [-1.2, Math.PI / 2, 0, 0], wind: [1.2, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [-0.9, 0, 0, 0], misc: [0, 0.4, 1, 1] };
  const hind: JointDef = { p: [-0.27, 0.47, 0.065], walk: [0.55, Math.PI, 0, 0], wind: [0.55, 0, 0, 0], strike: [-0.9, 0, 0, 0], die: [-1.0, 0.3, 0, 0], misc: [0, 0.5, 1, 2] };
  const hindLo: JointDef = { p: [-0.2, 0.28, 0.065], walk: [0, Math.PI, 0, 0], flex: [0.9, Math.PI / 2, 0, 0], wind: [0.8, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [1.4, 0, 0, 0], misc: [0, 0.4, 1, 2] };
  const right = (d: JointDef): JointDef => ({ ...d, p: [d.p[0], d.p[1], -d.p[2]] });
  return rig(p, {
    [J.CHEST]: { p: [-0.27, 0.47, 0], walk: [0.12, Math.PI / 2, 0.04, 0], flex: [0, 0, 0.08, 0.02], wind: [-0.18, 0, 0, 0], strike: [0.25, 0, 0, 0], die: [0, 1.3, 0, 0], misc: [0.3, 0.3, 0, 0] },
    [J.HEAD]: { p: [0.19, 0.48, 0], walk: [0.14, 2.4, 0.05, -0.05], flex: [0, 0, 0, 0.1], wind: [-0.35, 0, 0, 0], strike: [0.45, 0, 0, 0], die: [-0.7, 0.4, 0, 0], misc: [0.4, 0.5, 0, 0] },
    [J.UARM_L]: leg(1, fore), [J.FARM_L]: leg(1, foreLo),
    [J.UARM_R]: right(leg(-1, fore)), [J.FARM_R]: right(leg(-1, foreLo)),
    [J.THIGH_L]: leg(1, hind), [J.SHIN_L]: leg(1, hindLo),
    [J.THIGH_R]: right(leg(-1, hind)), [J.SHIN_R]: right(leg(-1, hindLo)),
  }, { stride: 1.05, bob: 0.035, drop: 0.18, turn: 12, flinch: 1.2, scale: UNIT });
}

// The thrower: tall and rangy in a torn canvas work jacket, the left arm grown long and thick
// out of a swollen shoulder, the sleeve split off it, a lump of concrete with rebar in that
// hand at its knee; the right arm thin in its sleeve. It rears, the long arm back over its
// head, and throws.
export function hurler(): CreepRig {
  const p: RigPart[] = [];
  const JACKET = PAL.canvas, JACKETD = darker(PAL.canvas, 0.7), ROCK = PAL.concrete, ROCKD = darker(PAL.concrete, 0.7), REBAR = PAL.rust;
  const b: Body = { hip: 0.73, knee: 0.4, hz: 0.075, sh: [0, 1.14, 0.175], el: [0, 0.9, 0.185], wr: [0, 0.7, 0.19], waist: 0.79 };
  legs(p, b, 0.92, {});
  pelvis(p, b, 0.115, 0.66, false);
  // The jacket, open on the shirt, hanging below the belt; its collar up, its hem torn.
  const top = b.sh[1] + 0.02;
  const lo = tube(p, J.CHEST, [0, b.waist - 0.14, 0], [0, b.waist + 0.14, 0], 0.135, 0.14, JACKET, 6, 0.68, 1, 0);
  const hi = tube(p, J.CHEST, [0, b.waist + 0.12, 0], [0, top, 0], 0.145, 0.185, JACKET, 6, 0.62, 1, 2);
  for (const T of [lo, hi]) onTube(p, T, [1, 0, 0], 0.5, 0, T === lo ? 0.27 : 0.21, 0.055, SHIRT, 0.002);
  onTube(p, hi, [1, 0, 0], 0.55, 0.02, 0.08, 0.04, BLOOD);
  onTube(p, lo, [1, 0, 0], 0.7, -0.05, 0.07, 0.035, CLOT);
  for (const s of [1, -1]) {
    bx(p, J.CHEST, 0.05, 0.06, 0.06, JACKETD, -0.02, top + 0.02, 0.06 * s, 0, 0.3 * s);
    onTube(p, lo, [1, 0, 1.6 * s], 0.5, 0, 0.07, 0.07, JACKETD, 0.012);
  }
  bx(p, J.CHEST, 0.06, 0.08, 0.04, JACKET, 0.04, b.waist - 0.16, 0.11, 0.2);
  bx(p, J.CHEST, 0.05, 0.06, 0.04, JACKET, -0.06, b.waist - 0.15, -0.1, -0.2);
  // The long arm's shoulder, swollen, the skin split over it.
  const shL: P3 = [0, 1.15, 0.205];
  ball(p, J.CHEST, 0.07, [0, 1.11, 0.165], [1.05, 1.15, 1], SKIN, 6, 4);
  plate(p, J.CHEST, [0.02, 1.215, 0.18], [0.3, 1, 0.3], 0.07, 0.04, GORE, 0.4);
  head(p, J.HEAD, 0.01, top, 0.98);
  // The long arm (left), bare and blotched to the knee, a forearm like a club, the concrete.
  const elL: P3 = [0.02, 0.85, 0.235], wrL: P3 = [0.04, 0.53, 0.24];
  arm(p, 1, shL, elL, wrL, [0.068, 0.058], [0.062, 0.048], { hand: 1.3 });
  ball(p, J.FARM_L, 0.085, [0.09, 0.38, 0.24], [1.1, 0.85, 0.95], ROCK, 5, 3);
  bx(p, J.FARM_L, 0.08, 0.05, 0.07, ROCKD, 0.13, 0.33, 0.27, 0.3, 0.2);
  bx(p, J.FARM_L, 0.012, 0.14, 0.012, REBAR, 0.11, 0.42, 0.3, 0.4, 0.5);
  bx(p, J.FARM_L, 0.012, 0.1, 0.012, REBAR, 0.04, 0.33, 0.2, -0.6, -0.3);
  // The thin arm in its sleeve.
  arm(p, -1, mir(b.sh, -1), mir(b.el, -1), mir(b.wr, -1), [0.045, 0.04], [0.04, 0.034], { cut: 1.9, sleeve: JACKET, hand: 0.95 });
  const big: JointDef = { p: shL, walk: [0.22, Math.PI + 0.4, -0.06, 0.12], flex: [0, 0, 0, 0.05], wind: [-2.6, -0.2, 0, 0], strike: [1.5, 0.1, 0, 0], die: [-0.8, -0.3, 0, 0], misc: [-0.3, 0.7, 1, 1] };
  const bigLo: JointDef = { p: elL, walk: [0.12, Math.PI + 0.9, 0, 0.3], flex: [0.3, 1.1, 0, 0.03], wind: [0.9, 0, 0, 0], strike: [-0.2, 0, 0, 0], die: [-0.2, 0, 0, 0], misc: [0, 0.7, 1, 1] };
  const small: JointDef = mirror({ p: b.sh, walk: [0.32, Math.PI + 0.4, -0.06, 0.12], flex: [0, 0, 0, 0.05], wind: [0.6, -0.3, 0, 0], strike: [-0.4, 0, 0, 0], die: [-0.8, -0.3, 0, 0], misc: [-0.4, 0.7, 1, 1] });
  const smallLo: JointDef = mirror({ p: b.el, walk: [0.15, Math.PI + 0.9, 0, 0.35], flex: [0.35, 1.1, 0, 0.03], wind: [0.4, 0, 0, 0], strike: [0.1, 0, 0, 0], die: [-0.2, 0, 0, 0], misc: [0, 0.5, 1, 1] });
  return rig(p, {
    [J.CHEST]: { p: [0, b.waist, 0], walk: [0.04, Math.PI / 2, 0.1, -0.22], flex: [0.06, 0.5, 0.16, 0.03], wind: [0.55, 0, -0.3, 0], strike: [-0.6, 0, 0.3, 0], die: [-0.7, 0, 0.2, 0], misc: [0.35, 0.3, 0, 0] },
    [J.HEAD]: { p: [0.01, top + 0.01, 0], walk: [0.07, 2.0, -0.1, 0.18], flex: [0, 0, 0, 0.06], wind: [0.4, 0, 0, 0], strike: [-0.5, 0, 0, 0], die: [-0.5, 0.3, 0, 0], misc: [0.5, 0.4, 0, 0] },
    [J.UARM_L]: big, [J.FARM_L]: bigLo, [J.UARM_R]: small, [J.FARM_R]: smallLo,
    ...legJoints(b, 0.36, 0.85, { rest: 0.08, knee: -0.12 }),
  }, { stride: 1.0, bob: 0.035, drop: 0.4, turn: 5, flinch: 0.9, scale: UNIT });
}
