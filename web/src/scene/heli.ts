import * as THREE from 'three/webgpu';
import { mrt, output, vec4 } from 'three/tsl';
import { EffectKind, EvacStage, TRACER_HELI } from '../protocol';
import type { Game } from '../state';
import type { Effects } from './effects';
import { ik2 } from './rig';
import { litMaterial } from './structs';
import { box, cyl, merge, part, type Part } from './util';

// Supply drops: the Huey gunship that flies the crate in, with the surfboards strapped to its
// side (a nod to Kilgore in Apocalypse Now), the crate coming down under a chute, and the crates
// waiting on the ground with green smoke over them. And at the end of the last wave the same Huey
// coming in to the helipad to get the survivors out. Its door gunner (a nod to Tropic Thunder:
// red headband, aviators, crossed belts of brass) sits in the open doorway behind a minigun on
// an outrigger arm, turning it to what it fires at, its barrels spinning up whenever it fires
// and its tracers leaving from the muzzle.

const OD = 0x4b5631, OD_DARK = 0x363e22, GLASS = 0x34505a, BLACK = 0x1c1c1a, STEEL = 0x55574f, INSIDE = 0x2a2c22;
// The door gunner: sun-browned arms, a sweat-dark olive vest, red headband, brass belts.
const SKIN = 0xc98a5a, VEST = 0x55602f, PANTS = 0x4a4f2c, BOOT = 0x23201b, BRASS = 0xc9a03a, BAND = 0xc4261d, HAIR = 0x2b1d14;
const CRUISE = 10, HOVER = 6.5; // flying height in, and over the drop zone
const HOVER_TIME = 3; // the host's dropHover: seconds over the zone before the crate is down
const RELEASE = 1.6; // seconds before landing that the crate is let go under its chute
const DEPART = 7; // seconds the Huey takes to fly off after the crate is down
const SCALE = 0.75; // a touch under life size, so it does not swallow the screen
const OUTRO = 3.5; // seconds the evac Huey flies on, climbing away, once the host has it gone

interface Flight {
  root: THREE.Group; body: THREE.Group; rotor: THREE.Object3D; tail: THREE.Object3D; crate: THREE.Group; chute: THREE.Object3D;
  gun: Gun;
  x0: number; y0: number; x: number; y: number;
  heading: number; seen: number; landedAt: number; // landedAt: seconds, 0 while still in flight
}

// The door gunner and his minigun: the gun turns on its pintle (yaw) and tips in its cradle
// (pitch); he turns to it and leans in from the hips, his arms (upper arm and forearm, bent at
// the elbow) on its grips. Where it
// points is eased toward its last mark, back to rest once it has been quiet a while.
interface Gun {
  yaw: THREE.Object3D; pitch: THREE.Object3D; barrels: THREE.Object3D; flash: THREE.Object3D; muzzle: THREE.Object3D;
  torso: THREE.Object3D; upper: THREE.Object3D[]; lower: THREE.Object3D[]; shoulders: THREE.Object3D[]; grips: THREE.Object3D[];
  spin: number; // how fast the barrels turn
  aimYaw: number; aimPitch: number; // where it points now, in the Huey's frame
  markX: number; markY: number; markAt: number; // its last mark on the map, and when (seconds)
}

const PIVOT = new THREE.Vector3(-0.1, 1.33, 1.38); // the gun's pivot on its pintle
const HIPS = new THREE.Vector3(-0.1, 0.97, 0.74); // where the gunner turns from
const UPPER = 0.29, FORE = 0.29; // his upper arm and forearm, shoulder to elbow to grip
const REST_YAW = 0.25, REST_PITCH = 0.45; // a little forward and down while it waits
const YAW_MAX = 1.05, PITCH_MIN = -0.15, PITCH_MAX = 1.3;
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), pole = new THREE.Vector3();

// A bar w thick from (x0, y0, z0) to (x1, y1, z1).
function strut(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, w: number, c: number): Part {
  const d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0), len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  const e = new THREE.Euler().setFromQuaternion(q);
  return part(box(w, len, w), c, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, e.x, e.y, e.z);
}

// A surfboard on its edge along x: a long rounded plank with a stripe down it.
function board(color: number, stripe: number, x: number, y: number, z: number): Part[] {
  const p = (w: number, d: number, dx: number, c = color) => part(box(w, 0.07, d), c, x + dx, y, z, Math.PI / 2, 0, 0);
  return [p(1.7, 0.5, 0), p(0.45, 0.38, 1.05), p(0.3, 0.24, 1.4), p(0.12, 0.1, 1.58), p(0.35, 0.4, -1.0), p(0.12, 0.3, -1.22),
    part(box(2.6, 0.075, 0.07), stripe, x + 0.1, y, z, Math.PI / 2, 0, 0)];
}

function hueyBody(): THREE.BufferGeometry {
  const p: Part[] = [];
  const add = (w: number, h: number, d: number, c: number, x: number, y: number, z = 0, rx = 0, ry = 0, rz = 0) => p.push(part(box(w, h, d), c, x, y, z, rx, ry, rz));
  // Cabin, nose and the sloped windscreen with the chin bubbles under it. The cabin is built
  // round an open doorway on the right (x -0.85..0.65, y 0.55..1.85), a recess back to z 0.2
  // where the door gunner sits; the left door is shut behind the surfboards.
  add(1.05, 1.7, 1.9, OD, 1.175, 1.25);
  add(0.85, 1.7, 1.9, OD, -1.275, 1.25);
  add(1.5, 0.15, 1.9, OD, -0.1, 0.475);
  add(1.5, 0.25, 1.9, OD, -0.1, 1.975);
  add(1.5, 1.3, 1.15, OD, -0.1, 1.2, -0.375);
  add(1.5, 1.3, 0.04, INSIDE, -0.1, 1.2, 0.215);
  add(0.03, 1.3, 0.75, INSIDE, -0.835, 1.2, 0.575); add(0.03, 1.3, 0.75, INSIDE, 0.635, 1.2, 0.575);
  add(1.5, 0.02, 0.75, 0x2a2b24, -0.1, 0.56, 0.575);
  add(1.56, 0.06, 0.06, OD_DARK, -0.1, 1.86, 0.95); add(1.56, 0.06, 0.06, OD_DARK, -0.1, 0.54, 0.95);
  add(1.2, 1.35, 1.75, OD, 2.25, 1.1);
  add(0.7, 0.75, 1.5, OD, 3.0, 0.75);
  add(0.9, 0.75, 1.78, GLASS, 2.45, 1.55, 0, 0, 0, -0.55);
  add(0.5, 0.4, 0.5, GLASS, 3.1, 0.65, 0.42); add(0.5, 0.4, 0.5, GLASS, 3.1, 0.65, -0.42);
  // The left cargo door, shut: a dark window in it.
  add(1.5, 1.15, 0.05, OD_DARK, -0.1, 1.2, -0.96); add(0.6, 0.4, 0.06, GLASS, -0.1, 1.45, -0.965);
  // The hump over the cabin: transmission, engine and exhaust.
  add(2.1, 0.6, 1.15, OD_DARK, -0.4, 2.4);
  add(0.45, 0.4, 0.55, BLACK, -1.55, 2.4);
  p.push(part(cyl(0.08, 0.1, 0.55), STEEL, 0.1, 2.9, 0));
  // Tail boom, fin, stabiliser.
  add(2.2, 0.62, 0.55, OD, -2.6, 1.75);
  add(2.8, 0.42, 0.36, OD, -4.9, 1.8);
  add(1.0, 1.5, 0.12, OD_DARK, -6.2, 2.45, 0, 0, 0, 0.4);
  add(0.55, 0.08, 1.7, OD_DARK, -5.2, 1.75);
  add(0.25, 0.25, 0.2, STEEL, -6.4, 2.9, 0.12);
  // Skids and struts.
  for (const z of [0.95, -0.95]) {
    add(4.2, 0.1, 0.12, STEEL, 0.15, 0.05, z);
    add(0.45, 0.1, 0.12, STEEL, 2.4, 0.16, z, 0, 0, 0.55);
    add(0.1, 0.75, 0.1, STEEL, 1.1, 0.42, z * 0.88, z > 0 ? 0.25 : -0.25);
    add(0.1, 0.75, 0.1, STEEL, -0.9, 0.42, z * 0.88, z > 0 ? 0.25 : -0.25);
  }
  // The door gunner's seat at the edge of the doorway, his legs hanging out over the skid
  // (the rest of him turns with the gun, in gunnerGeo), and the minigun's outrigger arm out
  // from the doorframe to its pintle.
  add(0.5, 0.08, 0.34, BLACK, -0.1, 0.91, 0.7);
  add(0.5, 0.42, 0.06, BLACK, -0.1, 0.78, 0.5);
  for (const x of [-0.21, 0.01]) {
    add(0.15, 0.14, 0.4, PANTS, x, 0.98, 0.92);
    add(0.14, 0.42, 0.14, PANTS, x, 0.78, 1.1, -0.15);
    add(0.16, 0.11, 0.26, BOOT, x, 0.56, 1.17);
  }
  p.push(strut(-0.83, 0.85, 0.96, -0.1, 1.08, 1.38, 0.07, STEEL));
  p.push(strut(-0.83, 1.5, 0.96, -0.1, 1.1, 1.38, 0.05, STEEL));
  p.push(part(cyl(0.05, 0.06, 0.22, 8), STEEL, -0.1, 1.12, 1.38));
  // Two surfboards strapped along the left skid struts, Kilgore style.
  p.push(...board(0xf1ece0, 0xc8402a, 0.2, 0.95, -1.13));
  p.push(...board(0xf2c64a, 0x2d6fb0, 0.05, 1.05, -1.24));
  for (const x of [-0.55, 0.75]) add(0.08, 0.75, 0.32, BLACK, x, 1.0, -1.18);
  return merge(p);
}

// The minigun's six barrels round its axis, along +z, with the clamps along them; spun as one.
function barrelsGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    p.push(part(cyl(0.028, 0.028, 1.0, 6), BLACK, Math.cos(a) * 0.065, Math.sin(a) * 0.065, 0.5, Math.PI / 2, 0, 0));
  }
  for (const z of [0.05, 0.55, 0.95]) p.push(part(cyl(0.105, 0.105, 0.07, 8), STEEL, 0, 0, z, Math.PI / 2, 0, 0));
  return merge(p);
}

// The rest of the minigun, about its pivot on the cradle with the barrels along +z: the
// receiver and its drive motor, the spade grips behind it with the trigger bar between, and an
// ammo can slung on the left with its brass belt running up into the feed.
function gunGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  const add = (w: number, h: number, d: number, c: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => p.push(part(box(w, h, d), c, x, y, z, rx, ry, rz));
  p.push(part(cyl(0.12, 0.12, 0.42, 8), 0x2e2f2a, 0, 0, -0.02, Math.PI / 2, 0, 0));
  p.push(part(cyl(0.06, 0.06, 0.26, 8), STEEL, 0.1, 0.1, -0.05, Math.PI / 2, 0, 0));
  add(0.08, 0.05, 0.12, BLACK, 0, 0.14, -0.1);
  add(0.3, 0.05, 0.05, STEEL, 0, 0, -0.26);
  for (const x of [-0.13, 0.13]) { add(0.05, 0.05, 0.12, STEEL, x, 0, -0.3); add(0.05, 0.16, 0.05, BLACK, x, -0.02, -0.36); }
  add(0.16, 0.03, 0.03, 0x8a2a1a, 0, 0.03, -0.34);
  // The ammo can and the belt up from it.
  add(0.16, 0.26, 0.34, OD_DARK, -0.24, -0.2, -0.06);
  add(0.17, 0.04, 0.35, BLACK, -0.24, -0.06, -0.06);
  for (let i = 0; i < 4; i++) add(0.09, 0.03, 0.2, BRASS, -0.21 + i * 0.05, -0.05 + i * 0.045, -0.04, 0, 0, 0.75);
  return merge(p);
}

// The door gunner from the hips up, facing +z: a sleeveless olive vest with two belts of brass
// crossed over it and his dog tags, a cigar in his teeth, aviators, and a red headband knotted
// behind with its tails out in the wash. His arms are their own meshes (upperArmGeo, foreArmGeo), reaching for
// the gun's grips wherever it points.
function gunnerGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  const add = (w: number, h: number, d: number, c: number, x: number, y: number, z = 0, rx = 0, ry = 0, rz = 0) => p.push(part(box(w, h, d), c, x, y, z, rx, ry, rz));
  add(0.42, 0.08, 0.27, 0x3a2e1e, 0, 0.03);
  add(0.4, 0.46, 0.25, VEST, 0, 0.29);
  add(0.44, 0.1, 0.24, SKIN, 0, 0.5); // the bare shoulders
  add(0.07, 0.66, 0.03, BRASS, 0, 0.29, 0.13, 0, 0, 0.62); add(0.07, 0.66, 0.03, BRASS, 0, 0.29, 0.135, 0, 0, -0.62);
  add(0.075, 0.66, 0.02, 0x5a3e1e, 0, 0.29, 0.14, 0, 0, 0.62);
  add(0.012, 0.16, 0.012, 0xb8b8b0, 0.035, 0.42, 0.135, 0, 0, 0.3); add(0.04, 0.055, 0.012, 0xd0d0c8, 0.0, 0.34, 0.15);
  add(0.1, 0.08, 0.1, SKIN, 0, 0.58);
  // The head: face, crew-cut hair, the headband and its knot and tails.
  add(0.22, 0.24, 0.22, SKIN, 0, 0.73);
  add(0.235, 0.06, 0.235, HAIR, 0, 0.87);
  add(0.235, 0.05, 0.235, BAND, 0, 0.82);
  add(0.06, 0.06, 0.05, BAND, 0, 0.8, -0.135);
  add(0.05, 0.03, 0.2, BAND, 0.03, 0.76, -0.22, 0.5, 0.2, 0); add(0.05, 0.03, 0.17, BAND, -0.03, 0.74, -0.2, 0.7, -0.25, 0);
  // Aviators, gold-rimmed, the stubble and a cigar with its ember.
  add(0.235, 0.022, 0.02, 0xd4af37, 0, 0.775, 0.112);
  add(0.085, 0.055, 0.02, 0x101010, -0.055, 0.75, 0.118); add(0.085, 0.055, 0.02, 0x101010, 0.055, 0.75, 0.118);
  add(0.2, 0.06, 0.02, 0x6a4a34, 0, 0.64, 0.112);
  add(0.13, 0.025, 0.02, HAIR, 0, 0.675, 0.115);
  add(0.025, 0.025, 0.13, 0x6b4426, 0.05, 0.655, 0.17, 0, 0.35, 0); add(0.03, 0.03, 0.02, 0xff5a1a, 0.073, 0.655, 0.235);
  return merge(p);
}

// The arm's two bones, hanging down -y from their pivots as ik2 has them: the bare upper arm
// with a rolled-up sleeve's edge at the shoulder; the forearm and the gloved hand.
function upperArmGeo(): THREE.BufferGeometry {
  return merge([part(box(0.115, UPPER, 0.115), SKIN, 0, -UPPER / 2, 0), part(box(0.13, 0.07, 0.13), VEST, 0, -0.02, 0)]);
}
function foreArmGeo(): THREE.BufferGeometry {
  return merge([part(box(0.1, FORE - 0.04, 0.1), SKIN, 0, -(FORE - 0.04) / 2, 0), part(box(0.12, 0.1, 0.12), 0x3a3324, 0, -FORE + 0.02, 0)]);
}

// A muzzle flash, a cross of two flat stars along +z, drawn additive.
function flashGeo(): THREE.BufferGeometry {
  const plane = () => new THREE.PlaneGeometry(0.34, 0.6);
  return merge([part(plane(), 0xffffff, 0, 0, 0.3, Math.PI / 2, 0, 0), part(plane(), 0xffffff, 0, 0, 0.3, Math.PI / 2, 0, Math.PI / 2),
    part(new THREE.CircleGeometry(0.17, 6), 0xffffff, 0, 0, 0.02)]);
}

function crateGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  const add = (w: number, h: number, d: number, c: number, x: number, y: number, z = 0) => p.push(part(box(w, h, d), c, x, y, z));
  add(0.9, 0.7, 0.9, 0x5d6234, 0, 0.35);
  for (const x of [-0.42, 0.42]) for (const z of [-0.42, 0.42]) add(0.1, 0.72, 0.1, 0x3e4222, x, 0.35, z);
  add(0.92, 0.1, 0.92, 0x3e4222, 0, 0.71);
  add(0.4, 0.2, 0.02, 0xe8e2c8, 0, 0.42, 0.46); // the stencilled panel
  add(0.96, 0.06, 0.12, 0xc8a24a, 0, 0.5); // a strap round it
  return merge(p);
}

function chuteGeo(): THREE.BufferGeometry {
  const p: Part[] = [];
  // A canopy of alternating panels, and the lines down to the crate.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    p.push(part(box(0.9, 0.12, 0.7), i % 2 ? 0xe9e2cc : 0x6b7a45, Math.cos(a) * 0.75, 2.6 - 0.12, Math.sin(a) * 0.75, 0, -a, 0.35));
  }
  p.push(part(box(0.9, 0.15, 0.9), 0xe9e2cc, 0, 2.75, 0));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    p.push(part(box(0.03, 2.1, 0.03), 0x2a2a24, Math.cos(a) * 0.55, 1.65, Math.sin(a) * 0.55, Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4));
  }
  return merge(p);
}

// A flat rounded square, 2*half across with corners of radius r, h thick, standing on y = 0.
function roundSlab(half: number, r: number, h: number): THREE.BufferGeometry {
  const sh = new THREE.Shape(), a = half - r;
  sh.moveTo(-a, -half); sh.lineTo(a, -half); sh.absarc(a, -a, r, -Math.PI / 2, 0, false);
  sh.lineTo(half, a); sh.absarc(a, a, r, 0, Math.PI / 2, false);
  sh.lineTo(-a, half); sh.absarc(-a, a, r, Math.PI / 2, Math.PI, false);
  sh.lineTo(-half, -a); sh.absarc(-a, -a, r, Math.PI, Math.PI * 1.5, false);
  return new THREE.ExtrudeGeometry(sh, { depth: h, bevelEnabled: false, curveSegments: 6 }).rotateX(-Math.PI / 2);
}

// The helipad: a concrete slab half tiles out from its middle each way with rounded corners and
// a white edge line, a yellow ring and the H.
function padGeo(half: number): THREE.BufferGeometry {
  const p: Part[] = [part(roundSlab(half, 1.1, 0.06), 0x6e6d68), part(roundSlab(half - 0.2, 0.95, 0.07), 0xd8d4c6),
    part(roundSlab(half - 0.38, 0.8, 0.075), 0x7d7c76)];
  const r = half * 0.72, n = 28;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    p.push(part(box(0.26, 0.02, 2 * Math.PI * r / n + 0.02), 0xd8b23a, Math.cos(a) * r, 0.085, Math.sin(a) * r, 0, -a, 0));
  }
  const s = half / 2;
  p.push(part(box(0.24 * s, 0.02, 1.5 * s), 0xeeeae0, -0.5 * s, 0.09, 0), part(box(0.24 * s, 0.02, 1.5 * s), 0xeeeae0, 0.5 * s, 0.09, 0),
    part(box(1 * s, 0.02, 0.22 * s), 0xeeeae0, 0, 0.09, 0));
  return merge(p);
}

export class Helis {
  group = new THREE.Group();
  private mat = litMaterial();
  private bodyGeo = hueyBody();
  private rotorGeo = merge([part(box(10, 0.05, 0.36), 0x262624, 0, 0, 0), part(box(0.5, 0.15, 0.5), STEEL, 0, 0, 0)]);
  private tailGeo = merge([part(box(0.1, 1.5, 0.16), 0x262624, 0, 0, 0)]);
  private crateG = crateGeo();
  private barrelsG = barrelsGeo();
  private gunG = gunGeo();
  private gunnerG = gunnerGeo();
  private upperG = upperArmGeo();
  private foreG = foreArmGeo();
  private flashG = flashGeo();
  private flashMat = new THREE.MeshBasicNodeMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  private chuteG = chuteGeo();
  private blurMat = new THREE.MeshBasicNodeMaterial({ color: 0x1a1a18, transparent: true, opacity: 0.07, depthWrite: false });
  private blurGeo = new THREE.CircleGeometry(5, 24).rotateX(-Math.PI / 2);
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
    this.blurMat.mrtNode = mrt({ output, normal: vec4(0, 0, 0, 0) }); // the blur is no crease
  }

  private make(x0: number, y0: number, x: number, y: number): Flight {
    const root = new THREE.Group(), body = new THREE.Group();
    root.add(body);
    root.scale.setScalar(SCALE);
    const hull = new THREE.Mesh(this.bodyGeo, this.mat);
    hull.castShadow = true;
    body.add(hull);
    const rotor = new THREE.Group();
    rotor.position.set(0.1, 3.18, 0);
    const blades = new THREE.Mesh(this.rotorGeo, this.mat);
    blades.castShadow = true;
    rotor.add(blades, new THREE.Mesh(this.blurGeo, this.blurMat));
    body.add(rotor);
    const tail = new THREE.Mesh(this.tailGeo, this.mat);
    tail.position.set(-6.4, 2.9, 0.26);
    body.add(tail);
    const gun = this.makeGun(body);
    const crate = new THREE.Group();
    const cm = new THREE.Mesh(this.crateG, this.mat);
    cm.castShadow = true;
    const chute = new THREE.Mesh(this.chuteG, this.mat);
    chute.visible = false;
    crate.add(cm, chute);
    this.group.add(root, crate);
    return { root, body, rotor, tail, crate, chute, gun, x0, y0, x, y, heading: -Math.atan2(y - y0, x - x0), seen: 0, landedAt: 0 };
  }

  private makeGun(body: THREE.Object3D): Gun {
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material = this.mat) => { const o = new THREE.Mesh(g, m); o.castShadow = m === this.mat; return o; };
    const yaw = new THREE.Group(), pitch = new THREE.Group();
    yaw.position.copy(PIVOT);
    // The yoke the cradle swings in, on top of the post.
    const yoke = mesh(merge([part(box(0.36, 0.05, 0.1), STEEL, 0, -0.1, 0), part(box(0.04, 0.16, 0.08), STEEL, -0.17, -0.03, 0), part(box(0.04, 0.16, 0.08), STEEL, 0.17, -0.03, 0)]));
    yaw.add(yoke, pitch);
    const barrels = mesh(this.barrelsG);
    barrels.position.set(0, 0, 0.18);
    const flash = mesh(this.flashG, this.flashMat);
    flash.position.set(0, 0, 1.18); flash.visible = false;
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0, 1.2);
    const grips = [-0.13, 0.13].map((x) => { const o = new THREE.Object3D(); o.position.set(x, -0.04, -0.37); return o; });
    pitch.add(mesh(this.gunG), barrels, flash, muzzle, ...grips);
    const torso = mesh(this.gunnerG);
    torso.position.copy(HIPS);
    torso.scale.setScalar(1.1);
    const shoulders = [-0.21, 0.21].map((x) => { const o = new THREE.Object3D(); o.position.set(x, 0.5, 0.02); torso.add(o); return o; });
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
      // The crate rides under the Huey, then comes down under its chute.
      if (left > RELEASE) {
        fl.crate.position.set(hx, alt - 1.3, hy);
        fl.chute.visible = false;
      } else {
        const s = left / RELEASE;
        fl.crate.position.set(x, 0.02 + (alt - 1.3) * s, y);
        fl.chute.visible = true;
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
    // Crates on the ground, with green marker smoke.
    while (this.grounded.length < f.crates.length) {
      const g = new THREE.Group();
      const m = new THREE.Mesh(this.crateG, this.mat);
      m.castShadow = true;
      const ch = new THREE.Mesh(this.chuteG, this.mat);
      ch.rotation.z = 1.35; ch.position.set(1.4, -0.2, 0.3); ch.scale.set(0.9, 0.35, 0.9);
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
    this.pose(fl, x, h + 1.1 * SCALE + (h > 0.05 ? Math.sin(t * 2.1) * 0.12 * Math.min(1, h) : 0), y, pitch, t, Math.max(-0.45, Math.min(0.45, this.evacTurn * 0.5)));
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
    fl.rotor.rotation.y = t * 21;
    fl.tail.rotation.z = t * 40;
  }

  private drop(): void {
    if (this.evac) { this.group.remove(this.evac.root, this.evac.crate); this.evac = null; }
  }

  private pose(fl: Flight, x: number, alt: number, z: number, pitch: number, t: number, roll = 0): void {
    fl.root.position.set(x, alt - 1.1 * SCALE, z);
    fl.root.rotation.y = fl.heading;
    fl.body.rotation.z = -pitch;
    fl.body.rotation.x = Math.sin(t * 1.3) * 0.03 + roll;
    fl.rotor.rotation.y = t * 21;
    fl.tail.rotation.z = t * 40;
  }
}
