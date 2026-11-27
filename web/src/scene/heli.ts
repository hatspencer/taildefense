import * as THREE from 'three/webgpu';
import { mrt, output, vec4 } from 'three/tsl';
import { EffectKind, EvacStage, TRACER_HELI } from '../protocol';
import type { Game } from '../state';
import type { Effects } from './effects';
import { blend, darker, lighter, mute, PAL } from './palette';
import { ik2 } from './rig';
import { litMaterial } from './structs';
import { box, cyl, merge, part, type Part } from './util';

// Supply drops: the Huey gunship that flies the crate in on a sling, with the surfboards
// strapped to its skid (a nod to Kilgore in Apocalypse Now), the crate coming down under a
// chute, and the crates waiting on the ground with green smoke over them. And at the end of the
// last wave the same Huey coming in to the helipad to get the survivors out. Its door gunner (a
// nod to Tropic Thunder: red headband, aviators, crossed belts of brass) sits in the open
// doorway behind a minigun on an outrigger arm, turning it to what it fires at, its barrels
// spinning up whenever it fires and its tracers leaving from the muzzle.
//
// The Huey is a UH-1 at its true size beside a 1.8 m survivor: 12.8 m from the nose to the
// fin, a 14.6 m rotor whose hub stands 4 m up, on skids 2.6 m apart. It faces +x, its skids on
// y = 0, the mast at x = 0, the open cargo door on its right (+z).

// Olive drab, worn: faded where the sun has had it, grimy underneath, sooted behind the exhaust.
const OD = 0x474c2d, OD_FADE = lighter(OD, 0.1), OD_DARK = darker(OD, 0.72);
const GLASS = 0x2b3836, GLASS_SKY = 0x56665c, ROOF_GLASS = 0x3e5a44, FRAME = darker(OD, 0.6);
const INSIDE = 0x22241a, FLOOR = 0x3b3b2e, SEAT = mute(0x9a3020, 0.7, 0.1); // the troop seats' red nylon
const STEEL = PAL.steel, STEEL_DARK = PAL.steelDark, BLACK = PAL.ink, SOOT = 0x26231b, STENCIL = 0x9a9578;
const BLADE = 0x2a2a24, TIP = PAL.hardHat, TAIL_RED = PAL.medRed, TAIL_WHITE = PAL.medWhite;
// The door gunner: sun-browned arms, a sweat-dark olive vest, red headband, brass belts.
const SKIN = PAL.skin, VEST = 0x55582f, PANTS = 0x4c5032, BOOT = PAL.leatherDark, BRASS = 0xa8873a, BAND = 0xb3301f, HAIR = PAL.hairBrown;
const CRUISE = 10, HOVER = 6.5; // flying height in, and over the drop zone
const HOVER_TIME = 3; // the host's dropHover: seconds over the zone before the crate is down
const RELEASE = 1.6; // seconds before landing that the crate is let go under its chute
const DEPART = 7; // seconds the Huey takes to fly off after the crate is down
const LIFT = 1.1; // a flight's height is taken this far above the skids
const SLING = 3; // the crate hangs this far under the skids on its sling
const OUTRO = 3.5; // seconds the evac Huey flies on, climbing away, once the host has it gone
const ROTOR_Y = 3.95, ROTOR_R = 7.3; // the main rotor's hub height and radius
const TAIL_AT = new THREE.Vector3(-8.32, 3.12, 0.22), TAIL_R = 1.3; // the tail rotor's hub, on the fin's right

interface Flight {
  root: THREE.Group; body: THREE.Group; rotor: THREE.Object3D; tail: THREE.Object3D; crate: THREE.Group; chute: THREE.Object3D; sling: THREE.Object3D;
  gun: Gun;
  x0: number; y0: number; x: number; y: number;
  heading: number; seen: number; landedAt: number; // landedAt: seconds, 0 while still in flight
}

// The door gunner and his minigun: the gun turns on its pintle (yaw) and tips in its cradle
// (pitch); he turns to it and leans in from the hips, his arms (upper arm and forearm, bent at
// the elbow) on its grips. Where it points is eased toward its last mark, back to rest once it
// has been quiet a while.
interface Gun {
  yaw: THREE.Object3D; pitch: THREE.Object3D; barrels: THREE.Object3D; flash: THREE.Object3D; muzzle: THREE.Object3D;
  torso: THREE.Object3D; upper: THREE.Object3D[]; lower: THREE.Object3D[]; shoulders: THREE.Object3D[]; grips: THREE.Object3D[];
  spin: number; // how fast the barrels turn
  aimYaw: number; aimPitch: number; // where it points now, in the Huey's frame
  markX: number; markY: number; markAt: number; // its last mark on the map, and when (seconds)
}

const SILL = 0.74; // the cabin floor at the doorway
const HIPS = new THREE.Vector3(0.75, SILL + 0.07, 0.98); // where the gunner sits and turns from
const PIVOT = new THREE.Vector3(0.75, HIPS.y + 0.36, HIPS.z + 0.64); // the gun's pivot on its pintle
const UPPER = 0.29, FORE = 0.29; // his upper arm and forearm, shoulder to elbow to grip
const REST_YAW = 0.25, REST_PITCH = 0.45; // a little forward and down while it waits
const YAW_MAX = 1.05, PITCH_MIN = -0.15, PITCH_MAX = 1.3;
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), pole = new THREE.Vector3();

// A little hash of a point, 0..1, for the paint's wear.
const hash = (a: number, b: number, c: number): number => { const s = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453; return s - Math.floor(s); };

// A round tube r thick from (x0, y0, z0) to (x1, y1, z1).
function tube(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, c: number, seg = 6): Part {
  const d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0), len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  const e = new THREE.Euler().setFromQuaternion(q);
  return part(new THREE.CylinderGeometry(r, r, len, seg, 1, true), c, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, e.x, e.y, e.z);
}

// A hull lofted through cross-sections, nose first (x falling). Each section is the ring's
// shape (u across, v up, both -1..1) at its own middle height, half width and half height. A
// section with `door` takes the ring's points marked 1 that far in from its right side, so a
// run of them is a real opening with a floor, a lintel, jambs and the dark cabin behind it.
// Each face is painted by where it is and which way it faces; the faces come back one part a
// colour.
type Ring = [number, number, number?][];
interface Sec { x: number; y: number; w: number; h: number; door?: number }
type Paint = (x: number, y: number, z: number, n: THREE.Vector3, inside: boolean) => number;

function loft(secs: Sec[], ring: Ring, paint: Paint): Part[] {
  const pts = secs.map((s) => ring.map(([u, v, d]) => {
    const inside = !!(d && s.door);
    return { p: new THREE.Vector3(s.x, s.y + v * s.h, u * s.w - (inside ? s.door! : 0)), inside };
  }));
  const by = new Map<number, number[]>();
  const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, col: number) => {
    let arr = by.get(col);
    if (!arr) by.set(col, arr = []);
    arr.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  const area = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => e1.subVectors(b, a).cross(e2.subVectors(c, a)).length();
  const R = ring.length;
  for (let i = 0; i + 1 < secs.length; i++) {
    for (let j = 0; j < R; j++) {
      const A = pts[i][j], B = pts[i + 1][j], C = pts[i][(j + 1) % R], D = pts[i + 1][(j + 1) % R];
      const a = A.p, b = B.p, c = C.p, d = D.p;
      const t1 = area(a, c, b) > 1e-5, t2 = area(c, d, b) > 1e-5;
      if (!t1 && !t2) continue;
      // The face's normal (ring direction across section direction points out) and middle.
      n.copy(t1 ? e1.subVectors(c, a).cross(e2.subVectors(b, a)) : e1.subVectors(d, c).cross(e2.subVectors(b, c))).normalize();
      const mx = (a.x + b.x + c.x + d.x) / 4, my = (a.y + b.y + c.y + d.y) / 4, mz = (a.z + b.z + c.z + d.z) / 4;
      const col = paint(mx, my, mz, n, A.inside || B.inside || C.inside || D.inside);
      if (t1) tri(a, c, b, col);
      if (t2) tri(c, d, b, col);
    }
  }
  // The ends, closed with a fan.
  for (const [i, sign] of [[0, 1], [secs.length - 1, -1]] as const) {
    const ring0 = pts[i], m = new THREE.Vector3();
    for (const q of ring0) m.add(q.p);
    m.divideScalar(R);
    for (let j = 0; j < R; j++) {
      const a = ring0[j].p, b = ring0[(j + 1) % R].p;
      if (area(m, a, b) < 1e-6) continue;
      n.copy(e1).normalize();
      if (n.x * sign > 0) tri(m, a, b, paint(m.x, m.y, m.z, n, false));
      else { n.negate(); tri(m, b, a, paint(m.x, m.y, m.z, n, false)); }
    }
  }
  return [...by].map(([col, arr]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
    return part(g, col);
  });
}

// The hull's cross-section: a rounded box, flat sided, the belly flatter than the roof. The
// right side's points from the floor to the lintel are marked to go in at the open door, with
// twins at the floor and the lintel so the opening has square edges.
const HULL_RING: Ring = [
  [0, -1], [0.25, -1], [0.62, -0.99], [0.9, -0.93], [1, -0.75], [1, -0.75, 1], [1, 0, 1], [1, 0.72, 1], [1, 0.72],
  [0.96, 0.88], [0.72, 0.99], [0.25, 1.03], [0, 1.04],
  [-0.25, 1.03], [-0.72, 0.99], [-0.96, 0.88], [-1, 0.72], [-1, 0], [-1, -0.75], [-0.9, -0.93], [-0.62, -0.99], [-0.25, -1],
];
const ROUND_RING = (n: number, sq: number): Ring => Array.from({ length: n }, (_, k) => {
  const a = (k / n) * Math.PI * 2 - Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
  return [Math.sign(c) * Math.abs(c) ** sq, Math.sign(s) * Math.abs(s) ** sq];
});

// Worn olive drab for a face: the belly grimy, the top sun-faded in patches, a few panels a
// shade off where they were patched.
function worn(x: number, y: number, z: number, n: THREE.Vector3): number {
  const h = hash(Math.round(x * 2), Math.round(y * 3), Math.round(z * 2));
  let c = n.y < -0.5 ? OD_DARK : n.y > 0.6 ? blend(OD, OD_FADE, 0.5) : OD;
  if (h < 0.08) c = lighter(c, 0.05);
  else if (h > 0.93) c = darker(c, 0.9);
  return c;
}

// The fuselage: the round nose with its windscreen and chin windows, the cockpit doors, the
// cabin with its open door on the right and its shut one on the left, the aft fuselage tapering
// to the boom.
function fuselage(): Part[] {
  const DOOR = 0.86;
  const cab = (x: number, door?: number): Sec => ({ x, y: 1.36, w: 1.2, h: 0.82, door });
  const secs: Sec[] = [
    { x: 4.4, y: 1.12, w: 0.14, h: 0.1 },
    { x: 4.3, y: 1.14, w: 0.52, h: 0.4 },
    { x: 4.1, y: 1.2, w: 0.84, h: 0.62 },
    { x: 3.78, y: 1.27, w: 1.03, h: 0.75 },
    { x: 3.32, y: 1.33, w: 1.14, h: 0.81 },
    cab(2.8), cab(2.08), cab(1.97), cab(1.97, DOOR), cab(1.3, DOOR), cab(0.7, DOOR), cab(0.05, DOOR), cab(0.05),
    { x: -1.9, y: 1.4, w: 1.15, h: 0.79 },
    { x: -2.5, y: 1.6, w: 0.8, h: 0.6 },
    { x: -2.95, y: 1.84, w: 0.48, h: 0.42 },
  ];
  return loft(secs, HULL_RING, (x, y, z, n, inside) => {
    const az = Math.abs(z), side = Math.abs(n.z) > 0.6;
    if (inside) return n.y > 0.5 ? FLOOR : INSIDE;
    // The windscreen over the nose, its middle post, and the chin windows under it.
    if (x > 3.3 && y > 1.36) return az < 0.22 ? FRAME : n.y > 0.55 ? GLASS_SKY : GLASS;
    if (x > 3.3 && y < 1.05 && n.x > 0.15) return az < 0.2 ? OD : GLASS;
    if (x > 2.8 && x < 3.32 && y > 1.36 && n.y < 0.6) return GLASS;
    // The green-tinted roof windows over the pilots.
    if (x > 2.08 && x < 3.32 && n.y > 0.6) return az < 0.22 ? FRAME : ROOF_GLASS;
    // The cockpit doors' windows, and the post between them and the cargo doors.
    if (x > 2.08 && x < 2.8 && y > 1.36 && y < 1.96 && side) return GLASS;
    if (x > 1.97 && x < 2.08 && side) return FRAME;
    // The left cargo door's window.
    if (z < 0 && x > 0.7 && x < 1.3 && y > 1.36 && y < 1.96 && side) return GLASS;
    // Exhaust soot down the aft fuselage's top.
    if (x < -1.9 && n.y > 0.3) return SOOT;
    return worn(x, y, z, n);
  });
}

// A shut sliding door seen from outside: the right cargo door slid back along its rails over
// the aft cabin, standing proud of it, with its window.
function slidDoor(): Part[] {
  const z = 1.23, x = -0.92;
  return [
    part(box(1.85, 1.16, 0.05), OD, x, 1.35, z),
    part(box(0.62, 0.5, 0.02), GLASS, x - 0.1, 1.62, z + 0.03),
    part(box(1.9, 0.05, 0.08), STEEL_DARK, x, 1.98, z + 0.01), // the rail
    part(box(0.12, 0.05, 0.03), STEEL, x + 0.75, 1.3, z + 0.035), // the handle
  ];
}

// The doghouse over the cabin: transmission and engine cowling, its intake grilles, and the
// exhaust stack at the back. And the pitot tube on the roof's front.
function cowling(): Part[] {
  const secs: Sec[] = [
    { x: 1.75, y: 2.22, w: 0.3, h: 0.06 },
    { x: 1.4, y: 2.42, w: 0.6, h: 0.27 },
    { x: 0.2, y: 2.47, w: 0.66, h: 0.32 },
    { x: -1.6, y: 2.45, w: 0.62, h: 0.3 },
    { x: -2.55, y: 2.38, w: 0.46, h: 0.24 },
  ];
  const p = loft(secs, ROUND_RING(10, 0.5), (x, y, z, n) => {
    if (x < 1.3 && x > -0.2 && Math.abs(n.z) > 0.7 && y > 2.3 && y < 2.6) return INSIDE; // the intake grilles
    if (x < -1.6 && n.y > 0.2) return SOOT;
    return worn(x, y, z, n);
  });
  p.push(part(cyl(0.2, 0.24, 0.42, 6), SOOT, -2.75, 2.42, 0, 0, 0, 1.25)); // the exhaust stack
  p.push(part(cyl(0.16, 0.16, 0.05, 6), BLACK, -2.95, 2.48, 0, 0, 0, 1.25));
  p.push(tube(3.0, 2.12, 0, 3.75, 2.1, 0, 0.025, STEEL)); // the pitot tube
  return p;
}

// Tail boom, synchronized elevator, the fin with its gearboxes, the tail skid; and the boom's
// U.S. ARMY in faded stencil, the number on the fin, the red and white bands on the tail.
function tailParts(): Part[] {
  const p = loft([
    { x: -2.95, y: 1.86, w: 0.46, h: 0.4 },
    { x: -5.2, y: 1.98, w: 0.3, h: 0.27 },
    { x: -8.0, y: 2.1, w: 0.2, h: 0.19 },
  ], ROUND_RING(8, 0.6), worn);
  // The fin: swept back and up from the boom's end, a gearbox at its root and at its top.
  const fin = new THREE.Shape();
  fin.moveTo(-7.55, 2.0); fin.lineTo(-8.38, 1.95); fin.lineTo(-8.78, 3.6); fin.lineTo(-8.32, 3.62); fin.closePath();
  p.push(part(new THREE.ExtrudeGeometry(fin, { depth: 0.14, bevelEnabled: false }), OD, 0, 0, -0.07));
  p.push(part(box(0.55, 0.3, 0.34), OD_DARK, -8.0, 2.12, 0));
  p.push(part(box(0.32, 0.28, 0.22), OD_DARK, -8.4, 3.12, 0.1));
  p.push(part(box(0.2, 0.06, 0.15), TAIL_RED, -8.6, 3.66, 0)); // the fin's tip light
  // The synchronized elevator across the boom.
  p.push(part(box(0.52, 0.05, 2.9), OD, -5.0, 1.98, 0));
  for (const z of [1.45, -1.45]) p.push(part(box(0.54, 0.08, 0.06), OD_DARK, -5.0, 1.98, z));
  // The tail skid, a bent tube under the fin.
  p.push(tube(-7.8, 1.9, 0, -8.35, 1.35, 0, 0.03, STEEL), tube(-8.35, 1.35, 0, -8.5, 1.4, 0, 0.03, STEEL));
  // The stencils: U.S. ARMY down both sides of the boom, in blocks of the letters' size, and
  // the tail number on the fin.
  const boom = (x: number) => (x + 2.95) / -2.25; // 0 at the boom's root, 1 at x -5.2
  for (const s of [1, -1]) {
    let x = -3.3;
    for (const w of [0.13, 0.05, 0.13, 0.05, 0, 0.15, 0.13, 0.13, 0.16, 0.13]) {
      const k = boom(x - w / 2);
      if (w) p.push(part(box(w, 0.2, 0.01), STENCIL, x - w / 2, 1.86 + 0.12 * k * 0.4, s * (0.465 - 0.16 * k)));
      x -= (w || 0.1) + 0.04;
    }
    for (let k = 0; k < 5; k++) p.push(part(box(0.08, 0.15, 0.01), STENCIL, -8.25 - k * 0.11, 2.6, s * 0.075));
  }
  return p;
}

// The skids: two tubes 2.6 m apart turned up at the front, each with its step, on two arched
// cross tubes up to the belly.
function skids(): Part[] {
  const p: Part[] = [];
  for (const s of [1, -1]) {
    const z = s * 1.3;
    p.push(tube(-1.75, 0.06, z, 2.3, 0.06, z, 0.055, STEEL));
    p.push(tube(2.3, 0.06, z, 2.7, 0.3, z, 0.055, STEEL));
    p.push(part(box(0.4, 0.04, 0.22), STEEL_DARK, 1.0, 0.24, s * 1.18)); // the step
    for (const x of [1.55, -0.85]) {
      p.push(tube(x, 0.06, z, x, 0.42, s * 1.16, 0.055, STEEL));
      p.push(tube(x, 0.42, s * 1.16, x, 0.56, s * 0.75, 0.055, STEEL));
    }
  }
  for (const x of [1.55, -0.85]) p.push(tube(x, 0.56, 0.75, x, 0.56, -0.75, 0.055, STEEL));
  return p;
}

// A surfboard on its edge along x: a longboard's outline, round-nosed with a square tail,
// and a stripe down it.
function board(color: number, stripe: number, x: number, y: number, z: number): Part[] {
  const L = 2.8, W = 0.28, sh = new THREE.Shape();
  sh.moveTo(-L / 2, -W * 0.7); sh.lineTo(L * 0.2, -W);
  sh.quadraticCurveTo(L / 2, -W, L / 2, 0); sh.quadraticCurveTo(L / 2, W, L * 0.2, W);
  sh.lineTo(-L / 2, W * 0.7); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.07, bevelEnabled: false, curveSegments: 3 });
  return [part(g, color, x, y, z - 0.035), part(box(L * 0.8, 0.05, 0.075), stripe, x - 0.1, y, z)];
}

// The cabin behind the door: the troop seat along the back wall in its red nylon, the gunner's
// seat at the door's edge, his legs out over the skid; the minigun's outrigger arm from the
// door's back post to its pintle; the surfboards strapped along the left skid.
function crewParts(): Part[] {
  const p: Part[] = [];
  const add = (w: number, h: number, d: number, c: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => p.push(part(box(w, h, d), c, x, y, z, rx, ry, rz));
  add(1.7, 0.08, 0.36, SEAT, 1.0, SILL + 0.32, 0.56);
  add(1.7, 0.52, 0.04, SEAT, 1.0, SILL + 0.66, 0.38);
  for (const x of [0.2, 1.0, 1.8]) add(0.04, 0.4, 0.04, STEEL, x, SILL + 0.14, 0.7);
  add(0.42, 0.06, 0.4, BLACK, HIPS.x, SILL + 0.03, HIPS.z - 0.04);
  for (const dx of [-0.1, 0.1]) {
    const x = HIPS.x + dx;
    add(0.15, 0.15, 0.46, PANTS, x, HIPS.y + 0.02, HIPS.z + 0.22);
    add(0.13, 0.46, 0.14, PANTS, x, HIPS.y - 0.2, HIPS.z + 0.46, -0.18);
    add(0.13, 0.11, 0.28, BOOT, x, HIPS.y - 0.47, HIPS.z + 0.56);
  }
  const post = PIVOT.y - 0.5;
  p.push(tube(PIVOT.x, PIVOT.y - 0.12, PIVOT.z, PIVOT.x, post, PIVOT.z, 0.04, STEEL_DARK));
  p.push(tube(0.08, SILL + 0.1, 1.17, PIVOT.x, post, PIVOT.z, 0.035, STEEL));
  p.push(tube(0.08, 1.75, 1.17, PIVOT.x, PIVOT.y - 0.2, PIVOT.z, 0.03, STEEL));
  // Two surfboards strapped outside the left skid's cross tubes, Kilgore style.
  p.push(...board(0xb8ad8a, PAL.medRed, 0.3, 0.62, -1.42));
  p.push(...board(mute(0xe0b040, 0.7, 0.1), PAL.teal, 0.45, 0.68, -1.52));
  for (const x of [1.55, -0.85]) add(0.06, 0.66, 0.24, PAL.webbing, x + 0.1, 0.64, -1.44);
  return p;
}

function hueyBody(): THREE.BufferGeometry {
  return merge([...fuselage(), ...slidDoor(), ...cowling(), ...tailParts(), ...skids(), ...crewParts(),
    part(cyl(0.13, 0.16, ROTOR_Y - 2.7, 8), STEEL_DARK, 0, (ROTOR_Y + 2.7) / 2, 0)]); // the mast
}

// The main rotor's hub: the yoke and the blade grips, the first metre of each blade (what the
// eye catches of them spinning), and the stabilizer bar across them with its weights.
function hubGeo(): THREE.BufferGeometry {
  const p: Part[] = [part(box(0.7, 0.16, 0.32), STEEL_DARK, 0, 0, 0), part(cyl(0.14, 0.14, 0.25, 8), STEEL, 0, 0.12, 0)];
  for (const s of [1, -1]) {
    p.push(part(box(1.1, 0.06, 0.53), BLADE, s * 0.9, 0.02, 0));
    p.push(tube(0, 0.18, 0, 0, 0.18, s * 1.25, 0.025, STEEL, 5));
    p.push(part(cyl(0.07, 0.07, 0.34, 6), STEEL_DARK, 0, 0.18, s * 1.32, Math.PI / 2, 0, 0));
  }
  return merge(p);
}

// The tail rotor: two blades with their red and white tips, on its hub; it turns about z.
function tailRotorGeo(): THREE.BufferGeometry {
  const p: Part[] = [part(cyl(0.09, 0.09, 0.14, 6), STEEL, 0, 0, 0, Math.PI / 2, 0, 0)];
  for (const s of [1, -1]) {
    p.push(part(box(0.2, TAIL_R - 0.42, 0.04), BLADE, 0, s * (TAIL_R - 0.42) / 2 + s * 0.05, 0));
    p.push(part(box(0.2, 0.18, 0.04), TAIL_WHITE, 0, s * (TAIL_R - 0.28), 0));
    p.push(part(box(0.2, 0.16, 0.04), TAIL_RED, 0, s * (TAIL_R - 0.09), 0));
  }
  return merge(p);
}

// The main rotor turning, drawn as the eye sees one: at this size a blade moves several metres
// between frames, so drawn solid it would stutter round as two black bars across whatever is
// under it. Instead a faint disc, the yellow tips' ring, and each blade as a smear that is
// darkest at its leading edge and fades over the half turn behind it, a few steps of it as
// the picture would paint it.
function smearGeo(): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  for (const base of [0, Math.PI]) for (const len of [0.7, 0.36, 0.14]) {
    geos.push(new THREE.RingGeometry(1.2, ROTOR_R, 6, 1, base - len, len));
  }
  return mergeFlat(geos);
}
function mergeFlat(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return merge(geos.map((g) => part(g.rotateX(-Math.PI / 2), 0xffffff)));
}

// The crate on its pallet: plank sides painted olive, battens at the corners, two cargo straps
// round it and the stencilled panel; slung under the Huey and dropped under a chute.
function crateGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  const add = (w: number, h: number, d: number, c: number, x: number, y: number, z = 0) => p.push(part(box(w, h, d), c, x, y, z));
  const WOOD = mute(0x6a6a3a, 0.8, 0.1);
  add(1.1, 0.07, 1.0, PAL.woodDark, 0, 0.11);
  for (const z of [-0.4, 0, 0.4]) add(1.1, 0.08, 0.1, PAL.wood, 0, 0.04, z);
  add(0.94, 0.62, 0.84, WOOD, 0, 0.46);
  for (const y of [0.3, 0.5]) add(0.96, 0.025, 0.86, darker(WOOD, 0.6), 0, y);
  for (const x of [-0.45, 0.45]) for (const z of [-0.4, 0.4]) add(0.08, 0.64, 0.08, darker(WOOD, 0.75), x, 0.46, z);
  add(0.98, 0.06, 0.88, darker(WOOD, 0.8), 0, 0.79);
  add(0.36, 0.18, 0.02, STENCIL, 0.1, 0.55, 0.43);
  add(1.0, 0.04, 0.1, PAL.canvas, 0, 0.83, 0.18); add(0.1, 0.04, 0.9, PAL.canvas, -0.2, 0.84, 0);
  for (const x of [-0.49, 0.49]) add(0.03, 0.62, 0.1, PAL.canvas, x, 0.5, 0.18);
  return merge(p);
}

// The chute: a canopy of olive and off-white gores, and the rigging lines down to the crate.
function canopyGeo(): THREE.BufferGeometry {
  const n = 10, rings: [number, number][] = [[0.15, 3.65], [0.8, 3.52], [1.35, 3.2], [1.6, 2.8]];
  const p: Part[] = [];
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2, pos: number[] = [];
    for (let r = 0; r + 1 < rings.length; r++) {
      const [r0, y0] = rings[r], [r1, y1] = rings[r + 1];
      const v = (rr: number, y: number, a: number) => [Math.cos(a) * rr, y, Math.sin(a) * rr];
      pos.push(...v(r0, y0, a0), ...v(r0, y0, a1), ...v(r1, y1, a0), ...v(r0, y0, a1), ...v(r1, y1, a1), ...v(r1, y1, a0));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    p.push(part(g, k % 2 ? 0xa8a28a : 0x5a6238));
  }
  return merge(p);
}
function linesGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    p.push(tube(Math.cos(a) * 1.55, 2.8, Math.sin(a) * 1.55, Math.cos(a) * 0.25, 0.86, Math.sin(a) * 0.25, 0.012, 0x2a2a22, 3));
  }
  return merge(p);
}

// The helipad: square concrete slabs, each a shade of its own and some with an oil stain, a
// pale edge line, the yellow ring and the white H, both worn through in places.
function padGeo(half: number): THREE.BufferGeometry {
  const p: Part[] = [part(box(2 * half + 0.1, 0.05, 2 * half + 0.1), 0x4f4c42, 0, 0.025, 0)];
  const n = Math.max(2, Math.round(half)), cell = (2 * half) / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = -half + (i + 0.5) * cell, z = -half + (j + 0.5) * cell, h = hash(i, j, 3);
    p.push(part(box(cell - 0.05, 0.04, cell - 0.05), blend(PAL.concrete, h < 0.5 ? 0x8a8676 : 0x6a675c, h * 0.6), x, 0.07, z));
    if (h > 0.6) p.push(part(box(cell * 0.3, 0.01, cell * 0.22), 0x4a463c, x + (h - 0.8) * cell, 0.09, z - (h - 0.7) * cell, 0, h * 3, 0));
  }
  const PAINT = 0xb8b29a, RING = mute(PAL.hardHat, 0.8, 0.12);
  for (const s of [1, -1]) {
    p.push(part(box(2 * half - 0.3, 0.012, 0.12), PAINT, 0, 0.095, s * (half - 0.2)));
    p.push(part(box(0.12, 0.012, 2 * half - 0.3), PAINT, s * (half - 0.2), 0.095, 0));
  }
  const r = half * 0.72, segs = 28;
  for (let i = 0; i < segs; i++) {
    if (hash(i, 7, 1) < 0.12) continue; // worn through
    const a = (i / segs) * Math.PI * 2;
    p.push(part(box(0.22, 0.012, 2 * Math.PI * r / segs + 0.02), RING, Math.cos(a) * r, 0.096, Math.sin(a) * r, 0, -a, 0));
  }
  const s = half / 2;
  p.push(part(box(0.24 * s, 0.012, 1.5 * s), PAINT, -0.5 * s, 0.097, 0), part(box(0.24 * s, 0.012, 1.5 * s), PAINT, 0.5 * s, 0.097, 0),
    part(box(1 * s, 0.012, 0.22 * s), PAINT, 0, 0.097, 0));
  return merge(p);
}

// The minigun's six barrels round its axis, along +z, with the clamps along them; spun as one.
function barrelsGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    p.push(part(cyl(0.02, 0.02, 0.62, 4), BLACK, Math.cos(a) * 0.05, Math.sin(a) * 0.05, 0.31, Math.PI / 2, 0, 0));
  }
  for (const z of [0.04, 0.4, 0.6]) p.push(part(cyl(0.085, 0.085, 0.05, 6), STEEL_DARK, 0, 0, z, Math.PI / 2, 0, 0));
  return merge(p);
}

// The rest of the minigun, about its pivot on the cradle with the barrels along +z: the
// receiver and its drive motor, the spade grips behind it with the trigger bar between, and an
// ammo can slung on the left with its brass belt running up into the feed.
function gunGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  const add = (w: number, h: number, d: number, c: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => p.push(part(box(w, h, d), c, x, y, z, rx, ry, rz));
  p.push(part(cyl(0.1, 0.1, 0.36, 8), 0x2e2f2a, 0, 0, -0.02, Math.PI / 2, 0, 0));
  p.push(part(cyl(0.05, 0.05, 0.22, 6), STEEL, 0.09, 0.09, -0.05, Math.PI / 2, 0, 0));
  add(0.3, 0.05, 0.05, STEEL, 0, 0, -0.26);
  for (const x of [-0.13, 0.13]) { add(0.05, 0.05, 0.12, STEEL, x, 0, -0.3); add(0.05, 0.16, 0.05, BLACK, x, -0.02, -0.36); }
  add(0.16, 0.03, 0.03, PAL.medRed, 0, 0.03, -0.34);
  // The ammo can and the belt up from it.
  add(0.16, 0.26, 0.34, OD_DARK, -0.24, -0.2, -0.06);
  add(0.17, 0.04, 0.35, BLACK, -0.24, -0.06, -0.06);
  for (let i = 0; i < 4; i++) add(0.09, 0.03, 0.2, BRASS, -0.21 + i * 0.05, -0.05 + i * 0.045, -0.04, 0, 0, 0.75);
  return merge(p);
}

// The door gunner from the hips up, facing +z: a sleeveless olive vest with two belts of brass
// crossed over it and his dog tags, a cigar in his teeth, aviators, and a red headband knotted
// behind with its tails out in the wash. His arms are their own meshes (upperArmGeo,
// foreArmGeo), reaching for the gun's grips wherever it points.
function gunnerGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  const add = (w: number, h: number, d: number, c: number, x: number, y: number, z = 0, rx = 0, ry = 0, rz = 0) => p.push(part(box(w, h, d), c, x, y, z, rx, ry, rz));
  add(0.36, 0.14, 0.24, PANTS, 0, 0.04);
  add(0.37, 0.05, 0.25, PAL.leather, 0, 0.12);
  add(0.33, 0.18, 0.21, VEST, 0, 0.23);
  add(0.4, 0.22, 0.25, VEST, 0, 0.4);
  add(0.42, 0.07, 0.2, SKIN, 0, 0.51); // the bare shoulders
  add(0.06, 0.56, 0.03, BRASS, 0, 0.33, 0.135, 0, 0, 0.6); add(0.06, 0.56, 0.03, BRASS, 0, 0.33, 0.14, 0, 0, -0.6);
  add(0.012, 0.14, 0.012, PAL.steelLit, 0.03, 0.44, 0.14, 0, 0, 0.3); add(0.035, 0.05, 0.012, PAL.steelLit, 0.0, 0.37, 0.15);
  add(0.1, 0.08, 0.1, SKIN, 0, 0.57);
  // The head: face, crew-cut hair, the headband and its knot and tails.
  add(0.19, 0.23, 0.21, SKIN, 0, 0.71);
  add(0.2, 0.05, 0.22, HAIR, 0, 0.84, -0.01);
  add(0.205, 0.045, 0.225, BAND, 0, 0.79);
  add(0.06, 0.06, 0.05, BAND, 0, 0.78, -0.125);
  add(0.05, 0.03, 0.18, BAND, 0.03, 0.74, -0.2, 0.5, 0.2, 0); add(0.05, 0.03, 0.15, BAND, -0.03, 0.72, -0.18, 0.7, -0.25, 0);
  // Aviators, the stubble and a cigar with its ember.
  add(0.2, 0.02, 0.02, 0xa88a3a, 0, 0.745, 0.108);
  add(0.075, 0.05, 0.02, BLACK, -0.048, 0.725, 0.112); add(0.075, 0.05, 0.02, BLACK, 0.048, 0.725, 0.112);
  add(0.17, 0.06, 0.02, PAL.skinDark, 0, 0.625, 0.1);
  add(0.022, 0.022, 0.12, PAL.leather, 0.04, 0.64, 0.16, 0, 0.35, 0); add(0.028, 0.028, 0.02, 0xd8582a, 0.062, 0.64, 0.22);
  return merge(p);
}

// The arm's two bones, hanging down -y from their pivots as ik2 has them: the bare upper arm
// with the vest's edge at the shoulder; the forearm and the gloved hand.
function upperArmGeo(): THREE.BufferGeometry {
  return merge([part(box(0.1, UPPER, 0.1), SKIN, 0, -UPPER / 2, 0), part(box(0.12, 0.07, 0.12), VEST, 0, -0.02, 0)]);
}
function foreArmGeo(): THREE.BufferGeometry {
  return merge([part(box(0.09, FORE - 0.04, 0.09), SKIN, 0, -(FORE - 0.04) / 2, 0), part(box(0.1, 0.1, 0.11), PAL.leatherDark, 0, -FORE + 0.02, 0)]);
}

// A muzzle flash, a cross of two flat stars along +z, drawn additive.
function flashGeo(): THREE.BufferGeometry {
  const plane = () => new THREE.PlaneGeometry(0.3, 0.5);
  return merge([part(plane(), 0xffffff, 0, 0, 0.25, Math.PI / 2, 0, 0), part(plane(), 0xffffff, 0, 0, 0.25, Math.PI / 2, 0, Math.PI / 2),
    part(new THREE.CircleGeometry(0.15, 6), 0xffffff, 0, 0, 0.02)]);
}

// A see-through material for the rotor's blur: no line drawn round it, no shadow.
function blurMaterial(color: number, opacity: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
  m.mrtNode = mrt({ output, normal: vec4(0, 0, 0, 0) }); // the blur is no crease
  return m;
}

export class Helis {
  group = new THREE.Group();
  private mat = litMaterial();
  private bodyGeo = hueyBody();
  private hubG = hubGeo();
  private tailG = tailRotorGeo();
  private crateG = crateGeo();
  private canopyG = canopyGeo();
  private linesG = linesGeo();
  private slingG = merge([tube(0, 0, 0, 0, 1, 0, 0.02, 0x2a2a22, 4)]);
  private barrelsG = barrelsGeo();
  private gunG = gunGeo();
  private gunnerG = gunnerGeo();
  private upperG = upperArmGeo();
  private foreG = foreArmGeo();
  private flashG = flashGeo();
  private flashMat = new THREE.MeshBasicNodeMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  private discMat = blurMaterial(0x1a1a16, 0.07);
  private smearMat = blurMaterial(0x1a1a16, 0.15);
  private tipMat = blurMaterial(TIP, 0.09);
  private discGeo = new THREE.CircleGeometry(ROTOR_R, 24).rotateX(-Math.PI / 2);
  private tipGeo = new THREE.RingGeometry(ROTOR_R - 0.22, ROTOR_R, 32).rotateX(-Math.PI / 2);
  private smearG = smearGeo();
  private tailDiscGeo = new THREE.CircleGeometry(TAIL_R, 12);
  private flights = new Map<string, Flight>();
  private grounded: THREE.Group[] = [];
  private serial = 0;
  private lastPuff = 0;
  // The evac Huey, made when it first shows; its pose in the frame before and the current one,
  // to ease between them; and the helipad, made for the pad it is on.
  private evac: Flight | null = null;
  private evacFrame = 0;
  private ev0 = { x: 0, y: 0, alt: 0, yaw: 0 }; private ev1 = { x: 0, y: 0, alt: 0, yaw: 0 };
  private pad: THREE.Mesh | null = null;
  private padAt = '';
  // The evac Huey's speed and turn rate between the last two frames, carried on into the outro;
  // when the outro began (0 before), and whether it has played out.
  private evacSpeed = 0; private evacTurn = 0; private outroAt = 0; private outroDone = false;

  constructor(scene: THREE.Scene, private fx: Effects) {
    scene.add(this.group);
    fx.heliMuzzle = (x, y, out) => this.muzzle(x, y, out);
  }

  private make(x0: number, y0: number, x: number, y: number): Flight {
    const root = new THREE.Group(), body = new THREE.Group();
    root.add(body);
    const hull = new THREE.Mesh(this.bodyGeo, this.mat);
    hull.castShadow = true;
    body.add(hull);
    // The rotor: the hub and blade roots, solid and throwing their shadow; the disc, its tips'
    // ring and the blades' smears see-through over them.
    const rotor = new THREE.Group();
    rotor.position.set(0, ROTOR_Y, 0);
    const hub = new THREE.Mesh(this.hubG, this.mat);
    hub.castShadow = true;
    const smear = new THREE.Mesh(this.smearG, this.smearMat);
    rotor.add(hub, smear);
    const disc = new THREE.Group();
    disc.position.set(0, ROTOR_Y + 0.02, 0);
    disc.add(new THREE.Mesh(this.discGeo, this.discMat), new THREE.Mesh(this.tipGeo, this.tipMat));
    body.add(rotor, disc);
    const tail = new THREE.Mesh(this.tailG, this.mat);
    tail.position.copy(TAIL_AT);
    const tailDisc = new THREE.Mesh(this.tailDiscGeo, this.discMat);
    tailDisc.position.copy(TAIL_AT).setZ(TAIL_AT.z + 0.01);
    body.add(tail, tailDisc);
    const gun = this.makeGun(body);
    const crate = new THREE.Group();
    const cm = new THREE.Mesh(this.crateG, this.mat);
    cm.castShadow = true;
    const chute = new THREE.Group();
    chute.add(new THREE.Mesh(this.canopyG, this.mat), new THREE.Mesh(this.linesG, this.mat));
    chute.visible = false;
    // The sling from the crate's straps up to the Huey's belly hook.
    const sling = new THREE.Mesh(this.slingG, this.mat);
    sling.position.y = 0.86;
    sling.scale.y = SLING + 0.56 - 0.86;
    crate.add(cm, chute, sling);
    this.group.add(root, crate);
    return { root, body, rotor, tail, crate, chute, sling, gun, x0, y0, x, y, heading: -Math.atan2(y - y0, x - x0), seen: 0, landedAt: 0 };
  }

  private makeGun(body: THREE.Object3D): Gun {
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material = this.mat) => { const o = new THREE.Mesh(g, m); o.castShadow = m === this.mat; return o; };
    const yaw = new THREE.Group(), pitch = new THREE.Group();
    yaw.position.copy(PIVOT);
    // The yoke the cradle swings in, on top of the post.
    const yoke = mesh(merge([part(box(0.32, 0.05, 0.1), STEEL, 0, -0.1, 0), part(box(0.04, 0.16, 0.08), STEEL, -0.15, -0.03, 0), part(box(0.04, 0.16, 0.08), STEEL, 0.15, -0.03, 0)]));
    yaw.add(yoke, pitch);
    const barrels = mesh(this.barrelsG);
    barrels.position.set(0, 0, 0.16);
    const flash = mesh(this.flashG, this.flashMat);
    flash.position.set(0, 0, 0.78); flash.visible = false;
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0, 0.8);
    const grips = [-0.13, 0.13].map((x) => { const o = new THREE.Object3D(); o.position.set(x, -0.04, -0.37); return o; });
    pitch.add(mesh(this.gunG), barrels, flash, muzzle, ...grips);
    const torso = mesh(this.gunnerG);
    torso.position.copy(HIPS);
    const shoulders = [-0.2, 0.2].map((x) => { const o = new THREE.Object3D(); o.position.set(x, 0.5, 0.02); torso.add(o); return o; });
    const upper = [0, 1].map(() => mesh(this.upperG));
    const lower = upper.map((u) => { const l = mesh(this.foreG); l.position.y = -UPPER; u.add(l); return l; });
    body.add(yaw, torso, ...upper);
    return { yaw, pitch, barrels, flash, muzzle, torso, upper, lower, shoulders, grips, spin: 0, aimYaw: REST_YAW, aimPitch: REST_PITCH, markX: 0, markY: 0, markAt: -9 };
  }

  // Where the door gunner's rounds leave from: the muzzle of the Huey nearest x, y on the map,
  // in the world; null if no Huey is near. The effects start the gunner's tracers here.
  muzzle(x: number, y: number, out: THREE.Vector3): THREE.Vector3 | null {
    let best: Flight | null = null, bd = 25;
    for (const fl of this.all()) {
      const d = (fl.root.position.x - x) ** 2 + (fl.root.position.z - y) ** 2;
      if (d < bd) { bd = d; best = fl; }
    }
    if (!best) return null;
    best.root.updateMatrixWorld(true);
    return best.gun.muzzle.getWorldPosition(out);
  }

  private all(): Flight[] { return this.evac ? [...this.flights.values(), this.evac] : [...this.flights.values()]; }

  // Points each gun at its latest mark, spins its barrels, flashes its muzzle while it fires,
  // and turns the gunner with it.
  private aim(f: Game['cur'], t: number, dt: number): void {
    const fls = this.all();
    for (let i = 0; i < f.nTracers; i++) {
      if (f.tKind[i] !== TRACER_HELI) continue;
      let best: Flight | null = null, bd = 25;
      for (const fl of fls) {
        const d = (fl.root.position.x - f.tX0[i]) ** 2 + (fl.root.position.z - f.tY0[i]) ** 2;
        if (d < bd) { bd = d; best = fl; }
      }
      if (best) { best.gun.markX = f.tX1[i]; best.gun.markY = f.tY1[i]; best.gun.markAt = t; }
    }
    for (const fl of fls) {
      const g = fl.gun, firing = t - g.markAt < 0.35;
      let ty = REST_YAW, tp = REST_PITCH;
      if (t - g.markAt < 1.8) {
        // The mark, a little off the ground, in the Huey's own frame from the pivot.
        fl.root.updateMatrixWorld(true);
        tmpA.set(g.markX, 0.5, g.markY);
        fl.body.worldToLocal(tmpA).sub(PIVOT);
        ty = Math.max(-YAW_MAX, Math.min(YAW_MAX, Math.atan2(tmpA.x, tmpA.z)));
        tp = Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.atan2(-tmpA.y, Math.hypot(tmpA.x, tmpA.z))));
      }
      const k = Math.min(1, dt * (firing ? 12 : 3));
      g.aimYaw += (ty - g.aimYaw) * k; g.aimPitch += (tp - g.aimPitch) * k;
      // A shudder while it fires.
      const shake = firing ? (Math.random() - 0.5) * 0.025 : 0;
      g.yaw.rotation.y = g.aimYaw + shake;
      g.pitch.rotation.x = g.aimPitch + shake;
      g.spin += ((firing ? 45 : 0) - g.spin) * Math.min(1, dt * (firing ? 8 : 1.5));
      g.barrels.rotation.z += g.spin * dt;
      g.flash.visible = firing && Math.random() < 0.7;
      if (g.flash.visible) { g.flash.rotation.z = Math.random() * Math.PI; g.flash.scale.setScalar(0.7 + Math.random() * 0.6); }
      // He turns from the hips to face the grips, leaning in as far as it takes to keep them
      // in reach, shaking with the gun; his arms bend to them, elbows out and down.
      fl.body.updateMatrixWorld(true);
      fl.body.worldToLocal(g.grips[0].getWorldPosition(tmpA));
      fl.body.worldToLocal(g.grips[1].getWorldPosition(tmpB));
      tmpA.add(tmpB).multiplyScalar(0.5);
      const tx = tmpA.x - HIPS.x, tz = tmpA.z - HIPS.z;
      const ry = Math.atan2(tx, tz), lean = Math.asin(Math.max(0, Math.min(0.75, (Math.hypot(tx, tz) - 0.3) / 0.6)));
      g.torso.rotation.set(Math.max(0.08, lean) + shake, ry, 0, 'YXZ');
      g.torso.position.set(HIPS.x, HIPS.y, HIPS.z + (firing ? (Math.random() - 0.5) * 0.02 : 0));
      g.torso.updateMatrixWorld(true);
      for (let a = 0; a < 2; a++) {
        const side = a ? 1 : -1;
        fl.body.worldToLocal(g.shoulders[a].getWorldPosition(tmpA));
        fl.body.worldToLocal(g.grips[a].getWorldPosition(tmpB));
        g.upper[a].position.copy(tmpA);
        pole.set(Math.cos(ry) * side, -1.4, -Math.sin(ry) * side);
        ik2(g.upper[a], g.lower[a], UPPER, FORE, tmpB, pole);
      }
    }
  }

  update(game: Game, now: number, dt: number): void {
    const f = game.cur, t = now / 1000, serial = ++this.serial;
    const sinceFrame = Math.min(0.1, (performance.now() - game.frameAt) / 1000);
    const puff = t - this.lastPuff > 0.12;
    if (puff) this.lastPuff = t;
    for (let i = 0; i < f.nEffects; i++) {
      if (f.eKind[i] !== EffectKind.Drop) continue;
      const x0 = f.eX0[i], y0 = f.eY0[i], x = f.eX[i], y = f.eY[i];
      const key = `${x0.toFixed(1)},${y0.toFixed(1)},${x.toFixed(1)},${y.toFixed(1)}`;
      let fl = this.flights.get(key);
      if (!fl) { fl = this.make(x0, y0, x, y); this.flights.set(key, fl); }
      fl.seen = serial;
      const left = Math.max(0, f.eLeft[i] / 10 - sinceFrame), total = Math.max(HOVER_TIME + 1, f.eTotal[i] / 10);
      const k0 = Math.min(1, Math.max(0, (total - left) / (total - HOVER_TIME)));
      const k = 1 - (1 - k0) * (1 - k0);
      const hx = x0 + (x - x0) * k, hy = y0 + (y - y0) * k;
      const alt = HOVER + (CRUISE - HOVER) * (1 - k) + Math.sin(t * 2.1) * 0.12;
      this.pose(fl, hx, alt, hy, (1 - k0) * 0.22, t);
      // The crate rides on its sling under the Huey, then comes down under its chute.
      const hang = alt - LIFT - SLING;
      if (left > RELEASE) {
        fl.crate.position.set(hx, hang, hy);
        fl.chute.visible = false; fl.sling.visible = true;
      } else {
        const s = left / RELEASE;
        fl.crate.position.set(x, 0.02 + (hang - 0.02) * s, y);
        fl.chute.visible = true; fl.sling.visible = false;
        fl.chute.scale.setScalar(Math.min(1, (1 - s) * 3));
      }
      fl.crate.rotation.y = fl.heading;
      // Rotor wash kicks up dust as it comes down into the hover.
      this.fx.rotorWash(game, hx, hy, Math.max(0, (k0 - 0.55) / 0.45) ** 1.5, dt);
    }
    // Gone from the frame: the crate is down; the Huey climbs away along its heading.
    for (const [key, fl] of this.flights) {
      if (fl.seen === serial) continue;
      if (!fl.landedAt) { fl.landedAt = t; this.group.remove(fl.crate); }
      const s = t - fl.landedAt;
      if (s > DEPART) { this.group.remove(fl.root); this.flights.delete(key); continue; }
      const dx = Math.cos(-fl.heading), dz = Math.sin(-fl.heading);
      const d = s * s * 1.6;
      this.pose(fl, fl.x + dx * d, HOVER + s * s * 0.35, fl.y + dz * d, Math.min(0.3, s * 0.15), t);
      // The wash follows it off, thinning as it climbs and pulls away.
      this.fx.rotorWash(game, fl.x + dx * d, fl.y + dz * d, Math.max(0, 1 - s / 2.5), dt);
    }
    this.updateEvac(game, now, t, dt);
    this.aim(f, t, dt);
    // Crates on the ground, their chutes slumped beside them, with green marker smoke.
    while (this.grounded.length < f.crates.length) {
      const g = new THREE.Group();
      const m = new THREE.Mesh(this.crateG, this.mat);
      m.castShadow = true;
      const ch = new THREE.Mesh(this.canopyG, this.mat);
      ch.position.set(1.5, -0.36, 0.2); ch.scale.set(0.85, 0.12, 0.6);
      g.add(m, ch);
      this.group.add(g);
      this.grounded.push(g);
    }
    for (let i = 0; i < this.grounded.length; i++) {
      const g = this.grounded[i], c = f.crates[i];
      g.visible = !!c;
      if (!c) continue;
      g.position.set(c.x, 0.02, c.y);
      g.rotation.y = i * 1.3;
      if (puff) this.fx.crateSmoke(c.x, c.y);
    }
  }

  // Where the evac Huey is drawn, on the map, or null while it is not; the camera rides along
  // until it is gone.
  evacAt(): { x: number; y: number } | null {
    return this.evac && !this.outroAt ? { x: this.evac.root.position.x, y: this.evac.root.position.z } : null;
  }

  // Whether the evac Huey is lifting off or still flying away: the field report waits for it.
  leaving(game: Game): boolean {
    const st = game.cur.evac;
    return st === EvacStage.Departing || (st === EvacStage.Gone && !!this.evac && !this.outroDone);
  }

  // The helipad, and the evac Huey over it: hidden until its last flight in, eased between
  // frames, its skids on the pad while it is down.
  private updateEvac(game: Game, now: number, t: number, dt: number): void {
    const f = game.cur, ev = game.welcome?.evac;
    const at = ev ? `${ev.pad.x},${ev.pad.y}` : '';
    if (at !== this.padAt) {
      if (this.pad) { this.group.remove(this.pad); this.pad.geometry.dispose(); this.pad = null; }
      if (ev) {
        this.pad = new THREE.Mesh(padGeo(ev.half), this.mat);
        this.pad.receiveShadow = true;
        this.pad.position.set(ev.pad.x, 0, ev.pad.y);
        this.group.add(this.pad);
      }
      this.padAt = at;
    }
    if (this.pad) this.pad.visible = game.padKnown();
    // Gone: on past the edge of the map, climbing away, until it is out of sight.
    if (f.evac === EvacStage.Gone && this.evac && !this.outroDone) { this.outro(t, dt); return; }
    const flying = f.evac === EvacStage.Landed || f.evac === EvacStage.Departing ||
      (f.evac === EvacStage.Inbound && !!ev && f.evacLeft <= ev.flight);
    if (!flying) {
      this.drop();
      // A game joined after the Huey left has no outro to wait for.
      this.outroDone = f.evac === EvacStage.Gone;
      return;
    }
    if (!this.evac) {
      this.evac = this.make(f.evacX, f.evacY, f.evacX, f.evacY);
      this.group.remove(this.evac.crate);
      this.evacFrame = 0; this.outroAt = 0; this.outroDone = false;
    }
    if (this.evacFrame !== game.frames) {
      const fresh = this.evacFrame === 0;
      this.evacFrame = game.frames;
      Object.assign(this.ev0, fresh ? { x: f.evacX, y: f.evacY, alt: f.evacAlt, yaw: f.evacYaw } : this.ev1);
      Object.assign(this.ev1, { x: f.evacX, y: f.evacY, alt: f.evacAlt, yaw: f.evacYaw });
      const iv = game.interval / 1000, e0 = this.ev0, e1 = this.ev1;
      let turn = e1.yaw - e0.yaw;
      turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
      this.evacSpeed = Math.hypot(e1.x - e0.x, e1.y - e0.y) / iv;
      this.evacTurn += (turn / iv - this.evacTurn) * 0.3;
    }
    const a = game.alpha(now), e0 = this.ev0, e1 = this.ev1;
    const x = e0.x + (e1.x - e0.x) * a, y = e0.y + (e1.y - e0.y) * a, alt = e0.alt + (e1.alt - e0.alt) * a;
    let dy = e1.yaw - e0.yaw;
    dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
    const fl = this.evac, h = alt * CRUISE;
    fl.heading = -(e0.yaw + dy * a);
    // Nose down while it flies, the more the faster; banked into a turn; level as it settles
    // onto the pad.
    const pitch = Math.min(0.32, h * 0.025 + this.evacSpeed * 0.012);
    this.pose(fl, x, h + LIFT + (h > 0.05 ? Math.sin(t * 2.1) * 0.12 * Math.min(1, h) : 0), y, pitch, t, Math.max(-0.45, Math.min(0.45, this.evacTurn * 0.5)));
    this.fx.rotorWash(game, x, y, Math.max(0, 1 - h / 8) ** 1.5, dt);
  }

  // The Huey flies on along its heading at its last speed, climbing and levelling out.
  private outro(t: number, dt: number): void {
    const fl = this.evac!;
    if (!this.outroAt) this.outroAt = t;
    const s = t - this.outroAt, p = fl.root.position;
    if (s > OUTRO) { this.drop(); this.outroDone = true; return; }
    const sp = Math.max(this.evacSpeed, 12) * (1 + s * 0.4), yaw = -fl.heading;
    p.x += Math.cos(yaw) * sp * dt; p.z += Math.sin(yaw) * sp * dt; p.y += (2 + s * 3) * dt;
    this.evacTurn *= 1 - Math.min(1, dt * 2);
    fl.body.rotation.z = -Math.min(0.32, 0.12 + sp * 0.01);
    fl.body.rotation.x = this.evacTurn * 0.5;
    this.spin(fl, t);
  }

  private drop(): void {
    if (this.evac) { this.group.remove(this.evac.root, this.evac.crate); this.evac = null; }
  }

  // The rotors turning: the main one at a little under its 324 rpm (the smears carry the rest),
  // the tail rotor about five times as fast.
  private spin(fl: Flight, t: number): void {
    fl.rotor.rotation.y = t * 21;
    fl.tail.rotation.z = t * 40;
  }

  private pose(fl: Flight, x: number, alt: number, z: number, pitch: number, t: number, roll = 0): void {
    fl.root.position.set(x, alt - LIFT, z);
    fl.root.rotation.y = fl.heading;
    fl.body.rotation.z = -pitch;
    fl.body.rotation.x = Math.sin(t * 1.3) * 0.03 + roll;
    this.spin(fl, t);
  }
}
