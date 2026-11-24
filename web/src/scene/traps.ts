// The two traps, three by three and laid flat, so they read as ground a creep walks over:
// the bait pit and the catapult pit. Each has a ring of lamps round its rim that fills as it
// recharges and burns green when it is ready, and a moving part: the bait pit's hooks and
// meat churn while it holds, the catapult's arm flips its bucket over its pivot when it throws,
// the way it was turned to face when it was placed, which a big arrow on its deck shows.
import * as THREE from 'three/webgpu';
import { vertexColor } from 'three/tsl';
import { K_BAIT, K_CATAPULT } from '../protocol';
import { box, cone, cyl, merge, part, torus, type Part } from './util';

export const isTrapKind = (k: number): boolean => k === K_BAIT || k === K_CATAPULT;

const DARK = 0x26282a, STEEL = 0x5a5f63, RUST = 0x7a4a2a, MEAT = 0x8a2a22, FAT = 0xc89a8a, BONE = 0xd8d0b8, PLANK = 0x8a6a46;
const SEGMENTS = 15; // as many as the charge has steps

export function trapModel(kind: number): { body: Part[]; head?: Part[]; headY?: number } {
  if (kind === K_BAIT) {
    // A shallow pit in a rim of rubble and sandbags, dark and wet at the bottom, offal and
    // bones strewn flat over it. At the corners, outside where the knot stands, four stakes
    // each hang a joint of meat on a chain and hook.
    const body: Part[] = [
      part(cyl(1.42, 1.48, 0.08, 14), 0x6a6252, 0, 0.04, 0),
      part(cyl(1.18, 1.18, 0.05, 14), 0x1c1612, 0, 0.07, 0),
      part(cyl(0.95, 0.95, 0.03, 12), 0x2a1210, 0, 0.1, 0),
    ];
    for (let k = 0; k < 10; k++) {
      const a = k * Math.PI / 5 + 0.2;
      body.push(part(box(0.42, 0.18, 0.26), k % 2 ? 0x9a8c66 : 0x857854, Math.cos(a) * 1.28, 0.14, Math.sin(a) * 1.28, 0, -a, 0));
    }
    // A stake at each corner, outside the round pit, each with an arm over it, a chain and
    // hook, and a joint hanging on it clear of the knot.
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const st = 1.32, hang = 1.08, a = Math.atan2(sz, sx);
      body.push(part(box(0.16, 1.4, 0.16), 0x5a4430, sx * st, 0.7, sz * st));
      body.push(part(box(0.2, 0.08, 0.2), 0x3e3022, sx * st, 1.38, sz * st));
      body.push(part(box(0.42, 0.09, 0.09), 0x4e3a26, sx * (st + hang) / 2, 1.3, sz * (st + hang) / 2, 0, -a, 0));
      body.push(part(box(0.035, 0.45, 0.035), 0x4a4c4a, sx * hang, 1.05, sz * hang));
      body.push(part(torus(0.09, 0.025, 4, 8), STEEL, sx * hang, 0.8, sz * hang, 0, -a, 0));
      // The joint: a dark red haunch with its pale fat and a knob of bone, on the hook.
      body.push(part(box(0.28, 0.42, 0.22), MEAT, sx * hang, 0.52, sz * hang, 0.1, -a, 0.15));
      body.push(part(box(0.18, 0.12, 0.24), FAT, sx * hang, 0.74, sz * hang, 0, -a, 0));
      body.push(part(cyl(0.04, 0.04, 0.2, 5), BONE, sx * hang, 0.24, sz * hang));
    }
    // The head, flat on the pit floor: offal and bones, which churn while the pit holds.
    const head: Part[] = [];
    const bits: [number, number, number, number][] = [[0.3, 0.1, 0.5, 0.3], [-0.35, 0.25, -1.1, 0.25], [0.05, -0.4, 2.2, 0.28], [-0.2, -0.15, 0.4, 0.2], [0.5, -0.3, 1.6, 0.18], [-0.55, -0.35, 2.9, 0.2]];
    bits.forEach(([x, z, r, w], k) => head.push(part(box(w, 0.07, w * 0.7), k % 3 === 2 ? FAT : k % 2 ? 0x6a1a16 : MEAT, x, 0.04, z, 0, r, 0)));
    for (const [x, z, r] of [[0.1, 0.35, 0.3], [-0.45, 0.05, 1.9], [0.4, 0.45, 2.6], [-0.05, -0.6, 0.9]]) {
      head.push(part(cyl(0.022, 0.022, 0.34, 5), BONE, x, 0.06, z, Math.PI / 2, 0, r));
    }
    return { body, head, headY: 0.1 };
  }
  // A square steel deck. On it, turned the way it throws (catapultTurn): a big arrow painted
  // across it, the pivot frame towards the front and the throwing arm lying back from it with a
  // bucket at its far end, which flips over the pivot to the front when it throws.
  const body: Part[] = [
    part(box(2.9, 0.1, 2.9), 0x6a6252, 0, 0.05, 0),
    part(box(2.6, 0.08, 2.6), DARK, 0, 0.12, 0),
  ];
  for (const [x, z] of [[1.3, 1.3], [1.3, -1.3], [-1.3, 1.3], [-1.3, -1.3]]) body.push(part(cone(0.1, 0.26, 4), 0xc89a2a, x, 0.2, z));
  // The head is the arm, pivoted at the origin here: a beam lying back along -x to an open
  // bucket, and a short stub forward with the counterweight on it.
  const head: Part[] = [
    part(box(ARM_L, 0.12, 0.3), PLANK, -ARM_L / 2, 0.02, 0),
    part(box(ARM_L - 0.1, 0.03, 0.06), 0x2a2a2a, -ARM_L / 2, 0.095, 0.1),
    part(box(ARM_L - 0.1, 0.03, 0.06), 0x2a2a2a, -ARM_L / 2, 0.095, -0.1),
    // The bucket: a floor and four walls, rusted iron, dark inside.
    part(box(BUCKET, 0.06, BUCKET), 0x1e1a16, -ARM_L - BUCKET / 2, 0.02, 0),
    part(box(0.07, 0.3, BUCKET), RUST, -ARM_L - BUCKET + 0.035, 0.17, 0),
    part(box(0.07, 0.3, BUCKET), RUST, -ARM_L - 0.035, 0.17, 0),
    part(box(BUCKET, 0.3, 0.07), 0x8a5632, -ARM_L - BUCKET / 2, 0.17, BUCKET / 2 - 0.035),
    part(box(BUCKET, 0.3, 0.07), 0x8a5632, -ARM_L - BUCKET / 2, 0.17, -BUCKET / 2 + 0.035),
    // The counterweight, forward of the pivot.
    part(box(0.3, 0.08, 0.16), STEEL, 0.12, 0, 0),
    part(box(0.18, 0.2, 0.42), 0x34363a, 0.24, -0.02, 0),
  ];
  return { body, head, headY: ARM_Y };
}

// The catapult's arm: where its pivot stands on the deck (towards the way it throws), how high,
// the beam's length back to the bucket and the bucket's size. Turned 45 degrees the bucket's far
// corner stays inside the deck, and the lamps.
const PIVOT_X = 0.2, ARM_Y = 0.34, ARM_L = 0.85, BUCKET = 0.6;

// The parts that turn with the catapult's facing and stay put when it throws: the pivot frame
// and the coil springs under the beam.
let armGeo: THREE.BufferGeometry | null = null;
function catapultArm(): THREE.BufferGeometry {
  if (armGeo) return armGeo;
  const p: Part[] = [part(box(0.09, 0.09, 0.78), STEEL, PIVOT_X, ARM_Y, 0)];
  for (const z of [-0.34, 0.34]) {
    p.push(part(box(0.12, 0.3, 0.1), STEEL, PIVOT_X, 0.31, z));
    p.push(part(box(0.3, 0.06, 0.14), 0x3e4044, PIVOT_X, 0.19, z));
  }
  for (const x of [-0.25, -0.55]) {
    for (let k = 0; k < 2; k++) p.push(part(torus(0.12, 0.035, 4, 8), RUST, PIVOT_X + x, 0.21 + k * 0.07, 0, Math.PI / 2, 0, 0));
  }
  armGeo = merge(p);
  return armGeo;
}

// The arrow painted across the deck, from behind the bucket to near the front edge, inside the
// lamps at any facing: a broad shaft and a head wider than the arm, lit like the lamps so it
// reads at night too.
let arrowGeo: THREE.BufferGeometry | null = null;
function catapultArrow(): THREE.BufferGeometry {
  if (arrowGeo) return arrowGeo;
  const sh = new THREE.Shape();
  sh.moveTo(-1.15, -0.24); sh.lineTo(0.42, -0.24); sh.lineTo(0.42, -0.62); sh.lineTo(1.22, 0);
  sh.lineTo(0.42, 0.62); sh.lineTo(0.42, 0.24); sh.lineTo(-1.15, 0.24); sh.closePath();
  const g = new THREE.ShapeGeometry(sh);
  g.rotateX(-Math.PI / 2);
  arrowGeo = merge([part(g, 0xd8a428, 0, 0.165, 0)]);
  return arrowGeo;
}
let arrowMat: THREE.MeshBasicNodeMaterial | null = null;

// The way a catapult's facing (eighths of a turn from +x towards +y) turns its arm.
const turnFor = (facing: number): number => -(facing & 7) * Math.PI / 4;

// catapultTurn puts the catapult's arm (head), its frame and its arrow, made with mat, on a
// turntable in g that trapFace turns. A built one's arrow is lit (glow); a ghost's is mat.
// With band, the placement ghost's: a mark on the ground where it throws to, at its spread
// and its least and most throw.
function catapultTurn(g: THREE.Group, head: THREE.Object3D | null, mat: THREE.Material, glow: boolean, band: boolean): void {
  const turn = new THREE.Group();
  turn.add(new THREE.Mesh(catapultArm(), mat));
  if (glow && !arrowMat) { arrowMat = new THREE.MeshBasicNodeMaterial(); arrowMat.colorNode = vertexColor().rgb; }
  turn.add(new THREE.Mesh(catapultArrow(), glow ? arrowMat! : mat));
  if (head) { turn.add(head); head.position.set(PIVOT_X, ARM_Y, 0); }
  if (band) turn.add(new THREE.Mesh(landingGeo(), mat));
  g.add(turn);
  g.userData.turn = turn;
}

// The landing band, as the sim throws: within THROW_SPREAD of the facing, THROW_NEAR to
// THROW_FAR tiles from the middle, and an arrow along the facing out to it.
const THROW_NEAR = 6, THROW_FAR = 10, THROW_SPREAD = 15 * Math.PI / 180;
let landGeo: THREE.BufferGeometry | null = null;
function landingGeo(): THREE.BufferGeometry {
  if (landGeo) return landGeo;
  const band = (r0: number, r1: number) => {
    const g = new THREE.RingGeometry(r0, r1, 12, 1, -THROW_SPREAD, THROW_SPREAD * 2);
    g.rotateX(-Math.PI / 2);
    return g;
  };
  const p: Part[] = [part(band(THROW_NEAR, THROW_FAR), 0xffd040, 0, 0.06, 0)];
  // Dashes from the rim out to the band, and an arrowhead at its near edge.
  for (let x = 1.9; x < THROW_NEAR - 0.6; x += 0.9) p.push(part(box(0.5, 0.02, 0.1), 0xffd040, x + 0.25, 0.07, 0));
  for (const s of [1, -1]) p.push(part(box(0.6, 0.02, 0.12), 0xffd040, THROW_NEAR - 0.4, 0.07, s * 0.19, 0, s * Math.PI / 4, 0));
  landGeo = merge(p);
  return landGeo;
}

// trapFace turns a catapult's (or its ghost's) arm to facing.
export function trapFace(g: THREE.Group, facing: number): void {
  const turn = g.userData.turn as THREE.Object3D | undefined;
  if (turn) turn.rotation.y = turnFor(facing);
}

// trapGhost readies a trap's placement ghost: a catapult's arm and arrow on its turntable, with the
// landing band when band.
export function trapGhost(g: THREE.Group, head: THREE.Object3D | null, kind: number, mat: THREE.Material, band: boolean): void {
  if (kind === K_CATAPULT) catapultTurn(g, head, mat, false, band);
}

// The lamps round the rim, the first n of SEGMENTS lit: amber while it charges, green when
// ready.
const rings = new Map<number, THREE.BufferGeometry>();
function ringGeo(n: number): THREE.BufferGeometry {
  let g = rings.get(n);
  if (g) return g;
  const p: Part[] = [];
  for (let k = 0; k < SEGMENTS; k++) {
    const a = -Math.PI / 2 + k * Math.PI * 2 / SEGMENTS;
    const lit = k < n, col = n >= SEGMENTS ? 0x70ff80 : lit ? 0xffc040 : 0x2a2a22;
    p.push(part(box(0.26, 0.09, 0.16), col, Math.cos(a) * 1.4, 0.27, Math.sin(a) * 1.4, 0, -a, 0));
  }
  g = merge(p);
  rings.set(n, g);
  return g;
}
let ringMat: THREE.MeshBasicNodeMaterial | null = null;

// trapMake adds the charge ring to a trap's group, and a catapult's turntable.
export function trapMake(g: THREE.Group, head: THREE.Object3D | null, kind: number, mat: THREE.Material): void {
  if (kind === K_CATAPULT) catapultTurn(g, head, mat, true, false);
  if (!ringMat) { ringMat = new THREE.MeshBasicNodeMaterial(); ringMat.colorNode = vertexColor().rgb.mul(1.6); }
  const ring = new THREE.Mesh(ringGeo(0), ringMat);
  g.userData.ring = ring;
  g.userData.snap = 0;
  g.add(ring);
}

// trapUpdate moves a trap's parts for its state (the frame's sTrap): the ring to its charge,
// the bait pit's hooks churning while it holds, the catapult's arm flipping its bucket over
// the pivot the way it faces while it is sprung.
export function trapUpdate(g: THREE.Group, head: THREE.Object3D | null, kind: number, state: number, facing: number, t: number, dt: number): void {
  const busy = (state & 1) !== 0, charge = Math.min(SEGMENTS, state >> 1);
  const ring = g.userData.ring as THREE.Mesh | undefined;
  if (ring) ring.geometry = ringGeo(charge);
  if (!head) return;
  if (kind === K_BAIT) {
    const goal = busy ? 1 : 0;
    g.userData.snap += (goal - g.userData.snap) * Math.min(1, dt * 4);
    const s = g.userData.snap as number;
    head.rotation.y += dt * s * 3;
    head.position.y = 0.1 + s * Math.abs(Math.sin(t * 9)) * 0.04;
    head.rotation.x = s * Math.sin(t * 7) * 0.08;
    return;
  }
  trapFace(g, facing);
  // The arm snaps up hard, past upright, about its pivot, the bucket over to the front, and
  // settles back slowly.
  const goal = busy ? 1 : 0, rate = busy ? 30 : 3;
  g.userData.snap += (goal - g.userData.snap) * Math.min(1, dt * rate);
  head.rotation.z = -(g.userData.snap as number) * 1.75;
}
