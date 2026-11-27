import * as THREE from 'three/webgpu';
import { mix, normalWorld, smoothstep, vec3, vertexColor } from 'three/tsl';
import { PF_ALIVE, SiteKind, Tile, walled, wreck, type SiteDef, type Welcome } from '../protocol';
import { Wrecks } from '../predict';
import type { Game } from '../state';
import { indexed } from './rig';
import { painted } from './paint';
import { blend, darker, lighter, mute, PAL } from './palette';
import { box, cyl, dodeca, merge, part, torus, type Part } from './util';
import { uSnow, uWet } from './weather';

// ---- The wasteland's set dressing ----
//
// What the end of the world left lying about: bones and the dead in bags, blood and drag marks,
// luggage, clothes and trash, tyres, drums and cans, broken pallets and trolleys, fences and
// wire, leaning power poles with their wires, bent road signs, painted warnings, cones, craters
// and burnt ground, and crows on it all. Purely for looks: nothing here is in the sim, nothing
// blocks, and everything is low or thin so walking through it does not jar. Placed from the
// map's tiles and sites with a hash, so every player sees the same world; it tells a story
// rather than sprinkling noise: thick round ruins, along roads, at the landmarks and where the
// roads leave the base (a quarantine checkpoint), thin in open country, and none in the build
// radius, on water, in solid tiles, on wrecks and loot or on the helipad.
//
// Built from merged parts like the rest of the scene, one instanced mesh a kind, culled by
// block as the terrain's props are; the detail governor's level thins the incidental ones.

function hash(x: number, y: number, s = 0): number {
  let h = Math.imul(x * 374761393 + y * 668265263 + s * 1442695041, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Metres to world units (a 1.8 m survivor is about 1.53), as loot.ts builds its props.
const M = 0.85;
const PI = Math.PI;
const OLD_BLOOD = 0x3a2416, BLOOD = 0x3c1c12, BLOOD_HEART = 0x4a2016;
const BONE = 0xb4aa86, BONE_DARK = 0x948a6a, CHAR = 0x241f18, SCORCH = 0x2e2820, ASH = 0x5a5650;
const WOOD = 0x6e604a, WOOD_DARK = 0x4e4232, CREOSOTE = 0x45362a, WIRE = 0x2a2824, PAINT = 0xc0b896;

const bx = (w: number, h: number, d: number, col: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): Part => part(box(w, h, d), col, x, y, z, rx, ry, rz);
// A flat disc lying on the ground, sx by sz across: blood, oil, scorch.
const disc = (r: number, col: number, x: number, y: number, z: number, sx = 1, sz = 1, seg = 8): Part => part(cyl(r, r, 0.01, seg), col, x, y, z, 0, (x * 7 + z * 3) % 3, 0, sx, 1, sz);
const lump = (r: number, col: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0): Part => part(dodeca(r), col, x, y, z, 0, ry, 0, sx, sy, sz);

// A round rod from a to b, for bones, wires, frames and posts.
const UP = new THREE.Vector3(0, 1, 0);
function rod(a: number[], b: number[], r: number, col: number, seg = 4, r2 = r): Part {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const g = new THREE.CylinderGeometry(r2, r, d.length(), seg, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return { geo: g, color: col };
}

// Merged and brought from metres to world units.
function built(ps: Part[], scale = M): THREE.BufferGeometry {
  const g = merge(ps);
  g.scale(scale, scale, scale);
  g.computeBoundingSphere();
  return g;
}

// ---- Pixel text: the HUD's 3x5 font, painted on boards and on the ground ----

const GLYPH: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', K: '101101110101101',
  L: '100100100100111', N: '110101101101101', O: '010101101101010', P: '110101110100100', Q: '010101101110011',
  R: '110101110101101', S: '011100010001110', T: '111010010010010', U: '101101101101111', Y: '101101010010010',
  ' ': '000000000000000',
};

// The text's pixels as quads, runs of a row merged, px a pixel, centred on x. Upright on a
// board's face at z (facing +z), or lying on the ground at y (read from the camera's side).
function text(s: string, px: number, col: number, cx: number, cy: number, z: number, flat: boolean): Part[] {
  const cols = s.length * 4 - 1, ps: Part[] = [];
  const x0 = cx - cols * px / 2;
  [...s].forEach((ch, i) => {
    const g = GLYPH[ch] ?? GLYPH[' '];
    for (let row = 0; row < 5; row++) {
      for (let c = 0; c < 3;) {
        if (g[row * 3 + c] !== '1') { c++; continue; }
        let e = c;
        while (e < 3 && g[row * 3 + e] === '1') e++;
        const q = new THREE.PlaneGeometry((e - c) * px, px);
        const x = x0 + (i * 4 + (c + e) / 2) * px;
        if (flat) {
          q.rotateX(-PI / 2);
          ps.push(part(q, col, x, cy, z + (row + 0.5) * px - 2.5 * px));
        } else {
          ps.push(part(q, col, x, cy + 2.5 * px - (row + 0.5) * px, z));
        }
        c = e;
      }
    }
  });
  return ps;
}

// ---- The props, in metres, facing +x on y = 0 ----

// A body long dead, on its back, head to +x: skull, ribs, spine, the limbs splayed, a rag of
// shirt under it and the old stain it lies in.
function skeleton(): THREE.BufferGeometry {
  const ps: Part[] = [
    disc(0.55, OLD_BLOOD, 0.15, 0.004, 0.02, 1.7, 1),
    disc(0.32, darker(OLD_BLOOD, 0.8), -0.2, 0.007, 0.1, 1.4, 1),
    lump(0.1, BONE, 0.84, 0.085, 0, 1.15, 0.95, 0.9),
    bx(0.04, 0.02, 0.035, PAL.ink, 0.86, 0.17, 0.038), bx(0.04, 0.02, 0.035, PAL.ink, 0.86, 0.17, -0.038),
    bx(0.07, 0.04, 0.1, BONE_DARK, 0.95, 0.035, 0),
    bx(0.6, 0.04, 0.045, BONE_DARK, 0.4, 0.045, 0),
    bx(0.12, 0.07, 0.26, BONE_DARK, 0.06, 0.05, 0),
    // Arms and legs.
    rod([0.62, 0.04, 0.17], [0.36, 0.04, 0.32], 0.024, BONE), rod([0.36, 0.04, 0.32], [0.12, 0.035, 0.4], 0.02, BONE),
    rod([0.62, 0.04, -0.17], [0.4, 0.04, -0.3], 0.024, BONE), rod([0.4, 0.04, -0.3], [0.48, 0.035, -0.55], 0.02, BONE),
    bx(0.1, 0.02, 0.08, BONE_DARK, 0.1, 0.02, 0.43, 0, 0.4, 0), bx(0.1, 0.02, 0.08, BONE_DARK, 0.52, 0.02, -0.62, 0, 1.2, 0),
    rod([0.04, 0.045, 0.08], [-0.4, 0.04, 0.16], 0.03, BONE), rod([-0.4, 0.04, 0.16], [-0.82, 0.035, 0.24], 0.025, BONE),
    rod([0.04, 0.045, -0.08], [-0.42, 0.04, -0.1], 0.03, BONE), rod([-0.42, 0.04, -0.1], [-0.84, 0.035, -0.06], 0.025, BONE),
    bx(0.09, 0.02, 0.07, BONE_DARK, -0.88, 0.02, 0.27, 0, 0.2, 0), bx(0.09, 0.02, 0.07, BONE_DARK, -0.9, 0.02, -0.05, 0, -0.1, 0),
  ];
  for (let i = 0; i < 5; i++) {
    const x = 0.62 - i * 0.07;
    for (const s of [1, -1]) ps.push(bx(0.028, 0.028, 0.17 - i * 0.012, BONE, x, 0.085, s * 0.09, s * 0.55, 0, 0));
  }
  return built(ps);
}

// Bones scattered by what ate the rest: a skull, long bones, a jaw, a piece of a ribcage.
function bones(): THREE.BufferGeometry {
  return built([
    disc(0.3, OLD_BLOOD, 0, 0.004, 0, 1.6, 1),
    lump(0.095, BONE, 0.2, 0.08, -0.1, 1.15, 0.95, 0.9, 0.7),
    bx(0.035, 0.025, 0.035, PAL.ink, 0.27, 0.11, -0.15, 0, 0.7, 0),
    rod([-0.4, 0.035, 0.05], [0.0, 0.035, 0.22], 0.028, BONE), rod([-0.2, 0.03, -0.2], [0.05, 0.03, -0.35], 0.024, BONE_DARK),
    rod([0.3, 0.03, 0.2], [0.55, 0.03, 0.12], 0.02, BONE),
    bx(0.08, 0.035, 0.1, BONE_DARK, -0.42, 0.03, 0.04, 0, 0.5, 0),
    ...[0, 1, 2].map((i) => bx(0.025, 0.025, 0.2, BONE, -0.15 + i * 0.07, 0.06, -0.05, 0.6, 0.3, 0)),
  ]);
}

// Old blood: a dark pool, a fresher heart to it, specks round it.
function blood(): THREE.BufferGeometry {
  return built([
    disc(0.42, OLD_BLOOD, 0, 0.004, 0, 1.4, 1.1),
    disc(0.3, BLOOD, 0.12, 0.007, -0.05, 1.2, 1),
    disc(0.16, BLOOD_HEART, 0.18, 0.01, 0.02, 1, 1),
    disc(0.08, OLD_BLOOD, -0.58, 0.004, 0.3), disc(0.06, OLD_BLOOD, 0.62, 0.004, -0.36), disc(0.05, BLOOD, -0.3, 0.004, -0.5),
  ]);
}

// Something dragged off: a pool, then a smear that thins and breaks into two streaks.
function drag(): THREE.BufferGeometry {
  const ps: Part[] = [disc(0.36, OLD_BLOOD, 0, 0.004, 0, 1.2, 1), disc(0.2, BLOOD, 0.05, 0.008, 0, 1, 1)];
  for (let i = 0; i < 7; i++) {
    const x = -0.35 - i * 0.32, wd = 0.34 - i * 0.035;
    ps.push(bx(0.36, 0.008, wd, i % 2 ? OLD_BLOOD : BLOOD, x, 0.005, Math.sin(i * 0.9) * 0.05, 0, Math.sin(i) * 0.08, 0));
  }
  ps.push(bx(0.6, 0.008, 0.05, OLD_BLOOD, -2.6, 0.005, 0.08, 0, 0.1, 0), bx(0.5, 0.008, 0.05, OLD_BLOOD, -2.55, 0.005, -0.1, 0, -0.15, 0));
  return built(ps);
}

// A suitcase burst open with its clothes thrown out, another shut, a duffel.
function luggage(): THREE.BufferGeometry {
  const shell = 0x3e4c5a;
  return built([
    bx(0.7, 0.18, 0.48, shell, 0, 0.09, 0), bx(0.64, 0.02, 0.42, 0x6a5a48, 0, 0.18, 0),
    bx(0.7, 0.07, 0.48, darker(shell, 0.85), 0, 0.05, -0.56, -0.12, 0, 0),
    lump(0.14, 0x8a7a5a, 0.1, 0.2, 0.05, 1.6, 0.5, 1.2), lump(0.12, mute(0x5a3e62, 0.8), -0.15, 0.2, -0.05, 1.5, 0.45, 1.2),
    lump(0.14, 0x9a9484, 0.2, 0.04, 0.42, 1.8, 0.35, 1.2, 0.6), lump(0.12, mute(0x2f6a7a, 0.6), -0.2, 0.035, 0.5, 1.7, 0.35, 1.1, 1.1),
    bx(0.62, 0.2, 0.42, 0x5e2e2a, 0.82, 0.1, 0.42, 0, 0.5, 0), bx(0.14, 0.03, 0.03, PAL.ink, 0.95, 0.21, 0.36, 0, 0.5, 0),
    part(cyl(0.16, 0.16, 0.6, 7), PAL.olive, -0.72, 0.15, 0.3, 0, 0.3, PI / 2), bx(0.3, 0.02, 0.05, PAL.ink, -0.72, 0.31, 0.3, 0, 0.3, 0),
  ]);
}

// Clothes dropped in a heap: a jacket with its arms out, jeans, a shirt, a shoe.
function clothes(): THREE.BufferGeometry {
  const jacket = mute(0x6a4a3a, 0.8);
  return built([
    bx(0.5, 0.035, 0.42, jacket, 0, 0.02, 0, 0, 0.2, 0),
    rod([0.08, 0.025, 0.2], [0.38, 0.02, 0.5], 0.06, jacket), rod([-0.1, 0.025, -0.18], [-0.42, 0.02, -0.3], 0.06, darker(jacket, 0.85)),
    bx(0.6, 0.03, 0.14, PAL.denim, -0.1, 0.05, 0.36, 0, -0.4, 0), bx(0.55, 0.03, 0.14, PAL.denimDark, -0.05, 0.05, 0.52, 0, -0.25, 0),
    lump(0.14, PAL.shirtWhite, 0.32, 0.03, -0.2, 1.6, 0.3, 1.2, 0.8),
    bx(0.27, 0.1, 0.1, PAL.leather, -0.45, 0.05, 0.05, 0, 1.1, 0), bx(0.28, 0.025, 0.11, PAL.ink, -0.45, 0.012, 0.05, 0, 1.1, 0),
  ]);
}

// Three tyres: two stacked, one rolled off and lying.
function tyres(): THREE.BufferGeometry {
  const tyre = (x: number, y: number, z: number, rx = 0, rz = 0, col: number = PAL.rubber): Part[] => {
    const t = torus(0.3, 0.11, 4, 10);
    t.rotateX(PI / 2);
    return [part(t, col, x, y, z, rx, 0, rz), part(cyl(0.2, 0.2, 0.04, 8), PAL.ink, x, y - 0.06, z, rx, 0, rz)];
  };
  return built([
    ...tyre(0, 0.11, 0), ...tyre(0.03, 0.33, -0.02, 0, 0, 0x2e2b26),
    ...tyre(0.72, 0.13, 0.35, 0.25, 0.15, 0x2a2722),
  ]);
}

// An oil drum, pale under its instance's paint: ribs, a rusted foot, the lid and its bung.
function drum(): THREE.BufferGeometry {
  const body = 0x9a968a;
  return built([
    part(cyl(0.29, 0.29, 0.88, 10), body, 0, 0.44, 0),
    part(cyl(0.3, 0.3, 0.035, 10), darker(body, 0.85), 0, 0.3, 0), part(cyl(0.3, 0.3, 0.035, 10), darker(body, 0.85), 0, 0.6, 0),
    part(cyl(0.295, 0.3, 0.14, 10), PAL.rust, 0, 0.07, 0),
    part(cyl(0.27, 0.27, 0.02, 10), darker(body, 0.7), 0, 0.885, 0),
    part(cyl(0.04, 0.04, 0.03, 6), PAL.steelDark, 0.15, 0.9, 0.05),
    bx(0.2, 0.18, 0.02, PAL.rust, 0.1, 0.5, 0.29, 0, 0.3, 0),
  ]);
}

// Two jerrycans, a red one standing and an olive one on its side.
function jerrycans(): THREE.BufferGeometry {
  const can = (col: number): Part[] => [
    bx(0.17, 0.45, 0.34, col, 0, 0.225, 0), bx(0.18, 0.02, 0.3, darker(col, 0.8), 0, 0.3, 0),
    bx(0.04, 0.05, 0.2, darker(col, 0.7), 0, 0.47, -0.02), part(cyl(0.025, 0.03, 0.07, 6), PAL.steelDark, 0, 0.48, 0.13, 0.4, 0, 0),
  ];
  const lying = can(0x5a5c32).map((p) => { p.geo.rotateX(PI / 2); p.geo.translate(0.32, 0.09, 0.15); return p; });
  return built([...can(0x8a3424), ...lying]);
}

// A broken pallet with its deck half gone and a loose board beside it.
function pallet(): THREE.BufferGeometry {
  const ps: Part[] = [];
  for (const z of [-0.45, 0, 0.45]) ps.push(bx(1.2, 0.09, 0.08, WOOD_DARK, 0, 0.045, z));
  [-0.52, -0.3, 0.12, 0.5].forEach((x, i) => ps.push(bx(0.12, 0.022, 1.0, i % 2 ? WOOD : blend(WOOD, PAL.stone, 0.3), x, 0.1, 0, 0, (i - 1.5) * 0.04, 0)));
  ps.push(bx(0.12, 0.022, 0.6, WOOD, 0.3, 0.06, 0.25, 0.1, 0.2, 0.25), bx(0.95, 0.025, 0.12, lighter(WOOD, 0.1), 0.25, 0.015, 0.85, 0, 0.35, 0));
  return built(ps);
}

// A shopping trolley lying on its side, wheels out.
function trolley(): THREE.BufferGeometry {
  const c = PAL.steelLit, d = darker(PAL.steelLit, 0.75), r = 0.018, ps: Part[] = [];
  const lo = 0.45, hi = 0.95, xb = -0.42, xf = 0.42;
  const wz = (x: number) => 0.26 - (x - xb) / (xf - xb) * 0.06;
  for (const [y, k] of [[lo, 0.9], [hi, 1]]) {
    const zb = wz(xb) * k, zf = wz(xf) * k;
    ps.push(rod([xb, y, -zb], [xf, y, -zf], r, c), rod([xb, y, zb], [xf, y, zf], r, c), rod([xb, y, -zb], [xb, y, zb], r, c), rod([xf, y, -zf], [xf, y, zf], r, c));
  }
  for (const x of [xb, xf]) for (const s of [1, -1]) ps.push(rod([x, lo, s * wz(x) * 0.9], [x, hi, s * wz(x)], r, c));
  for (let i = 1; i < 6; i++) {
    const x = xb + (xf - xb) * i / 6;
    for (const s of [1, -1]) ps.push(rod([x, lo, s * wz(x) * 0.9], [x, hi, s * wz(x)], r * 0.8, d));
  }
  ps.push(rod([xb - 0.1, hi + 0.05, -0.24], [xb - 0.1, hi + 0.05, 0.24], 0.025, 0x8a3424));
  for (const s of [1, -1]) {
    ps.push(rod([xb - 0.1, hi + 0.05, s * 0.24], [xb, hi, s * wz(xb)], r, c));
    ps.push(rod([xb, lo, s * 0.2], [xb + 0.05, 0.1, s * 0.22], r, d), rod([xf, lo, s * 0.18], [xf - 0.02, 0.1, s * 0.2], r, d));
    ps.push(rod([xb + 0.05, 0.1, s * 0.22], [xf - 0.02, 0.1, s * 0.2], r, d));
    for (const x of [xb + 0.05, xf - 0.02]) ps.push(part(cyl(0.05, 0.05, 0.035, 8), PAL.rubber, x, 0.05, s * 0.21, PI / 2, 0, 0));
  }
  for (const p of ps) { p.geo.rotateX(PI / 2); p.geo.translate(0, 0.28, 0); }
  return built(ps);
}

// One run of fence a unit long along +x, its post at 0, stretched to the spacing: three
// strands of wire sagging to the next post.
function fenceWire(): THREE.BufferGeometry {
  const ps: Part[] = [rod([0, 0, 0], [0.02, 1.0, 0], 0.035, WOOD_DARK, 5, 0.03), bx(0.08, 0.04, 0.08, WOOD_DARK, 0.02, 1.0, 0)];
  for (const y of [0.35, 0.62, 0.88]) {
    ps.push(rod([0, y, 0.03], [0.5, y - 0.06, 0.03], 0.012, WIRE, 3), rod([0.5, y - 0.06, 0.03], [1, y, 0.03], 0.012, WIRE, 3));
  }
  return built(ps, 1);
}

// The same run broken: the post leaning, one strand still up, the others snapped and trailing.
function fenceBroken(): THREE.BufferGeometry {
  return built([
    rod([0, 0, 0], [0.28, 0.9, 0.12], 0.035, WOOD_DARK, 5, 0.03),
    rod([0.09, 0.3, 0.06], [0.5, 0.2, 0.03], 0.012, WIRE, 3), rod([0.5, 0.2, 0.03], [1, 0.35, 0.03], 0.012, WIRE, 3),
    rod([0.2, 0.62, 0.1], [0.45, 0.02, 0.2], 0.012, WIRE, 3), rod([1, 0.62, 0.03], [0.72, 0.02, -0.1], 0.012, WIRE, 3),
    rod([1, 0.88, 0.03], [0.8, 0.3, 0.02], 0.012, WIRE, 3),
  ], 1);
}

// A picket fence's run round a house: post, two rails, pickets with gaps, grey with age.
function picket(): THREE.BufferGeometry {
  const pale = 0x8f877a, ps: Part[] = [bx(0.08, 0.9, 0.08, darker(pale, 0.7), 0, 0.45, 0)];
  for (const y of [0.3, 0.68]) ps.push(bx(1, 0.05, 0.03, darker(pale, 0.8), 0.5, y, 0.05));
  [0.17, 0.34, 0.66, 0.83].forEach((x, i) => ps.push(bx(0.09, 0.78 + (i % 2) * 0.06, 0.02, i === 2 ? darker(pale, 0.9) : pale, x, 0.4, 0.075, 0, 0, i === 3 ? 0.18 : 0)));
  ps.push(bx(0.09, 0.8, 0.02, darker(pale, 0.85), 0.5, 0.03, 0.3, PI / 2, 0.4, 0));
  return built(ps, 1);
}

// Concertina wire, a unit long along +x: loops staggered along a line, staked at the ends.
function wireCoil(): THREE.BufferGeometry {
  const ps: Part[] = [];
  for (let i = 0; i < 7; i++) {
    const t = torus(0.32, 0.016, 3, 10);
    t.rotateY(PI / 2);
    ps.push(part(t, i % 2 ? 0x5e5a50 : 0x6e6858, 0.07 + i * 0.14, 0.32, (i % 2 - 0.5) * 0.05, 0, 0, (i % 2 ? 1 : -1) * 0.35));
  }
  ps.push(rod([0, 0, 0], [0, 0.55, 0], 0.02, PAL.rust), rod([1, 0, 0], [1, 0.5, 0], 0.02, PAL.rust));
  return built(ps, 1);
}

// A power pole of creosoted wood with its crossarm across the line and the insulators on it,
// in world units; the wires hang from ATTACH either end of the crossarm.
const POLE_H = 4.4, ATTACH_Y = POLE_H - 0.3, ATTACH_Z = 0.62;
function pole(): THREE.BufferGeometry {
  const ps: Part[] = [
    part(cyl(0.065, 0.095, POLE_H, 7), CREOSOTE, 0, POLE_H / 2, 0),
    bx(0.08, 0.1, 1.45, WOOD_DARK, 0, POLE_H - 0.4, 0),
    rod([0, POLE_H - 0.8, 0], [0, POLE_H - 0.42, 0.5], 0.02, PAL.steelDark), rod([0, POLE_H - 0.8, 0], [0, POLE_H - 0.42, -0.5], 0.02, PAL.steelDark),
    bx(0.05, 0.05, 0.05, PAL.steel, 0, POLE_H - 1.2, 0.07),
  ];
  for (const z of [-ATTACH_Z, ATTACH_Z]) ps.push(part(cyl(0.035, 0.045, 0.12, 6), 0x6a7a6a, 0, POLE_H - 0.29, z));
  return built(ps, 1);
}

// A wire a unit long along +x, sagging; stretched and sheared between two attach points.
const SAG = 0.38;
function wire(): THREE.BufferGeometry {
  const ps: Part[] = [], n = 6, y = (t: number) => -SAG * 4 * t * (1 - t);
  for (let i = 0; i < n; i++) ps.push(rod([i / n, y(i / n), 0], [(i + 1) / n, y((i + 1) / n), 0], 0.022, WIRE, 3));
  return built(ps, 1);
}

// A road sign on a post bent over by something heavy: a diamond, pale under its instance's
// paint, its symbol and bullet holes on the face.
function roadSign(): THREE.BufferGeometry {
  return built([
    rod([0, 0, 0], [0.04, 1.15, 0], 0.035, PAL.steel), rod([0.04, 1.15, 0], [0.38, 1.75, 0.06], 0.035, PAL.steel),
    bx(0.56, 0.56, 0.03, PAINT, 0.45, 1.95, 0.06, 0, 0, PI / 4 + 0.5),
    bx(0.6, 0.6, 0.02, PAL.steelDark, 0.45, 1.95, 0.035, 0, 0, PI / 4 + 0.5),
    bx(0.06, 0.2, 0.01, PAL.ink, 0.43, 2.0, 0.088, 0, 0, 0.5), bx(0.06, 0.06, 0.01, PAL.ink, 0.5, 1.84, 0.088, 0, 0, 0.5),
    bx(0.03, 0.03, 0.01, PAL.ink, 0.32, 1.86, 0.088), bx(0.03, 0.03, 0.01, PAL.ink, 0.58, 2.08, 0.088),
  ]);
}

// A board on two posts with words painted on it, its face to +z.
function board(words: string, w: number, hgt: number, px: number, face: number, ink: number, hazard: boolean): THREE.BufferGeometry {
  const y0 = 0.7, ps: Part[] = [];
  for (const s of [-1, 1]) ps.push(bx(0.09, y0 + hgt + 0.05, 0.09, WOOD_DARK, s * (w / 2 - 0.25), (y0 + hgt + 0.05) / 2, -0.07, 0, 0, s * 0.02));
  ps.push(bx(w, hgt, 0.04, face, 0, y0 + hgt / 2, 0));
  // Painted on both faces, so it reads whichever way the view is turned.
  for (const back of [false, true]) {
    const face: Part[] = text(words, px, ink, 0, y0 + hgt / 2 + (hazard ? 0.06 : 0), 0.032, false);
    if (hazard) {
      const n = Math.floor(w / 0.16);
      for (let i = 0; i < n; i++) face.push(bx(w / n, 0.1, 0.01, i % 2 ? PAL.ink : PAL.hardHat, -w / 2 + (i + 0.5) * w / n, y0 + 0.07, 0.03));
    }
    if (back) for (const p of face) p.geo.rotateY(PI);
    ps.push(...face);
  }
  // A corner split off and a hole shot through.
  ps.push(bx(0.07, 0.07, 0.01, PAL.ink, w * 0.3, y0 + hgt * 0.8, 0.03), bx(0.05, 0.05, 0.01, PAL.ink, -w * 0.35, y0 + hgt * 0.3, 0.03));
  return built(ps);
}

// A traffic cone, faded orange with its pale band, on its black foot.
function cone(): THREE.BufferGeometry {
  const orange = blend(PAL.capOrange, PAL.hiVis, 0.5);
  return built([
    bx(0.36, 0.035, 0.36, PAL.rubber, 0, 0.018, 0),
    part(cyl(0.025, 0.13, 0.6, 8), orange, 0, 0.33, 0),
    part(cyl(0.082, 0.098, 0.1, 8), PAL.hiVisBand, 0, 0.36, 0),
  ]);
}

// A shell crater: a broken rim of thrown earth round scorched ground.
function crater(): THREE.BufferGeometry {
  const ps: Part[] = [disc(1.05, SCORCH, 0, 0.004, 0, 1, 0.9, 10), disc(0.6, CHAR, 0.05, 0.008, -0.04, 1, 0.9, 9)];
  for (let i = 0; i < 9; i++) {
    const a = i * 2 * PI / 9 + Math.sin(i * 3) * 0.2, r = 1.15 + Math.sin(i * 5) * 0.1;
    ps.push(lump(0.3, i % 3 ? PAL.dirtDark : PAL.dirt, Math.cos(a) * r, 0.03, Math.sin(a) * r * 0.9, 1.4, 0.35, 0.9, a));
  }
  ps.push(lump(0.08, PAL.stoneDark, 0.3, 0.02, 0.2, 1, 0.6, 1), lump(0.07, PAL.stone, -0.4, 0.02, -0.1, 1, 0.6, 1));
  return built(ps);
}

// Burnt ground: a scorch, charred sticks and lumps of ash where something was burnt.
function burnt(): THREE.BufferGeometry {
  return built([
    disc(0.9, SCORCH, 0, 0.004, 0, 1.2, 0.9, 9), disc(0.55, CHAR, 0.2, 0.008, -0.1, 1.3, 1, 8), disc(0.3, 0x3a3428, -0.5, 0.01, 0.3),
    rod([-0.4, 0.04, -0.1], [0.4, 0.05, 0.15], 0.04, 0x1f1b16), rod([0.0, 0.04, -0.35], [0.3, 0.06, 0.3], 0.035, 0x1f1b16),
    rod([-0.2, 0.03, 0.3], [0.5, 0.03, -0.2], 0.03, 0x2a241c),
    lump(0.12, ASH, 0.1, 0.03, 0.05, 1.4, 0.4, 1), lump(0.08, 0x46423c, -0.25, 0.025, -0.15, 1.3, 0.4, 1),
  ]);
}

// Trash: newspapers, a can, a bottle, a torn bag.
function trash(): THREE.BufferGeometry {
  const paper = 0xa8a088;
  return built([
    bx(0.38, 0.006, 0.28, paper, 0, 0.012, 0, 0.04, 0.3, 0.03), bx(0.34, 0.006, 0.26, darker(paper, 0.88), 0.4, 0.016, 0.3, -0.05, 1.2, 0.06),
    bx(0.3, 0.006, 0.22, lighter(paper, 0.08), -0.35, 0.02, -0.2, 0.12, 2.1, 0),
    bx(0.12, 0.007, 0.2, 0x5a5448, 0.02, 0.018, 0.01, 0, 0.3, 0),
    part(cyl(0.035, 0.035, 0.12, 6), 0x8a3424, 0.25, 0.035, -0.25, 0, 0.6, PI / 2),
    part(cyl(0.035, 0.035, 0.22, 6), 0x3a4a30, -0.15, 0.035, 0.35, 0, 1.9, PI / 2),
    lump(0.1, 0x7a8288, 0.6, 0.04, -0.05, 1.3, 0.5, 1),
  ]);
}

// A body bag, dark and zipped, its tag on it.
function bodyBag(): THREE.BufferGeometry {
  const bag = 0x2c2d26;
  return built([
    part(cyl(0.27, 0.27, 1.4, 8), bag, 0, 0.135, 0, 0, 0, PI / 2, 0.5, 1, 1),
    lump(0.27, darker(bag, 0.9), 0.72, 0.12, 0, 0.6, 0.48, 1), lump(0.25, bag, -0.72, 0.11, 0, 0.55, 0.45, 0.95),
    bx(1.55, 0.012, 0.03, 0x7a7c74, 0, 0.27, 0.04),
    bx(0.08, 0.012, 0.06, PAL.medWhite, 0.82, 0.22, 0.12, 0, 0.3, 0),
    bx(0.1, 0.03, 0.04, PAL.ink, -0.3, 0.13, 0.27), bx(0.1, 0.03, 0.04, PAL.ink, 0.3, 0.13, -0.27),
  ]);
}

// A grave: a mound of dirt towards the camera and a cross of two sticks at its head.
function grave(): THREE.BufferGeometry {
  return built([
    lump(0.5, PAL.dirt, 0, 0.06, 0.1, 0.85, 0.3, 2.0), lump(0.3, PAL.dirtDark, 0.1, 0.12, -0.2, 0.9, 0.3, 1.2),
    bx(0.07, 0.95, 0.05, WOOD, 0, 0.47, -0.85), bx(0.5, 0.06, 0.05, WOOD, 0, 0.72, -0.85),
    lump(0.06, PAL.stone, -0.25, 0.02, 0.6, 1, 0.6, 1), lump(0.05, PAL.stoneDark, 0.3, 0.02, -0.4, 1, 0.6, 1),
  ]);
}

// HELP painted large on the ground for whoever flew over, never came.
function help(): THREE.BufferGeometry {
  return built([...text('HELP', 0.32, PAINT, 0, 0.02, 0, true), disc(0.12, PAINT, 2.8, 0.01, 0.7), lump(0.12, PAL.steelDark, 2.9, 0.06, 0.4, 1, 1.4, 1)]);
}

// A crow, a little larger than life to read at the game's zoom: perched with its wings folded,
// or in flight with them up or down.
function crow(fly: number): THREE.BufferGeometry {
  const black = 0x22211e, wing = 0x2d2b27;
  const ps: Part[] = [
    lump(0.1, black, 0, 0.17, 0, 1.6, 0.85, 0.85),
    lump(0.06, black, 0.15, 0.24, 0, 1, 1, 0.9),
    part(new THREE.ConeGeometry(0.022, 0.09, 4), 0x3a3834, 0.23, 0.235, 0, 0, 0, -PI / 2),
    bx(0.16, 0.02, 0.08, wing, -0.19, 0.16, 0, 0, 0, 0.25),
  ];
  if (fly === 0) {
    ps.push(bx(0.22, 0.05, 0.03, wing, -0.02, 0.18, 0.08, 0, 0, 0.1), bx(0.22, 0.05, 0.03, wing, -0.02, 0.18, -0.08, 0, 0, 0.1));
    ps.push(rod([0.0, 0.1, 0.03], [0.02, 0, 0.03], 0.008, 0x3a3834, 3), rod([0.0, 0.1, -0.03], [0.02, 0, -0.03], 0.008, 0x3a3834, 3));
  } else {
    for (const s of [1, -1]) ps.push(bx(0.13, 0.015, 0.34, wing, 0, 0.18 + fly * 0.08, s * 0.2, s * fly * 0.6, 0, 0));
  }
  return built(ps, M * 1.4);
}

// ---- Instancing ----

// Kinds below this share of the props drawn at each detail level (the governor's 0..5). The
// set pieces (poles, wires, signs, fences, checkpoints) always stay.
const KEEP = [1, 1, 0.8, 0.65, 0.5, 0.4];
// From this level on, the props that only throw a shadow at full detail throw none.
const NO_SHADOW_FROM = 3;
const BLOCK = 32;

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3(), _s = new THREE.Vector3();

// One kind of prop over the whole map, sorted into blocks; the blocks in view (or near enough
// to shadow it) are packed to the front of the mesh, and within a block only the share the
// detail level keeps, the essential first.
class Kind {
  private mats: number[] = []; private cols: number[] = []; private keys: number[] = []; private ranks: number[] = [];
  private mesh: THREE.InstancedMesh | null = null;
  private allM = new Float32Array(0); private allC = new Float32Array(0);
  private blocks: { from: number; cut: number[]; box: THREE.Box3 }[] = [];
  private shown = '';
  count = 0;

  // shadow: 0 never, 1 at full detail, 2 always. tall: how high it stands and how far its
  // shadow may reach, for culling. r: how far it reaches round where it stands.
  constructor(readonly name: string, readonly geo: THREE.BufferGeometry, readonly shadow: 0 | 1 | 2, readonly r: number, readonly tall = 2) {}

  add(e: ArrayLike<number>, col: number[], rank: number, x: number, z: number): void {
    for (let i = 0; i < 16; i++) this.mats.push(e[i]);
    this.cols.push(col[0], col[1], col[2]);
    this.ranks.push(rank);
    this.keys.push((Math.floor(x / BLOCK) + 8) * 1024 + Math.floor(z / BLOCK) + 8);
  }

  // How many of this kind each detail level draws.
  // Before build.
  counts(): number[] {
    return KEEP.map((k) => this.ranks.filter((r) => r < k).length);
  }

  build(group: THREE.Group, mat: THREE.Material): void {
    const n = this.keys.length;
    this.count = n;
    if (!n) return;
    const order = [...this.keys.keys()].sort((a, b) => this.keys[a] - this.keys[b] || this.ranks[a] - this.ranks[b]);
    this.allM = new Float32Array(n * 16); this.allC = new Float32Array(n * 3);
    let start = 0;
    order.forEach((i, j) => {
      for (let e = 0; e < 16; e++) this.allM[j * 16 + e] = this.mats[i * 16 + e];
      for (let e = 0; e < 3; e++) this.allC[j * 3 + e] = this.cols[i * 3 + e];
      const k = this.keys[i], last = j === n - 1 || this.keys[order[j + 1]] !== k;
      if (!last) return;
      const bx0 = (Math.floor(k / 1024) - 8) * BLOCK, bz0 = (k % 1024 - 8) * BLOCK, reach = 2 + this.tall;
      const cut = KEEP.map((keep) => {
        let c = start;
        while (c <= j && this.ranks[order[c]] < keep) c++;
        return c;
      });
      this.blocks.push({ from: start, cut, box: new THREE.Box3(new THREE.Vector3(bx0 - reach, -1, bz0 - reach), new THREE.Vector3(bx0 + BLOCK + reach, this.tall, bz0 + BLOCK + reach)) });
      start = j + 1;
    });
    this.mats = []; this.cols = []; this.keys = []; this.ranks = [];
    const m = new THREE.InstancedMesh(indexed(this.geo), mat, n);
    m.castShadow = this.shadow > 0; m.receiveShadow = true;
    m.frustumCulled = false;
    m.name = 'wasteland:' + this.name;
    (m.instanceMatrix.array as Float32Array).set(this.allM);
    m.instanceColor = new THREE.InstancedBufferAttribute(this.allC.slice(), 3);
    group.add(m);
    this.mesh = m;
  }

  dispose(): void { this.mesh?.geometry.dispose(); this.geo.dispose(); }

  cull(fr: THREE.Frustum, level: number): void {
    const m = this.mesh;
    if (!m) return;
    const lv = Math.max(0, Math.min(KEEP.length - 1, level));
    let shown = lv + ':';
    for (let b = 0; b < this.blocks.length; b++) if (fr.intersectsBox(this.blocks[b].box)) shown += b + ',';
    if (shown === this.shown) return;
    this.shown = shown;
    if (this.shadow === 1) m.castShadow = lv < NO_SHADOW_FROM;
    const a = m.instanceMatrix.array as Float32Array, c = m.instanceColor!.array as Float32Array;
    let n = 0;
    for (const s of shown.slice(shown.indexOf(':') + 1).split(',')) {
      if (!s) continue;
      const { from, cut } = this.blocks[+s], to = cut[lv];
      a.set(this.allM.subarray(from * 16, to * 16), n * 16);
      c.set(this.allC.subarray(from * 3, to * 3), n * 3);
      n += to - from;
    }
    m.count = n;
    m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, n * 16); m.instanceMatrix.needsUpdate = true;
    m.instanceColor!.clearUpdateRanges(); m.instanceColor!.addUpdateRange(0, n * 3); m.instanceColor!.needsUpdate = true;
  }
}

// The props' material: painted light, the vertex colour times the instance's, wet and snow
// on it as on the terrain's props. The fog node (fow.ts) darkens what is out of sight.
function propMaterial(): THREE.MeshLambertNodeMaterial {
  const m = painted(new THREE.MeshLambertNodeMaterial());
  const c = vertexColor().rgb.mul(uWet.mul(-0.28).add(1));
  m.colorNode = mix(c, vec3(0.84, 0.87, 0.9), uSnow.mul(0.45).mul(smoothstep(0.35, 0.8, normalWorld.y)));
  m.shadowSide = THREE.DoubleSide;
  return m;
}

// ---- Crows ----

const enum Crow { Perched = 0, Leaving, Away, Returning }
const CROW_SCARE = 4.5, CROW_CREEP = 3, CROW_CLEAR = 8, CROW_ACTIVE = 60;

class Crows {
  readonly n: number;
  private x: Float32Array; private y: Float32Array; private z: Float32Array; private head: Float32Array;
  private ground: Uint8Array;
  private state: Uint8Array; private t: Float32Array; private dx: Float32Array; private dz: Float32Array;
  private idle: Float32Array; private hop: Float32Array; private peck: Float32Array; private turn: Float32Array;
  private meshes: THREE.InstancedMesh[] = [];
  private cells = new Map<number, number[]>();
  private spare: number[][] = [];
  private clock = 0;

  constructor(perches: number[][], group: THREE.Group, mat: THREE.Material, private geos: THREE.BufferGeometry[]) {
    const n = this.n = perches.length;
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n); this.head = new Float32Array(n);
    this.ground = new Uint8Array(n);
    this.state = new Uint8Array(n); this.t = new Float32Array(n); this.dx = new Float32Array(n); this.dz = new Float32Array(n);
    this.idle = new Float32Array(n); this.hop = new Float32Array(n); this.peck = new Float32Array(n); this.turn = new Float32Array(n);
    perches.forEach(([x, y, z, h, g], i) => {
      this.x[i] = x; this.y[i] = y; this.z[i] = z; this.head[i] = h; this.ground[i] = g;
      this.idle[i] = hash(i, 3, 77) * 4;
    });
    if (!n) return;
    for (const g of geos) {
      const m = new THREE.InstancedMesh(indexed(g), mat, n);
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.name = 'wasteland:crow';
      this.meshes.push(m);
      group.add(m);
    }
    // Every crow perched at first; one of each flight pose too, so the warm-up builds them.
    this.write(0);
    for (let k = 1; k < 3; k++) { this.place(this.meshes[k], 0, this.x[0], this.y[0] - 3, this.z[0], 0, 0); this.meshes[k].count = 1; }
  }

  dispose(): void { for (const m of this.meshes) m.geometry.dispose(); for (const g of this.geos) g.dispose(); }

  private place(m: THREE.InstancedMesh, j: number, x: number, y: number, z: number, heading: number, pitch: number): void {
    _e.set(0, -heading, pitch);
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s.set(1, 1, 1));
    _m.toArray(m.instanceMatrix.array as Float32Array, j * 16);
  }

  // Each frame: the crows near the view fidget, take off from survivors and creeps that come
  // close, wheel away, and come back once the ground is clear.
  update(game: Game, dt: number, tx: number, tz: number): void {
    if (!this.n) return;
    this.clock += dt;
    const f = game.cur;
    // Where creeps are, in cells of four tiles.
    for (const a of this.cells.values()) { a.length = 0; this.spare.push(a); }
    this.cells.clear();
    for (let i = 0; i < f.nCreeps; i++) {
      const k = (Math.floor(game.rx[i] / 4) + 4) * 4096 + Math.floor(game.ry[i] / 4) + 4;
      let a = this.cells.get(k);
      if (!a) { a = this.spare.pop() ?? []; this.cells.set(k, a); }
      a.push(i);
    }
    for (let i = 0; i < this.n; i++) {
      const x = this.x[i], z = this.z[i];
      if (Math.abs(x - tx) > CROW_ACTIVE || Math.abs(z - tz) > CROW_ACTIVE) continue;
      const perched = this.state[i] === Crow.Perched;
      const threat = this.threat(game, x, z, perched ? CROW_SCARE : CROW_CLEAR, perched ? CROW_CREEP : CROW_CLEAR - 2);
      switch (this.state[i]) {
        case Crow.Perched: {
          if (threat) {
            this.state[i] = Crow.Leaving; this.t[i] = 0;
            const a = threat.a + (Math.random() - 0.5) * 1.2;
            this.dx[i] = Math.cos(a); this.dz[i] = Math.sin(a);
            break;
          }
          this.idle[i] -= dt;
          this.hop[i] = Math.max(0, this.hop[i] - dt * 3); this.peck[i] = Math.max(0, this.peck[i] - dt * 3);
          if (this.idle[i] < 0) {
            this.idle[i] = 0.8 + Math.random() * 3.5;
            const r = Math.random();
            if (r < 0.35) this.turn[i] += (Math.random() - 0.5) * 2.4;
            else if (r < 0.6 && this.ground[i]) { this.hop[i] = 1; this.turn[i] += (Math.random() - 0.5) * 1.2; }
            else if (this.ground[i]) this.peck[i] = 1;
          }
          break;
        }
        case Crow.Leaving:
          this.t[i] += dt / 2.4;
          if (this.t[i] >= 1) { this.state[i] = Crow.Away; this.t[i] = 8 + Math.random() * 10; }
          break;
        case Crow.Away:
          this.t[i] -= dt;
          if (this.t[i] <= 0 && !threat) { this.state[i] = Crow.Returning; this.t[i] = 1; }
          else if (this.t[i] <= 0) this.t[i] = 2;
          break;
        case Crow.Returning:
          if (threat) { this.state[i] = Crow.Leaving; break; }
          this.t[i] -= dt / 3;
          if (this.t[i] <= 0) { this.state[i] = Crow.Perched; this.t[i] = 0; this.idle[i] = 1; }
          break;
      }
    }
    this.write(this.clock);
  }

  // The bearing away from the nearest survivor or creep within r of x, z, or null.
  private threat(game: Game, x: number, z: number, r: number, rc: number): { a: number } | null {
    const f = game.cur;
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      if (!(p.flags & PF_ALIVE)) continue;
      const px = game.prx[p.id], pz = game.pry[p.id];
      if (Math.hypot(px - x, pz - z) < r) return { a: Math.atan2(z - pz, x - px) };
    }
    const cx = Math.floor(x / 4) + 4, cz = Math.floor(z / 4) + 4, reach = Math.ceil(rc / 4);
    for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) {
      const a = this.cells.get((cx + dx) * 4096 + cz + dz);
      if (a) for (const i of a) {
        const ex = game.rx[i], ez = game.ry[i];
        if (Math.abs(ex - x) < rc && Math.abs(ez - z) < rc) return { a: Math.atan2(z - ez, x - ex) };
      }
    }
    return null;
  }

  private write(clock: number): void {
    const counts = [0, 0, 0];
    for (let i = 0; i < this.n; i++) {
      const s = this.state[i];
      if (s === Crow.Away) continue;
      if (s === Crow.Perched) {
        const hop = Math.sin(this.hop[i] * PI) * 0.09, peck = Math.sin(this.peck[i] * PI) * 0.7;
        const h = this.head[i] + this.turn[i];
        this.place(this.meshes[0], counts[0]++, this.x[i] + Math.cos(h) * this.hop[i] * 0.05, this.y[i] + hop, this.z[i] + Math.sin(h) * this.hop[i] * 0.05, h, -peck);
        continue;
      }
      // In flight: up and away along dx, dz, beating its wings, then gliding.
      const t = this.t[i], e = 1 - (1 - t) * (1 - t);
      const x = this.x[i] + this.dx[i] * 14 * t * t, z = this.z[i] + this.dz[i] * 14 * t * t, y = this.y[i] + 7 * e;
      const h = Math.atan2(this.dz[i], this.dx[i]);
      const beat = t < 0.7 || s === Crow.Returning ? Math.floor(clock * 9 + i) % 2 : 0;
      const k = 1 + beat;
      this.place(this.meshes[k], counts[k]++, x, y, z, s === Crow.Returning ? h + PI : h, s === Crow.Returning ? 0.25 : -0.3);
    }
    this.meshes.forEach((m, k) => { m.count = counts[k]; m.instanceMatrix.needsUpdate = true; });
  }
}

// ---- Placing it all ----

type Pick = [string, number][];

// What lies about where, by weight.
const ROAD: Pick = [['trash', 5], ['blood', 3], ['drag', 2], ['tyres', 2], ['clothes', 2], ['luggage', 1.5], ['bones', 1.5], ['cone', 1],
  ['crater', 0.8], ['burnt', 1], ['drum', 1], ['jerrycans', 1], ['trolley', 0.6], ['skeleton', 0.6], ['pallet', 0.5], ['bodyBag', 0.3]];
const RUIN: Pick = [['trash', 4], ['clothes', 3], ['bones', 2], ['blood', 2], ['drag', 1], ['burnt', 2], ['pallet', 2], ['drum', 1.5],
  ['jerrycans', 1], ['tyres', 1], ['trolley', 0.6], ['luggage', 1], ['skeleton', 1], ['bodyBag', 1]];
const OPEN: Pick = [['bones', 3], ['skeleton', 1], ['crater', 2], ['burnt', 1.5], ['trash', 1], ['tyres', 0.5], ['drum', 0.3], ['blood', 1],
  ['clothes', 0.5], ['keepOut', 0.12], ['turnBack', 0.12]];
const CRASH: Pick = [['luggage', 5], ['clothes', 4], ['trash', 2], ['bones', 1.5], ['skeleton', 1], ['bodyBag', 0.6], ['pallet', 1]];
const GARAGE: Pick = [['tyres', 4], ['drum', 3], ['jerrycans', 3], ['cone', 2], ['trash', 2], ['pallet', 1], ['trolley', 1]];
const CAMP: Pick = [['drum', 3], ['jerrycans', 2], ['bodyBag', 2], ['burnt', 1.5], ['bones', 1], ['cone', 1], ['trash', 1.5], ['crater', 0.6]];

function pick(table: Pick, r: number): string {
  let total = 0;
  for (const [, w] of table) total += w;
  r *= total;
  for (const [k, w] of table) { if (r < w) return k; r -= w; }
  return table[0][0];
}

// Whether segment ab crosses segment cd.
type XZ = { x: number; z: number };
function crosses(a: XZ, b: XZ, c: XZ, d: XZ): boolean {
  const side = (p: XZ, q: XZ, r: XZ) => Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

// Kinds that are carrion and draw crows, and kinds a crow may stand on.
const CARRION = new Set(['skeleton', 'bones', 'bodyBag', 'drag']);

export class Wasteland {
  group = new THREE.Group();
  private kinds = new Map<string, Kind>();
  private crows: Crows | null = null;
  private mat: THREE.Material | null = null;
  private frustum = new THREE.Frustum(); private pv = new THREE.Matrix4();
  // The instances each detail level draws, for F3 and the docs.
  levels: number[] = KEEP.map(() => 0);

  // The map, while building.
  private tiles: Uint8Array = new Uint8Array(0); private w = 0; private h = 0;
  private ch = new Float32Array(0);
  private roadD: Uint8Array = new Uint8Array(0); private rockD: Uint8Array = new Uint8Array(0); private waterD: Uint8Array = new Uint8Array(0);
  private occ: Uint8Array = new Uint8Array(0);
  private wrecks: Wrecks | null = null;
  private keepOff: { x: number; z: number; r: number }[] = [];
  private boxes: { x0: number; z0: number; x1: number; z1: number }[] = [];
  private cx = 0; private cz = 0; private clear0 = -1;
  private perches: number[][] = [];
  private seq = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'wasteland';
    scene.add(this.group);
  }

  clear(): void {
    for (const k of this.kinds.values()) k.dispose();
    this.crows?.dispose();
    this.mat?.dispose();
    this.kinds.clear(); this.crows = null; this.mat = null;
    this.group.clear();
  }

  // Per frame: the props in view (and those that shadow it) at the detail level, and the crows.
  update(cam: THREE.Camera, level: number, game: Game, dt: number, tx: number, tz: number): void {
    cam.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    for (const k of this.kinds.values()) k.cull(this.frustum, level);
    this.crows?.update(game, dt, tx, tz);
  }

  build(tiles: Uint8Array, w: number, h: number, wd: Welcome | null): void {
    this.clear();
    this.tiles = tiles; this.w = w; this.h = h;
    this.seq = 0; this.perches = []; this.keepOff = []; this.boxes = [];
    const sites = wd?.sites ?? [];
    this.cx = wd?.core.x ?? w / 2; this.cz = wd?.core.y ?? h / 2;
    this.clear0 = wd ? wd.buildRadius + 1 : -1;
    this.heights();
    this.roadD = this.distance((t) => t === Tile.Dirt, 9);
    this.rockD = this.distance((t) => t === Tile.Rock, 9);
    this.waterD = this.distance((t) => t === Tile.Water, 3);
    this.occ = new Uint8Array(w * h);
    this.wrecks = new Wrecks(sites, w, h);
    for (const s of sites) {
      // Nothing on a site's loot, a pump or an engine; nothing in the landmarks' own ground.
      if (walled(s.kind)) this.keepOff.push({ x: s.sx, z: s.sy, r: 1.8 });
      else if (!wreck(s.kind) && s.kind !== SiteKind.Plane) this.keepOff.push({ x: s.x + s.w / 2, z: s.y + s.h / 2, r: s.kind === SiteKind.Crate ? 1.4 : 1.5 });
      if (s.kind === SiteKind.Pump || s.kind === SiteKind.Tank) this.keepOff.push({ x: s.sx, z: s.sy, r: 1.6 });
      if (s.kind === SiteKind.Station || s.kind === SiteKind.Church || s.kind === SiteKind.Shrine) this.boxes.push({ x0: s.x - 1, z0: s.y - 1, x1: s.x + s.w + 1, z1: s.y + s.h + 1 });
      if (s.kind === SiteKind.Church) {
        // The tower stands on past the nave towards yaw.
        const fx = Math.round(Math.cos(s.yaw ?? 0)), fy = Math.round(Math.sin(s.yaw ?? 0));
        this.boxes.push({ x0: Math.min(s.x, s.x + fx * 4) - 1, z0: Math.min(s.y, s.y + fy * 4) - 1, x1: Math.max(s.x + s.w, s.x + s.w + fx * 4) + 1, z1: Math.max(s.y + s.h, s.y + s.h + fy * 4) + 1 });
      }
    }
    const pad = wd?.evac?.pad, half = wd?.evac?.half ?? 0;
    if (pad) this.boxes.push({ x0: pad.x - half - 2.5, z0: pad.y - half - 2.5, x1: pad.x + half + 2.5, z1: pad.y + half + 2.5 });

    this.defineKinds();
    this.poleLines();
    if (wd) this.checkpoints(wd.buildRadius);
    for (const s of sites) this.site(s.kind, s, sites);
    this.fenceLines();
    this.background();

    const mat = this.mat = propMaterial();
    this.levels = KEEP.map(() => 0);
    for (const k of this.kinds.values()) { k.counts().forEach((c, i) => { this.levels[i] += c; }); k.build(this.group, mat); }
    this.crows = new Crows(this.perches, this.group, mat, [crow(0), crow(1), crow(-1)]);
    console.info(`taildefense: wasteland ${this.levels[0]} props (by detail level ${this.levels.join('/')}), ${this.crows.n} crows`);
    // The map's working arrays are not needed after.
    this.roadD = this.rockD = this.waterD = this.occ = new Uint8Array(0);
    this.ch = new Float32Array(0);
  }

  // How many of each kind there are, for the docs.
  census(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [n, k] of this.kinds) out[n] = k.count;
    out.crows = this.crows?.n ?? 0;
    return out;
  }

  private defineKinds(): void {
    const add = (name: string, geo: THREE.BufferGeometry, shadow: 0 | 1 | 2, r: number, tall = 1) => this.kinds.set(name, new Kind(name, geo, shadow, r, tall));
    add('skeleton', skeleton(), 0, 0.8);
    add('bones', bones(), 0, 0.5);
    add('blood', blood(), 0, 0.6);
    add('drag', drag(), 0, 1.3);
    add('luggage', luggage(), 1, 0.9);
    add('clothes', clothes(), 0, 0.5);
    add('tyres', tyres(), 1, 0.6);
    add('drum', drum(), 1, 0.4);
    add('jerrycans', jerrycans(), 1, 0.4);
    add('pallet', pallet(), 1, 0.8);
    add('trolley', trolley(), 1, 0.6);
    add('fenceWire', fenceWire(), 2, 0.4, 2);
    add('fenceBroken', fenceBroken(), 1, 0.4, 2);
    add('picket', picket(), 2, 0.4, 2);
    add('wireCoil', wireCoil(), 1, 0.5, 2);
    add('pole', pole(), 2, 0.4, 6);
    add('wire', wire(), 2, 0, 6);
    add('roadSign', roadSign(), 2, 0.5, 3);
    add('quarantine', board('QUARANTINE', 3.2, 0.95, 0.075, 0xb0a684, 0x8a2a1a, true), 2, 1.1, 3);
    add('keepOut', board('KEEP OUT', 2.6, 0.7, 0.075, 0x7a6a50, 0x8a2a1a, false), 2, 0.9, 3);
    add('turnBack', board('TURN BACK', 2.8, 0.7, 0.07, 0x8f877a, PAL.ink, false), 2, 0.9, 3);
    add('cone', cone(), 1, 0.3);
    add('crater', crater(), 0, 1.3);
    add('burnt', burnt(), 0, 1.0);
    add('trash', trash(), 0, 0.5);
    add('bodyBag', bodyBag(), 1, 0.85);
    add('grave', grave(), 1, 0.9, 2);
    add('help', help(), 0, 1.8);
  }

  // ---- The map ----

  // The ground's height, as terrain.ts makes it: each tile's own height averaged into its
  // corners, the corners joined in triangles. Kept in step with Terrain.buildGround by hand.
  private heights(): void {
    const { tiles, w, h } = this;
    const th = (t: number, x: number, y: number) => t === Tile.Water ? -0.75 : t === Tile.Dirt ? -0.03 : t === Tile.Floor ? 0.03 : (hash(x, y, 9) - 0.5) * 0.08;
    const ch = this.ch = new Float32Array((w + 1) * (h + 1));
    for (let y = 0; y <= h; y++) for (let x = 0; x <= w; x++) {
      let s = 0, n = 0, water = 0;
      for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) {
        const tx = x + dx, ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const t = tiles[ty * w + tx];
        s += th(t, tx, ty); n++;
        if (t === Tile.Water) water++;
      }
      ch[y * (w + 1) + x] = x === 0 || y === 0 || x === w || y === h ? -0.12 : n ? (water && water < n ? Math.min(s / n, -0.3) : s / n) : 0;
    }
  }

  private groundY(x: number, z: number): number {
    const { w, h, ch } = this;
    if (x <= 0 || z <= 0 || x >= w || z >= h) return -0.12;
    const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, cw = w + 1;
    const h00 = ch[iz * cw + ix], h10 = ch[iz * cw + ix + 1], h01 = ch[(iz + 1) * cw + ix], h11 = ch[(iz + 1) * cw + ix + 1];
    return fx + fz <= 1 ? h00 + fx * (h10 - h00) + fz * (h01 - h00) : h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
  }

  // The highest ground under a prop of reach r, so a flat one never sinks into it.
  private restY(x: number, z: number, r: number): number {
    let y = this.groundY(x, z);
    if (r > 0.2) for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) y = Math.max(y, this.groundY(x + dx * 0.8, z + dz * 0.8));
    return y;
  }

  // Tiles' distance (8-way, in tiles) to the nearest tile that is, up to max.
  private distance(is: (t: number) => boolean, max: number): Uint8Array {
    const { tiles, w, h } = this, d = new Uint8Array(w * h).fill(255), q: number[] = [];
    for (let i = 0; i < w * h; i++) if (is(tiles[i])) { d[i] = 0; q.push(i); }
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi], x = i % w, y = (i - x) / w, nd = d[i] + 1;
      if (nd > max) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (d[j] > nd) { d[j] = nd; q.push(j); }
      }
    }
    return d;
  }

  private tile(x: number, z: number): number {
    const tx = Math.floor(x), tz = Math.floor(z);
    return tx < 0 || tz < 0 || tx >= this.w || tz >= this.h ? Tile.Rock : this.tiles[tz * this.w + tx];
  }

  // How far x, z is from the build radius's edge, and so how thick things may lie: 0 inside,
  // rising to 1 twelve tiles out.
  private fade(x: number, z: number): number {
    if (this.clear0 < 0) return 1;
    const d = Math.hypot(x - this.cx, z - this.cz) - this.clear0;
    return d <= 0 ? 0 : Math.min(1, d / 12);
  }

  // Whether a prop reaching r can lie at x, z: open ground under it all, clear of the base,
  // the helipad, wrecks, loot and the landmarks' insides, and (flat ones) off the shore.
  private ok(x: number, z: number, r: number, flat = false): boolean {
    if (this.fade(x, z) <= 0 || Math.hypot(x - this.cx, z - this.cz) < this.clear0 + r) return false;
    const pts = r > 0.15 ? [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, -r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, r * 0.7]] : [[0, 0]];
    for (const [dx, dz] of pts) {
      const px = x + dx, pz = z + dz, t = this.tile(px, pz);
      if (t !== Tile.Grass && t !== Tile.Dirt && t !== Tile.Sand && t !== Tile.Floor) return false;
      if (this.wrecks!.at(px, pz, () => false)) return false;
      if (flat && this.waterD[Math.floor(pz) * this.w + Math.floor(px)] < 2) return false;
    }
    for (const k of this.keepOff) if (Math.hypot(x - k.x, z - k.z) < k.r + r) return false;
    for (const b of this.boxes) if (x + r > b.x0 && x - r < b.x1 && z + r > b.z0 && z - r < b.z1) return false;
    return true;
  }

  // Takes the tiles under a prop for it, or says they are taken.
  private claim(x: number, z: number, r: number): boolean {
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r), z0 = Math.floor(z - r), z1 = Math.floor(z + r), w = this.w;
    for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) if (tx >= 0 && tz >= 0 && tx < w && tz < this.h && this.occ[tz * w + tx]) return false;
    for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) if (tx >= 0 && tz >= 0 && tx < w && tz < this.h) this.occ[tz * w + tx] = 1;
    return true;
  }

  // Lays one prop. heading as writeMatrix's (towards +z positive); tilt leans it forward about
  // its own z, roll about its own x. essential: drawn at every detail level.
  private put(name: string, x: number, z: number, heading: number, opt: { s?: number; sx?: number; sy?: number; tilt?: number; roll?: number; y?: number; tint?: number[]; essential?: boolean; check?: boolean } = {}): boolean {
    const k = this.kinds.get(name)!, s = opt.s ?? 1, r = k.r * s;
    if (opt.check !== false) {
      const flat = k.shadow === 0;
      if (!this.ok(x, z, r, flat) || !this.claim(x, z, Math.max(0.3, r * 0.7))) return false;
    }
    const n = this.seq++;
    const y = opt.y ?? (name === 'help' ? this.restY(x, z, 2.4) + 0.02 : this.restY(x, z, Math.min(r, 0.8)));
    _e.set(opt.roll ?? 0, -heading, opt.tilt ?? 0);
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s.set(s * (opt.sx ?? 1), s * (opt.sy ?? 1), s));
    const b = 0.86 + hash(n, 1, 61) * 0.22;
    k.add(_m.elements, opt.tint ?? [b, b, b], opt.essential ? 0 : 0.01 + hash(n, 2, 61) * 0.99, x, z);
    if (CARRION.has(name) && hash(n, 3, 61) < (name === 'bones' ? 0.25 : 0.4)) this.flock(x, z, 1 + Math.floor(hash(n, 4, 61) * 3), n);
    return true;
  }

  // A few crows on the ground round x, z.
  private flock(x: number, z: number, count: number, seed: number): void {
    for (let i = 0; i < count && this.perches.length < 220; i++) {
      const a = hash(seed, i, 91) * 6.28, d = 0.4 + hash(seed, i, 92) * 0.9, px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      if (this.tile(px, pz) === Tile.Water) continue;
      this.perches.push([px, this.groundY(px, pz), pz, hash(seed, i, 93) * 6.28, 1]);
    }
  }

  // A run of fence or wire from a to b, one unit a post, with gaps; the wire stretched to it.
  private run(name: string, ax: number, az: number, bx: number, bz: number, gap: number, seed: number, broken = ''): void {
    const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 1.3)), step = len / n;
    const ux = (bx - ax) / len, uz = (bz - az) / len, heading = Math.atan2(uz, ux);
    for (let i = 0; i < n; i++) {
      if (hash(seed, i, 71) < gap) continue;
      const x = ax + ux * i * step, z = az + uz * i * step, mx = x + ux * step / 2, mz = z + uz * step / 2;
      if (!this.ok(mx, mz, 0.3) || !this.ok(x, z, 0.1)) continue;
      this.claim(mx, mz, 0.3);
      const k = broken && hash(seed, i, 72) < 0.3 ? broken : name;
      this.put(k, x, z, heading + (hash(seed, i, 73) - 0.5) * 0.08, { sx: step, check: false, essential: true, y: this.groundY(x, z) });
    }
  }

  // ---- The story ----

  // Power poles down the roads, a step off to one side, their wires sagging pole to pole; one
  // in a dozen fallen, its wires down, and crows on a crossarm here and there.
  private poleLines(): void {
    const { w, h, roadD } = this, CELL = 9;
    const poles: { x: number; z: number; links: number[]; fallen: boolean; heading: number }[] = [];
    for (let cy = 0; cy < h; cy += CELL) for (let cx = 0; cx < w; cx += CELL) {
      let best = -1, bd = 1e9;
      const mx = cx + CELL / 2, my = cy + CELL / 2;
      for (let y = cy; y < Math.min(h, cy + CELL); y++) for (let x = cx; x < Math.min(w, cx + CELL); x++) {
        const i = y * w + x;
        if (roadD[i] !== 2 || this.tiles[i] === Tile.Floor || this.rockD[i] <= 2) continue;
        // On the side of the road away from the screen's top and left, so a line keeps to one side.
        const north = (y >= 2 && roadD[i - 2 * w] === 0) || (x >= 2 && roadD[i - 2] === 0);
        if (!north) continue;
        const d = Math.hypot(x + 0.5 - mx, y + 0.5 - my);
        if (d < bd && this.ok(x + 0.5, y + 0.5, 0.4) && this.fade(x + 0.5, y + 0.5) > 0.2) { bd = d; best = i; }
      }
      if (best < 0) continue;
      const x = best % w + 0.5, z = Math.floor(best / w) + 0.5;
      poles.push({ x, z, links: [], fallen: hash(x, z, 41) < 0.08, heading: 0 });
    }
    // Each pole wired to its nearest neighbour and the nearest the other way, while the line
    // between keeps to the road.
    const near = (a: number, b: number) => {
      const p = poles[a], q = poles[b], d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < 5 || d > 13.5) return false;
      for (let t = 0.1; t < 1; t += 0.1) {
        const x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t, tx = Math.floor(x), tz = Math.floor(z);
        if (tx < 0 || tz < 0 || tx >= w || tz >= h || roadD[tz * w + tx] > 4 || this.fade(x, z) <= 0) return false;
      }
      return true;
    };
    const edges: [number, number][] = [];
    poles.forEach((p, a) => {
      const cand = poles.map((q, b) => [b, Math.hypot(q.x - p.x, q.z - p.z)] as [number, number]).filter(([b]) => b !== a && near(a, b)).sort((u, v) => u[1] - v[1]);
      if (!cand.length) return;
      const first = cand[0][0], fx = poles[first].x - p.x, fz = poles[first].z - p.z;
      const pickd = [first];
      const second = cand.find(([b]) => (poles[b].x - p.x) * fx + (poles[b].z - p.z) * fz < 0);
      if (second) pickd.push(second[0]);
      for (const b of pickd) {
        if (p.links.includes(b) || p.links.length >= 2 || poles[b].links.length >= 2) continue;
        if (edges.some(([c, d]) => c !== a && c !== b && d !== a && d !== b && crosses(p, poles[b], poles[c], poles[d]))) continue;
        p.links.push(b); poles[b].links.push(a); edges.push([a, b]);
      }
    });
    for (const p of poles) {
      if (p.links.length) {
        const q = poles[p.links[0]], r = p.links[1] !== undefined ? poles[p.links[1]] : p;
        p.heading = Math.atan2((q.z - r.z) || (q.z - p.z), (q.x - r.x) || (q.x - p.x));
      } else p.heading = hash(p.x, p.z, 42) * PI;
    }
    // Where the wires hang from: either end of each standing pole's crossarm, leaning with it.
    const tops: THREE.Vector3[][] = poles.map((p, i) => {
      const lean = (hash(i, 1, 43) - 0.5) * 0.16, roll = (hash(i, 2, 43) - 0.5) * 0.16;
      let fall = -1;
      if (p.fallen) for (let k = 0; k < 6 && fall < 0; k++) {
        const a = hash(i, 3 + k, 43) * 6.28;
        // It lies along its heading's +z once rolled over: that ground must be open.
        let clear = true;
        for (let d = 0.5; d < POLE_H && clear; d += 0.7) clear = this.ok(p.x - Math.sin(a) * d, p.z + Math.cos(a) * d, 0.1);
        if (clear) fall = a;
      }
      p.fallen = fall >= 0;
      const y = this.groundY(p.x, p.z);
      if (p.fallen) {
        // Down across the verge: lying on its side, its crossarm in the dirt.
        this.put('pole', p.x, p.z, fall, { roll: PI / 2 - 0.06, y: y + 0.08, check: false, essential: true });
        return [];
      }
      this.put('pole', p.x, p.z, p.heading, { tilt: lean, roll, y, check: false, essential: true });
      this.claim(p.x, p.z, 0.4);
      _e.set(roll, -p.heading, lean); _q.setFromEuler(_e);
      if (hash(i, 4, 43) < 0.12) {
        const at = new THREE.Vector3(0, ATTACH_Y + 0.02, (hash(i, 5, 43) < 0.5 ? -1 : 1) * (ATTACH_Z - 0.2)).applyQuaternion(_q).add(_p.set(p.x, y, p.z));
        this.perches.push([at.x, at.y, at.z, p.heading + PI / 2, 0]);
      }
      return [-1, 1].map((s) => new THREE.Vector3(0, ATTACH_Y, s * ATTACH_Z).applyQuaternion(_q).add(_p.set(p.x, y, p.z)));
    });
    for (const [a, b] of edges) {
      const ta = tops[a], tb = tops[b];
      if (ta.length && tb.length) {
        for (let s = 0; s < 2; s++) {
          // The two ends of the crossarm on the same side of the line.
          const ua = ta[s], ub = tb[0].distanceTo(ua) < tb[1].distanceTo(ua) ? tb[0] : tb[1];
          if (hash(a, b * 2 + s, 44) < 0.06) continue;
          this.wire(ua, ub);
        }
      } else if (ta.length || tb.length) {
        // A wire down: from the standing pole to the ground towards the fallen one.
        const up = ta.length ? ta : tb, p = poles[ta.length ? b : a];
        const g = new THREE.Vector3(up[0].x + (p.x - up[0].x) * 0.45, 0, up[0].z + (p.z - up[0].z) * 0.45);
        g.y = this.groundY(g.x, g.z) + 0.02;
        this.wire(up[0], g);
      }
    }
  }

  // One wire from a to b: its unit length stretched along the line, its sag hanging straight down.
  private wire(a: THREE.Vector3, b: THREE.Vector3): void {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    const e = [dx, dy, dz, 0, 0, 1, 0, 0, -dz / l, 0, dx / l, 0, a.x, a.y, a.z, 1];
    this.kinds.get('wire')!.add(e, [1, 1, 1], 0, (a.x + b.x) / 2, (a.z + b.z) / 2);
  }

  // Where a road leaves the build radius, a checkpoint that did not hold: wire dragged off the
  // road, cones knocked about, a QUARANTINE board, drums, a burnt patch and the dead in bags.
  private checkpoints(radius: number): void {
    const { w, h, tiles } = this, ring = radius + 8, found: { x: number; z: number; n: number }[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (tiles[y * w + x] !== Tile.Dirt) continue;
      const d = Math.hypot(x + 0.5 - this.cx, y + 0.5 - this.cz);
      if (Math.abs(d - ring) > 0.8) continue;
      const c = found.find((f) => Math.hypot(f.x / f.n - x, f.z / f.n - y) < 6);
      if (c) { c.x += x + 0.5; c.z += y + 0.5; c.n++; } else found.push({ x: x + 0.5, z: y + 0.5, n: 1 });
    }
    found.forEach((f, i) => {
      const x = f.x / f.n, z = f.z / f.n, l = Math.hypot(x - this.cx, z - this.cz) || 1;
      const ux = (x - this.cx) / l, uz = (z - this.cz) / l, px = -uz, pz = ux;
      const at = (a: number, b: number): [number, number] => [x + px * a + ux * b, z + pz * a + uz * b];
      const across = Math.atan2(pz, px);
      // Wire on both verges, pulled off the road.
      for (const s of [-1, 1]) {
        const [ax, az] = at(s * 2.8, 0.3), [bx, bz] = at(s * 6.5, -0.4);
        this.run('wireCoil', ax, az, bx, bz, 0.1, i * 7 + s + 3);
      }
      const [wx, wz] = at(1.2, 1.6);
      this.put('wireCoil', wx, wz, across + 0.7, { sx: 1.3, essential: true });
      for (let k = 0; k < 4; k++) {
        const [cx, cz] = at(-1.8 + k * 1.1 + (hash(i, k, 51) - 0.5) * 0.4, (hash(i, k, 52) - 0.5) * 1.2);
        const down = hash(i, k, 53) < 0.45;
        this.put('cone', cx, cz, hash(i, k, 54) * 6.28, { roll: down ? PI / 2 - 0.15 : 0, y: down ? this.groundY(cx, cz) + 0.1 : undefined, essential: true });
      }
      // The board on whichever verge has room for it, facing the road out.
      const side = hash(i, 9, 51) < 0.5 ? -1 : 1;
      const opt = { tilt: (hash(i, 2, 55) - 0.5) * 0.12, essential: true };
      for (const [a, b] of [[4.6, 1.2], [5.4, 2.6], [4.2, -1.2], [-4.6, 1.2], [-5.4, 2.6], [-4.2, -1.2], [6.4, 0], [-6.4, 0]]) {
        if (this.put('quarantine', ...at(side * a, b), across + (hash(i, 1, 55) - 0.5) * 0.5, opt)) break;
      }
      const [dx, dz] = at(-side * 4.2, 1.6);
      this.put('drum', dx, dz, 0, { tint: [0.9, 0.45, 0.32], essential: true });
      this.put('drum', dx + ux * 0.8, dz + uz * 0.8, hash(i, 3, 55) * 6, { roll: PI / 2, y: this.groundY(dx + ux * 0.8, dz + uz * 0.8) + 0.25, tint: [0.55, 0.6, 0.38], essential: true });
      const [bx, bz] = at(0.3, 3.2);
      this.put('burnt', bx, bz, hash(i, 4, 55) * 6.28, { s: 1.4, essential: true });
      const [gx, gz] = at(side * 5, 3.6);
      for (let k = 0; k < 3; k++) this.put('bodyBag', gx + ux * k * 0.75, gz + uz * k * 0.75, across, { essential: true });
      const [ex, ez] = at(-0.6, -2.2);
      this.put('blood', ex, ez, hash(i, 5, 55) * 6.28, { s: 1.2 });
    });
  }

  // Scatters n props from a table between rIn and rOut of x, z.
  private around(x: number, z: number, rIn: number, rOut: number, n: number, table: Pick, seed: number): void {
    for (let i = 0, tries = 0; i < n && tries < n * 6; tries++) {
      const a = hash(seed, tries, 81) * 6.28, d = rIn + hash(seed, tries, 82) * (rOut - rIn);
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      if (this.lay(pick(table, hash(seed, tries, 83)), px, pz, seed * 31 + tries)) i++;
    }
  }

  // One prop of a kind at x, z, turned and tinted as that kind takes it.
  private lay(name: string, x: number, z: number, seed: number): boolean {
    const r = hash(seed, 1, 85), head = hash(seed, 2, 85) * 6.28;
    switch (name) {
      case 'drum': {
        const tint = [[0.9, 0.45, 0.32], [0.55, 0.6, 0.38], [0.42, 0.52, 0.72], [0.95, 0.75, 0.32], [0.8, 0.78, 0.72]][Math.floor(hash(seed, 3, 85) * 5)];
        const down = r < 0.5;
        return this.put('drum', x, z, head, { roll: down ? PI / 2 : 0, y: down ? this.groundY(x, z) + 0.24 : undefined, tint });
      }
      case 'cone': {
        const down = r < 0.5;
        return this.put('cone', x, z, head, { roll: down ? PI / 2 - 0.15 : 0, y: down ? this.groundY(x, z) + 0.1 : undefined });
      }
      case 'roadSign': {
        const tint = [[1, 0.82, 0.4], [0.95, 0.42, 0.32], [1, 1, 1]][Math.floor(hash(seed, 3, 85) * 3)];
        return this.put('roadSign', x, z, (r - 0.5) * 0.7, { tilt: (hash(seed, 4, 85) - 0.5) * 0.3, tint, essential: true });
      }
      case 'keepOut': case 'turnBack': case 'quarantine':
        // A board wants room: nudged about until it finds some.
        for (let k = 0; k < 6; k++) {
          const a = hash(seed, 5 + k, 85) * 6.28, d = k ? 0.8 + k * 0.5 : 0;
          if (this.put(name, x + Math.cos(a) * d, z + Math.sin(a) * d, (r - 0.5) * 0.6, { tilt: (hash(seed, 4, 85) - 0.5) * 0.15, essential: true })) return true;
        }
        return false;
      case 'skeleton': case 'bones': case 'crater': case 'burnt':
        return this.put(name, x, z, head, { s: 0.85 + r * 0.4 });
      default:
        return this.put(name, x, z, head, { s: 0.9 + r * 0.2 });
    }
  }

  // What each site has round it.
  private site(kind: number, s: SiteDef, sites: SiteDef[]): void {
    const cx = s.x + s.w / 2, cz = s.y + s.h / 2, seed = s.x * 977 + s.y * 13 + kind;
    const r = (k: number) => hash(seed, k, 21);
    if (wreck(kind)) {
      // The car's people did not get far: their bags, a drag mark, now and then one of them.
      const yaw = s.yaw ?? 0, fx = Math.cos(yaw), fz = Math.sin(yaw), side = r(1) < 0.5 ? -1 : 1;
      const at = (a: number, b: number): [number, number] => [s.sx + fx * a - fz * b * side, s.sy + fz * a + fx * b * side];
      if (r(2) < 0.4) this.put('luggage', ...at(0.2, 1.7), yaw + (r(3) - 0.5), {});
      if (r(4) < 0.3) { const [x, z] = at(0.3, 1.4); this.put('drag', x, z, Math.atan2(z - s.sy, x - s.sx) + PI + (r(5) - 0.5)); }
      if (r(6) < 0.25) for (let k = 0; k < 3; k++) this.lay('cone', ...at(-2.6 - k * 0.9, (r(7 + k) - 0.5) * 1.5), seed + k);
      if (r(10) < 0.12) this.put('skeleton', ...at(1.4, -1.6), r(11) * 6.28, {});
      if (r(12) < 0.4) this.lay('trash', ...at(-1, 1.5), seed + 20);
      if (r(13) < 0.3) this.put('blood', ...at(0.8, 1.3), r(14) * 6.28, {});
      if (r(15) < 0.15) this.lay('tyres', ...at(-1.5, -1.6), seed + 21);
      return;
    }
    switch (kind) {
      case SiteKind.House: {
        // A yard fence half gone, the dead bagged by a wall, what was left behind round it.
        if (r(1) < 0.5) {
          const name = r(2) < 0.6 ? 'picket' : 'fenceWire', x0 = s.x - 1.6, z0 = s.y - 1.6, x1 = s.x + s.w + 1.6, z1 = s.y + s.h + 1.6;
          const broken = name === 'fenceWire' ? 'fenceBroken' : '';
          this.run(name, x0, z0, x1, z0, 0.3, seed + 1, broken); this.run(name, x1, z0, x1, z1, 0.3, seed + 2, broken);
          this.run(name, x1, z1, x0, z1, 0.3, seed + 3, broken); this.run(name, x0, z1, x0, z0, 0.3, seed + 4, broken);
        }
        if (r(3) < 0.25) {
          const along = s.w >= s.h, n = 1 + Math.floor(r(4) * 3);
          for (let k = 0; k < n; k++) {
            const x = along ? s.x + 1 + k * 0.8 : s.x + s.w + 0.7, z = along ? s.y + s.h + 0.7 : s.y + 1 + k * 0.8;
            this.put('bodyBag', x, z, along ? PI / 2 : 0, {});
          }
        }
        if (s.tier >= 2 && r(5) < 0.3) {
          const x = cx + (r(6) - 0.5) * 2, z = s.y + s.h + 3.6;
          this.put('help', x, z, 0, { essential: true });
        }
        this.around(cx, cz, Math.max(s.w, s.h) / 2 - 0.5, Math.max(s.w, s.h) / 2 + 4, 3 + Math.floor(r(7) * 5), RUIN, seed);
        return;
      }
      case SiteKind.Outpost: {
        // The army's last stand: wire round it with gaps blown in, the warnings, its dead.
        const x0 = s.x - 2.2, z0 = s.y - 2.2, x1 = s.x + s.w + 2.2, z1 = s.y + s.h + 2.2;
        this.run('wireCoil', x0, z0, x1, z0, 0.25, seed + 1); this.run('wireCoil', x1, z0, x1, z1, 0.25, seed + 2);
        this.run('wireCoil', x1, z1, x0, z1, 0.25, seed + 3); this.run('wireCoil', x0, z1, x0, z0, 0.25, seed + 4);
        this.lay('quarantine', cx + (r(1) - 0.5) * s.w, z1 + 1.6, seed + 5);
        this.lay('keepOut', x0 - 1.5, cz + (r(2) - 0.5) * s.h, seed + 6);
        this.around(cx, cz, Math.max(s.w, s.h) / 2 + 2.5, Math.max(s.w, s.h) / 2 + 7, 10, CAMP, seed);
        return;
      }
      case SiteKind.Station:
        this.around(cx, cz, Math.max(s.w, s.h) / 2 + 1.5, Math.max(s.w, s.h) / 2 + 9, 14, GARAGE, seed);
        // Oil where the pumps leaked.
        for (const p of sites) if (p.kind === SiteKind.Pump && Math.hypot(p.sx - cx, p.sy - cz) < 16) {
          const a = hash(p.sx, p.sy, 22) * 6.28;
          this.put('blood', p.sx + Math.cos(a) * 2.2, p.sy + Math.sin(a) * 2.2, a, { tint: [0.45, 0.5, 0.55], s: 1.2 });
        }
        return;
      case SiteKind.Plane: {
        // The crash spilled its passengers' luggage along the scar behind it.
        const yaw = s.yaw ?? 0, c = Math.cos(yaw), sn = Math.sin(yaw);
        for (let i = 0, tries = 0; i < 26 && tries < 160; tries++) {
          const fx = -18 + hash(seed, tries, 23) * 30, fy = (hash(seed, tries, 24) - 0.5) * 16;
          // Not under the wing still on, nor on the other wing's wreck lying out (loot.ts).
          if ((fx > -1.8 && fx < 2.6 && fy > 0.4 && fy < 8.2) || (fx > -6.8 && fx < -0.2 && fy > -11.8 && fy < -5.2)) continue;
          const x = s.sx + fx * c - fy * sn, z = s.sy + fx * sn + fy * c;
          if (this.lay(pick(CRASH, hash(seed, tries, 25)), x, z, seed + tries)) i++;
        }
        this.around(s.sx, s.sy, 14, 19, 5, [['burnt', 3], ['crater', 1], ['bones', 1]], seed + 1);
        return;
      }
      case SiteKind.Church: {
        // A graveyard on the far side from the tower, the latest dead still in their bags.
        const yaw = s.yaw ?? 0, fx = -Math.round(Math.cos(yaw)), fz = -Math.round(Math.sin(yaw));
        const gx = cx + fx * (s.w / 2 + 5.5), gz = cz + fz * (s.h / 2 + 5.5);
        for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
          if (hash(seed, row * 5 + col, 26) < 0.15) continue;
          this.put('grave', gx + (col - 2) * 1.7 + (hash(seed, col, 27) - 0.5) * 0.3, gz + (row - 1) * 2.6, (hash(seed, row * 5 + col, 28) - 0.5) * 0.25,
            { tilt: (hash(seed, row * 5 + col, 29) - 0.5) * 0.12, essential: true });
        }
        for (let k = 0; k < 4; k++) this.put('bodyBag', gx - 4 + k * 0.8, gz + 4.4, PI / 2 + (r(k) - 0.5) * 0.2, { essential: true });
        this.flock(gx, gz, 4, seed);
        this.around(cx, cz, Math.max(s.w, s.h) / 2 + 2, Math.max(s.w, s.h) / 2 + 8, 8, RUIN, seed + 2);
        return;
      }
      case SiteKind.Shrine:
        this.around(cx, cz, Math.max(s.w, s.h) / 2 + 1, Math.max(s.w, s.h) / 2 + 6, 6, [['bones', 3], ['skeleton', 2], ['burnt', 1]], seed);
        return;
    }
  }

  // Old field boundaries across open country: long runs of post and wire, half fallen.
  private fenceLines(): void {
    const { w, h, roadD, rockD } = this, n = Math.floor(w * h / 2600);
    for (let i = 0; i < n; i++) {
      const x = 4 + hash(i, 1, 31) * (w - 8), z = 4 + hash(i, 2, 31) * (h - 8), ti = Math.floor(z) * w + Math.floor(x);
      if (roadD[ti] < 4 || rockD[ti] < 4 || this.fade(x, z) < 0.6) continue;
      const a = (hash(i, 3, 31) < 0.5 ? 0 : PI / 2) + (hash(i, 4, 31) - 0.5) * 0.3, len = 10 + hash(i, 5, 31) * 22;
      const bx = x + Math.cos(a) * len, bz = z + Math.sin(a) * len;
      this.run('fenceWire', x, z, bx, bz, 0.12, i * 101, 'fenceBroken');
    }
  }

  // Everything else, tile by tile: thick by roads and ruins and the sites, thin in the open.
  private background(): void {
    const { w, h, tiles, roadD, rockD } = this;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, t = tiles[i];
      if (t !== Tile.Grass && t !== Tile.Dirt && t !== Tile.Sand && t !== Tile.Floor) continue;
      const f = this.fade(x + 0.5, y + 0.5);
      if (f <= 0) continue;
      const road = roadD[i] <= 1 ? 1 : roadD[i] <= 3 ? 0.6 : 0, ruin = rockD[i] <= 2 ? 1 : rockD[i] <= 5 ? 0.45 : 0;
      const p = (0.005 + 0.03 * road + 0.045 * ruin) * f;
      if (hash(x, y, 101) >= p) continue;
      const table = ruin >= road && ruin > 0 ? RUIN : road > 0 ? ROAD : OPEN;
      let name = pick(table, hash(x, y, 102));
      const px = x + 0.2 + hash(x, y, 103) * 0.6, pz = y + 0.2 + hash(x, y, 104) * 0.6;
      if (table === ROAD && roadD[i] === 2 && hash(x, y, 105) < 0.18) name = 'roadSign';
      if (name === 'bodyBag' && table === RUIN && rockD[i] === 1) {
        // Laid out along the wall beside it.
        const side = this.tile(px - 1, pz) === Tile.Rock || this.tile(px + 1, pz) === Tile.Rock;
        this.put('bodyBag', px, pz, side ? PI / 2 : 0, {});
        continue;
      }
      this.lay(name, px, pz, i);
    }
  }
}
