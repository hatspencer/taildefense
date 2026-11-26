import * as THREE from 'three/webgpu';
import { color, float, fract, max, mix, mrt, output, positionLocal, sin, step, time, uniform, vertexColor, vec3, vec4 } from 'three/tsl';
import { K_ARMORY, K_BAIT, K_CANNON, K_CATAPULT, K_CORE, K_FROST, K_GATE, K_GUN, K_MISSILE, K_SNIPER, K_PYLON, K_TESLA, K_WALL, type StructDef, TTrack, TURRET_TRACKS, turretRange } from '../protocol';
import type { Game } from '../state';
import { isTrapKind, trapFace, trapGhost, trapMake, trapModel, trapUpdate } from './traps';
import { box, concat, cone, cyl, dodeca, ico, merge, octa, part, playerColor, sphere, torus, writeMatrix, type Part } from './util';
import { AWM_LENS, AWM_MUZZLE, awmParts } from './awm';
import { painted } from './paint';

export { K_ARMORY, K_CANNON, K_CORE, K_FROST, K_GATE, K_GUN, K_MISSILE, K_SNIPER, K_TESLA, K_WALL };

// Highlight of what is under the cursor, set per object through userData.hl.
const hl = uniform(0).onObjectUpdate((frame) => (frame.object?.userData.hl as number | undefined) ?? 0);

export function litMaterial(): THREE.MeshLambertNodeMaterial {
  const m = painted(new THREE.MeshLambertNodeMaterial());
  m.colorNode = vertexColor().rgb;
  m.emissiveNode = vec3(0.32, 0.3, 0.18).mul(hl);
  return m;
}

// How damaged the object is, 0..1, set per object through userData.dmg.
const dmgU = uniform(0).onObjectUpdate((frame) => (frame.object?.userData.dmg as number | undefined) ?? 0);

// The generator's core: teal light with pulses running up it, flickering red as it fails.
function coreGlowMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const band = fract(positionLocal.y.mul(1.4).sub(time.mul(0.7)));
  const ok = color(0x7affd8).mul(sin(time.mul(2.2)).mul(0.12).add(1).add(step(0.82, band).mul(0.55)));
  const flick = step(0.3, fract(sin(time.mul(17).floor().mul(91.7)).mul(437.5)));
  const bad = color(0xff4a20).mul(flick.mul(0.9).add(0.25));
  m.colorNode = mix(ok, bad, max(float(0), dmgU.mul(1.2).sub(0.2)));
  return m;
}

// How strong a sniper's laser is, 0..1, set per object through userData.laser.
const laserU = uniform(0).onObjectUpdate((frame) => (frame.object?.userData.laser as number | undefined) ?? 0);

// The laser sight's beam and dot: additive red, bright in the dark, writing no depth (so the
// outline pass draws no edge round it) and no normal (no crease).
function laserMaterial(hex: number, k: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = color(hex).mul(laserU.mul(k));
  m.transparent = true; m.depthWrite = false; m.blending = THREE.AdditiveBlending;
  m.mrtNode = mrt({ output, normal: vec4(0, 0, 0, 0) });
  return m;
}

function glowMaterial(hex: number, pulse = 0): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = pulse ? color(hex).mul(sin(time.mul(pulse)).mul(0.25).add(1.05)) : color(hex);
  return m;
}

// dmg: extra wreckage shown below 60% and 30% hp. gun: a part of the head that recoils in it,
// pivoting at gunX along the head's +x.
interface Model { body: Part[]; head?: Part[]; headY?: number; gun?: Part[]; gunX?: number; glow?: { parts: Part[]; color: number; pulse: number }; spin?: Part[]; spinY?: number; dmg?: [Part[], Part[]] }

// The colours of a turret's tracks: damage, fire rate, range, special.
const PIP = [0xc8502a, 0xd8b040, 0x5aa0c8, 0xb070d0];

const STEEL = 0x5a5f63, DARK = 0x26282a, HAZARD = 0xc89a2a, CONCRETE = 0x7a776e, RUST = 0x7a4a2a, PIPE = 0x5e625e;

// Hazard stripes along one edge of a square of half-size h, at height y.
function stripes(p: Part[], h: number, y: number, n: number): void {
  const step = (2 * h) / n;
  for (let i = 0; i < n; i++) {
    const u = -h + step * (i + 0.5), c = i % 2 ? HAZARD : DARK;
    p.push(part(box(step, 0.03, 0.14), c, u, y, h - 0.07), part(box(step, 0.03, 0.14), c, -u, y, -h + 0.07));
    p.push(part(box(0.14, 0.03, step), c, h - 0.07, y, -u), part(box(0.14, 0.03, step), c, -h + 0.07, y, u));
  }
}

// The generator, 5x5: a jury-rigged reactor on a concrete pad. A stepped steel housing with
// ribs and vents, a mustard upper deck, a glowing core in a cage under a cap, a turbine ring
// turning round it, fuel tanks piped in on one side, a control panel and cables on the others.
function coreModel(): Model {
  const mustard = 0xa08a3a, olive = 0x6a6a3a;
  const body: Part[] = [
    part(box(4.95, 0.06, 4.95), 0x5a5850, 0, 0.03, 0),
    part(box(4.8, 0.2, 4.8), CONCRETE, 0, 0.14, 0),
    part(box(3.8, 0.34, 3.8), DARK, 0, 0.41, 0),
    part(box(3.4, 0.9, 3.4), STEEL, 0, 1.03, 0),
    part(box(3.5, 0.08, 3.5), DARK, 0, 1.5, 0),
    part(box(2.5, 0.6, 2.5), mustard, 0, 1.84, 0),
    part(box(2.6, 0.08, 2.6), 0x5a4c20, 0, 2.17, 0),
    part(box(1.5, 0.12, 1.5), DARK, 0, 2.27, 0),
    // The cage round the core and the cap on it.
    ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, z]) => part(box(0.12, 1.15, 0.12), STEEL, x * 0.55, 2.88, z * 0.55)),
    part(cyl(0.66, 0.74, 0.16, 8), DARK, 0, 3.5, 0),
    part(cyl(0.36, 0.6, 0.2, 8), olive, 0, 3.68, 0),
    part(cyl(0.05, 0.05, 0.7, 4), DARK, 0.2, 4.0, 0.15),
    part(box(0.2, 0.04, 0.04), DARK, 0.2, 4.3, 0.15),
    // Rust streaks, a hatch and a ladder on the front.
    part(box(0.6, 0.3, 0.02), RUST, -0.8, 0.9, 1.71),
    part(box(0.02, 0.25, 0.5), RUST, -1.71, 1.2, 0.6),
    part(box(0.9, 0.7, 0.04), 0x3a3e42, 0.6, 1.0, 1.72),
    part(box(0.06, 0.06, 0.08), 0xa0a090, 0.95, 1.0, 1.76),
    ...[0.6, 0.9, 1.2, 1.5, 1.8].map((y) => part(box(0.04, 0.04, 0.4), 0x8a8a80, 1.95, y, -0.9)),
    part(box(0.04, 1.7, 0.04), 0x8a8a80, 1.95, 1.2, -0.7), part(box(0.04, 1.7, 0.04), 0x8a8a80, 1.95, 1.2, -1.1),
    // Control panel on the right side, with a cable bundle down to the pad.
    part(box(0.12, 0.7, 1.0), 0x3a3e3a, 1.76, 1.0, 0.5),
    part(box(0.03, 0.12, 0.7), 0x1a1c1a, 1.83, 1.18, 0.5),
    // Fuel tanks on the left, piped up into the housing.
    part(cyl(0.32, 0.32, 1.5, 8), 0x8a3a24, -2.0, 0.6, -0.8, Math.PI / 2, 0, 0),
    part(cyl(0.34, 0.34, 0.06, 8), DARK, -2.0, 0.6, -0.1, Math.PI / 2, 0, 0),
    part(cyl(0.34, 0.34, 0.06, 8), DARK, -2.0, 0.6, -1.5, Math.PI / 2, 0, 0),
    part(box(0.5, 0.25, 1.4), DARK, -2.0, 0.27, -0.8),
    part(cyl(0.08, 0.08, 0.7, 5), PIPE, -2.0, 1.1, -0.5),
    part(cyl(0.08, 0.08, 0.4, 5), PIPE, -1.8, 1.42, -0.5, 0, 0, Math.PI / 2),
    part(cyl(0.08, 0.08, 0.7, 5), PIPE, -2.0, 1.1, -1.1),
    part(cyl(0.08, 0.08, 0.4, 5), PIPE, -1.8, 1.42, -1.1, 0, 0, Math.PI / 2),
    part(box(0.3, 0.42, 0.2), 0x8a2a20, -2.0, 0.42, 0.9), part(box(0.3, 0.42, 0.2), 0x6a6a3a, -2.0, 0.42, 1.25, 0, 0.3, 0),
    // Pipes over the top deck into the cage.
    part(cyl(0.07, 0.07, 1.0, 5), PIPE, -0.8, 2.3, 0.8, 0, Math.PI / 4, Math.PI / 2),
    part(cyl(0.07, 0.07, 1.0, 5), PIPE, 0.8, 2.3, -0.8, 0, Math.PI / 4, Math.PI / 2),
    // Cables snaking off the pad towards the gates.
    part(box(0.06, 0.05, 1.2), DARK, 0.3, 0.27, 2.0, 0, 0.15, 0), part(box(0.06, 0.05, 1.2), DARK, -0.3, 0.27, -2.0, 0, -0.2, 0),
    part(box(1.0, 0.05, 0.06), DARK, 2.0, 0.27, -0.2, 0, 0.1, 0), part(box(0.8, 0.05, 0.06), 0x3a2a1a, 2.1, 0.27, 1.6, 0, -0.3, 0),
    // Corner bollards.
    ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].flatMap(([x, z]) => [
      part(cyl(0.1, 0.1, 0.6, 6), HAZARD, x * 2.15, 0.54, z * 2.15), part(cyl(0.11, 0.11, 0.1, 6), DARK, x * 2.15, 0.6, z * 2.15)]),
  ];
  // Ribs and vent slats round the housing.
  for (let s = 0; s < 4; s++) {
    const a = s * Math.PI / 2, c = Math.cos(a), sn = Math.sin(a);
    for (const u of [-1.3, -0.65, 0, 0.65, 1.3]) body.push(part(box(0.08, 0.86, 0.08), 0x3a3e42, c * 1.72 - sn * u, 1.03, sn * 1.72 + c * u));
    if (s % 2 === 0) for (const y of [0.85, 0.97, 1.09, 1.21]) body.push(part(box(0.04, 0.05, 0.9), DARK, c * 1.72, y, -0.5 * c));
    for (const u of [-0.6, 0.6]) body.push(part(box(0.5, 0.18, 0.04), 0x3a3418, -sn * u + c * 1.26, 1.9, c * u + sn * 1.26, 0, a + Math.PI / 2, 0));
  }
  stripes(body, 2.4, 0.255, 14);
  const spin: Part[] = [part(torus(0.92, 0.06, 5, 20), 0x8a8a70, 0, 0, 0, Math.PI / 2, 0, 0)];
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2;
    spin.push(part(box(0.5, 0.05, 0.14), 0x6a6a5a, Math.cos(a) * 0.68, 0, Math.sin(a) * 0.68, 0, -a, 0.3));
  }
  const glow = [
    part(cyl(0.3, 0.3, 1.05, 8), 0, 0, 2.86, 0),
    ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, z]) => part(box(0.12, 0.08, 0.12), 0, x * 2.15, 0.88, z * 2.15)),
    ...[0, 1, 2, 3].map((s) => { const a = s * Math.PI / 2; return part(box(1.2, 0.06, 0.03), 0, Math.cos(a) * 1.72, 1.35, Math.sin(a) * 1.72, 0, -a + Math.PI / 2, 0); }),
    part(box(0.05, 0.08, 0.08), 0, 1.84, 0.95, 0.2), part(box(0.05, 0.08, 0.08), 0, 1.84, 0.95, 0.75),
  ];
  const dmg1: Part[] = [
    part(box(0.9, 0.5, 0.03), 0x1a1612, 1.0, 1.2, -1.72), part(box(0.03, 0.4, 0.8), 0x1a1612, 1.72, 1.6, -0.6),
    part(box(0.8, 0.04, 0.6), 0x1e1a14, -0.5, 2.19, 0.6),
    part(box(0.9, 0.6, 0.04), 0x3a3e42, 0.7, 0.45, 1.95, -1.1, 0.3, 0),
  ];
  const dmg2: Part[] = [
    part(box(1.1, 0.4, 0.03), 0x141210, -0.6, 1.4, 1.73), part(box(0.03, 0.6, 1.2), 0x141210, -1.72, 0.9, 0.2),
    part(box(0.12, 1.1, 0.12), STEEL, 1.3, 2.32, 0.9, 0.2, 0, 1.2),
    ...[[1.9, 1.7], [-1.2, 2.0], [2.0, -1.6], [0.4, -2.1]].map(([x, z], i) => part(dodeca(0.16 + i * 0.03), 0x5a5650, x, 0.28, z)),
  ];
  return { body, glow: { parts: glow, color: 0x7affd8, pulse: 0 }, spin, spinY: 2.35, dmg: [dmg1, dmg2] };
}

// The armory, 3x3: a plank shop with a tin roof, a striped awning over the door, a sign with a
// rifle on it, crates and ammo boxes stacked outside, a barrel and a workbench.
function armoryModel(): Model {
  const plank = 0x7e6446, plankDk = 0x5a4630, tin = 0x6a6e70, tinDk = 0x575b5e, crate = 0x8a6a3a, ammo = 0x4e5a34;
  const p: Part[] = [
    part(box(2.95, 0.12, 2.95), 0x6e675c, 0, 0.06, 0),
    part(box(2.0, 1.3, 2.3), plank, -0.35, 0.77, 0),
    ...[0.35, 0.65, 0.95, 1.25].flatMap((y) => [
      part(box(2.02, 0.03, 0.03), plankDk, -0.35, y, 1.16), part(box(2.02, 0.03, 0.03), plankDk, -0.35, y, -1.16),
      part(box(0.03, 0.03, 2.32), plankDk, 0.66, y, 0)]),
    ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, z]) => part(box(0.12, 1.42, 0.12), 0x3e3022, -0.35 + x * 1.0, 0.77, z * 1.15)),
    // Tin roof, ridge and eaves.
    part(box(2.4, 0.07, 1.42), tin, -0.35, 1.68, 0.6, 0.42, 0, 0),
    part(box(2.4, 0.07, 1.42), tinDk, -0.35, 1.68, -0.6, -0.42, 0, 0),
    part(box(2.45, 0.09, 0.12), 0x4a4e50, -0.35, 1.97, 0),
    ...[-1.1, -0.5, 0.1, 0.7].map((x) => part(box(0.03, 0.08, 1.4), 0x5a5e60, x - 0.35 + 0.35, 1.7, 0.6, 0.42, 0, 0)),
    // Door, step and sign.
    part(box(0.05, 0.95, 0.62), 0x2e2218, 0.67, 0.6, 0),
    part(box(0.03, 0.08, 0.08), 0xc0a040, 0.7, 0.62, 0.22),
    part(box(0.3, 0.08, 0.8), 0x5a5650, 0.8, 0.12, 0),
    part(box(0.07, 0.42, 1.3), 0x3a2a1a, 0.72, 1.62, 0),
    part(box(0.02, 0.36, 1.24), 0x8a2a20, 0.76, 1.62, 0),
    part(box(0.03, 0.06, 0.62), 0xe0d090, 0.78, 1.68, 0.02),
    part(box(0.03, 0.12, 0.08), 0xe0d090, 0.78, 1.58, -0.12),
    part(box(0.03, 0.08, 0.22), 0xe0d090, 0.78, 1.64, -0.36),
    part(box(0.03, 0.04, 0.04), 0xe0d090, 0.78, 1.63, 0.38),
    // Windows, boarded up.
    part(box(0.6, 0.4, 0.03), 0x1a1a18, -0.35, 0.95, 1.17), part(box(0.7, 0.08, 0.03), plankDk, -0.35, 0.98, 1.19, 0, 0, 0.3),
    part(box(0.6, 0.4, 0.03), 0x1a1a18, -0.35, 0.95, -1.17), part(box(0.7, 0.08, 0.03), plankDk, -0.35, 0.92, -1.19, 0, 0, -0.25),
    // Crates and ammo boxes by the door, a barrel, a workbench along the back.
    part(box(0.45, 0.42, 0.45), crate, 1.1, 0.33, 0.95, 0, 0.2, 0),
    part(box(0.4, 0.38, 0.4), 0x7a5a30, 1.15, 0.73, 0.95, 0, -0.15, 0),
    part(box(0.47, 0.03, 0.47), 0x5a4020, 1.1, 0.55, 0.95, 0, 0.2, 0),
    part(box(0.42, 0.4, 0.42), crate, 1.15, 0.32, 0.45, 0, -0.1, 0),
    part(box(0.36, 0.2, 0.22), ammo, 1.12, 0.22, -0.55), part(box(0.36, 0.2, 0.22), ammo, 1.14, 0.42, -0.58, 0, 0.2, 0),
    part(box(0.36, 0.2, 0.22), 0x5a6038, 1.18, 0.22, -0.82, 0, -0.3, 0),
    part(cyl(0.2, 0.2, 0.55, 8), RUST, 1.15, 0.4, -1.2), part(cyl(0.21, 0.21, 0.04, 8), DARK, 1.15, 0.6, -1.2),
    part(box(0.4, 0.06, 1.4), 0x6a5034, -1.18, 0.7, -0.2), part(box(0.06, 0.6, 0.06), 0x4a3824, -1.18, 0.37, 0.4), part(box(0.06, 0.6, 0.06), 0x4a3824, -1.18, 0.37, -0.8),
    part(box(0.12, 0.14, 0.12), STEEL, -1.18, 0.8, 0.2), part(box(0.5, 0.06, 0.08), 0x2b2b2b, -1.18, 0.77, -0.4, 0, 1.4, 0),
    // Sandbags in front of the crates.
    ...[0.2, 0.55, 0.9, 1.25].map((z) => part(box(0.22, 0.16, 0.34), 0x9a8c66, 1.35, 0.2, z - 0.55, 0, 0.1, 0)),
  ];
  // The awning: red and off-white stripes, sloping down over the door.
  for (let i = 0; i < 5; i++) p.push(part(box(0.62, 0.04, 0.28), i % 2 ? 0xd8d0b8 : 0x9a2a22, 0.98, 1.3, -0.56 + i * 0.28, 0, 0, -0.3));
  p.push(part(box(0.04, 0.95, 0.05), 0x3e3022, 1.27, 0.7, 0.68), part(box(0.04, 0.95, 0.05), 0x3e3022, 1.27, 0.7, -0.68));
  return { body: p, glow: { parts: [part(box(0.12, 0.08, 0.12), 0, 0.78, 1.18, 0.4), part(box(0.1, 0.1, 0.1), 0, 0.78, 1.18, -0.4)], color: 0xffc070, pulse: 2.5 } };
}

// What the generator's tiers add to it: at II a radio mast and dish on scaffolding by the
// housing, at III floodlights on poles at its four corners. Body parts, then lamps that glow.
function tierParts(tier: number): { body: Part[]; lamps: Part[] } {
  const body: Part[] = [], lamps: Part[] = [];
  if (tier >= 2) {
    for (const [x, z] of [[1.55, -1.55], [2.05, -1.55], [1.55, -2.05], [2.05, -2.05]]) body.push(part(box(0.06, 2.6, 0.06), RUST, x, 1.3, z));
    for (const y of [0.6, 1.3, 2.0, 2.6]) body.push(part(box(0.56, 0.05, 0.56), STEEL, 1.8, y, -1.8));
    body.push(part(cyl(0.04, 0.06, 1.6, 6), STEEL, 1.8, 3.4, -1.8), part(cone(0.3, 0.12, 10), 0xb8bcbc, 1.8, 2.85, -1.8, 0.6, 0, 0.5));
    lamps.push(part(box(0.08, 0.08, 0.08), 0, 1.8, 4.22, -1.8));
  }
  if (tier >= 3) {
    for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      body.push(part(cyl(0.05, 0.07, 3.2, 6), STEEL, x * 2.35, 1.6, z * 2.35), part(box(0.5, 0.22, 0.14), DARK, x * 2.3, 3.25, z * 2.3, 0, Math.atan2(-z, x), 0.4));
      lamps.push(part(box(0.42, 0.16, 0.04), 0, x * 2.32, 3.22, z * 2.32, 0, Math.atan2(-z, x) + Math.PI / 2, 0));
    }
  }
  return { body, lamps };
}

// An evolved turret's collar: a brass band round its foot and a lamp on a stalk, amber for
// the first branch and violet for the second.
const EVO = [0xffb030, 0xc070ff];
function evoParts(): Part[] {
  return [part(cyl(0.44, 0.46, 0.08, 10), 0xb08a40, 0, 0.12, 0), part(cyl(0.02, 0.02, 0.5, 4), DARK, -0.36, 0.4, 0.36)];
}

// The sniper tower's rifle, the green AWM (awm.ts): its bore this high over the ground (the
// effects' muzzle height in main.ts), pitching on its recoil about a point this far along it.
// The tower's deck is this high, so it stands over every other turret and the walls. The bore
// is 0.6 above it, high enough that the stock never comes down into the sandbag rim (its top
// 0.16 over the deck, 0.34 to 0.65 from the centre) at any heading, at rest or at the top of
// the kick.
export const SNIPER_DECK = 2.78;
export const SNIPER_HEAD_Y = SNIPER_DECK + 0.6;
export const SNIPER_MUZZLE = AWM_MUZZLE;
const SNIPER_PIVOT = -0.3;

// How far a sniper's recoil throws its rifle back and tips it up, and how hard the mount
// shudders.
const SNIPER_KICK = { back: 0.3, pitch: 0.34, shudder: 0.05 };

// The cradle the rifle rides in, turning on the pintle: a turntable, a yoke with steel cheeks
// either side of the stock, and a recoil buffer on each side. The yoke sits low enough that the
// rifle's magazine (its foot 0.24 under the bore) clears it.
function sniperCradle(): Part[] {
  const p: Part[] = [
    part(cyl(0.16, 0.18, 0.06, 10), STEEL, 0, -0.31, 0),
    part(box(0.3, 0.05, 0.26), DARK, 0, -0.27, 0),
  ];
  for (const z of [-1, 1]) {
    p.push(part(box(0.3, 0.16, 0.03), STEEL, 0, -0.15, z * 0.11));
    p.push(part(cyl(0.028, 0.028, 0.34, 6), 0x6a6e70, 0.02, -0.16, z * 0.15, 0, 0, Math.PI / 2));
    p.push(part(cyl(0.036, 0.036, 0.08, 6), DARK, -0.15, -0.16, z * 0.15, 0, 0, Math.PI / 2));
  }
  return p;
}

// The sniper's recoil, time s seconds after a shot: a slam back to full in a few hundredths of
// a second, then a damped settle that is still by about 1.2 s, inside its fastest reload
// (0.35/s at level 0, 0.61 with a full fire rate track, 0.70 with a pylon: 1.42 s).
function sniperKick(s: number, decay: number): number {
  if (s < 0) return 0;
  if (s < 0.035) return s / 0.035;
  const u = s - 0.035;
  return u > 1.6 ? 0 : Math.exp(-u * decay) * Math.cos(u * 5.5);
}

// Models face +x and stand on y = 0, centred on their footprint.
function modelFor(kind: number): Model {
  switch (kind) {
    case K_CORE: return coreModel();
    case K_ARMORY: return armoryModel();
    case K_GUN: return {
      // A sandbag nest with a machine gun.
      body: [
        ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => part(box(0.32, 0.2, 0.2), i % 2 ? 0x9a8c66 : 0x8a7c58, Math.cos(i * Math.PI / 4) * 0.38, 0.1, Math.sin(i * Math.PI / 4) * 0.38, 0, -i * Math.PI / 4 + Math.PI / 2, 0)),
        ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => part(box(0.3, 0.18, 0.2), i % 2 ? 0x8a7c58 : 0xa49670, Math.cos((i + 0.5) * Math.PI / 4) * 0.36, 0.28, Math.sin((i + 0.5) * Math.PI / 4) * 0.36, 0, -(i + 0.5) * Math.PI / 4 + Math.PI / 2, 0)),
        part(cyl(0.06, 0.08, 0.4, 5), 0x2c2c2a, 0, 0.4, 0),
      ],
      head: [
        part(box(0.36, 0.18, 0.2), 0x3a3c34, 0, 0, 0),
        part(box(0.22, 0.1, 0.14), 0x4a4c40, -0.24, -0.02, 0),
        part(cyl(0.04, 0.04, 0.6, 5), 0x1e1e1c, 0.45, 0.02, 0, 0, 0, Math.PI / 2),
        part(box(0.12, 0.14, 0.08), 0x5a5a2a, 0.02, -0.04, 0.14),
      ],
      headY: 0.66,
    };
    case K_CANNON: return {
      // A mortar pit: a low wall of crates, an olive tube on a baseplate.
      body: [
        part(box(0.9, 0.3, 0.9), 0x6a5a40, 0, 0.15, 0),
        part(box(0.7, 0.06, 0.7), 0x3e3a30, 0, 0.32, 0),
        part(cyl(0.3, 0.34, 0.2, 8), 0x4a4c3a, 0, 0.45, 0),
      ],
      head: [
        part(box(0.36, 0.26, 0.4), 0x4e5636, 0, 0, 0),
        part(cyl(0.12, 0.14, 0.75, 7), 0x3e4430, 0.42, 0.08, 0, 0, 0, Math.PI / 2),
        part(cyl(0.15, 0.15, 0.1, 7), 0x2a2c24, 0.8, 0.08, 0, 0, 0, Math.PI / 2),
        part(box(0.1, 0.06, 0.1), 0xd0c060, -0.1, 0.16, 0.12),
      ],
      headY: 0.75,
    };
    case K_FROST: return {
      body: [
        part(cyl(0.3, 0.42, 0.25, 6), 0x6e7a84, 0, 0.12, 0),
        part(cyl(0.18, 0.28, 0.85, 6), 0xb4c0c8, 0, 0.67, 0),
        part(cyl(0.3, 0.2, 0.1, 6), 0xa8c0d8, 0, 1.12, 0),
      ],
      glow: { parts: [part(octa(0.25), 0, 0, 0, 0, 0, 0, 0, 1, 1.7, 1)], color: 0x9fe4ff, pulse: 2 },
      spinY: 1.5,
    };
    case K_TESLA: return {
      body: [
        part(cyl(0.36, 0.44, 0.3, 8), 0x4d4a55, 0, 0.15, 0),
        part(cyl(0.1, 0.14, 1.2, 6), 0x6a6070, 0, 0.9, 0),
        part(torus(0.26, 0.06, 5, 12), 0xc07a3a, 0, 0.55, 0, Math.PI / 2, 0, 0),
        part(torus(0.22, 0.06, 5, 12), 0xc07a3a, 0, 0.8, 0, Math.PI / 2, 0, 0),
        part(torus(0.18, 0.06, 5, 12), 0xc07a3a, 0, 1.05, 0, Math.PI / 2, 0, 0),
      ],
      glow: { parts: [part(ico(0.2, 1), 0, 0, 1.6, 0)], color: 0xd8b0ff, pulse: 9 },
    };
    case K_SNIPER: {
      // A plank watchtower on four legs, a sandbagged platform up top, and on a pintle in the
      // middle of it the green AWM in a cradle.
      const wood = 0x5a4430, wd2 = 0x6a5034, bag = 0x9a8c66, D = SNIPER_DECK, legH = D - 0.08;
      const body: Part[] = [part(box(0.9, 0.06, 0.9), 0x5a5850, 0, 0.03, 0)];
      // Four stout legs on footing blocks, ringed by rails and braced crosswise in every bay
      // on every side, so it stands tall without looking spindly.
      for (const [x, z] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        body.push(part(box(0.12, legH, 0.12), wood, x * 0.33, legH / 2, z * 0.33));
        body.push(part(box(0.2, 0.1, 0.2), CONCRETE, x * 0.33, 0.05, z * 0.33));
      }
      const rails = [0.35, 1.15, 1.95, D - 0.14];
      for (const y of rails) {
        body.push(part(box(0.66, 0.06, 0.06), wd2, 0, y, 0.33), part(box(0.66, 0.06, 0.06), wd2, 0, y, -0.33));
        body.push(part(box(0.06, 0.06, 0.66), wd2, 0.33, y, 0), part(box(0.06, 0.06, 0.66), wd2, -0.33, y, 0));
      }
      for (let b = 0; b + 1 < rails.length; b++) {
        const y0 = rails[b], y1 = rails[b + 1], h = y1 - y0, len = Math.hypot(0.66, h), a = Math.atan2(0.66, h), sgn = b % 2 ? 1 : -1;
        for (const s of [-1, 1]) {
          body.push(part(box(0.05, len, 0.04), wd2, 0, (y0 + y1) / 2, s * 0.34, 0, 0, sgn * a));
          body.push(part(box(0.04, len, 0.05), wd2, s * 0.34, (y0 + y1) / 2, 0, -sgn * a, 0, 0));
        }
      }
      body.push(part(box(0.92, 0.08, 0.92), wd2, 0, D - 0.04, 0));
      body.push(part(box(0.9, 0.16, 0.12), bag, 0, D + 0.08, 0.4), part(box(0.9, 0.16, 0.12), bag, 0, D + 0.08, -0.4), part(box(0.12, 0.16, 0.66), bag, -0.4, D + 0.08, 0));
      // A ladder up the back, all the way to the deck.
      body.push(part(box(0.04, D, 0.04), wood, -0.5, D / 2, 0.12), part(box(0.04, D, 0.04), wood, -0.5, D / 2, -0.12));
      for (let y = 0.2; y < D - 0.1; y += 0.27) body.push(part(box(0.03, 0.03, 0.26), wd2, -0.5, y, 0));
      // The pintle the rifle turns on, bolted to the deck.
      body.push(part(box(0.32, 0.04, 0.32), DARK, 0, D + 0.02, 0), part(cyl(0.05, 0.07, 0.3, 8), STEEL, 0, D + 0.15, 0));
      return { body, head: sniperCradle(), headY: SNIPER_HEAD_Y, gun: awmParts(), gunX: SNIPER_PIVOT };
    }
    case K_MISSILE: {
      // A steel plinth with a box of six rockets on a turntable, red noses showing.
      const body: Part[] = [
        part(box(0.9, 0.22, 0.9), 0x4a4e44, 0, 0.11, 0),
        part(cyl(0.2, 0.28, 0.4, 8), STEEL, 0, 0.42, 0),
      ];
      stripes(body, 0.45, 0.23, 4);
      const head: Part[] = [
        part(box(0.56, 0.44, 0.62), 0x4e5636, 0, 0.12, 0),
        part(box(0.5, 0.06, 0.66), 0x3e4430, -0.02, 0.36, 0),
        part(box(0.2, 0.3, 0.12), DARK, -0.1, -0.02, 0.36),
      ];
      for (const y of [0.02, 0.22]) for (const z of [-0.19, 0, 0.19]) {
        head.push(part(cyl(0.075, 0.075, 0.04, 8), 0x1a1a18, 0.28, y, z, 0, 0, Math.PI / 2));
        head.push(part(cone(0.055, 0.1, 6), 0xb03a2a, 0.32, y, z, 0, 0, -Math.PI / 2));
      }
      return { body, head, headY: 0.68 };
    }
    case K_BAIT: case K_CATAPULT: return trapModel(kind);
    case K_PYLON: return {
      // A mast on a concrete foot, wound with copper coils, a ring turning near the top and a
      // cyan lamp on it: the amplifier.
      body: [
        part(box(0.8, 0.14, 0.8), CONCRETE, 0, 0.07, 0),
        part(cyl(0.12, 0.16, 1.5, 8), STEEL, 0, 0.85, 0),
        ...[0.45, 0.65, 0.85, 1.05].map((y) => part(cyl(0.2, 0.2, 0.1, 10), 0xb06a30, 0, y, 0)),
        ...[0, 1, 2, 3].map((k) => { const a = k * Math.PI / 2 + Math.PI / 4; return part(box(0.06, 0.5, 0.06), DARK, Math.cos(a) * 0.3, 0.3, Math.sin(a) * 0.3, Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4); }),
      ],
      spin: [part(torus(0.32, 0.035, 4, 16), 0x8a8e90, 0, 0, 0, Math.PI / 2, 0, 0), part(box(0.64, 0.03, 0.05), 0x6a6e70, 0, 0, 0)],
      spinY: 1.4,
      glow: { parts: [part(ico(0.12), 0x60f0ff, 0, 1.7, 0)], color: 0x60f0ff, pulse: 1.5 },
    };
  }
  return { body: [part(box(0.9, 0.8, 0.9), 0x888888, 0, 0.4, 0)] };
}

interface Built { body: THREE.BufferGeometry; head?: THREE.BufferGeometry; headY: number; gun?: THREE.BufferGeometry; gunX: number; glow?: THREE.BufferGeometry; glowMat?: THREE.Material; spin?: THREE.BufferGeometry; spinY: number; dmg?: THREE.BufferGeometry[] }

interface Obj {
  kind: number; x: number; y: number; level: number; owner: number; evo: number; tier: number;
  group: THREE.Group; head: THREE.Object3D | null; spin: THREE.Object3D | null; glow: THREE.Object3D | null;
  dmg: THREE.Object3D[]; spinA: number;
  aim: number; aimGoal: number; recoil: number; lastShot: number;
  // A sniper's: the rifle on its recoil pivot, and its laser sight (laser).
  gun: THREE.Object3D | null; laser: Laser | null;
}

// A sniper's laser sight: the lens it shines from, the beam and its halo, the dot and its halo
// on the mark; the creep it is on (by id, -1 none) and when it last looked for one.
interface Laser { lens: THREE.Object3D; beam: THREE.Object3D[]; dot: THREE.Object3D[]; mark: number; lookedAt: number }

const tmpV = new THREE.Vector3(), tmpW = new THREE.Vector3(), tmpD = new THREE.Vector3(), AXIS_X = new THREE.Vector3(1, 0, 0);

// Walls and gates: an instanced post per tile and an instanced arm towards each connected
// neighbour, so lines of walls read as one wall.
// outward is the unit step from tile x, y away from the generator, along the axis it is
// further out on: where an open gate's leaves swing to.
function outward(game: Game, x: number, y: number): [number, number] {
  const w = game.welcome;
  if (!w) return [0, -1];
  const dx = x + 0.5 - w.core.x, dy = y + 0.5 - w.core.y;
  return Math.abs(dx) > Math.abs(dy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1];
}

class WallSet {
  posts: THREE.InstancedMesh; arms: THREE.InstancedMesh; gposts: THREE.InstancedMesh; garms: THREE.InstancedMesh;
  constructor(private group: THREE.Group, private mat: THREE.Material, cap: number) {
    const mk = (g: THREE.BufferGeometry) => this.mesh(g, cap);
    // Walls are plank barricades on a sandbag footing between log posts; gates are chain-link
    // on a steel frame with a hazard-striped top bar.
    const bag = 0x9a8c66, bagDk = 0x857854;
    this.posts = mk(merge([
      part(box(0.7, 0.1, 0.5), 0x8a8478, 0, 0.05, 0),
      part(box(0.3, 1.4, 0.3), 0x5a4430, 0, 0.7, 0),
      part(box(0.34, 0.06, 0.34), 0x3e3022, 0, 1.0, 0),
      part(cone(0.18, 0.18, 4), 0x4a3828, 0, 1.49, 0, 0, Math.PI / 4, 0),
      part(box(0.36, 0.2, 0.26), bag, 0.05, 0.2, 0.2, 0, 0.3, 0),
      part(box(0.36, 0.2, 0.26), bagDk, -0.08, 0.2, -0.2, 0, -0.2, 0),
      part(box(0.32, 0.18, 0.24), bag, 0, 0.38, 0.02, 0, 0.8, 0),
      part(box(0.04, 0.04, 0.36), 0x2a2a2a, 0.15, 1.12, 0),
    ]));
    this.arms = mk(merge([
      part(box(0.5, 0.2, 0.34), bag, 0.25, 0.11, 0.04, 0, 0.06, 0),
      part(box(0.46, 0.18, 0.3), bagDk, 0.27, 0.29, -0.02, 0, -0.08, 0),
      part(box(0.52, 0.22, 0.1), 0x8a6a46, 0.25, 0.5, 0.06),
      part(box(0.52, 0.22, 0.1), 0x7a5c3c, 0.25, 0.74, -0.03),
      part(box(0.5, 0.2, 0.1), 0x92724c, 0.26, 0.97, 0.04, 0.05, 0, 0.04),
      part(box(0.46, 0.16, 0.1), 0x6e5236, 0.24, 1.17, -0.02, 0.1, 0, -0.06),
      part(box(0.07, 0.86, 0.06), 0x4e3a26, 0.27, 0.82, -0.09, 0, 0, 0.55),
      ...[0.5, 0.74, 0.97].map((y) => part(box(0.03, 0.03, 0.12), 0x2a2a2a, 0.42, y, 0.06)),
    ]));
    this.gposts = mk(merge([
      part(box(0.5, 0.08, 0.5), 0x8a8478, 0, 0.04, 0),
      part(box(0.16, 1.3, 0.16), 0x5a5c5a, 0, 0.65, 0),
      part(box(0.2, 0.08, 0.2), HAZARD, 0, 1.3, 0),
      part(box(0.2, 0.12, 0.2), DARK, 0, 0.14, 0),
      part(box(0.06, 0.06, 0.06), 0xffb040, 0, 1.38, 0),
    ]));
    this.garms = mk(merge([
      part(box(0.5, 0.95, 0.025), 0x8a8e8c, 0.25, 0.58, 0),
      ...[0.2, 0.4, 0.6, 0.8, 1.0].map((y) => part(box(0.5, 0.015, 0.035), 0x6a6e6c, 0.25, y, 0)),
      ...[0, 1, 2, 3].map((k) => part(box(0.125, 0.07, 0.09), k % 2 ? DARK : HAZARD, 0.0625 + k * 0.125, 1.08, 0)),
      part(box(0.5, 0.05, 0.08), 0x4a4c4a, 0.25, 0.1, 0),
      part(box(0.04, 0.98, 0.06), 0x4a4c4a, 0.48, 0.58, 0),
      part(box(0.05, 1.05, 0.04), 0x4a4c4a, 0.25, 0.58, 0, 0, 0, 0.47),
    ]));
  }
  private mesh(g: THREE.BufferGeometry, cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(g, this.mat, cap);
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
    this.group.add(m);
    return m;
  }
  // Room for n walls, each with up to four arms. Growing makes new meshes: the renderer binds
  // a mesh's instance matrices once, so a bigger buffer swapped into the old mesh is never
  // drawn, and walls past the first 128 stood there unseen.
  ensure(n: number): void {
    const grow = (m: THREE.InstancedMesh) => {
      if (m.instanceMatrix.count >= n * 4) return m;
      this.group.remove(m);
      m.dispose();
      return this.mesh(m.geometry, n * 8);
    };
    this.posts = grow(this.posts); this.arms = grow(this.arms);
    this.gposts = grow(this.gposts); this.garms = grow(this.garms);
  }
}

export class Structs {
  group = new THREE.Group();
  private objs = new Map<number, Obj>();
  private built = new Map<number, Built>();
  private mat = litMaterial();
  private walls: WallSet;
  private version = -1;
  private defs: StructDef[] = [];
  private pipGeo = new Map<number, THREE.BufferGeometry>();
  private extraGeo = new Map<string, THREE.BufferGeometry>();
  private evoMats = EVO.map((c) => glowMaterial(c, 2));
  private lampMat = glowMaterial(0xfff2c0);
  private ringGeo = new Map<number, THREE.BufferGeometry>();
  // The laser sight's pieces: a unit beam along +x from its start, and a ball for the dot.
  private beamGeo = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0, 0);
  private dotGeo = sphere(1, 8, 6);
  private laserMats = [laserMaterial(0xff2a18, 2.2), laserMaterial(0xff1808, 0.35)];

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.walls = new WallSet(this.group, this.mat, 512);
  }

  setup(defs: StructDef[]): void {
    this.defs = defs;
    for (const o of this.objs.values()) this.group.remove(o.group);
    this.objs.clear();
    this.version = -1;
  }

  private buildKind(kind: number): Built {
    let b = this.built.get(kind);
    if (b) return b;
    const m = modelFor(kind);
    b = { body: merge(m.body), headY: m.headY ?? 0, gunX: m.gunX ?? 0, spinY: m.spinY ?? 0 };
    if (m.head) b.head = merge(m.head);
    if (m.gun) b.gun = merge(m.gun);
    if (m.glow) { b.glow = merge(m.glow.parts); b.glowMat = kind === K_CORE ? coreGlowMaterial() : glowMaterial(m.glow.color, m.glow.pulse); }
    if (m.spin) b.spin = merge(m.spin);
    if (m.dmg) b.dmg = m.dmg.map((d) => merge(d));
    this.built.set(kind, b);
    return b;
  }

  // A turret's upgrades: a column of pips on its side for each track, in the track's colour.
  private pips(f: Game['cur'], i: number): THREE.BufferGeometry {
    let key = 0;
    for (let t = 0; t < TURRET_TRACKS; t++) key = key * 8 + f.sLv[i * TURRET_TRACKS + t];
    let g = this.pipGeo.get(key);
    if (!g) {
      const p: Part[] = [];
      for (let t = 0; t < TURRET_TRACKS; t++) {
        for (let l = 0; l < f.sLv[i * TURRET_TRACKS + t]; l++) p.push(part(box(0.09, 0.09, 0.09), PIP[t], 0.47, 0.1 + l * 0.12, -0.21 + t * 0.14));
      }
      g = merge(p.length ? p : [part(box(0.001, 0.001, 0.001), 0)]);
      this.pipGeo.set(key, g);
    }
    return g;
  }

  private ring(owner: number, w: number): THREE.BufferGeometry {
    const key = owner * 16 + w;
    let g = this.ringGeo.get(key);
    if (!g) {
      const r = w * 0.5 + 0.02;
      g = merge([
        part(box(r * 2, 0.06, 0.07), playerColor(owner), 0, 0.03, r), part(box(r * 2, 0.06, 0.07), playerColor(owner), 0, 0.03, -r),
        part(box(0.07, 0.06, r * 2), playerColor(owner), r, 0.03, 0), part(box(0.07, 0.06, r * 2), playerColor(owner), -r, 0.03, 0),
      ]);
      this.ringGeo.set(key, g);
    }
    return g;
  }

  private make(game: Game, i: number): Obj {
    const f = game.cur;
    const kind = f.sKind[i], b = this.buildKind(kind);
    const g = new THREE.Group();
    const w = f.sW[i], h = f.sH[i];
    g.position.set(f.sX[i] + w / 2, 0, f.sY[i] + h / 2);
    const body = new THREE.Mesh(b.body, this.mat);
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    let head: THREE.Object3D | null = null, spin: THREE.Object3D | null = null, glow: THREE.Object3D | null = null;
    let gun: THREE.Object3D | null = null, laser: Laser | null = null;
    if (b.head) {
      head = new THREE.Mesh(b.head, this.mat);
      head.position.y = b.headY;
      head.castShadow = true;
      g.add(head);
      if (b.gun) {
        // The rifle pitches on its recoil about gunX along it.
        gun = new THREE.Group();
        gun.position.x = b.gunX;
        const gm = new THREE.Mesh(b.gun, this.mat);
        gm.position.x = -b.gunX;
        gm.castShadow = true;
        gun.add(gm);
        head.add(gun);
        const lens = new THREE.Object3D();
        lens.position.set(...AWM_LENS);
        gm.add(lens);
        const piece = (geo: THREE.BufferGeometry, k: number) => {
          const m = new THREE.Mesh(geo, this.laserMats[k]);
          m.renderOrder = 3; m.frustumCulled = false; m.visible = false;
          g.add(m);
          return m;
        };
        laser = { lens, beam: [piece(this.beamGeo, 0), piece(this.beamGeo, 1)], dot: [piece(this.dotGeo, 0), piece(this.dotGeo, 1)], mark: -1, lookedAt: -1e9 };
      }
    }
    if (b.glow) {
      glow = new THREE.Mesh(b.glow, b.glowMat);
      if (kind === K_FROST) glow.position.y = b.spinY;
      g.add(glow);
    }
    if (b.spin) { spin = new THREE.Mesh(b.spin, this.mat); spin.position.y = b.spinY; spin.castShadow = true; g.add(spin); }
    const dmg: THREE.Object3D[] = [];
    for (const d of b.dmg ?? []) { const m = new THREE.Mesh(d, this.mat); m.visible = false; m.castShadow = true; g.add(m); dmg.push(m); }
    if (isTrapKind(kind)) trapMake(g, head, kind, this.mat);
    const def = this.defs[kind];
    const evo = f.sEvo[i], tier = kind === K_CORE ? f.tier : 0;
    // The trim that throws no shadow and never moves (the upgrade pips, the owner's ring, an
    // evolution's fittings) is one mesh: as three were it was three draws a turret, and on
    // WebGL2 every draw is CPU time.
    const trim: THREE.BufferGeometry[] = [];
    if (def?.turret) trim.push(this.pips(f, i));
    if (kind !== K_WALL && kind !== K_GATE) trim.push(this.ring(f.sOwner[i], w));
    if (evo) trim.push(this.extra('evo', () => merge(evoParts())));
    if (trim.length) {
      let pip = 0;
      for (let t = 0; t < TURRET_TRACKS; t++) pip = pip * 8 + f.sLv[i * TURRET_TRACKS + t];
      const key = `trim${def?.turret ? pip : -1}:${kind !== K_WALL && kind !== K_GATE ? f.sOwner[i] * 16 + w : -1}:${evo ? 1 : 0}`;
      g.add(new THREE.Mesh(this.extra(key, () => concat(trim)), this.mat));
    }
    if (evo) {
      g.add(new THREE.Mesh(this.extra('evoLamp', () => merge([part(ico(0.07), 0, -0.36, 0.7, 0.36)])), this.evoMats[evo - 1]));
    }
    if (tier >= 2) {
      const tp = tierParts(tier);
      const tb = new THREE.Mesh(this.extra(`tier${tier}`, () => merge(tp.body)), this.mat);
      tb.castShadow = true;
      g.add(tb, new THREE.Mesh(this.extra(`lamps${tier}`, () => merge(tp.lamps)), this.lampMat));
    }
    const aim = Math.random() * 6.28;
    return { kind, x: f.sX[i], y: f.sY[i], level: f.sLevel[i], owner: f.sOwner[i], evo, tier, group: g, head, spin, glow, dmg, spinA: 0, aim, aimGoal: aim, recoil: 0, lastShot: -1e9, gun, laser };
  }

  private extra(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let g = this.extraGeo.get(key);
    if (!g) { g = make(); this.extraGeo.set(key, g); }
    return g;
  }

  private sync(game: Game): void {
    const f = game.cur;
    const seen = new Set<number>();
    let nw = 0;
    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sAlive[i]) continue;
      const k = f.sKind[i];
      if (k === K_WALL || k === K_GATE) { nw++; continue; }
      seen.add(i);
      const o = this.objs.get(i);
      if (o && o.kind === k && o.x === f.sX[i] && o.y === f.sY[i] && o.level === f.sLevel[i] && o.owner === f.sOwner[i] && o.evo === f.sEvo[i] && (k !== K_CORE || o.tier === f.tier)) continue;
      if (o) this.group.remove(o.group);
      const n = this.make(game, i);
      if (o && o.kind === k) {
        n.aim = o.aim; n.aimGoal = o.aimGoal; n.lastShot = o.lastShot;
        if (o.laser && n.laser) n.laser.mark = o.laser.mark;
      }
      this.objs.set(i, n);
      this.group.add(n.group);
    }
    for (const [i, o] of this.objs) if (!seen.has(i)) { this.group.remove(o.group); this.objs.delete(i); }
    this.syncWalls(game, nw);
  }

  private syncWalls(game: Game, n: number): void {
    const f = game.cur, ws = this.walls;
    ws.ensure(n);
    const isWall = (x: number, y: number) => {
      const s = game.structAtTile(x, y);
      return s >= 0 && (f.sKind[s] === K_WALL || f.sKind[s] === K_GATE);
    };
    let np = 0, na = 0, gp = 0, ga = 0;
    const pa = ws.posts.instanceMatrix.array as Float32Array, aa = ws.arms.instanceMatrix.array as Float32Array;
    const gpa = ws.gposts.instanceMatrix.array as Float32Array, gaa = ws.garms.instanceMatrix.array as Float32Array;
    const dirs = [[1, 0, 0], [0, 1, Math.PI / 2], [-1, 0, Math.PI], [0, -1, -Math.PI / 2]];
    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sAlive[i]) continue;
      const k = f.sKind[i];
      if (k !== K_WALL && k !== K_GATE) continue;
      const x = f.sX[i], y = f.sY[i], cx = x + 0.5, cz = y + 0.5;
      const gate = k === K_GATE;
      // Each level makes the post a little stouter.
      writeMatrix(gate ? gpa : pa, (gate ? gp++ : np++) * 16, cx, 0, cz, 0, 1 + 0.07 * (f.sLevel[i] - 1));
      // An open gate's leaves stand swung back off the gateway, out towards the wastes.
      const out = gate && f.sOpen[i] ? outward(game, x, y) : null;
      for (const [dx, dy, a] of dirs) {
        if (!isWall(x + dx, y + dy)) continue;
        const r = out ? Math.atan2(dy * 0.2 + out[1], dx * 0.2 + out[0]) : a;
        writeMatrix(gate ? gaa : aa, (gate ? ga++ : na++) * 16, cx, 0, cz, r, 1);
      }
    }
    const set = (m: THREE.InstancedMesh, c: number) => { m.count = c; m.instanceMatrix.needsUpdate = true; };
    set(ws.posts, np); set(ws.arms, na); set(ws.gposts, gp); set(ws.garms, ga);
  }

  // A turret fired from (x0, y0) at (x1, y1): turn its head that way.
  onShot(game: Game, x0: number, y0: number, x1: number, y1: number, now: number): void {
    const s = game.structAtTile(Math.floor(x0), Math.floor(y0));
    const o = this.objs.get(s);
    if (!o) return;
    o.aimGoal = Math.atan2(y1 - y0, x1 - x0);
    o.recoil = 1;
    o.lastShot = now;
    // A sniper's laser goes on what it just shot: the creep nearest where the round ended.
    if (o.laser) {
      const f = game.cur;
      let best = -1, bd = 2.25;
      for (let j = 0; j < f.nCreeps; j++) {
        const d = (f.cX[j] - x1) ** 2 + (f.cY[j] - y1) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      if (best >= 0) o.laser.mark = f.cId[best];
    }
  }

  // A sniper's mark, as an index into the frame's creeps, or -1. The page is not told what a
  // sniper aims at between shots, so the laser stays on what it last shot while that lives and
  // is in reach; with nothing, it looks a few times a second for what the host would pick, the
  // toughest creep in reach, judged by each creep's kind's health times the share it has left.
  private sniperMark(game: Game, i: number, o: Obj, L: Laser, now: number): number {
    const f = game.cur, def = this.defs[o.kind], wd = game.welcome;
    if (!def || !wd) return -1;
    const r = turretRange(def, f.sLv[i * TURRET_TRACKS + TTrack.Range], f.sEvo[i]), rr = r * r;
    const cx = o.group.position.x, cz = o.group.position.z;
    const inReach = (j: number) => (game.rx[j] - cx) ** 2 + (game.ry[j] - cz) ** 2 <= rr;
    const at = L.mark >= 0 ? game.indexById[L.mark] : -1;
    if (at >= 0 && at < f.nCreeps && f.cId[at] === L.mark && inReach(at)) return at;
    L.mark = -1;
    if (now - L.lookedAt < 300) return -1;
    L.lookedAt = now;
    let best = -1, most = 0;
    for (let j = 0; j < f.nCreeps; j++) {
      const hp = (wd.creeps[f.cKind[j]]?.hp ?? 0) * f.cHp[j];
      if (hp > most && inReach(j)) { most = hp; best = j; }
    }
    if (best >= 0) L.mark = f.cId[best];
    return best;
  }

  // Points a sniper's laser from its lens to the dot on its mark, at strength k (0 off).
  private shine(game: Game, o: Obj, L: Laser, j: number, k: number): void {
    const on = j >= 0 && k > 0.01;
    for (const m of [...L.beam, ...L.dot]) { m.visible = on; m.userData.laser = k; }
    if (!on) return;
    const g = o.group, wd = game.welcome!;
    o.head!.updateWorldMatrix(true, true);
    const from = L.lens.getWorldPosition(tmpV).sub(g.position);
    const rad = wd.creeps[game.cur.cKind[j]]?.radius ?? 0.5;
    const to = tmpW.set(game.rx[j] - g.position.x, 0.35 + rad * 0.6, game.ry[j] - g.position.z);
    const d = tmpD.subVectors(to, from), len = d.length();
    if (len < 0.05) { for (const m of [...L.beam, ...L.dot]) m.visible = false; return; }
    d.divideScalar(len);
    L.beam.forEach((m, n) => {
      m.position.copy(from);
      m.quaternion.setFromUnitVectors(AXIS_X, d);
      const w = n ? 0.13 : 0.045;
      m.scale.set(len, w, w);
    });
    L.dot.forEach((m, n) => { m.position.copy(to).addScaledVector(d, -rad * 0.5); m.scale.setScalar(n ? 0.24 : 0.08); });
  }

  setHover(id: number, on: boolean): void {
    const o = this.objs.get(id);
    if (o) o.group.traverse((c) => { c.userData.hl = on ? 1 : 0; });
  }

  update(game: Game, now: number, dt: number): void {
    if (game.structsVersion !== this.version) { this.version = game.structsVersion; this.sync(game); }
    const t = now / 1000, f = game.cur;
    for (const [i, o] of this.objs) {
      if (o.kind === K_CORE || o.dmg.length) {
        const r = f.sHp[i] / Math.max(1, f.sMaxHp[i]);
        const d = Math.min(1, Math.max(0, (0.6 - r) / 0.4));
        if (o.glow) o.glow.userData.dmg = d;
        if (o.dmg[0]) o.dmg[0].visible = r < 0.6;
        if (o.dmg[1]) o.dmg[1].visible = r < 0.3;
        if (o.spin) { o.spinA += dt * (0.9 - 0.7 * d) * (d > 0.6 && Math.sin(t * 3) > 0.6 ? 0.1 : 1); o.spin.rotation.y = o.spinA; }
        continue;
      }
      if (isTrapKind(o.kind)) { trapUpdate(o.group, o.head, o.kind, f.sTrap[i], f.sFacing[i], t, dt); continue; }
      if (o.head && o.laser && o.gun) {
        // A sniper: its rifle follows the laser's mark, slams back and up on each shot and
        // settles; the laser cuts out at the shot and flickers back on as it settles.
        const L = o.laser, j = this.sniperMark(game, i, o, L, now), s = (now - o.lastShot) / 1000;
        if (j >= 0) o.aimGoal = Math.atan2(game.ry[j] - o.group.position.z, game.rx[j] - o.group.position.x);
        else if (s > 2.5) o.aimGoal += dt * 0.4;
        let d = o.aimGoal - o.aim;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        o.aim += d * Math.min(1, dt * 10);
        const K = SNIPER_KICK;
        const shudder = s < 0.5 ? Math.sin(s * 47) * K.shudder * Math.exp(-s * 9) : 0;
        o.head.rotation.y = -o.aim + shudder;
        o.gun.position.x = SNIPER_PIVOT - K.back * Math.max(-0.25, sniperKick(s, 4.2));
        o.gun.rotation.z = K.pitch * Math.max(-0.12, sniperKick(s - 0.01, 3.6));
        // Off through the slam, then back over 0.35 s with two short blinks as the rifle
        // settles, then steady.
        let k = 1;
        if (s < 0.22) k = 0;
        else if (s < 0.57) { const u = (s - 0.22) / 0.35; k = (0.4 + 0.6 * u) * ((u > 0.2 && u < 0.3) || (u > 0.55 && u < 0.62) ? 0.25 : 1); }
        this.shine(game, o, L, j, k);
        continue;
      }
      if (o.head) {
        // Idle turrets scan slowly.
        if (now - o.lastShot > 2500) o.aimGoal += dt * 0.4;
        let d = o.aimGoal - o.aim;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        o.aim += d * Math.min(1, dt * 14);
        o.head.rotation.y = -o.aim;
        o.recoil = Math.max(0, o.recoil - dt * 8);
        o.head.position.x = -Math.cos(o.aim) * o.recoil * 0.08;
        o.head.position.z = -Math.sin(o.aim) * o.recoil * 0.08;
      }
      if (o.spin) o.spin.rotation.y = t * 0.8;
      if (o.glow && o.kind === K_FROST) { o.glow.rotation.y = t * 1.2; o.glow.position.y = 1.5 + Math.sin(t * 2) * 0.06; }
    }
  }

  // A translucent copy of a struct for build placement, turned to facing; with band, a
  // catapult's shows where it throws to.
  ghost(kind: number, mat: THREE.Material, facing = 0, band = false): THREE.Group {
    const g = new THREE.Group();
    if (kind === K_WALL || kind === K_GATE) {
      g.add(new THREE.Mesh(kind === K_WALL ? this.walls.posts.geometry : this.walls.gposts.geometry, mat));
      return g;
    }
    const b = this.buildKind(kind);
    g.add(new THREE.Mesh(b.body, mat));
    let head: THREE.Mesh | null = null;
    if (b.head) {
      head = new THREE.Mesh(b.head, mat); head.position.y = b.headY; g.add(head);
      if (b.gun) head.add(new THREE.Mesh(b.gun, mat));
    }
    if (b.glow) { const h = new THREE.Mesh(b.glow, mat); if (kind === K_FROST) h.position.y = b.spinY; g.add(h); }
    if (isTrapKind(kind)) { trapGhost(g, head, kind, mat, band); trapFace(g, facing); }
    return g;
  }
}

