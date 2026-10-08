import * as THREE from 'three/webgpu';
import { color, float, fract, max, mix, positionLocal, sin, step, time, uniform, vertexColor, vec3 } from 'three/tsl';
import type { StructDef } from '../protocol';
import type { Game } from '../state';
import { box, cone, cyl, dodeca, ico, merge, octa, part, playerColor, setEmissive, torus, writeMatrix, type Part } from './util';

export const K_CORE = 1, K_ARMORY = 2, K_WALL = 3, K_GATE = 4, K_GUN = 5, K_CANNON = 6, K_FROST = 7, K_TESLA = 8;

// Highlight of what is under the cursor, set per object through userData.hl.
const hl = uniform(0).onObjectUpdate((frame) => (frame.object?.userData.hl as number | undefined) ?? 0);

export function litMaterial(): THREE.MeshLambertNodeMaterial {
  const m = new THREE.MeshLambertNodeMaterial();
  m.colorNode = vertexColor().rgb;
  setEmissive(m, vec3(0.32, 0.3, 0.18).mul(hl));
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

function glowMaterial(hex: number, pulse = 0): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = pulse ? color(hex).mul(sin(time.mul(pulse)).mul(0.25).add(1.05)) : color(hex);
  return m;
}

// dmg: extra wreckage shown below 60% and 30% hp.
interface Model { body: Part[]; head?: Part[]; headY?: number; glow?: { parts: Part[]; color: number; pulse: number }; spin?: Part[]; spinY?: number; dmg?: [Part[], Part[]] }

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
  }
  return { body: [part(box(0.9, 0.8, 0.9), 0x888888, 0, 0.4, 0)] };
}

interface Built { body: THREE.BufferGeometry; head?: THREE.BufferGeometry; headY: number; glow?: THREE.BufferGeometry; glowMat?: THREE.Material; spin?: THREE.BufferGeometry; spinY: number; dmg?: THREE.BufferGeometry[] }

interface Obj {
  kind: number; x: number; y: number; level: number; owner: number;
  group: THREE.Group; head: THREE.Object3D | null; spin: THREE.Object3D | null; glow: THREE.Object3D | null;
  dmg: THREE.Object3D[]; spinA: number;
  aim: number; aimGoal: number; recoil: number; lastShot: number;
}

// Walls and gates: an instanced post per tile and an instanced arm towards each connected
// neighbour, so lines of walls read as one wall.
class WallSet {
  posts: THREE.InstancedMesh; arms: THREE.InstancedMesh; gposts: THREE.InstancedMesh; garms: THREE.InstancedMesh;
  constructor(group: THREE.Group, mat: THREE.Material, cap: number) {
    const mk = (g: THREE.BufferGeometry) => {
      const m = new THREE.InstancedMesh(g, mat, cap);
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
      group.add(m);
      return m;
    };
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
  ensure(n: number): void {
    for (const m of [this.posts, this.arms, this.gposts, this.garms]) {
      if (m.instanceMatrix.count >= n * 4) continue;
      const cap = n * 8;
      m.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      (m as unknown as { count: number }).count = 0;
    }
  }
}

export class Structs {
  group = new THREE.Group();
  private objs = new Map<number, Obj>();
  private built = new Map<number, Built>();
  private mat = litMaterial();
  private pipMat = litMaterial();
  private walls: WallSet;
  private version = -1;
  private defs: StructDef[] = [];
  private pipGeo: THREE.BufferGeometry[] = [];
  private ringGeo = new Map<number, THREE.BufferGeometry>();

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
    b = { body: merge(m.body), headY: m.headY ?? 0, spinY: m.spinY ?? 0 };
    if (m.head) b.head = merge(m.head);
    if (m.glow) { b.glow = merge(m.glow.parts); b.glowMat = kind === K_CORE ? coreGlowMaterial() : glowMaterial(m.glow.color, m.glow.pulse); }
    if (m.spin) b.spin = merge(m.spin);
    if (m.dmg) b.dmg = m.dmg.map((d) => merge(d));
    this.built.set(kind, b);
    return b;
  }

  private pips(level: number): THREE.BufferGeometry {
    if (!this.pipGeo[level]) {
      const p: Part[] = [];
      for (let i = 0; i < level; i++) p.push(part(box(0.11, 0.11, 0.11), 0xd8b040, 0.47, 0.12 + i * 0.14, 0));
      this.pipGeo[level] = merge(p.length ? p : [part(box(0.001, 0.001, 0.001), 0)]);
    }
    return this.pipGeo[level];
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
    if (b.head) {
      head = new THREE.Mesh(b.head, this.mat);
      head.position.y = b.headY;
      head.castShadow = true;
      g.add(head);
    }
    if (b.glow) {
      glow = new THREE.Mesh(b.glow, b.glowMat);
      if (kind === K_FROST) glow.position.y = b.spinY;
      g.add(glow);
    }
    if (b.spin) { spin = new THREE.Mesh(b.spin, this.mat); spin.position.y = b.spinY; spin.castShadow = true; g.add(spin); }
    const dmg: THREE.Object3D[] = [];
    for (const d of b.dmg ?? []) { const m = new THREE.Mesh(d, this.mat); m.visible = false; m.castShadow = true; g.add(m); dmg.push(m); }
    const def = this.defs[kind];
    if (def?.turret) {
      const pm = new THREE.Mesh(this.pips(f.sLevel[i]), this.pipMat);
      g.add(pm);
    }
    if (kind !== K_WALL && kind !== K_GATE) g.add(new THREE.Mesh(this.ring(f.sOwner[i], w), this.mat));
    const aim = Math.random() * 6.28;
    return { kind, x: f.sX[i], y: f.sY[i], level: f.sLevel[i], owner: f.sOwner[i], group: g, head, spin, glow, dmg, spinA: 0, aim, aimGoal: aim, recoil: 0, lastShot: 0 };
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
      if (o && o.kind === k && o.x === f.sX[i] && o.y === f.sY[i] && o.level === f.sLevel[i] && o.owner === f.sOwner[i]) continue;
      if (o) this.group.remove(o.group);
      const n = this.make(game, i);
      if (o && o.kind === k) { n.aim = o.aim; n.aimGoal = o.aimGoal; }
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
      writeMatrix(gate ? gpa : pa, (gate ? gp++ : np++) * 16, cx, 0, cz, 0, 1);
      for (const [dx, dy, a] of dirs) {
        if (!isWall(x + dx, y + dy)) continue;
        writeMatrix(gate ? gaa : aa, (gate ? ga++ : na++) * 16, cx, 0, cz, a, 1);
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

  // A translucent copy of a struct for build placement.
  ghost(kind: number, mat: THREE.Material): THREE.Group {
    const g = new THREE.Group();
    if (kind === K_WALL || kind === K_GATE) {
      g.add(new THREE.Mesh(kind === K_WALL ? this.walls.posts.geometry : this.walls.gposts.geometry, mat));
      return g;
    }
    const b = this.buildKind(kind);
    g.add(new THREE.Mesh(b.body, mat));
    if (b.head) { const h = new THREE.Mesh(b.head, mat); h.position.y = b.headY; g.add(h); }
    if (b.glow) { const h = new THREE.Mesh(b.glow, mat); if (kind === K_FROST) h.position.y = b.spinY; g.add(h); }
    return g;
  }
}

