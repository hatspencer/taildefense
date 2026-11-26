import * as THREE from 'three/webgpu';
import { color, float, fract, max, mix, mrt, output, sin, step, time, uniform, vertexColor, vec3, vec4 } from 'three/tsl';
import { K_ARMORY, K_BAIT, K_CANNON, K_CATAPULT, K_CORE, K_FROST, K_GATE, K_GUN, K_MISSILE, K_SNIPER, K_PYLON, K_TESLA, K_WALL, type StructDef, TTrack, TURRET_TRACKS, turretRange } from '../protocol';
import type { Game } from '../state';
import { isTrapKind, trapFace, trapGhost, trapMake, trapModel, trapUpdate } from './traps';
import { box, concat, cone, cyl, dodeca, ico, merge, part, playerColor, sphere, torus, writeMatrix, type Part } from './util';
import { AWM_LENS, AWM_MUZZLE, awmParts } from './awm';
import { painted } from './paint';
import { blend, darker, lighter, mute, PAL } from './palette';

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

// The generator's running lamp on its control panel: a steady green while it holds, going over
// to a flickering red as it fails. The one light the base needs to read its state by.
function coreLampMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const ok = color(0x8aff6a).mul(sin(time.mul(1.6)).mul(0.08).add(1));
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
// pivoting at gunX along the head's +x. spin turns about the upright through spinAt (x, y, z).
interface Model { body: Part[]; head?: Part[]; headY?: number; gun?: Part[]; gunX?: number; glow?: { parts: Part[]; color: number; pulse: number }; spin?: Part[]; spinAt?: [number, number, number]; dmg?: [Part[], Part[]] }

// The colours of a turret's tracks: damage, fire rate, range, special.
const PIP = [0xc8502a, 0xd8b040, 0x5aa0c8, 0xb070d0];

// The camp's materials, worn: from the palette, and a few shades between.
const STEEL = PAL.steel, STEEL_D = PAL.steelDark, STEEL_L = PAL.steelLit, INK = PAL.ink, RUB = PAL.rubber;
const GUN = 0x2c2e29, GUN_L = 0x45473e, OD = 0x4f5634, OD_D = darker(0x4f5634, 0.72), OD_L = 0x626a40;
const BAG = 0x7d7048, BAG2 = 0x6c6040, BAG3 = 0x766a46;
const WOOD = PAL.wood, WOOD_D = PAL.woodDark, WOOD_W = 0x6e604a, WOOD_G = 0x5c5444, CUT = 0xa08660;
const PALLET = 0x7e6a4c, PALLET_D = 0x655438;
const RUST = PAL.rust, RUST_L = 0x8a4e2a, CONC = PAL.concrete, CONC_D = 0x67635a, SLAB = 0x6c685a;
const BRASS = 0xa8883a, COPPER = 0xa0602e, COPPER_L = 0xb8743a;
const HAZ = PAL.hardHat, RED = PAL.medRed;
const X = Math.PI / 2, UP = new THREE.Vector3(0, 1, 0);

type V3 = [number, number, number];

// A round bar from a to b: a pipe, a leg, a cable, a wire.
function rod(a: V3, b: V3, r: number, c: number, seg = 4): Part {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), len = d.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return { geo: g, color: c };
}

// A sandbag: a squat lozenge lying along heading a (0 along x), its middle at x, y, z.
function bag(x: number, y: number, z: number, a: number, c = BAG, len = 0.36): Part {
  return part(cyl(0.12, 0.12, len, 6), c, x, y, z, 0, a, X, 0.6, 1, 1);
}

// A ring of n sandbags of radius r, the bag at angle 0 turned by phase.
function bagRing(r: number, n: number, y: number, phase: number, len = 0.36): Part[] {
  const p: Part[] = [];
  for (let i = 0; i < n; i++) {
    const t = phase + i * 2 * Math.PI / n;
    p.push(bag(Math.cos(t) * r, y, Math.sin(t) * r, -t - X + ((i * 7) % 3 - 1) * 0.06, [BAG, BAG2, BAG3][(i * 5 + Math.round(phase * 10)) % 3], len));
  }
  return p;
}

// A sharpened stake standing on x, z, h to where the point starts, leaning by lx, lz.
function stake(x: number, z: number, h: number, r: number, c: number, lx = 0, lz = 0): Part[] {
  const tip = r * 2.6;
  return [
    part(new THREE.CylinderGeometry(r, r * 1.1, h, 6, 1, true).translate(0, h / 2, 0), c, x, 0, z, lx, 0, lz),
    part(new THREE.ConeGeometry(r, tip, 6, 1, true).translate(0, h + tip / 2, 0), blend(CUT, c, 0.25), x, 0, z, lx, 0, lz),
  ];
}

// A wooden pallet w by d, its top at 0.14.
function pallet(x: number, z: number, w: number, d: number, a = 0): Part[] {
  const p: Part[] = [], c = Math.cos(a), s = Math.sin(a);
  const at = (u: number, v: number): [number, number] => [x + u * c + v * s, z - u * s + v * c];
  for (const v of [-d / 2 + 0.05, 0, d / 2 - 0.05]) { const [px, pz] = at(0, v); p.push(part(box(w, 0.09, 0.1), PALLET_D, px, 0.045, pz, 0, a, 0)); }
  const n = Math.max(3, Math.round(w / 0.17));
  for (let i = 0; i < n; i++) {
    const u = -w / 2 + (i + 0.5) * w / n, [px, pz] = at(u, 0);
    p.push(part(box(w / n * 0.78, 0.03, d), i % 2 ? PALLET : blend(PALLET, WOOD_G, 0.4), px, 0.115, pz, 0, a, 0));
  }
  return p;
}

// A car battery standing at x, y, z: black case, grey lid, a red and a black terminal.
function battery(x: number, y: number, z: number, a = 0): Part[] {
  const c = Math.cos(a), s = Math.sin(a);
  return [
    part(box(0.26, 0.17, 0.17), 0x2a2c28, x, y + 0.085, z, 0, a, 0),
    part(box(0.27, 0.025, 0.18), 0x4a4c46, x, y + 0.18, z, 0, a, 0),
    part(box(0.035, 0.04, 0.035), RED, x + 0.09 * c, y + 0.2, z - 0.09 * s, 0, a, 0),
    part(box(0.035, 0.04, 0.035), INK, x - 0.09 * c, y + 0.2, z + 0.09 * s, 0, a, 0),
  ];
}

// A 200 l drum standing at x, z (or lying, with lie), with its two rolling hoops and lid.
function drum(x: number, z: number, c: number, y = 0, lie = 0): Part[] {
  const r = 0.29, h = 0.88, hoop = darker(c, 0.7);
  const at = (v: number): Part[] => lie
    ? [part(cyl(r + 0.014, r + 0.014, 0.035, 10), hoop, x + v * Math.cos(lie), y + r, z - v * Math.sin(lie), 0, lie, X)]
    : [part(cyl(r + 0.014, r + 0.014, 0.035, 10), hoop, x, y + h / 2 + v, z)];
  if (lie) return [part(cyl(r, r, h, 10), c, x, y + r, z, 0, lie, X), ...at(-0.15), ...at(0.15)];
  return [
    part(cyl(r, r, h, 10), c, x, y + h / 2, z),
    ...at(-0.15), ...at(0.15),
    part(cyl(r * 0.92, r * 0.92, 0.02, 10), darker(c, 0.8), x, y + h + 0.005, z),
    part(box(0.06, 0.03, 0.06), STEEL_L, x + 0.14, y + h + 0.02, z - 0.08),
  ];
}

// A 20 l jerrycan at x, z, turned a: red, with its three-bar handle.
function jerrycan(x: number, z: number, a: number, c: number = RED, y = 0): Part[] {
  const s = Math.sin(a), co = Math.cos(a);
  return [
    part(box(0.34, 0.45, 0.16), c, x, y + 0.225, z, 0, a, 0),
    part(box(0.2, 0.05, 0.05), darker(c, 0.6), x - 0.04 * co, y + 0.47, z + 0.04 * s, 0, a, 0),
    part(box(0.05, 0.06, 0.05), darker(c, 0.75), x + 0.13 * co, y + 0.47, z - 0.13 * s, 0, a, 0),
  ];
}

// A crate w by h by d at x, y (its foot), z: planks, a darker band round it, a pale stencil.
function crate(x: number, y: number, z: number, w: number, h: number, d: number, c: number, a = 0): Part[] {
  return [
    part(box(w, h, d), c, x, y + h / 2, z, 0, a, 0),
    part(box(w + 0.02, 0.04, d + 0.02), darker(c, 0.7), x, y + h * 0.72, z, 0, a, 0),
    part(box(w * 0.5, h * 0.28, d + 0.01), lighter(c, 0.22), x, y + h * 0.36, z, 0, a, 0),
  ];
}

// An ammo can, olive drab, at x, y (its foot), z.
function ammoCan(x: number, y: number, z: number, a = 0): Part[] {
  return [
    part(box(0.28, 0.17, 0.12), OD, x, y + 0.085, z, 0, a, 0),
    part(box(0.29, 0.03, 0.13), OD_D, x, y + 0.18, z, 0, a, 0),
    part(box(0.1, 0.02, 0.03), STEEL_D, x, y + 0.2, z, 0, a, 0),
  ];
}

// The generator, 5x5: a diesel generator set in its faded yellow canopy on a steel skid, on a
// cracked slab. The radiator fan turns under a grille in its roof, the exhaust stands up out of
// the other end with a flap on it, louvred doors and the control panel face the camera. Round
// it: fuel drums and a hand pump, two red cans, a cable reel and cables run off towards the
// walls, a work light on a tripod, a pallet of crates. Its running lamp is the one light.
function coreModel(): Model {
  const Y = 0xa8873a, Y_D = darker(Y, 0.72), Y_L = lighter(Y, 0.12), gz = -0.35, top = 1.82;
  const body: Part[] = [
    // The slab, its cracks and an oil stain.
    part(box(4.7, 0.14, 4.7), SLAB, 0, 0.07, 0),
    part(box(4.74, 0.05, 4.74), CONC_D, 0, 0.025, 0),
    part(box(1.6, 0.012, 0.03), CONC_D, 1.2, 0.145, 1.7, 0, 0.5, 0), part(box(1.1, 0.012, 0.03), CONC_D, -0.9, 0.145, 2.0, 0, -0.3, 0),
    part(box(0.03, 0.012, 1.3), CONC_D, 2.0, 0.145, -0.9, 0, 0.2, 0),
    part(box(1.1, 0.01, 0.6), 0x3e3a30, 0.4, 0.145, 0.65, 0, 0.25, 0),
    // The skid and its forklift pockets, a hazard band along the front.
    part(box(3.7, 0.18, 1.56), STEEL_D, 0, 0.23, gz),
    ...[-1.1, 1.1].map((x) => part(box(0.34, 0.1, 1.58), INK, x, 0.22, gz)),
  ];
  for (let i = 0; i < 12; i++) body.push(part(box(0.3, 0.06, 0.02), i % 2 ? HAZ : INK, -1.65 + i * 0.3, 0.29, gz + 0.79));
  // The canopy: a box with a lid, louvred doors along the front, the radiator grille at the
  // left end.
  body.push(
    part(box(3.5, 1.5, 1.4), Y, 0, 1.06, gz),
    part(box(3.56, 0.08, 1.46), Y_D, 0, top - 0.02, gz),
    part(box(3.52, 0.05, 1.42), Y_L, 0, 0.36, gz),
  );
  for (const x of [-0.95, -0.05, 0.85]) {
    body.push(part(box(0.84, 1.18, 0.03), Y_L, x, 1.03, gz + 0.715));
    for (let k = 0; k < 4; k++) body.push(part(box(0.56, 0.035, 0.04), Y_D, x, 1.38 - k * 0.09, gz + 0.73));
    body.push(part(box(0.05, 0.1, 0.04), INK, x + 0.34, 0.98, gz + 0.735));
  }
  for (let k = 0; k < 6; k++) body.push(part(box(0.03, 1.05, 1.1), k % 2 ? INK : Y_D, -1.76, 1.04, gz, 0, 0, 0));
  // The control panel at the right end of the front: a box with a hood, gauges, a breaker.
  body.push(
    part(box(0.5, 0.56, 0.1), 0x3a3c36, 1.42, 1.1, gz + 0.76),
    part(box(0.56, 0.05, 0.2), Y_D, 1.42, 1.41, gz + 0.8),
    part(box(0.09, 0.09, 0.03), 0xc8c2a0, 1.3, 1.2, gz + 0.82), part(box(0.09, 0.09, 0.03), 0xc8c2a0, 1.44, 1.2, gz + 0.82),
    part(box(0.07, 0.12, 0.05), RED, 1.42, 0.98, gz + 0.83),
    // A stencilled warning plate on the canopy.
    part(box(0.3, 0.2, 0.02), 0xc8c2a0, -0.5, 1.55, gz + 0.72), part(box(0.2, 0.04, 0.025), INK, -0.5, 1.55, gz + 0.72),
  );
  // The roof: the fan's grille over the radiator end, a lifting eye, soot round the exhaust.
  const fx = -1.0;
  body.push(part(box(1.0, 0.04, 1.0), STEEL_D, fx, top + 0.035, gz));
  for (let k = 0; k < 6; k++) body.push(part(box(0.04, 0.05, 0.96), STEEL, fx - 0.42 + k * 0.17, top + 0.13, gz));
  body.push(part(box(0.96, 0.05, 0.04), STEEL, fx, top + 0.13, gz + 0.46), part(box(0.96, 0.05, 0.04), STEEL, fx, top + 0.13, gz - 0.46));
  body.push(
    part(torus(0.07, 0.02, 4, 8), STEEL_D, 0.1, top + 0.08, gz),
    part(box(0.9, 0.01, 0.8), 0x3a3428, 1.0, top + 0.025, gz - 0.05),
    // The exhaust: a stack out of the roof, the silencer along it, a rain flap ajar.
    part(cyl(0.14, 0.14, 0.7, 8), 0x4a3a2c, 1.1, top + 0.18, gz - 0.25, 0, 0, X),
    part(cyl(0.065, 0.065, 0.95, 6), RUST, 1.35, top + 0.45, gz - 0.25),
    part(box(0.16, 0.02, 0.15), STEEL_D, 1.39, top + 0.94, gz - 0.25, 0, 0, 0.5),
    // The fuel line from the drums, along the ground to the skid.
    rod([-1.35, 0.33, 1.2], [-1.0, 0.28, 0.45], 0.022, RUB), rod([-1.0, 0.28, 0.45], [-0.8, 0.3, 0.4], 0.022, RUB),
  );
  // Fuel: three drums, one with a hand pump, one on its side, and two red cans by them.
  body.push(
    ...drum(-1.6, 1.25, 0x7a3a22), ...drum(-1.0, 1.55, 0x4e5634), ...drum(-1.75, 1.9, 0x46586a, 0, 0.3),
    rod([-1.6, 1.02, 1.25], [-1.6, 1.42, 1.25], 0.025, STEEL), part(box(0.24, 0.03, 0.03), STEEL, -1.52, 1.42, 1.25, 0, 0, -0.3),
    ...jerrycan(-0.45, 1.35, 0.2), ...jerrycan(-0.25, 1.65, -0.5),
  );
  // A cable reel, its cable run off to the right and towards the camera, more cables out of the
  // panel to the walls.
  body.push(
    part(cyl(0.34, 0.34, 0.05, 10), WOOD_W, 1.45, 0.34, 1.35, X, 0, 0), part(cyl(0.34, 0.34, 0.05, 10), WOOD_W, 1.45, 0.34, 1.75, X, 0, 0),
    part(cyl(0.22, 0.22, 0.36, 8), 0x2a2a24, 1.45, 0.34, 1.55, X, 0, 0),
    rod([1.45, 0.14, 1.85], [1.9, 0.16, 2.4], 0.03, RUB), rod([1.6, 1.0, gz + 0.8], [2.0, 0.15, 0.9], 0.028, RUB),
    rod([2.0, 0.15, 0.9], [2.42, 0.03, 1.1], 0.028, RUB), rod([-0.2, 0.15, gz - 0.8], [-0.4, 0.03, -2.4], 0.028, RUB),
  );
  // A work light on a tripod at the back left, a pallet of crates at the right end.
  const wl: V3 = [-1.95, 2.25, -1.85];
  for (const a of [0.4, 2.5, 4.6]) body.push(rod([wl[0] + Math.cos(a) * 0.4, 0.14, wl[2] + Math.sin(a) * 0.4], [wl[0], 1.0, wl[2]], 0.02, STEEL_D));
  body.push(rod([wl[0], 0.9, wl[2]], [wl[0], wl[1], wl[2]], 0.025, STEEL), part(box(0.18, 0.22, 0.3), HAZ, wl[0] + 0.05, wl[1] + 0.08, wl[2], 0, -0.6, 0.35));
  body.push(rod([wl[0], 1.0, wl[2]], [-1.75, 0.6, -1.08], 0.018, RUB));
  body.push(...pallet(2.05, 0.75, 0.5, 0.8, 0.1), ...crate(2.05, 0.13, 0.6, 0.4, 0.34, 0.4, OD, 0.1), ...crate(2.08, 0.13, 1.0, 0.36, 0.26, 0.3, WOOD_W, -0.2), ...ammoCan(2.05, 0.47, 0.6, 1.4));
  // The fan turning under the grille.
  const spin: Part[] = [part(cyl(0.08, 0.08, 0.05, 6), INK, 0, 0, 0)];
  for (let k = 0; k < 5; k++) { const a = k * 2 * Math.PI / 5; spin.push(part(box(0.4, 0.015, 0.13), 0x4a4c46, Math.cos(a) * 0.22, 0, -Math.sin(a) * 0.22, 0.35, a, 0)); }
  const glow = [part(box(0.07, 0.07, 0.03), 0, 1.56, 1.2, gz + 0.83)];
  const dmg1: Part[] = [
    // A door blown off its hinges, scorch up the canopy, a spill from the drums.
    part(box(0.84, 1.18, 0.03), Y_L, -0.05, 0.3, gz + 1.25, -1.3, 0.25, 0),
    part(box(0.8, 1.15, 0.02), INK, -0.05, 1.03, gz + 0.725),
    part(box(1.0, 0.6, 0.02), 0x2a241c, 0.85, 1.5, gz + 0.72), part(box(0.9, 0.012, 0.7), 0x2a2418, -1.15, 0.145, 0.9, 0, 0.4, 0),
  ];
  const dmg2: Part[] = [
    // The roof holed and burned, the exhaust down, a drum knocked over, scrap all round.
    part(box(1.0, 0.03, 0.9), 0x1c1812, 0.4, top + 0.03, gz),
    part(box(0.03, 0.9, 1.1), 0x1c1812, 1.76, 1.0, gz),
    part(cyl(0.065, 0.065, 0.95, 6), RUST, 1.5, 0.3, 0.85, X, 0.4, 0),
    ...drum(0.4, 1.45, 0x7a3a22, 0.07, 1.2),
    ...[[1.9, 1.7], [-1.2, 2.0], [2.0, -0.6], [0.4, -1.6], [-2.1, 0.3]].map(([x, z], i) => part(dodeca(0.1 + i * 0.03), i % 2 ? Y_D : STEEL_D, x, 0.18, z)),
  ];
  return { body, glow: { parts: glow, color: 0, pulse: 0 }, spin, spinAt: [fx, top + 0.07, gz], dmg: [dmg1, dmg2] };
}

// The armory, 3x3: a ten-foot shipping container gone to rust red, a hatch cut in its front
// with the shutter rolled up and a rack of rifles inside. A workbench out in front with a vise
// and a rifle on it, ammo crates stacked at one end, a drum and sandbags at the other, a
// patched tarp and a small solar panel on the roof, a bulb over the hatch.
function armoryModel(): Model {
  const C = 0x6e3e2c, C_D = darker(C, 0.7), C_L = lighter(C, 0.1), IN = 0x231d16;
  const x0 = -1.45, x1 = 1.45, z0 = -1.45, z1 = 0.8, h = 2.3, y0 = 0.12;
  const cx = 0, cz = (z0 + z1) / 2, L = x1 - x0, D = z1 - z0;
  const hx0 = -0.85, hx1 = 0.65, hy0 = 0.55, hy1 = 1.9;
  const p: Part[] = [
    // Footing sleepers, floor, roof, back, the two ends.
    part(box(0.2, 0.12, D + 0.1), WOOD_G, -1.2, 0.06, cz), part(box(0.2, 0.12, D + 0.1), WOOD_G, 1.2, 0.06, cz),
    part(box(L, 0.06, D), C_D, cx, y0 + 0.03, cz),
    part(box(L, 0.06, D), C_L, cx, y0 + h - 0.03, cz),
    part(box(L, h, 0.04), C, cx, y0 + h / 2, z0 + 0.02),
    part(box(0.04, h, D), C, x0 + 0.02, y0 + h / 2, cz), part(box(0.04, h, D), C, x1 - 0.02, y0 + h / 2, cz),
    // The front wall round the hatch: left, right, above, below.
    part(box(hx0 - x0, h, 0.04), C, (x0 + hx0) / 2, y0 + h / 2, z1 - 0.02),
    part(box(x1 - hx1, h, 0.04), C, (x1 + hx1) / 2, y0 + h / 2, z1 - 0.02),
    part(box(hx1 - hx0, y0 + h - hy1, 0.04), C, (hx0 + hx1) / 2, (hy1 + y0 + h) / 2, z1 - 0.02),
    part(box(hx1 - hx0, hy0 - y0, 0.04), C, (hx0 + hx1) / 2, (hy0 + y0) / 2, z1 - 0.02),
    // The shutter rolled up over the hatch, its guides, and the cut edge.
    part(cyl(0.1, 0.1, hx1 - hx0 + 0.1, 8), 0x7c7a70, (hx0 + hx1) / 2, hy1 + 0.1, z1 + 0.08, 0, 0, X),
    part(box(0.05, hy1 - hy0 + 0.1, 0.07), STEEL, hx0 - 0.03, (hy0 + hy1) / 2, z1 + 0.02), part(box(0.05, hy1 - hy0 + 0.1, 0.07), STEEL, hx1 + 0.03, (hy0 + hy1) / 2, z1 + 0.02),
    // A painted board over the hatch: a rifle on it.
    part(box(0.9, 0.24, 0.03), 0xb9b196, (hx0 + hx1) / 2 - 0.1, hy1 + 0.33, z1 + 0.03),
    part(box(0.62, 0.05, 0.02), INK, (hx0 + hx1) / 2 - 0.1, hy1 + 0.34, z1 + 0.05), part(box(0.1, 0.1, 0.02), INK, (hx0 + hx1) / 2 - 0.36, hy1 + 0.31, z1 + 0.05),
  ];
  // The inside, seen through the hatch: the rack, the rifles, the shelf.
  const rx = (hx0 + hx1) / 2, rz = z1 - 0.2;
  p.push(part(box(hx1 - hx0, hy1 - hy0, 0.03), IN, rx, (hy0 + hy1) / 2, rz - 0.3));
  p.push(part(box(hx1 - hx0, 0.03, 0.34), WOOD_D, rx, hy0 + 0.01, rz - 0.13));
  for (let k = 0; k < 4; k++) {
    const x = hx0 + 0.25 + k * 0.28;
    p.push(part(box(0.05, 0.85, 0.05), GUN, x, hy0 + 0.6, rz - 0.26, 0, 0, 0.05), part(box(0.08, 0.28, 0.05), WOOD, x - 0.01, hy0 + 0.17, rz - 0.26, 0, 0, 0.05));
  }
  p.push(part(box(0.16, 0.18, 0.1), OD, hx1 - 0.15, hy0 + 0.1, rz - 0.2));
  // Corrugation down the ends and the front, the corner posts and castings, rust runs.
  for (let k = 1; k < 12; k++) {
    const x = x0 + k * L / 12;
    if (x > hx0 - 0.04 && x < hx1 + 0.04) continue;
    p.push(part(box(0.05, h - 0.16, 0.03), C_D, x, y0 + h / 2, z1 + 0.005));
  }
  for (let k = 1; k < 9; k++) {
    const z = z0 + k * D / 9;
    p.push(part(box(0.03, h - 0.16, 0.05), C_D, x1 + 0.005, y0 + h / 2, z), part(box(0.03, h - 0.16, 0.05), C_D, x0 - 0.005, y0 + h / 2, z));
  }
  for (const [x, z] of [[x0, z0], [x0, z1], [x1, z0], [x1, z1]]) {
    p.push(part(box(0.1, h, 0.1), C_D, x + Math.sign(-x) * 0.04, y0 + h / 2, z + Math.sign(cz - z) * 0.04));
    p.push(part(box(0.13, 0.1, 0.13), INK, x + Math.sign(-x) * 0.05, y0 + h - 0.04, z + Math.sign(cz - z) * 0.05));
  }
  p.push(part(box(0.3, 0.8, 0.02), RUST, -1.1, y0 + 1.6, z1 + 0.012), part(box(0.2, 0.5, 0.02), RUST_L, 1.05, y0 + 1.8, z1 + 0.012), part(box(0.02, 0.7, 0.4), RUST, x1 + 0.012, y0 + 1.7, -0.6));
  // The roof: a tarp weighed down with sandbags, a solar panel on a frame with its cable.
  p.push(
    part(box(1.3, 0.03, 1.4), PAL.canvas, -0.75, y0 + h + 0.015, -0.3, 0, 0.08, 0),
    bag(-1.3, y0 + h + 0.08, -0.85, 0.3), bag(-0.2, y0 + h + 0.08, 0.3, -0.2), bag(-1.2, y0 + h + 0.08, 0.3, 0.1, BAG2),
    part(box(0.9, 0.04, 0.6), 0x2c3440, 0.75, y0 + h + 0.2, -0.55, 0.3, 0, 0),
    part(box(0.94, 0.03, 0.64), STEEL_L, 0.75, y0 + h + 0.18, -0.55, 0.3, 0, 0),
    part(box(0.02, 0.012, 0.58), 0x5a6878, 0.6, y0 + h + 0.225, -0.55, 0.3, 0, 0), part(box(0.02, 0.012, 0.58), 0x5a6878, 0.9, y0 + h + 0.225, -0.55, 0.3, 0, 0),
    rod([0.75, y0 + h + 0.05, -0.85], [0.75, y0 + h + 0.12, -0.85], 0.02, STEEL_D),
    rod([0.3, y0 + h + 0.03, -0.5], [hx1 + 0.1, hy1 + 0.25, z1 + 0.06], 0.015, RUB),
  );
  // The bench out front: a thick top on four legs, a vise, a rifle laid on it, a red toolbox.
  const bz = 1.15, by = 0.86;
  p.push(
    part(box(1.3, 0.07, 0.44), WOOD, -0.15, by, bz),
    ...[[-0.75, -1], [-0.75, 1], [0.45, -1], [0.45, 1]].map(([x, s]) => part(box(0.07, by, 0.07), WOOD_D, x, by / 2, bz + s * 0.17)),
    part(box(1.2, 0.04, 0.36), WOOD_G, -0.15, 0.25, bz),
    part(box(0.14, 0.14, 0.12), STEEL_D, 0.35, by + 0.1, bz - 0.1), part(box(0.04, 0.03, 0.22), STEEL_L, 0.35, by + 0.12, bz + 0.04),
    part(box(0.6, 0.05, 0.06), GUN, -0.2, by + 0.06, bz + 0.05, 0, 0.15, 0), part(box(0.24, 0.07, 0.06), WOOD, -0.6, by + 0.06, bz + 0.11, 0, 0.15, 0),
    part(box(0.34, 0.14, 0.17), RED, -0.6, by + 0.105, bz - 0.1, 0, -0.1, 0), part(box(0.2, 0.03, 0.04), INK, -0.6, by + 0.19, bz - 0.1, 0, -0.1, 0),
    ...ammoCan(-0.1, 0.27, bz, 0.1),
  );
  // Ammo crates stacked at the right, a drum, sandbags and a red can at the left.
  p.push(
    ...crate(1.1, 0, 1.12, 0.6, 0.34, 0.4, OD, 0.05), ...crate(1.12, 0.34, 1.1, 0.56, 0.3, 0.38, OD_L, -0.1),
    ...crate(1.3, 0, 0.95, 0.3, 0.22, 0.25, WOOD_W, 0.3),
    ...drum(-1.18, 1.17, 0x46586a), ...jerrycan(-0.82, 1.32, 0.4),
    bag(-1.25, 0.07, 1.45, 0), bag(-0.88, 0.07, 1.5, 0.1, BAG2),
  );
  return { body: p, glow: { parts: [part(sphere(0.045, 6, 4), 0, rx, hy1 + 0.02, z1 + 0.25)], color: 0xffd890, pulse: 0 } };
}

// What the generator's tiers add to it: at I its work light's lamp, at II a radio mast and
// dish on a scaffold tower behind its right end, at III floodlights on poles at the slab's four
// corners. Body parts, then lamps that glow.
function tierParts(tier: number): { body: Part[]; lamps: Part[] } {
  const body: Part[] = [], lamps: Part[] = [part(box(0.03, 0.17, 0.25), 0, -1.86, 2.35, -1.79, 0, -0.6, 0.35)];
  if (tier >= 2) {
    const sx = 1.8, sz = -1.75;
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) body.push(rod([sx + x * 0.3, 0.14, sz + z * 0.3], [sx + x * 0.3, 2.6, sz + z * 0.3], 0.03, STEEL));
    for (const y of [0.8, 1.6, 2.4]) body.push(part(box(0.64, 0.04, 0.64), WOOD_W, sx, y, sz));
    body.push(rod([sx - 0.3, 0.8, sz + 0.3], [sx + 0.3, 1.6, sz + 0.3], 0.02, STEEL), rod([sx + 0.3, 1.6, sz + 0.3], [sx - 0.3, 2.4, sz + 0.3], 0.02, STEEL));
    body.push(rod([sx, 2.4, sz], [sx, 4.1, sz], 0.03, STEEL_L), part(cone(0.32, 0.12, 10), 0xb8b4a4, sx - 0.05, 2.95, sz + 0.1, 0.5, 0, 0.6));
    body.push(part(box(0.3, 0.22, 0.2), OD, sx, 2.55, sz - 0.1), rod([sx, 2.45, sz], [1.3, 1.84, -0.9], 0.015, RUB));
    lamps.push(part(box(0.06, 0.06, 0.06), 0, sx, 4.15, sz));
  }
  if (tier >= 3) {
    for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const px = x * 2.2, pz = z * 2.2, a = Math.atan2(-z, x) + Math.PI;
      body.push(rod([px, 0.14, pz], [px, 3.0, pz], 0.045, STEEL_D), part(box(0.16, 0.24, 0.46), STEEL_D, px - x * 0.06, 3.05, pz - z * 0.06, 0, a, -0.4));
      lamps.push(part(box(0.03, 0.2, 0.4), 0, px - x * 0.15, 3.0, pz - z * 0.15, 0, a, -0.4));
    }
  }
  return { body, lamps };
}

// An evolved turret's collar: a brass band round its foot and a lamp on a stalk, amber for
// the first branch and violet for the second.
const EVO = [0xffb030, 0xc070ff];
function evoParts(): Part[] {
  return [part(cyl(0.44, 0.46, 0.08, 10), 0xb08a40, 0, 0.12, 0), part(cyl(0.02, 0.02, 0.5, 4), STEEL_D, -0.36, 0.4, 0.36)];
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
    part(box(0.3, 0.05, 0.26), STEEL_D, 0, -0.27, 0),
  ];
  for (const z of [-1, 1]) {
    p.push(part(box(0.3, 0.16, 0.03), STEEL, 0, -0.15, z * 0.11));
    p.push(part(cyl(0.028, 0.028, 0.34, 6), 0x6a6e70, 0.02, -0.16, z * 0.15, 0, 0, X));
    p.push(part(cyl(0.036, 0.036, 0.08, 6), STEEL_D, -0.15, -0.16, z * 0.15, 0, 0, X));
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

// The gun turret: a heavy machine gun on a tripod in a ring of sandbags two high, a steel plate
// for a shield, its ammo can hung on the left with the belt running into the feed, spare cans
// and spent brass on the bags. The bore is 0.05 over the head's pivot, the muzzle 0.62 out.
function gunModel(): Model {
  const body: Part[] = [...bagRing(0.39, 8, 0.072, 0.2, 0.29), ...bagRing(0.36, 8, 0.2, 0.2 + Math.PI / 8, 0.27)];
  for (const a of [Math.PI, Math.PI / 3, -Math.PI / 3]) body.push(rod([Math.cos(a) * 0.3, 0.02, Math.sin(a) * 0.3], [0, 0.5, 0], 0.022, GUN_L));
  body.push(part(cyl(0.035, 0.045, 0.16, 6), GUN, 0, 0.55, 0));
  body.push(...ammoCan(-0.3, 0.27, 0.22, 0.9), ...ammoCan(0.05, 0.27, -0.36, 0.2));
  for (const [x, z] of [[0.12, 0.12], [-0.1, 0.18], [0.18, -0.08], [-0.05, -0.15]]) body.push(part(box(0.06, 0.025, 0.025), BRASS, x, 0.03, z, 0, x * 9, 0));
  const head: Part[] = [
    // Cradle and pintle head.
    part(box(0.14, 0.08, 0.08), GUN_L, 0, -0.08, 0),
    // Receiver, its feed cover, the back plate and the spade grips.
    part(box(0.38, 0.12, 0.11), GUN, 0.02, 0.03, 0),
    part(box(0.26, 0.035, 0.1), GUN_L, 0.06, 0.105, 0),
    part(box(0.03, 0.12, 0.12), GUN, -0.18, 0.03, 0),
    part(box(0.08, 0.025, 0.025), GUN_L, -0.22, 0.03, 0.045), part(box(0.08, 0.025, 0.025), GUN_L, -0.22, 0.03, -0.045),
    // The barrel in its perforated jacket, the flash hider, the front sight.
    part(cyl(0.04, 0.04, 0.2, 6), GUN_L, 0.3, 0.05, 0, 0, 0, X),
    part(cyl(0.022, 0.022, 0.44, 6), GUN, 0.4, 0.05, 0, 0, 0, X),
    part(cyl(0.03, 0.026, 0.07, 6), INK, 0.6, 0.05, 0, 0, 0, X),
    part(box(0.02, 0.06, 0.015), GUN, 0.55, 0.09, 0),
    // The shield: a plate off a truck, leaning back, rusting through low down.
    part(box(0.025, 0.3, 0.48), 0x5a5c3e, 0.2, -0.01, 0, 0, 0, 0.12),
    part(box(0.03, 0.1, 0.16), RUST, 0.2, -0.06, -0.12, 0, 0, 0.12),
    // The ammo can hung on the left and its belt into the feed.
    ...ammoCan(0.02, -0.16, 0.14),
    ...[0, 1, 2].map((k) => part(box(0.05, 0.02, 0.05), BRASS, 0.04, 0.04 + k * 0.012, 0.105 - k * 0.02, 0.5)),
  ];
  return { body, head, headY: 0.7 };
}

// The cannon: a small field gun on two rubber-tyred wheels, its shield up, the split trail
// spread behind on a plank turntable ringed with a course of sandbags, a crate of shells by it.
// The bore is 0.62 over the head's pivot (the platform's top), the muzzle 0.66 out.
function cannonModel(): Model {
  const body: Part[] = [
    part(box(0.96, 0.05, 0.96), WOOD_G, 0, 0.025, 0),
    ...[-0.36, -0.18, 0, 0.18, 0.36].map((z, i) => part(box(0.92, 0.05, 0.16), i % 2 ? WOOD_W : blend(WOOD_W, WOOD, 0.3), 0, 0.075, z)),
    ...bagRing(0.5, 10, 0.07, 0.1, 0.3),
    ...crate(-0.3, 0.1, 0.38, 0.32, 0.12, 0.18, OD, 0.4),
  ];
  const head: Part[] = [];
  for (const z of [-0.29, 0.29]) {
    head.push(part(cyl(0.25, 0.25, 0.08, 10), RUB, 0, 0.25, z, X, 0, 0));
    head.push(part(cyl(0.15, 0.15, 0.09, 8), OD, 0, 0.25, z, X, 0, 0));
    head.push(part(cyl(0.04, 0.04, 0.1, 6), INK, 0, 0.25, z * 1.05, X, 0, 0));
  }
  head.push(
    // Axle and carriage.
    part(box(0.12, 0.08, 0.6), OD_D, 0, 0.25, 0),
    part(box(0.32, 0.12, 0.18), OD, 0.02, 0.38, 0),
    // The split trail, spread to two spades on the planks.
    rod([-0.05, 0.3, 0.06], [-0.52, 0.03, 0.2], 0.03, OD, 4), rod([-0.05, 0.3, -0.06], [-0.52, 0.03, -0.2], 0.03, OD, 4),
    part(box(0.03, 0.1, 0.12), STEEL_D, -0.53, 0.06, 0.2), part(box(0.03, 0.1, 0.12), STEEL_D, -0.53, 0.06, -0.2),
    // The shield in three plates round the barrel, its top edge rusted.
    part(box(0.03, 0.34, 0.68), OD, 0.12, 0.42, 0, 0, 0, 0.1),
    part(box(0.03, 0.2, 0.24), OD, 0.1, 0.68, 0.22, 0, 0, 0.1), part(box(0.03, 0.2, 0.24), OD, 0.1, 0.68, -0.22, 0, 0, 0.1),
    part(box(0.035, 0.04, 0.24), RUST, 0.09, 0.78, 0.22, 0, 0, 0.1), part(box(0.035, 0.04, 0.24), RUST, 0.09, 0.78, -0.22, 0, 0, 0.1),
    // Breech, recoil cylinder, barrel and its muzzle brake.
    part(box(0.2, 0.15, 0.15), GUN, -0.12, 0.62, 0),
    part(cyl(0.035, 0.035, 0.42, 6), GUN_L, 0.12, 0.53, 0, 0, 0, X),
    part(cyl(0.042, 0.055, 0.68, 8), OD_D, 0.28, 0.62, 0, 0, 0, X),
    part(box(0.1, 0.08, 0.12), GUN, 0.64, 0.62, 0), part(box(0.03, 0.05, 0.125), INK, 0.64, 0.62, 0),
    // The sight on the left of the breech and the elevating wheel.
    part(box(0.12, 0.05, 0.04), GUN, -0.02, 0.72, 0.12),
    part(torus(0.05, 0.012, 4, 8), STEEL, -0.1, 0.5, -0.13),
  );
  return { body, head, headY: 0.1 };
}

// The frost tower: a rack of nitrogen dewars, frosted half way up, strapped on a pallet with a
// truck's refrigeration unit, their hoses into a mast with a sprinkler head at the top that
// turns as it sprays. Pale ice is its only colour.
function frostModel(): Model {
  const ICE = 0xc8d0cc, TANK = 0x8a989a, ICE_B = 0x9cbcc4;
  const body: Part[] = [...pallet(0, 0, 0.94, 0.94)];
  const tanks: [number, number][] = [[-0.25, 0.22], [-0.27, -0.2], [0.05, -0.3]];
  for (const [x, z] of tanks) {
    body.push(
      part(cyl(0.12, 0.12, 0.9, 8), TANK, x, 0.6, z),
      part(cyl(0.125, 0.125, 0.42, 8), ICE, x, 0.36, z),
      part(cyl(0.07, 0.12, 0.08, 8), TANK, x, 1.09, z),
      part(cyl(0.025, 0.025, 0.08, 4), STEEL_D, x, 1.16, z), part(box(0.08, 0.02, 0.02), RED, x, 1.2, z),
    );
    body.push(rod([x, 1.18, z], [0.0, 1.25, 0.0], 0.018, RUB));
  }
  // The strap round the dewars.
  body.push(part(box(0.5, 0.04, 0.03), INK, -0.15, 0.85, 0.36, 0, 0.6, 0), part(box(0.03, 0.04, 0.62), INK, -0.4, 0.85, 0));
  // The refrigeration unit: a white box with a fan grille, the compressor's pipe up the mast.
  body.push(
    part(box(0.38, 0.42, 0.4), 0xa8a89a, 0.24, 0.35, 0.2),
    part(box(0.02, 0.3, 0.3), INK, 0.44, 0.35, 0.2), part(cyl(0.12, 0.12, 0.02, 8), 0x4a4c46, 0.455, 0.35, 0.2, 0, 0, X),
    part(box(0.4, 0.03, 0.42), 0x8a8a7c, 0.24, 0.575, 0.2),
    part(box(0.08, 0.06, 0.02), ICE_B, 0.12, 0.5, 0.41),
  );
  // The mast, its brace and the frost down it.
  body.push(
    rod([0.0, 0.14, 0.0], [0.0, 1.46, 0.0], 0.035, STEEL, 6),
    rod([0.3, 0.58, 0.05], [0.0, 1.05, 0.0], 0.018, STEEL),
    part(cyl(0.045, 0.045, 0.3, 6), ICE, 0, 1.25, 0),
    part(cyl(0.12, 0.2, 0.012, 10), ICE, 0.05, 0.135, 0.05),
  );
  // The sprinkler head: a hub, three arms and their nozzles, frosted.
  const spin: Part[] = [part(cyl(0.06, 0.06, 0.08, 6), STEEL_L, 0, 0, 0), part(cyl(0.04, 0.06, 0.04, 6), ICE, 0, 0.06, 0)];
  for (let k = 0; k < 3; k++) {
    const a = k * 2 * Math.PI / 3;
    spin.push(part(box(0.28, 0.03, 0.03), STEEL, Math.cos(a) * 0.17, 0, -Math.sin(a) * 0.17, 0, a, 0));
    spin.push(part(box(0.05, 0.06, 0.05), ICE_B, Math.cos(a) * 0.31, -0.02, -Math.sin(a) * 0.31, 0, a, 0));
  }
  return { body, spin, spinAt: [0, 1.5, 0] };
}

// The tesla coil: a home-made one, on a pallet. The secondary wound in copper on an insulator
// stack, a dryer-duct toroid on top, the primary's heavy turns round its foot; a bank of car
// batteries and a transformer feeding it, a striped warning plate leaning on the side.
function teslaModel(): Model {
  const body: Part[] = [...pallet(0, 0, 0.94, 0.94)];
  body.push(
    ...battery(-0.3, 0.14, 0.22, X), ...battery(-0.3, 0.14, -0.08, X),
    part(box(0.24, 0.22, 0.24), OD, 0.26, 0.25, -0.26), part(cyl(0.07, 0.07, 0.16, 8), COPPER, 0.26, 0.38, -0.26, X, 0, 0),
    rod([-0.22, 0.34, 0.22], [0.15, 0.2, -0.2], 0.018, RED), rod([-0.22, 0.34, -0.08], [0.15, 0.2, -0.3], 0.018, INK),
    rod([0.26, 0.37, -0.15], [0.0, 0.48, 0.0], 0.015, COPPER_L),
  );
  // The insulator stack and the secondary in alternating bands of winding.
  for (let k = 0; k < 3; k++) body.push(part(cyl(0.13 - k * 0.012, 0.13 - k * 0.012, 0.06, 8), 0xbcb49c, 0, 0.18 + k * 0.08, 0));
  for (let k = 0; k < 6; k++) body.push(part(cyl(0.085, 0.085, 0.14, 8), k % 2 ? COPPER : COPPER_L, 0, 0.45 + k * 0.14, 0));
  body.push(
    part(torus(0.19, 0.016, 4, 12), COPPER_L, 0, 0.48, 0, X, 0, 0), part(torus(0.22, 0.016, 4, 12), COPPER, 0, 0.53, 0, X, 0, 0),
    part(cyl(0.06, 0.09, 0.08, 8), STEEL, 0, 1.33, 0),
    part(torus(0.19, 0.075, 6, 12), 0xa49e8c, 0, 1.45, 0, X, 0, 0),
    part(cyl(0.12, 0.12, 0.05, 8), 0x8a8676, 0, 1.45, 0),
    part(cyl(0.008, 0.02, 0.14, 4), STEEL_L, 0, 1.53, 0),
  );
  // The warning plate.
  for (let k = 0; k < 4; k++) body.push(part(box(0.025, 0.09, 0.3), k % 2 ? INK : HAZ, 0.45, 0.2 + k * 0.08, 0.22, 0, 0, -0.25));
  return { body };
}

// The sniper tower: a rough timber watchtower on four splayed legs, cross-braced with planks and
// with a length of scaffold pipe where a plank ran out, a sheet of corrugated iron and a canvas
// screen nailed round the top bay, a ladder up the back, sandbags round the deck; on a pintle in
// the middle of the deck the green AWM in its cradle.
function sniperModel(): Model {
  const D = SNIPER_DECK, legH = D - 0.08;
  const body: Part[] = [];
  const top = 0.36, foot = 0.43;
  for (const [x, z] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    body.push(rod([x * foot, 0, z * foot], [x * top, legH, z * top], 0.06, WOOD_W, 4));
    body.push(part(box(0.2, 0.08, 0.2), CONC_D, x * foot, 0.04, z * foot));
  }
  const at = (y: number) => foot + (top - foot) * y / legH;
  const rails = [0.45, 1.3, 2.05, D - 0.14];
  for (const y of rails) {
    const r = at(y);
    body.push(part(box(2 * r, 0.06, 0.05), WOOD_G, 0, y, r), part(box(2 * r, 0.06, 0.05), WOOD_G, 0, y, -r));
    body.push(part(box(0.05, 0.06, 2 * r), WOOD_G, r, y, 0), part(box(0.05, 0.06, 2 * r), WOOD_G, -r, y, 0));
  }
  for (let b = 0; b + 2 < rails.length; b++) {
    const y0 = rails[b], y1 = rails[b + 1], r0 = at(y0), r1 = at(y1), sg = b % 2 ? 1 : -1;
    for (const s of [-1, 1]) {
      const c = b === 1 && s === 1 ? STEEL : WOOD_G, w = c === STEEL ? 0.025 : 0.035;
      body.push(rod([-sg * r0, y0, s * (r0 + 0.02)], [sg * r1, y1, s * (r1 + 0.02)], w, c));
      body.push(rod([s * (r0 + 0.02), y0, sg * r0], [s * (r1 + 0.02), y1, -sg * r1], w, WOOD_G));
    }
  }
  // The top bay: corrugated iron on the front, canvas on the left.
  const ry0 = rails[2], ry1 = rails[3], rm = at((ry0 + ry1) / 2) + 0.04;
  body.push(part(box(0.03, ry1 - ry0, 2 * rm), RUST, rm, (ry0 + ry1) / 2, 0, 0, 0, 0.02));
  for (let k = 0; k < 5; k++) body.push(part(box(0.04, ry1 - ry0, 0.03), RUST_L, rm + 0.01, (ry0 + ry1) / 2, -rm + 0.1 + k * (2 * rm - 0.2) / 4));
  body.push(part(box(2 * rm - 0.1, ry1 - ry0 - 0.08, 0.02), PAL.canvas, 0, (ry0 + ry1) / 2 - 0.03, rm, 0.04, 0, 0));
  // The deck, its planks overhanging, and the sandbag rim on three sides.
  body.push(part(box(0.96, 0.08, 0.96), WOOD, 0, D - 0.04, 0));
  for (let k = 0; k < 4; k++) body.push(part(box(0.98, 0.012, 0.02), WOOD_D, 0, D + 0.002, -0.36 + k * 0.24));
  for (const s of [-1, 1]) for (const u of [-0.22, 0.22]) body.push(bag(u, D + 0.075, s * 0.41, 0, s > 0 ? BAG : BAG2, 0.42));
  for (const u of [-0.22, 0.22]) body.push(bag(-0.41, D + 0.075, u, X, BAG3, 0.42));
  // The ladder up the back, all the way to the deck.
  body.push(part(box(0.04, D, 0.04), WOOD_W, -0.56, D / 2, 0.14), part(box(0.04, D, 0.04), WOOD_W, -0.56, D / 2, -0.14));
  for (let y = 0.25; y < D - 0.1; y += 0.3) body.push(part(box(0.03, 0.03, 0.3), WOOD_G, -0.56, y, 0));
  // The pintle the rifle turns on, bolted to the deck.
  body.push(part(box(0.3, 0.04, 0.3), STEEL_D, 0, D + 0.02, 0), part(cyl(0.05, 0.07, 0.3, 8), STEEL, 0, D + 0.15, 0));
  return { body, head: sniperCradle(), headY: SNIPER_HEAD_Y, gun: awmParts(), gunX: SNIPER_PIVOT };
}

// The missile battery: two rocket pods off a helicopter, olive drab, bolted either side of a
// yoke on a pipe pedestal welded to a truck wheel; red noses show in the tubes. A car battery
// on the ground fires them, its leads up the pedestal. The pods' bores are 0.17 over the head's
// pivot.
function missileModel(): Model {
  const body: Part[] = [
    part(cyl(0.34, 0.34, 0.2, 10), RUB, 0, 0.1, 0),
    part(cyl(0.22, 0.22, 0.21, 10), STEEL, 0, 0.105, 0),
    part(cyl(0.06, 0.07, 0.5, 6), STEEL_D, 0, 0.45, 0),
    ...[0, 1, 2].map((k) => { const a = k * 2.094 + 0.5; return rod([Math.cos(a) * 0.2, 0.21, Math.sin(a) * 0.2], [0, 0.5, 0], 0.016, STEEL_D); }),
    ...battery(-0.32, 0, 0.3, 0.6),
    rod([-0.3, 0.2, 0.3], [-0.05, 0.55, 0.04], 0.012, RED), rod([-0.36, 0.2, 0.26], [-0.05, 0.5, -0.04], 0.012, INK),
    ...bagRing(0.45, 9, 0.07, 0.3, 0.32).filter((_, i) => i !== 3),
  ];
  const head: Part[] = [part(box(0.16, 0.08, 0.5), STEEL_D, 0, 0.0, 0), part(box(0.1, 0.18, 0.06), STEEL, 0, 0.08, 0)];
  for (const z of [-0.2, 0.2]) {
    head.push(part(cyl(0.14, 0.14, 0.66, 8), OD, 0.02, 0.17, z, 0, 0, X));
    for (const x of [-0.18, 0.22]) head.push(part(cyl(0.148, 0.148, 0.05, 8), OD_L, x, 0.17, z, 0, 0, X));
    head.push(part(cyl(0.126, 0.126, 0.02, 8), OD_D, 0.355, 0.17, z, 0, 0, X));
    head.push(part(cyl(0.126, 0.126, 0.02, 8), INK, -0.315, 0.17, z, 0, 0, X));
    for (const [dy, dz] of [[0, 0], [0.07, 0.04], [-0.07, -0.04], [0.07, -0.04], [-0.07, 0.04]]) head.push(part(box(0.02, 0.05, 0.05), INK, 0.365, 0.17 + dy, z + dz));
    for (const [dy, dz] of [[0.07, 0.04], [-0.07, -0.04], [0, 0]]) head.push(part(cone(0.022, 0.05, 4), RED, 0.385, 0.17 + dy, z + dz, 0, 0, -X));
    head.push(part(box(0.2, 0.025, 0.03), 0xc8c2a0, 0.05, 0.31, z));
  }
  return { body, head, headY: 0.78 };
}

// The amplifier pylon: a scaffold pipe mast on a concrete-filled tyre, guyed three ways, a
// field radio and a car battery at its foot, a junction box on it; at the top a yagi antenna
// that turns, and over it a small warning light.
function pylonModel(): Model {
  const H = 2.0;
  const body: Part[] = [
    part(cyl(0.3, 0.3, 0.2, 10), RUB, 0, 0.1, 0), part(cyl(0.2, 0.2, 0.205, 10), CONC, 0, 0.105, 0),
    rod([0, 0.2, 0], [0, H, 0], 0.035, STEEL, 6),
    part(box(0.16, 0.24, 0.1), 0x7a7868, 0.06, 0.95, 0), part(box(0.04, 0.05, 0.02), RED, 0.06, 1.0, 0.055),
    ...[0, 1, 2].flatMap((k) => { const a = k * 2.094 + 0.8; const g: V3 = [Math.cos(a) * 0.46, 0.02, Math.sin(a) * 0.46]; return [rod([0, H - 0.4, 0], g, 0.008, STEEL_D), part(box(0.04, 0.08, 0.04), STEEL_D, g[0], 0.04, g[2])]; }),
    part(box(0.3, 0.2, 0.18), OD, 0.25, 0.1, -0.3, 0, 0.4, 0), part(box(0.1, 0.03, 0.03), INK, 0.22, 0.21, -0.25, 0, 0.4, 0),
    part(cyl(0.006, 0.006, 0.5, 3), INK, 0.3, 0.45, -0.38),
    ...battery(-0.3, 0, 0.25, 1.2),
    rod([0.06, 0.82, 0], [0.2, 0.2, -0.24], 0.012, RUB), rod([-0.3, 0.2, 0.25], [0.04, 0.86, 0], 0.012, RED),
  ];
  const spin: Part[] = [part(box(0.8, 0.025, 0.025), STEEL_L, 0, 0, 0), part(box(0.06, 0.08, 0.06), STEEL_D, 0, -0.03, 0)];
  [0.34, 0.16, -0.02, -0.2, -0.34].forEach((x, i) => spin.push(part(box(0.015, 0.015, 0.4 - i * 0.03), STEEL_L, x, 0, 0)));
  return { body, spin, spinAt: [0, H + 0.04, 0], glow: { parts: [part(sphere(0.035, 6, 4), 0, 0, H + 0.12, 0), part(box(0.01, 0.06, 0.01), 0, 0, H + 0.08, 0)], color: 0xff5a2a, pulse: 3 } };
}

// Models face +x and stand on y = 0, centred on their footprint.
function modelFor(kind: number): Model {
  switch (kind) {
    case K_CORE: return coreModel();
    case K_ARMORY: return armoryModel();
    case K_GUN: return gunModel();
    case K_CANNON: return cannonModel();
    case K_FROST: return frostModel();
    case K_TESLA: return teslaModel();
    case K_SNIPER: return sniperModel();
    case K_MISSILE: return missileModel();
    case K_BAIT: case K_CATAPULT: return trapModel(kind);
    case K_PYLON: return pylonModel();
  }
  return { body: [part(box(0.9, 0.8, 0.9), 0x888888, 0, 0.4, 0)] };
}

interface Built { body: THREE.BufferGeometry; head?: THREE.BufferGeometry; headY: number; gun?: THREE.BufferGeometry; gunX: number; glow?: THREE.BufferGeometry; glowMat?: THREE.Material; spin?: THREE.BufferGeometry; spinAt: [number, number, number]; dmg?: THREE.BufferGeometry[] }

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

// The wall's look: a palisade of sharpened logs on a low dirt berm, lashed with wire to split
// rails behind; a thick post on each tile, and towards each neighbour half a run of logs, now
// and then patched with a sheet of corrugated iron or a car door wired across it (ARMS: plain,
// sheet, door). A gate is welded scrap: a steel post with a warning lamp, and leaves of square
// tube framing a plate, bars and a hazard-striped top rail, hinged at the post and running on a
// caster.
const ARMS = 3;
function wallPost(): THREE.BufferGeometry {
  return merge([
    part(box(0.44, 0.12, 0.44), PAL.dirt, 0, 0.04, 0, 0, 0.785, 0),
    ...stake(0, 0, 1.62, 0.11, WOOD_W),
    part(box(0.25, 0.04, 0.25), INK, 0, 0.6, 0), part(box(0.25, 0.04, 0.25), INK, 0, 1.3, 0),
  ]);
}
function wallArm(v: number): THREE.BufferGeometry {
  const p: Part[] = [
    part(box(0.5, 0.11, 0.4), PAL.dirt, 0.25, 0.035, 0),
    part(box(0.5, 0.06, 0.06), WOOD_G, 0.25, 0.55, -0.12), part(box(0.5, 0.06, 0.06), WOOD_G, 0.25, 1.25, -0.12, 0.05, 0, 0.02),
    ...stake(0.17, 0.005, 1.5, 0.09, v === 1 ? WOOD_G : WOOD_W, 0.03, -0.02), ...stake(0.335, -0.01, 1.57, 0.095, v === 2 ? WOOD_W : WOOD, -0.02, 0.025),
    part(box(0.5, 0.03, 0.025), STEEL_D, 0.25, 0.62, 0.115), part(box(0.5, 0.03, 0.025), STEEL_D, 0.25, 1.32, 0.115),
  ];
  if (v === 1) {
    p.push(part(box(0.44, 0.66, 0.02), RUST, 0.26, 0.72, 0.115, 0, 0.04, 0.05));
    for (const x of [0.1, 0.2, 0.3, 0.4]) p.push(part(box(0.035, 0.64, 0.02), RUST_L, x, 0.72, 0.125, 0, 0.04, 0.05));
  } else if (v === 2) {
    const DOOR = 0x4e6472;
    p.push(
      part(box(0.86, 0.42, 0.04), DOOR, 0.5, 0.62, 0.13, 0, 0, 0.03),
      part(box(0.2, 0.28, 0.035), RUST, 0.24, 0.6, 0.142, 0, 0, 0.03),
      part(box(0.08, 0.03, 0.03), STEEL_L, 0.74, 0.74, 0.16),
      part(box(0.04, 0.3, 0.035), darker(DOOR, 0.7), 0.1, 0.98, 0.13, 0, 0, 0.35), part(box(0.68, 0.04, 0.035), darker(DOOR, 0.7), 0.52, 1.12, 0.13),
      part(box(0.04, 0.32, 0.035), darker(DOOR, 0.7), 0.9, 0.98, 0.13),
    );
  }
  return merge(p);
}
function gatePost(): THREE.BufferGeometry {
  return merge([
    part(box(0.4, 0.2, 0.4), CONC, 0, 0.1, 0),
    part(box(0.13, 1.55, 0.13), STEEL, 0, 0.88, 0),
    part(box(0.16, 0.04, 0.16), STEEL_D, 0, 1.66, 0),
    part(cyl(0.05, 0.06, 0.1, 6), 0xd8902a, 0, 1.73, 0),
    part(box(0.04, 0.08, 0.16), STEEL_D, 0.08, 0.45, 0), part(box(0.04, 0.08, 0.16), STEEL_D, 0.08, 1.25, 0),
  ]);
}
function gateLeaf(): THREE.BufferGeometry {
  const FR = 0x4a4c44, PLATE = 0x5e5a48;
  const p: Part[] = [
    part(box(0.5, 0.05, 0.05), FR, 0.25, 0.2, 0), part(box(0.5, 0.05, 0.05), FR, 0.25, 0.85, 0),
    part(box(0.05, 1.3, 0.05), FR, 0.47, 0.82, 0), part(box(0.05, 1.3, 0.05), FR, 0.08, 0.82, 0),
    part(box(0.4, 0.62, 0.02), PLATE, 0.27, 0.52, 0.01),
    part(box(0.18, 0.26, 0.025), RUST, 0.35, 0.36, 0.015), part(box(0.14, 0.2, 0.025), OD, 0.18, 0.68, 0.015),
    part(cyl(0.05, 0.05, 0.03, 6), RUB, 0.47, 0.05, 0, X, 0, 0),
  ];
  for (const x of [0.17, 0.27, 0.37]) p.push(part(box(0.02, 0.6, 0.02), STEEL_D, x, 1.15, 0));
  for (let k = 0; k < 4; k++) p.push(part(box(0.105, 0.08, 0.07), k % 2 ? INK : HAZ, 0.08 + 0.0525 + k * 0.105, 1.47, 0));
  p.push(rod([0.1, 0.24, 0.0], [0.45, 0.82, 0.0], 0.02, FR));
  return merge(p);
}

class WallSet {
  posts: THREE.InstancedMesh; arms: THREE.InstancedMesh[]; gposts: THREE.InstancedMesh; garms: THREE.InstancedMesh;
  constructor(private group: THREE.Group, private mat: THREE.Material, cap: number) {
    const mk = (g: THREE.BufferGeometry) => this.mesh(g, cap);
    this.posts = mk(wallPost());
    this.arms = Array.from({ length: ARMS }, (_, v) => mk(wallArm(v)));
    this.gposts = mk(gatePost());
    this.garms = mk(gateLeaf());
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
    this.posts = grow(this.posts); this.arms = this.arms.map(grow);
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
    b = { body: merge(m.body), headY: m.headY ?? 0, gunX: m.gunX ?? 0, spinAt: m.spinAt ?? [0, 0, 0] };
    if (m.head) b.head = merge(m.head);
    if (m.gun) b.gun = merge(m.gun);
    if (m.glow) { b.glow = merge(m.glow.parts); b.glowMat = kind === K_CORE ? coreLampMaterial() : glowMaterial(m.glow.color, m.glow.pulse); }
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
      // The owner's colour, a little worn, as a painted kerb round the footprint.
      const r = w * 0.5 + 0.02, c = mute(playerColor(owner), 0.8, 0.05);
      g = merge([
        part(box(r * 2, 0.06, 0.07), c, 0, 0.03, r), part(box(r * 2, 0.06, 0.07), c, 0, 0.03, -r),
        part(box(0.07, 0.06, r * 2), c, r, 0.03, 0), part(box(0.07, 0.06, r * 2), c, -r, 0.03, 0),
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
    if (b.glow) { glow = new THREE.Mesh(b.glow, b.glowMat); g.add(glow); }
    if (b.spin) { spin = new THREE.Mesh(b.spin, this.mat); spin.position.set(...b.spinAt); spin.castShadow = true; g.add(spin); }
    const dmg: THREE.Object3D[] = [];
    for (const d of b.dmg ?? []) { const m = new THREE.Mesh(d, this.mat); m.visible = false; m.castShadow = true; g.add(m); dmg.push(m); }
    if (isTrapKind(kind)) trapMake(g, head, kind, this.mat);
    const def = this.defs[kind];
    const evo = f.sEvo[i], tier = kind === K_CORE ? Math.max(1, f.tier) : 0;
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
    if (kind === K_CORE) {
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
      if (o && o.kind === k && o.x === f.sX[i] && o.y === f.sY[i] && o.level === f.sLevel[i] && o.owner === f.sOwner[i] && o.evo === f.sEvo[i] && (k !== K_CORE || o.tier === Math.max(1, f.tier))) continue;
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
    const isGate = (x: number, y: number) => { const s = game.structAtTile(x, y); return s >= 0 && f.sKind[s] === K_GATE; };
    let np = 0, gp = 0, ga = 0;
    const na = ws.arms.map(() => 0);
    const pa = ws.posts.instanceMatrix.array as Float32Array, aa = ws.arms.map((m) => m.instanceMatrix.array as Float32Array);
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
      dirs.forEach(([dx, dy, a], d) => {
        if (!isWall(x + dx, y + dy)) return;
        const r = out ? Math.atan2(dy * 0.2 + out[1], dx * 0.2 + out[0]) : a;
        if (gate) { writeMatrix(gaa, ga++ * 16, cx, 0, cz, r, 1); return; }
        // A patch now and then: a sheet on one in five half-runs, a car door (which spans the
        // whole run, so only from the tile on its west or north end) on one in nine.
        const h = ((x * 73856093) ^ (y * 19349663) ^ (d * 83492791)) >>> 0;
        const v = d < 2 && h % 9 === 0 && !isGate(x + dx, y + dy) ? 2 : h % 5 === 1 ? 1 : 0;
        writeMatrix(aa[v], na[v]++ * 16, cx, 0, cz, r, 1);
      });
    }
    const set = (m: THREE.InstancedMesh, c: number) => { m.count = c; m.instanceMatrix.needsUpdate = true; };
    set(ws.posts, np); ws.arms.forEach((m, v) => set(m, na[v])); set(ws.gposts, gp); set(ws.garms, ga);
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
        if (o.spin) { o.spinA += dt * (7 - 5 * d) * (d > 0.6 && Math.sin(t * 3) > 0.6 ? 0.1 : 1); o.spin.rotation.y = o.spinA; }
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
    if (b.glow) g.add(new THREE.Mesh(b.glow, mat));
    if (b.spin) { const h = new THREE.Mesh(b.spin, mat); h.position.set(...b.spinAt); g.add(h); }
    if (isTrapKind(kind)) { trapGhost(g, head, kind, mat, band); trapFace(g, facing); }
    return g;
  }
}

