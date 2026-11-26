import * as THREE from 'three/webgpu';
import { type CreepRig, HAIR, type JointDef, mirror, PANTS, rig, SHIRT, SKIN } from '../creepModels';
import { PAL } from '../palette';
import { J, rp, type RigPart } from '../rig';
import { box, sphere } from '../util';

// The common dead: the walker, the runner, the crawler (the swarmer) and the burster. The same
// people as the survivors gone wrong, built in the survivors' units (a person about 1.33 tall,
// seven heads) and drawn at a survivor's height, whatever its radius in the sim. Facing +x, standing on y = 0, the joints
// named L on the +z side. Limbs are tapered prisms between two points; the stoop, the head
// thrust forward and the arms' hang are the joints' rest angles, so the animation moves the
// pose they are drawn in. Stains and blotches are single-sided plates, two triangles each.
//
// Budgets: the near model at most 900 triangles, the far one (the parts at least a tenth of the
// height across, rig.ts farParts) at most 250; so the small things (hands, hems, the belt, the
// face) are each kept under that tenth, 0.13, and drop out far away.

// The world units per model unit that stand these beside the survivors at their height: the
// survivors' own scale (heroes.ts scales each survivor's group by 1.15), and as much again as
// a survivor, 1.4 to the top of the hair, is taller than these are built (1.33).
const SURVIVOR = 1.15 * 1.4 / 1.33;

type P3 = [number, number, number];
type V4 = [number, number, number, number];

const BLOOD = PAL.blood, FRESH = PAL.bloodFresh, GORE = PAL.bloodDark;
const MOUTH = 0x2a140c, SOCKET = 0x2e2018, EYE = 0xb8b08a, NAIL = PAL.deadSkinDark;
const SHOE = PAL.leather, SOLE = PAL.leatherDark, BELT = PAL.leatherDark, BONE = PAL.bone;

const UP = new THREE.Vector3(0, 1, 0), OUT = new THREE.Vector3(0, 0, 1);

// The frame of a limb from a to b: its local y runs along it.
function frame(a: P3, b: P3): THREE.Matrix4 {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, B.clone().sub(A).normalize());
  return new THREE.Matrix4().compose(A.add(B).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
}
const len = (a: P3, b: P3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

// An n-sided prism h long up y, radius ra at the bottom and rb at the top, a flat face to +x;
// its ends are fans, so it costs 4n - 4 triangles (a cylinder's would be 4n).
function prism(ra: number, rb: number, h: number, n: number): THREE.BufferGeometry {
  const ring = (r: number, y: number) => Array.from({ length: n }, (_, k) => {
    const a = Math.PI / n + (2 * Math.PI * k) / n;
    return [r * Math.cos(a), y, r * Math.sin(a)];
  });
  const lo = ring(ra, -h / 2), hi = ring(rb, h / 2), v: number[] = [];
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    v.push(...lo[k], ...hi[k], ...lo[k1], ...hi[k], ...hi[k1], ...lo[k1]);
  }
  for (let i = 1; i < n - 1; i++) v.push(...hi[0], ...hi[i + 1], ...hi[i], ...lo[0], ...lo[i], ...lo[i + 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

// A tapered prism from a (radius ra) to b (radius rb), its cross-section squashed to fx deep
// and fz wide.
function limb(p: RigPart[], j: number, a: P3, b: P3, ra: number, rb: number, c: number, n = 5, fx = 1, fz = 1): void {
  const g = prism(ra, rb, len(a, b), n);
  g.scale(fx, 1, fz);
  g.applyMatrix4(frame(a, b));
  p.push(rp(j, { geo: g, color: c }));
}
// A plate w by h, its face along normal n, centred at c.
function plate(p: RigPart[], j: number, c: P3, n: P3, w: number, h: number, col: number, spin = 0): void {
  const g = new THREE.PlaneGeometry(w, h);
  g.rotateZ(spin);
  const q = new THREE.Quaternion().setFromUnitVectors(OUT, new THREE.Vector3(...n).normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...c), q, new THREE.Vector3(1, 1, 1)));
  p.push(rp(j, { geo: g, color: col }));
}
// A plate on a limb from a to b: t of the way along it, round it by angle u (0 the front, +z
// side at +pi/2), r out from its axis; w along the limb and h across.
function patch(p: RigPart[], j: number, a: P3, b: P3, t: number, u: number, r: number, w: number, h: number, c: number): void {
  const g = new THREE.PlaneGeometry(h, w);
  g.rotateY(Math.PI / 2);
  g.translate(r, (t - 0.5) * len(a, b), 0);
  g.rotateY(-u);
  g.applyMatrix4(frame(a, b));
  p.push(rp(j, { geo: g, color: c }));
}
// A box at (x, y, z), turned by rz forward, rx out, ry round.
function bx(p: RigPart[], j: number, w: number, h: number, d: number, c: number, x: number, y: number, z = 0, rz = 0, rx = 0, ry = 0): void {
  const g = box(w, h, d);
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));
  p.push(rp(j, { geo: g, color: c }));
}

// A head on joint j with the neck's foot at (x, y): ashen, the jaw hanging, sunk eyes, short
// ragged hair or a bald blotched scalp. k scales it.
function head(p: RigPart[], j: number, x: number, y: number, k = 1, bald = false): void {
  bx(p, j, 0.06 * k, 0.07 * k, 0.06 * k, SKIN, x, y + 0.03 * k);
  const cy = y + 0.135 * k, hx = x + 0.015 * k, f = hx + 0.066 * k;
  // Skull and face, a narrower jaw below and forward, the brow and nose a pixel proud.
  bx(p, j, 0.142 * k, 0.12 * k, 0.12 * k, SKIN, hx - 0.006 * k, cy + 0.015 * k);
  bx(p, j, 0.1 * k, 0.055 * k, 0.1 * k, SKIN, hx + 0.012 * k, cy - 0.06 * k, 0, -0.15);
  bx(p, j, 0.025 * k, 0.025 * k, 0.11 * k, SKIN, f, cy + 0.045 * k);
  bx(p, j, 0.025 * k, 0.035 * k, 0.025 * k, SKIN, f + 0.005 * k, cy);
  for (const s of [1, -1]) {
    plate(p, j, [f + 0.001, cy + 0.022 * k, 0.03 * k * s], [1, 0, 0], 0.04 * k, 0.025 * k, SOCKET);
    plate(p, j, [f + 0.002, cy + 0.022 * k, 0.03 * k * s], [1, 0, 0], 0.012 * k, 0.012 * k, EYE);
  }
  // The mouth hanging open, blood down the chin and the neck.
  plate(p, j, [f - 0.006 * k, cy - 0.048 * k, 0], [1, -0.15, 0], 0.055 * k, 0.03 * k, MOUTH);
  plate(p, j, [f - 0.01 * k, cy - 0.08 * k, 0.012 * k], [1, -0.15, 0], 0.025 * k, 0.03 * k, FRESH);
  if (!bald) {
    // Short hair, matted: the crown, the back, a ragged lock over the brow.
    bx(p, j, 0.142 * k, 0.025 * k, 0.125 * k, HAIR, hx - 0.009 * k, cy + 0.083 * k);
    bx(p, j, 0.025 * k, 0.09 * k, 0.125 * k, HAIR, hx - 0.064 * k, cy + 0.035 * k);
    bx(p, j, 0.04 * k, 0.03 * k, 0.04 * k, HAIR, hx + 0.045 * k, cy + 0.075 * k, 0.03 * k, -0.3);
    bx(p, j, 0.035 * k, 0.025 * k, 0.04 * k, HAIR, hx - 0.03 * k, cy + 0.095 * k, -0.035 * k, 0, 0.4);
  } else {
    plate(p, j, [hx + 0.01 * k, cy + 0.0761 * k, 0.02 * k], [0, 1, 0], 0.06 * k, 0.05 * k, BLOOD, 0.4);
    plate(p, j, [hx - 0.065 * k, cy + 0.03 * k, -0.02 * k], [-1, 0, 0], 0.04 * k, 0.05 * k, BLOOD);
  }
  plate(p, j, [hx - 0.01 * k, cy - 0.01 * k, 0.0601 * k], [0, 0, 1], 0.05 * k, 0.04 * k, BLOOD);
}

// A hand at the end of a forearm from e to w: a flat palm, the fingers curled to claws.
function hand(p: RigPart[], j: number, e: P3, w: P3, k = 1): void {
  const L = len(e, w), d: P3 = [(w[0] - e[0]) / L, (w[1] - e[1]) / L, (w[2] - e[2]) / L];
  const at = (t: number): P3 => [w[0] + d[0] * t, w[1] + d[1] * t, w[2] + d[2] * t];
  limb(p, j, w, at(0.06 * k), 0.028 * k, 0.032 * k, SKIN, 4, 0.7, 1.2);
  limb(p, j, at(0.055 * k), at(0.105 * k), 0.03 * k, 0.014 * k, NAIL, 4, 0.7, 1.1);
}

// The skeleton's rest points, in the survivors' units.
interface Body {
  hip: number; knee: number; hz: number;        // hip and knee heights, the hips' half width
  sh: P3; el: P3; wr: P3;                       // the left shoulder, elbow and wrist
  waist: number;                                // the chest joint's height
}
const MAN: Body = { hip: 0.68, knee: 0.37, hz: 0.08, sh: [0, 1.08, 0.18], el: [0, 0.85, 0.19], wr: [0, 0.65, 0.195], waist: 0.74 };

// Both legs from the body's hips: trousers (or shorts to above the knee), a boot or a bare foot.
// thin scales the limbs; bare: which feet are bare (+1 the L side, -1 the R, 0 none, 2 both);
// n: the limbs' sides.
function legs(p: RigPart[], b: Body, thin: number, bare: number, shorts = false, n = 5): void {
  for (const s of [1, -1]) {
    const z = b.hz * s, th = s > 0 ? J.THIGH_L : J.THIGH_R, sh = s > 0 ? J.SHIN_L : J.SHIN_R;
    const hip: P3 = [0, b.hip, z], knee: P3 = [0.01, b.knee, z * 1.05], ankle: P3 = [-0.01, 0.05, z * 1.1];
    if (shorts) {
      limb(p, th, hip, knee, 0.058 * thin, 0.044 * thin, SKIN, n);
      const mid: P3 = [0.005, b.hip - 0.17, z * 1.02];
      limb(p, th, [0, b.hip + 0.02, z], mid, 0.075 * thin, 0.068 * thin, PANTS, n);
      patch(p, th, hip, knee, 0.75, 0.6 * s, 0.05 * thin, 0.05, 0.04, BLOOD);
    } else {
      limb(p, th, hip, knee, 0.07 * thin, 0.055 * thin, PANTS, n);
      // A knee worn through to the dead skin, or a dark stain down the thigh.
      patch(p, th, hip, knee, 0.86, 0, 0.056 * thin, 0.05, 0.045, s > 0 ? SKIN : GORE);
      patch(p, th, hip, knee, 0.35, 1.2 * s, 0.062 * thin, 0.09, 0.04, GORE);
    }
    const bareFoot = bare === 2 || bare === s;
    if (shorts) limb(p, sh, knee, ankle, 0.044 * thin, 0.03 * thin, SKIN, n);
    else if (bareFoot) {
      // The trouser leg torn off at the shin, the bare ankle below.
      const cut: P3 = [-0.005, 0.17, z * 1.1];
      limb(p, sh, knee, cut, 0.055 * thin, 0.054 * thin, PANTS, n);
      limb(p, sh, cut, ankle, 0.034 * thin, 0.03 * thin, SKIN, n);
    } else limb(p, sh, knee, ankle, 0.054 * thin, 0.052 * thin, PANTS, n);
    if (bareFoot) {
      bx(p, sh, 0.12, 0.035, 0.055, SKIN, 0.025, 0.018, z * 1.1);
      bx(p, sh, 0.025, 0.022, 0.058, NAIL, 0.083, 0.011, z * 1.1);
      patch(p, sh, knee, ankle, 0.6, 0.5 * s, 0.04 * thin, 0.06, 0.03, BLOOD);
    } else {
      // A worn work boot: the shaft, the foot, the dark sole under it, the hem bunched over.
      bx(p, sh, 0.085, 0.07, 0.07, SHOE, -0.01, 0.055, z * 1.1);
      bx(p, sh, 0.125, 0.045, 0.072, SHOE, 0.035, 0.03, z * 1.1);
      bx(p, sh, 0.12, 0.014, 0.078, SOLE, 0.03, 0.007, z * 1.1);
      bx(p, sh, 0.11, 0.04, 0.105, PANTS, -0.01, 0.1, z * 1.1);
    }
  }
}

// One arm from shoulder to claw. sleeve: -1 bare to the shoulder, 0 a torn short sleeve, 1 to
// the elbow, 2 to the wrist. n: the limbs' sides.
function arm(p: RigPart[], s: number, sh: P3, el: P3, wr: P3, thin: number, sleeve: number, n = 5): void {
  const u = s > 0 ? J.UARM_L : J.UARM_R, f = s > 0 ? J.FARM_L : J.FARM_R;
  if (sleeve >= 1) {
    limb(p, u, sh, el, 0.054 * thin, 0.046 * thin, SHIRT, n);
    // A strip of the torn cuff hanging.
    bx(p, u, 0.02, 0.07, 0.03, SHIRT, el[0] - 0.04, el[1] - 0.005, el[2] + 0.02 * s, 0, 0, 0.3);
  } else {
    limb(p, u, sh, el, 0.044 * thin, 0.036 * thin, SKIN, n);
    if (sleeve === 0) {
      const mid: P3 = [(sh[0] + el[0]) / 2, (sh[1] + el[1]) / 2 + 0.02, (sh[2] + el[2]) / 2];
      limb(p, u, [sh[0], sh[1] + 0.02, sh[2]], mid, 0.058 * thin, 0.054 * thin, SHIRT, n);
    }
    patch(p, u, sh, el, 0.72, 0.6 * s, 0.04 * thin, 0.05, 0.035, BLOOD);
  }
  if (sleeve >= 2) limb(p, f, el, wr, 0.045 * thin, 0.04 * thin, SHIRT, n);
  else {
    limb(p, f, el, wr, 0.037 * thin, 0.029 * thin, SKIN, n);
    // Blotches down the forearm: the picture's dead are mottled dark red to the fingers.
    patch(p, f, el, wr, 0.3, 0.4 * s, 0.036 * thin, 0.06, 0.035, BLOOD);
    patch(p, f, el, wr, 0.7, -1.4 * s, 0.033 * thin, 0.05, 0.03, GORE);
    patch(p, f, el, wr, 0.55, 2.4 * s, 0.033 * thin, 0.04, 0.03, BLOOD);
  }
  hand(p, f, el, wr, thin > 1 ? 1.15 : 1);
}

// The torso from the waist to the shoulders, in the shirt: a rounded chest over a narrower
// belly, the collar open on the dead skin, the torn hem hanging over the belt, hand prints in
// blood down the front.
function torso(p: RigPart[], b: Body, thin: number, prints: boolean): void {
  const w = b.sh[2] * thin, top = b.sh[1] + 0.02;
  limb(p, J.CHEST, [0, b.waist - 0.05, 0], [0, b.waist + 0.14, 0], 0.13 * thin, 0.135 * thin, SHIRT, 6, 0.66, 1);
  limb(p, J.CHEST, [0, b.waist + 0.12, 0], [0, top, 0], 0.145 * thin, w + 0.02, SHIRT, 6, 0.6, 1);
  const front = (y: number) => 0.6 * 0.866 * (0.145 * thin + (w + 0.02 - 0.145 * thin) * (y - b.waist - 0.12) / (top - b.waist - 0.12)) + 0.002;
  // The collar torn open on a V of skin, the collar's points standing out.
  plate(p, J.CHEST, [front(top - 0.04), top - 0.04, 0], [1, 0.25, 0], 0.05, 0.07, SKIN, Math.PI / 2);
  for (const s of [1, -1]) bx(p, J.CHEST, 0.05, 0.022, 0.05, SHIRT, 0.04, top + 0.005, 0.05 * s, 0, 0, 0.5 * s);
  // The hem hanging in tatters below the belt, front and sides.
  for (const [x, z, h] of [[0.075, 0.07, 0.07], [0.08, -0.05, 0.05], [0.03, 0.12, 0.08], [-0.05, -0.11, 0.06], [-0.07, 0.04, 0.05]] as const) {
    bx(p, -1, 0.035, h, 0.05, SHIRT, x * thin, b.waist - 0.07 - h / 2, z * thin);
  }
  if (prints) {
    // Hands that grabbed at it: palm prints and a smear, dark red.
    plate(p, J.CHEST, [front(b.waist + 0.24), b.waist + 0.24, 0.07 * thin], [1, 0, 0], 0.045, 0.05, BLOOD, 0.3);
    plate(p, J.CHEST, [front(b.waist + 0.2), b.waist + 0.2, -0.06 * thin], [1, 0, 0], 0.04, 0.09, BLOOD, -0.4);
    plate(p, J.CHEST, [0.6 * 0.866 * 0.135 * thin + 0.003, b.waist + 0.04, -0.05], [1, 0, 0], 0.04, 0.05, FRESH);
    plate(p, J.CHEST, [-0.02, b.waist + 0.22, w * 0.82 + 0.01], [0, 0, 1], 0.06, 0.05, GORE);
    plate(p, J.CHEST, [-0.075 * thin, b.waist + 0.18, 0.03], [-1, 0, 0], 0.05, 0.07, BLOOD);
  }
}

// The pelvis in the trousers, the belt round it in four plates.
function hips(p: RigPart[], b: Body, thin: number): void {
  const x = 0.085 * thin, z = 0.125 * thin, y = b.hip + 0.075;
  bx(p, -1, 2 * x, 0.14, 2 * z, PANTS, 0, b.hip + 0.02);
  for (const s of [1, -1]) {
    plate(p, -1, [(x + 0.003) * s, y, 0], [s, 0, 0], 2 * z, 0.028, BELT);
    plate(p, -1, [0, y, (z + 0.003) * s], [0, 0, s], 2 * x, 0.028, BELT);
  }
}

// The right twin of a left joint with a rest swing of its own.
const restR = (d: JointDef, rest: number): JointDef => {
  const m = mirror(d);
  return { ...m, walk: m.walk ? [m.walk[0], m.walk[1], m.walk[2], rest] as V4 : undefined };
};
const limbs = (b: Body, s: number): [P3, P3, P3] => [[b.sh[0], b.sh[1], b.sh[2] * s], [b.el[0], b.el[1], b.el[2] * s], [b.wr[0], b.wr[1], b.wr[2] * s]];

// The stooping walker: spine hunched, head pushed forward, one arm hanging and one half raised,
// a torn white or work shirt with hand prints of blood, one bare foot. It drags along, and
// brings an arm down on what it reaches.
export function walker(): CreepRig {
  const p: RigPart[] = [], b = MAN;
  legs(p, b, 1, -1);
  hips(p, b, 1);
  torso(p, b, 1, true);
  head(p, J.HEAD, 0.01, b.sh[1] + 0.02);
  for (const s of [1, -1]) arm(p, s, ...limbs(b, s), 1, s > 0 ? 0 : 1);
  const uarm: JointDef = { p: b.sh, walk: [0.14, 0.5, -0.05, 0.42], flex: [0, 0, 0, 0.06], wind: [1.5, -0.3, 0, 0], strike: [-0.8, 0.1, 0, 0], die: [-1.0, -0.2, 0, 0], misc: [-0.4, 1.4, 1, 1] };
  const farm: JointDef = { p: b.el, walk: [0.1, 1.0, 0, 0.2], wind: [0.6, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [-0.2, 0, 0, 0], misc: [0, 0.9, 1, 1] };
  return rig(p, {
    [J.CHEST]: { p: [0, b.waist, 0], walk: [0, 0, 0.07, -0.32], flex: [0, 0, 0.12, 0.03], wind: [0.35, 0, 0, 0], strike: [-0.45, 0, 0, 0], die: [-0.4, 0, 0.2, 0], misc: [0.35, 0.3, 0, 0] },
    [J.HEAD]: { p: [0.01, b.sh[1] + 0.03, 0], walk: [0, 1.2, 0.18, 0.1], flex: [0, 0, 0, 0.08], wind: [0.3, 0, 0, 0], strike: [-0.5, 0, 0, 0], die: [-0.5, 0.3, 0, 0], misc: [0.5, 0.4, 0, 0] },
    // One arm hangs from the stoop; the other is half raised, reaching.
    [J.UARM_L]: uarm, [J.FARM_L]: farm,
    [J.UARM_R]: restR(uarm, 1.1), [J.FARM_R]: restR(farm, 0.5),
    [J.THIGH_L]: { p: [0, b.hip, b.hz], walk: [0.36, 0, 0, 0.12], wind: [-0.2, 0, 0, 0], strike: [0.3, 0, 0, 0], die: [1.35, 0, 0, 0], misc: [0, 0.5, 1, 2] },
    [J.SHIN_L]: { p: [0.01, b.knee, b.hz * 1.05], walk: [0, 0, 0, -0.18], flex: [-0.8, Math.PI / 2, 0, 0], strike: [-0.2, 0, 0, 0], die: [-2.1, 0, 0, 0], misc: [0, 0.4, 1, 2] },
  }, { stride: 0.82, bob: 0.025, drop: 0.2, turn: 7, flinch: 1, scale: SURVIVOR });
}

const THIN: Body = { hip: 0.7, knee: 0.38, hz: 0.07, sh: [0, 1.08, 0.165], el: [0, 0.85, 0.175], wr: [0, 0.65, 0.18], waist: 0.75 };

// The thin runner: lean, bent hard forward mid-stride, a torn shirt and shorts, bare legs and
// feet, the arms flung back and the hands clawing; it coils and pounces.
export function runner(): CreepRig {
  const p: RigPart[] = [], b = THIN, k = 0.82;
  legs(p, b, k, 2, true);
  hips(p, b, k);
  torso(p, b, k, false);
  // Ribs through the shirt torn away at the side, blood down the front.
  plate(p, J.CHEST, [0.0, 0.95, 0.12], [0.2, 0, 1], 0.09, 0.16, SKIN);
  for (const y of [0.9, 0.94, 0.98, 1.02]) plate(p, J.CHEST, [0.01, y, 0.1215], [0.2, 0, 1], 0.07, 0.012, BONE);
  plate(p, J.CHEST, [0.07, 0.88, -0.03], [1, 0, 0], 0.05, 0.1, FRESH, 0.2);
  plate(p, J.CHEST, [0.07, 1.0, 0.04], [1, 0, 0], 0.04, 0.05, BLOOD);
  head(p, J.HEAD, 0.01, b.sh[1] + 0.02, 0.95);
  for (const s of [1, -1]) arm(p, s, ...limbs(b, s), k, -1);
  return rig(p, {
    [J.CHEST]: { p: [0, b.waist, 0], walk: [0, 0, 0.06, -0.72], flex: [0, 0, 0.2, 0.02], wind: [-0.3, 0, 0, 0], strike: [0.25, 0, 0, 0], die: [-0.4, 0, 0.3, 0], misc: [0.4, 0.3, 0, 0] },
    [J.HEAD]: { p: [0.01, b.sh[1] + 0.03, 0], walk: [0.05, 0, 0.05, 0.55], flex: [0, 0, 0, 0.06], wind: [0.25, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [-0.6, -0.3, 0, 0], misc: [0.5, 0.3, 0, 0] },
    [J.UARM_L]: { p: b.sh, walk: [0.8, Math.PI, -0.1, 0.85], wind: [-0.7, -0.3, 0, 0], strike: [2.3, 0.2, 0, 0], die: [-0.6, -0.4, 0, 0], misc: [-0.3, 1.6, 1, 1] },
    [J.FARM_L]: { p: b.el, walk: [0.35, Math.PI + 0.6, 0, 0.75], wind: [0.4, 0, 0, 0], strike: [-1.0, 0, 0, 0], die: [-0.8, 0, 0, 0], misc: [0, 1, 1, 1] },
    [J.THIGH_L]: { p: [0, b.hip, b.hz], walk: [0.8, 0, 0, 0.3], wind: [0.55, 0, 0, 0], strike: [-0.35, 0, 0, 0], die: [1.2, 0, 0, 0], misc: [0, 0.6, 1, 2] },
    [J.SHIN_L]: { p: [0.01, b.knee, b.hz * 1.05], walk: [0, 0, 0, -0.45], flex: [-1.4, Math.PI / 2, 0, 0], wind: [-1.0, 0, 0, 0], strike: [0.1, 0, 0, 0], die: [-1.8, 0, 0, 0], misc: [0, 0.4, 1, 2] },
  }, { stride: 1.3, bob: 0.06, drop: 0.2, turn: 10, flinch: 1.1, scale: SURVIVOR });
}

// The crawler: a person on all fours, the back arched, the bald head hung low and thrust out
// between the hands, knees and palms on the ground; it scuttles, rears and lunges.
export function swarmer(): CreepRig {
  const p: RigPart[] = [];
  // The pose is built in: hips over the knees, shoulders over the hands.
  const hipX = -0.2, hipY = 0.44, hz = 0.08, shX = 0.17, shY = 0.5, sz = 0.16;
  for (const s of [1, -1]) {
    const th = s > 0 ? J.THIGH_L : J.THIGH_R, sh = s > 0 ? J.SHIN_L : J.SHIN_R, z = hz * s;
    const hip: P3 = [hipX, hipY, z], knee: P3 = [hipX + 0.06, 0.06, z * 1.4], foot: P3 = [hipX - 0.22, 0.04, z * 1.7];
    limb(p, th, hip, knee, 0.07, 0.056, PANTS, 5);
    patch(p, th, hip, knee, 0.86, 0, 0.057, 0.05, 0.045, SKIN);
    patch(p, th, hip, knee, 0.4, 1.3 * s, 0.063, 0.08, 0.04, GORE);
    limb(p, sh, knee, foot, 0.052, 0.04, PANTS, 5);
    // Bare soles turned up behind.
    bx(p, sh, 0.04, 0.06, 0.05, SKIN, foot[0] - 0.02, 0.06, foot[2], 0.6);
    bx(p, sh, 0.035, 0.05, 0.052, SKIN, foot[0] - 0.045, 0.1, foot[2], 0.6);
    plate(p, sh, [foot[0] - 0.066, 0.12, foot[2]], [-1, 0.5, 0], 0.04, 0.03, NAIL);
  }
  bx(p, -1, 0.16, 0.15, 0.25, PANTS, hipX, hipY + 0.01, 0, 0.4);
  // The back arched up from the hips and down to the shoulders.
  const mid: P3 = [-0.02, 0.58, 0];
  limb(p, J.CHEST, [hipX + 0.01, hipY + 0.02, 0], mid, 0.13, 0.15, SHIRT, 5, 0.75, 1);
  limb(p, J.CHEST, [-0.04, 0.58, 0], [shX + 0.04, shY - 0.01, 0], 0.15, 0.165, SHIRT, 5, 0.8, 1);
  // The shirt rucked up: bare skin over the belt, a torn flap hanging under, blood across the back.
  plate(p, J.CHEST, [hipX + 0.09, hipY + 0.115, 0], [-0.5, 1, 0], 0.05, 0.17, SKIN);
  bx(p, J.CHEST, 0.06, 0.065, 0.03, SHIRT, -0.02, 0.41, 0.09, 0.3);
  plate(p, J.CHEST, [-0.07, 0.6601, 0.04], [0, 1, 0], 0.08, 0.07, BLOOD, 0.3);
  plate(p, J.CHEST, [0.06, 0.6501, -0.06], [0.2, 1, 0], 0.1, 0.05, GORE, -0.4);
  plate(p, J.CHEST, [0.08, 0.55, 0.1301], [0, 0, 1], 0.06, 0.05, BLOOD);
  // The neck out of the collar, and the head hung forward of the shoulders, looking up.
  limb(p, J.HEAD, [shX + 0.02, shY - 0.02, 0], [shX + 0.13, shY - 0.1, 0], 0.045, 0.04, SKIN, 4);
  head(p, J.HEAD, shX + 0.15, shY - 0.27, 1, true);
  for (const s of [1, -1]) {
    const z = sz * s, sh: P3 = [shX, shY, z], el: P3 = [shX + 0.1, 0.29, z * 1.25], wr: P3 = [shX + 0.18, 0.07, z * 1.15];
    arm(p, s, sh, el, wr, 1, 2);
    patch(p, s > 0 ? J.FARM_L : J.FARM_R, el, wr, 0.95, 0, 0.042, 0.05, 0.04, BLOOD);
  }
  return rig(p, {
    [J.CHEST]: { p: [hipX, hipY, 0], walk: [0.05, 0, 0.1, 0], flex: [0, 0, 0.15, 0.02], wind: [0.4, 0, 0, 0], strike: [-0.15, 0, 0, 0], die: [-0.15, 0, 0.1, 0], misc: [0.3, 0.3, 0, 0] },
    [J.HEAD]: { p: [shX + 0.04, shY - 0.03, 0], walk: [0.1, 1, 0.15, 0], flex: [0, 0, 0, 0.1], wind: [0.4, 0, 0, 0], strike: [-0.5, 0, 0, 0], die: [-0.3, 0.4, 0, 0], misc: [0.4, 0.4, 0, 0] },
    [J.UARM_L]: { p: [shX, shY, sz], walk: [0.45, 0, 0, 0], wind: [0.9, -0.2, 0, 0], strike: [1.1, 0, 0, 0], die: [0.3, -0.8, 0, 0], misc: [-0.3, 1.2, 1, 1] },
    [J.FARM_L]: { p: [shX + 0.1, 0.29, sz * 1.25], flex: [0.5, 0, 0, 0], wind: [0.5, 0, 0, 0], strike: [-0.6, 0, 0, 0], misc: [0, 0.8, 1, 1] },
    [J.THIGH_L]: { p: [hipX, hipY, hz], walk: [0.35, Math.PI, 0, 0], wind: [-0.25, 0, 0, 0], strike: [0.2, 0, 0, 0], die: [-0.3, 0, 0, 0], misc: [0, 0.4, 1, 2] },
    [J.SHIN_L]: { p: [hipX + 0.06, 0.06, hz * 1.4], flex: [0.35, Math.PI / 2, 0, 0], misc: [0, 0.3, 1, 2] },
  }, { stride: 0.6, bob: 0.02, drop: 0.12, turn: 9, flinch: 0.8, scale: SURVIVOR });
}

const FAT: Body = { hip: 0.66, knee: 0.36, hz: 0.1, sh: [0, 1.07, 0.2], el: [0.02, 0.84, 0.235], wr: [0.05, 0.64, 0.23], waist: 0.72 };

// The burster: a walker swollen to bursting, the shirt split open over a vast belly stretched
// tight, grey-green and blotched, boils on it about to go. It waddles, fast for its bulk; lit, it
// stands up, arms flung wide, and throws its head back.
export function burster(): CreepRig {
  const p: RigPart[] = [], b = FAT;
  const BELLY = 0x8c8e62, BOIL = 0xb4a452;
  legs(p, b, 1.35, 1, false, 4);
  hips(p, b, 1.4);
  // The shirt: its back and its sides, the front burst open, the sleeves torn away.
  limb(p, J.CHEST, [-0.04, b.waist - 0.04, 0], [-0.04, b.sh[1] + 0.02, 0], 0.18, 0.225, SHIRT, 5, 0.6, 1);
  for (const s of [1, -1]) bx(p, J.CHEST, 0.05, 0.12, 0.05, SHIRT, 0.12, 0.98, 0.17 * s, 0.2, 0.2 * s);
  for (const s of [1, -1]) bx(p, J.CHEST, 0.04, 0.12, 0.05, SHIRT, 0.11, 0.86, 0.2 * s, 0.1, 0.3 * s);
  // The chest above the belly, stretched and mottled, the neck thick.
  bx(p, J.CHEST, 0.08, 0.11, 0.12, SKIN, 0.1, 1.0, 0, 0.25);
  plate(p, J.CHEST, [0.141, 1.0, 0.03], [1, 0.25, 0], 0.05, 0.04, BLOOD);
  // The belly: a swollen sac bulging out of the shirt, veined and blotched, a boil or two.
  const C: P3 = [0.12, 0.82, 0], R = 0.26, S: P3 = [1.08, 1, 1.1];
  p.push(rp(J.X, sphereAt(R, BELLY, C, S, 7, 5)));
  const on = (dx: number, dy: number, dz: number, w: number, h: number, c: number, spin = 0, out = -0.014) => {
    const n = new THREE.Vector3(dx, dy, dz).normalize();
    const pt: P3 = [C[0] + n.x * (R * S[0] + out), C[1] + n.y * (R * S[1] + out), C[2] + n.z * (R * S[2] + out)];
    plate(p, J.X, pt, [n.x / S[0], n.y / S[1], n.z / S[2]], w, h, c, spin);
  };
  on(0.9, 0.3, 0.3, 0.12, 0.09, BLOOD, 0.4);
  on(0.85, -0.35, -0.4, 0.1, 0.08, GORE, -0.3);
  on(0.6, 0.1, 0.8, 0.11, 0.08, BLOOD, 0.8);
  on(0.6, -0.2, -0.8, 0.09, 0.08, BLOOD);
  on(0.95, -0.15, 0.05, 0.06, 0.05, FRESH, 0.2);
  on(0.5, 0.75, -0.2, 0.1, 0.07, GORE, 1.1);
  for (const [dx, dy, dz, r] of [[0.9, 0.15, -0.35, 0.032], [0.8, -0.45, 0.3, 0.028], [0.5, 0.35, 0.8, 0.026]]) {
    const n = new THREE.Vector3(dx, dy, dz).normalize();
    p.push(rp(J.X, sphereAt(r, BOIL, [C[0] + n.x * R * S[0], C[1] + n.y * R * S[1], C[2] + n.z * R * S[2]], [1, 1, 1], 5, 3)));
  }
  head(p, J.HEAD, 0.03, b.sh[1] + 0.0, 1.02, true);
  for (const s of [1, -1]) arm(p, s, ...limbs(b, s), 1.4, -1, 4);
  return rig(p, {
    [J.CHEST]: { p: [0, b.waist, 0], walk: [0, 0, 0.16, -0.1], flex: [0, 0, 0.12, 0.03], wind: [0.35, 0, 0, 0], strike: [0.45, 0, 0, 0], die: [-0.4, 0, 0.3, 0], misc: [0.4, 0.3, 0, 0] },
    [J.X]: { p: C, walk: [0, 0, 0.06, 0], flex: [0, 0, 0, 0.04], wind: [0, 0, 0, 0.25], strike: [0, 0, 0, 0.12], die: [0, 0, 0, -0.15], misc: [0.1, 0.2, 0, 0] },
    [J.HEAD]: { p: [0.03, b.sh[1] + 0.01, 0], walk: [0.05, 0, 0.1, 0.15], flex: [0, 0, 0, 0.06], wind: [0.7, 0, 0, 0], strike: [0.4, 0, 0, 0], die: [-0.6, -0.3, 0, 0], misc: [0.5, 0.3, 0, 0] },
    [J.UARM_L]: { p: b.sh, walk: [0.35, Math.PI, -0.1, 0.15], wind: [0.2, -1.4, 0, 0], strike: [0.2, -1.6, 0, 0], die: [-0.6, -0.4, 0, 0], misc: [-0.3, 1.6, 1, 1] },
    [J.FARM_L]: { p: b.el, walk: [0.25, Math.PI + 0.6, 0, 0.45], wind: [0.2, 0, 0, 0], strike: [0.1, 0, 0, 0], die: [-0.8, 0, 0, 0], misc: [0, 1, 1, 1] },
    [J.THIGH_L]: { p: [0, b.hip, b.hz], walk: [0.5, 0, 0.12, 0.05], wind: [0.1, 0, 0, 0], die: [1.3, 0, 0, 0], misc: [0, 0.6, 1, 2] },
    [J.SHIN_L]: { p: [0.01, b.knee, b.hz * 1.05], walk: [0, 0, 0, -0.1], flex: [-1.1, Math.PI / 2, 0, 0], wind: [-0.2, 0, 0, 0], die: [-2.0, 0, 0, 0], misc: [0, 0.4, 1, 2] },
  }, { stride: 1.1, bob: 0.06, drop: 0.2, turn: 12, flinch: 1.1, scale: SURVIVOR });
}

// A low sphere at c, squashed by s.
function sphereAt(r: number, col: number, c: P3, s: P3, ws: number, hs: number): { geo: THREE.BufferGeometry; color: number } {
  const g = sphere(r, ws, hs);
  g.scale(...s);
  g.translate(...c);
  return { geo: g, color: col };
}
