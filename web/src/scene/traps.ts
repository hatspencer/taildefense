// The two traps, three by three and laid flat, so they read as ground a creep walks over:
// the bait pit and the catapult pit, both improvised from what lies about. Each has a string
// of lamps round its rim that fills as it recharges and burns green when it is ready, and a
// moving part: the bait pit's offal churns while it holds, the catapult's arm flips its bucket
// over its pivot when it throws, the way it was turned to face when it was placed, which an
// arrow sprayed on its deck shows.
import * as THREE from 'three/webgpu';
import { vertexColor } from 'three/tsl';
import { K_BAIT, K_CATAPULT } from '../protocol';
import { blend, darker, mute, PAL } from './palette';
import { box, merge, octa, part, type Part } from './util';

export const isTrapKind = (k: number): boolean => k === K_BAIT || k === K_CATAPULT;

const MEAT = blend(PAL.bloodFresh, PAL.blood, 0.35), GORE = PAL.blood, OFFAL = 0x8a4a3a, BONE = PAL.bone;
const SEGMENTS = 15; // as many as the charge has steps

// A round slab r across on top (r1 at its foot), h high, standing on y = 0: a cylinder with no
// bottom, as nothing sees under it.
function slab(r: number, r1: number, h: number, seg: number): THREE.BufferGeometry {
  const side = new THREE.CylinderGeometry(r, r1, h, seg, 1, true).translate(0, h / 2, 0);
  const top = new THREE.CircleGeometry(r, seg).rotateX(-Math.PI / 2).translate(0, h, 0);
  return merge([part(side, 0), part(top, 0)]);
}
// The same as a part of one colour.
const disc = (r: number, r1: number, h: number, seg: number, c: number, x = 0, y = 0, z = 0): Part => part(slab(r, r1, h, seg), c, x, y, z);

export function trapModel(kind: number): { body: Part[]; head?: Part[]; headY?: number } {
  if (kind === K_BAIT) {
    // A shallow pit dug in the ground, its spoil heaped round the rim and two sandbags on it,
    // the floor wet and dark. At the corners, outside where the knot stands, four rough posts
    // each hang a joint of meat over the pit on a chain.
    const body: Part[] = [
      disc(1.5, 1.55, 0.05, 10, PAL.dirt),
      disc(1.02, 1.06, 0.035, 10, PAL.mud, 0, 0.05, 0),
    ];
    for (let k = 0; k < 6; k++) {
      const a = k * Math.PI / 3 + 0.35, r = 1.2 + (k % 3) * 0.04, w = 0.9 + (k % 2) * 0.2;
      body.push(part(box(w, 0.13 + (k % 3) * 0.04, 0.34), k % 2 ? PAL.dirtDark : blend(PAL.dirt, PAL.groundDry, 0.4),
        Math.cos(a) * r, 0.1, Math.sin(a) * r, (k % 2 - 0.5) * 0.2, Math.PI / 2 - a, 0));
    }
    for (const [x, z, r] of [[0.2, 1.3, 0.1], [-0.25, 1.32, -0.15]]) body.push(part(box(0.5, 0.17, 0.3), PAL.canvas, x, 0.2, z, 0, r, 0));
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const st = 1.3, hang = 1.04, a = Math.atan2(sz, sx);
      body.push(part(box(0.13, 1.45, 0.13), PAL.wood, sx * st, 0.72, sz * st, sz * 0.04, 0, -sx * 0.04));
      body.push(part(box(0.44, 0.08, 0.08), PAL.woodDark, sx * (st + hang) / 2, 1.38, sz * (st + hang) / 2, 0, -a, 0));
      body.push(part(box(0.03, 0.42, 0.03), PAL.steelDark, sx * hang, 1.15, sz * hang));
      // The joint: a dark red haunch hung by its narrow end on the hook, swinging a little.
      body.push(part(new THREE.CylinderGeometry(0.07, 0.14, 0.42, 5), MEAT, sx * hang, 0.74, sz * hang, 0.1, -a + 0.4, 0.12));
    }
    // The head, flat on the pit floor: offal and bones, which churn while the pit holds.
    const head: Part[] = [];
    const bits: [number, number, number, number][] = [[0.3, 0.1, 0.5, 0.34], [-0.35, 0.25, -1.1, 0.28], [0.05, -0.4, 2.2, 0.3], [-0.25, -0.15, 0.4, 0.22], [0.5, -0.3, 1.6, 0.2]];
    bits.forEach(([x, z, r, w], k) => head.push(part(box(w, 0.07, w * 0.7), k % 3 === 2 ? OFFAL : k % 2 ? GORE : MEAT, x, 0.04, z, 0, r, 0)));
    for (const [x, z, r] of [[0.1, 0.4, 0.3], [-0.45, 0.05, 1.9], [0.05, -0.62, 0.9]]) head.push(part(box(0.36, 0.045, 0.05), BONE, x, 0.06, z, 0, r, 0));
    return { body, head, headY: 0.1 };
  }
  // A square pit lined with planks, edged with steel angle and pegged at the corners. On it,
  // turned the way it throws (catapultTurn): an arrow sprayed across it, the pivot frame
  // towards the front and the throwing arm lying back from it with a cut-down drum for a
  // bucket at its far end, which flips over the pivot to the front when it throws.
  const body: Part[] = [part(box(2.9, 0.08, 2.9), PAL.dirtDark, 0, 0.04, 0)];
  for (let k = 0; k < 5; k++) {
    const x = -1.04 + k * 0.52;
    body.push(part(box(0.5, 0.06, 2.6), [PAL.wood, darker(PAL.wood, 0.82), blend(PAL.wood, PAL.canvas, 0.3)][k % 3], x, 0.11 + (k % 2) * 0.008, 0));
  }
  for (const s of [1, -1]) {
    body.push(part(box(2.74, 0.07, 0.07), PAL.steel, 0, 0.15, s * 1.33), part(box(0.07, 0.07, 2.74), PAL.steel, s * 1.33, 0.15, 0));
  }
  for (const [x, z] of [[1.33, 1.33], [1.33, -1.33], [-1.33, 1.33], [-1.33, -1.33]]) body.push(part(box(0.1, 0.32, 0.1), mute(PAL.hardHat, 0.85, 0.1), x, 0.16, z));
  // The head is the arm, pivoted at the origin here: a banded timber beam lying back along -x
  // to the bucket, and a short stub forward with an engine block for its counterweight.
  const drum = new THREE.CylinderGeometry(DRUM, DRUM * 0.92, 0.32, 8, 1, true);
  const head: Part[] = [
    part(box(ARM_L + 0.1, 0.13, 0.22), PAL.wood, -ARM_L / 2, 0.02, 0),
    part(box(0.07, 0.17, 0.26), PAL.steelDark, -0.25, 0.02, 0), part(box(0.07, 0.17, 0.26), PAL.steelDark, -0.62, 0.02, 0),
    // The bucket: half a rusted drum, open, dark inside.
    part(drum, PAL.rust, -ARM_L - DRUM, 0.24, 0),
    part(new THREE.CircleGeometry(DRUM * 0.92, 8).rotateX(Math.PI / 2), darker(PAL.rust, 0.7), -ARM_L - DRUM, 0.08, 0),
    part(new THREE.CircleGeometry(DRUM - 0.01, 8).rotateX(-Math.PI / 2), PAL.inkWarm, -ARM_L - DRUM, 0.34, 0),
    // The counterweight, forward of the pivot.
    part(box(0.3, 0.08, 0.16), PAL.steel, 0.12, 0, 0),
    part(box(0.26, 0.22, 0.4), PAL.steelDark, 0.26, -0.01, 0),
  ];
  return { body, head, headY: ARM_Y };
}

// The catapult's arm: where its pivot stands on the deck (towards the way it throws), how high,
// the beam's length back to the bucket and the bucket's radius. Turned 45 degrees the bucket's
// far side stays inside the deck, and the lamps.
const PIVOT_X = 0.2, ARM_Y = 0.36, ARM_L = 0.85, DRUM = 0.3;

// The parts that turn with the catapult's facing and stay put when it throws: the pivot frame
// on its feet, the axle, and two truck coil springs under the beam.
let armGeo: THREE.BufferGeometry | null = null;
function catapultArm(): THREE.BufferGeometry {
  if (armGeo) return armGeo;
  const p: Part[] = [part(box(0.08, 0.08, 0.8), PAL.steelLit, PIVOT_X, ARM_Y, 0)];
  for (const z of [-0.36, 0.36]) {
    p.push(part(box(0.12, 0.28, 0.08), PAL.steel, PIVOT_X, 0.27, z));
    p.push(part(box(0.34, 0.05, 0.16), PAL.steelDark, PIVOT_X, 0.16, z));
  }
  for (const x of [-0.3, -0.62]) p.push(disc(0.1, 0.1, 0.17, 6, PAL.rust, PIVOT_X + x, 0.14, 0));
  armGeo = merge(p);
  return armGeo;
}

// The arrow sprayed across the deck, from behind the bucket to near the front edge, inside the
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
  arrowGeo = merge([part(g, mute(PAL.hardHat, 0.9, 0.05), 0, 0.15, 0)]);
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

// The lamps round the rim, little bulbs, the first n of SEGMENTS lit: amber while it charges,
// green when ready, dark glass when spent.
const rings = new Map<number, THREE.BufferGeometry>();
function ringGeo(n: number): THREE.BufferGeometry {
  let g = rings.get(n);
  if (g) return g;
  const p: Part[] = [];
  for (let k = 0; k < SEGMENTS; k++) {
    const a = -Math.PI / 2 + k * Math.PI * 2 / SEGMENTS;
    const lit = k < n, col = n >= SEGMENTS ? 0x70ff80 : lit ? 0xffc040 : 0x2a2a22;
    p.push(part(octa(0.1), col, Math.cos(a) * 1.4, 0.27, Math.sin(a) * 1.4, 0, -a, 0, 1.3, 0.75, 0.9));
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
// the bait pit's offal churning while it holds, the catapult's arm flipping its bucket over
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
