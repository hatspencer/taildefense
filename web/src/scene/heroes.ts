import * as THREE from 'three/webgpu';
import { color, sin, time, vertexColor } from 'three/tsl';
import { WEAPON_BASE } from '../demo/defs';
import { Art, ART_TIME, Emote, GREAT, KATANA, legendary, Order, PF_ALIVE, PF_FIRING, PF_HURT, PF_RELOADING, OWNED_DUAL, OWNED_DUAL_KATANA, OWNED_TEMPERED, RIFLE, THROW_FLIGHT } from '../protocol';
import type { Game } from '../state';
import { AWM_HELD, AWM_HELD_MUZZLE, awmFull, awmParts } from './awm';
import { litMaterial } from './structs';
import { Body, type Look, readLook, shade } from './look';
import { darker, garment as wear, lighter, blend, PAL } from './palette';
import { ik2, Spring, turnTowards, wrapAngle } from './rig';
import { box, cyl, merge, part, type Part, playerColor, sphere } from './util';

interface Limb { upper: THREE.Group; lower: THREE.Group }
interface Hero {
  group: THREE.Group; body: THREE.Group; hips: THREE.Group; torso: THREE.Group; head: THREE.Group; tail: THREE.Group | null; pack: THREE.Group;
  legL: Limb; legR: Limb; armL: Limb; armR: Limb;
  gun: THREE.Group; gunMesh: THREE.Mesh | null; spin: THREE.Group | null; glow: THREE.Mesh | null; flash: THREE.Object3D; finger: THREE.Object3D; hand: THREE.Object3D;
  gun2: THREE.Group; dual: boolean; alt: boolean; // the second pistol or katana, in the left hand; alt: the last shot was its
  evo: number; // the legendary's evolution its blade is dressed for, and a greatsword tempered (+4)
  // A legendary's swings: the count last seen, when the last began, which of its combo it is,
  // and the blade's pose as it eases between them. art: the weapon art last seen; artEnd when
  // it last ended, and which it was.
  swings: number; swingAt: number; combo: number; bp: Pose; bp2: Pose; art: number; artStart: number; artEnd: number; artWas: number; stance: number;
  shout: THREE.Object3D; stars: THREE.Object3D; goggles: THREE.Object3D; marker: THREE.Object3D; cross: THREE.Object3D; progress: THREE.Object3D;
  look: number; wd: number; ht: number; weapon: number; color: number;
  phase: number; seen: number; down: boolean; pop: number; shotAt: number; crouch: number; downAmt: number; taunt: number; reload: number;
  sprint: number; leap: number; hurt: boolean; flyAt: number; // when a throw took them off their feet, -1 on them
  x: number; y: number; vx: number; vy: number; legYaw: number; dirSign: number; fresh: boolean;
  leanX: Spring; leanZ: Spring; aim: Spring; flinch: Spring; tailS: Spring; packS: Spring; kick: Spring;
}

// A pose blend towards a goal at rate k per second.
const ease = (v: number, goal: number, k: number, dt: number) => v + (goal - v) * Math.min(1, dt * k);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// A survivor is built in metres, a 1.8 m person standing on y = 0 and facing +x, then drawn at
// K of that inside a group scaled by GROUP: the scale every pose and hold below is written in.
// The joints, in metres: hip, knee, the waist the torso turns at, shoulder, elbow, the middle
// of the hand hanging, and the neck the head turns on.
const GROUP = 1.15;
export const K = 1 / GROUP;
const J_HIP = 0.93, J_KNEE = 0.48, J_WAIST = 1.0, J_SHOULDER = 1.455, J_ELBOW = 1.165, J_HAND = 0.9, J_NECK = 1.52;
const WAIST = J_WAIST * K, HIP = J_HIP * K, THIGH = (J_HIP - J_KNEE) * K;
const UPPER = (J_SHOULDER - J_ELBOW) * K, FORE = (J_ELBOW - J_HAND) * K;
// Half the distance between the hips and between the shoulders' pivots, by body.
const legZ = (b: Body) => (b === Body.Fem ? 0.106 : 0.1);
const armZ = (b: Body) => (b === Body.Masc ? 0.197 : b === Body.Fem ? 0.178 : 0.187);
// The head is drawn HEAD times its true size about the neck, as the picture draws its people:
// a little big, so a face and a hat read from the camera.
const HEAD = 1.08;
const hy = (y: number) => J_NECK + (y - J_NECK) * HEAD;
// Where the hair that swings (a ponytail, braids) hangs from: the back of the head.
export const TAIL = [-0.1 * HEAD * K, hy(1.74) * K];

// How each weapon is carried: where it sits in the torso's space (origin at the waist, +x the
// way the hero faces), where each hand holds it in its own, and where its muzzle is. A gun's
// own space has its bore along +x at y = 0; grip, fore and muzzle are given here in metres.
interface Hold { at: [number, number, number]; grip: [number, number, number]; fore: [number, number, number]; muzzle: number }
const hold = (at: [number, number, number], grip: [number, number, number], fore: [number, number, number], muzzle: number): Hold =>
  ({ at, grip: grip.map((v) => v * K) as [number, number, number], fore: fore.map((v) => v * K) as [number, number, number], muzzle: muzzle * K });
const HOLDS: Hold[] = [
  hold([0.42, 0.4, -0.06], [-0.012, -0.066, 0], [-0.02, -0.08, 0.05], 0.16),   // pistol, both hands out
  hold([0.2, 0.42, -0.14], [-0.06, -0.072, 0], [0.36, -0.04, 0], 0.66),        // shotgun, shouldered
  hold([0.24, 0.38, -0.12], [-0.035, -0.075, 0], [0.17, -0.09, 0], 0.31),      // SMG
  hold([0.2, 0.43, -0.14], [-0.08, -0.07, 0], [0.32, -0.04, 0], 0.76),         // rifle
  hold([0.24, 0.13, -0.1], [-0.2, 0, -0.04], [0.02, 0.13, 0.03], 0.78),         // minigun, braced at the hip
  hold([0.02, 0.56, -0.19], [0.06, -0.11, 0], [0.36, -0.1, 0], 0.74),          // launcher, on the shoulder
  hold([0.16, 0.24, -0.17], [0, 0, 0], [-0.1, 0, 0], 0.6),                     // crowbar, both hands on the tape, up at the shoulder
];

// The legendaries are held two-handed, the off hand behind the grip on the hilt; their poses
// are set by the swing (legendPose), so at is only where a fresh one starts.
HOLDS[KATANA] = { at: [0.26, 0.14, -0.2], grip: [0, 0, 0], fore: [-0.11, 0, 0], muzzle: 0.9 };
HOLDS[GREAT] = { at: [0, 0.6, -0.22], grip: [0, 0, 0], fore: [-0.14, 0, 0], muzzle: 1.3 };

// A fully bought Rifle is the AWM, shouldered as the rifle is, the off hand under its longer
// fore-end.
const AWM_HOLD: Hold = { at: [0.2, 0.43, -0.14], grip: [0, -0.04, 0], fore: [0.36, -0.06, 0], muzzle: AWM_HELD_MUZZLE };
const holdOf = (w: number, evo: number): Hold => (w === RIFLE && evo ? AWM_HOLD : HOLDS[w] ?? HOLDS[0]);

// A legendary's edge, lit: plain steel's shine, then by evolution (Crimson Fang, Moonlit Edge;
// Ashen Colossus, Stormbreaker).
const EDGE: Record<number, number[]> = { [KATANA]: [0xc8d2e4, 0xff2030, 0x9fdcff], [GREAT]: [0x8a8e96, 0xff6a10, 0xb080ff] };

// A box whose bottom is bx deep and bz wide and whose top is tx by tz, h tall, centred on its
// own middle; lean moves the top forward (+x). The survivors' bodies are stacks of these.
function taper(bx: number, bz: number, tx: number, tz: number, h: number, lean = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const top = p.getY(i) > 0;
    p.setXYZ(i, p.getX(i) * (top ? tx : bx) + (top ? lean : 0), p.getY(i) * h, p.getZ(i) * (top ? tz : bz));
  }
  return g;
}

const UP = new THREE.Vector3(0, 1, 0);

// Builds parts into one list at a time (to), in metres: a box, a tapered box standing on y0, a
// round limb standing on y0, a ball, and a strap or bar from one point to another.
class Kit {
  to: Part[] = [];
  b(dx: number, dy: number, dz: number, col: number, x: number, y: number, z = 0, rx = 0, ry = 0, rz = 0): void {
    this.to.push(part(box(dx, dy, dz), col, x, y, z, rx, ry, rz));
  }
  t(bx: number, bz: number, tx: number, tz: number, h: number, col: number, x: number, y0: number, z = 0, lean = 0): void {
    this.to.push(part(taper(bx, bz, tx, tz, h, lean), col, x, y0 + h / 2, z));
  }
  c(rb: number, rt: number, h: number, col: number, x: number, y0: number, z = 0, seg = 6): void {
    this.to.push(part(cyl(rt, rb, h, seg), col, x, y0 + h / 2, z));
  }
  ball(r: number, col: number, x: number, y: number, z = 0, sy = 1): void {
    this.to.push(part(sphere(r, 6, 4), col, x, y, z, 0, 0, 0, 1, sy, 1));
  }
  // A bar from a to b, dx thick across it and dz wide, its width kept along z where it can be.
  seg(a: [number, number, number], b: [number, number, number], dx: number, dz: number, col: number): void {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = d.length();
    const g = box(dx, len, dz);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
    g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    this.to.push({ geo: g, color: col });
  }
  // A round rod along x, from x0 to x1 at (y, z).
  rod(r0: number, r1: number, x0: number, x1: number, col: number, y = 0, z = 0, seg = 6): void {
    this.to.push(part(cyl(r1, r0, x1 - x0, seg), col, (x0 + x1) / 2, y, z, 0, 0, -Math.PI / 2));
  }
}

// Every part to the scale the hero is drawn in.
const toScale = (ps: Part[]): Part[] => { for (const p of ps) p.geo.scale(K, K, K); return ps; };

// The gun in the hand, facing +x along its bore, at its true size, with a band of tape in the
// player's colour. glow: the parts drawn lit, a legendary's edge. A tempered greatsword has a
// second blade forged into it. evo on the Rifle (3): every track bought, so it is the green
// AWM, the sniper tower's rifle (awm.ts) at a size to carry.
export function gunParts(w: number, c: number, evo = 0, temper = false): { body: Part[]; spin: Part[]; glow: Part[] } {
  const k = new Kit(), s: Part[] = [], gl: Part[] = [];
  const b = k.to;
  const POLY = 0x2a2824, STEEL = PAL.steelDark, BLUED = 0x26282a, WOOD = PAL.wood, WOODD = PAL.woodDark, SLING = PAL.leather;
  switch (w) {
    case 0:
      // A service pistol: slide, frame, the grip raked back with tape round it, the guard.
      k.b(0.19, 0.032, 0.026, STEEL, 0.06, 0.004); k.b(0.15, 0.02, 0.024, POLY, 0.05, -0.02);
      k.b(0.034, 0.105, 0.03, POLY, -0.014, -0.07, 0, 0, 0, 0.24); k.b(0.036, 0.035, 0.033, c, -0.02, -0.088, 0, 0, 0, 0.24);
      k.b(0.04, 0.008, 0.012, POLY, 0.032, -0.044); k.b(0.012, 0.01, 0.008, PAL.steelLit, 0.145, 0.025);
      break;
    case 1:
      // A pump shotgun: barrel over its magazine tube, the wooden pump and stock, a sling.
      k.b(0.2, 0.06, 0.042, BLUED, 0.06, -0.014);
      k.rod(0.012, 0.012, 0.16, 0.66, STEEL, 0.004); k.rod(0.013, 0.013, 0.16, 0.56, BLUED, -0.026);
      k.b(0.16, 0.044, 0.05, WOOD, 0.38, -0.026); for (const x of [0.33, 0.38, 0.43]) k.b(0.01, 0.046, 0.052, WOODD, x, -0.026);
      k.b(0.1, 0.045, 0.036, WOOD, -0.08, -0.045, 0, 0, 0, -0.3); k.b(0.24, 0.075, 0.04, WOOD, -0.24, -0.075, 0, 0, 0, -0.06);
      k.b(0.04, 0.078, 0.042, c, -0.17, -0.07, 0, 0, 0, -0.06); k.b(0.022, 0.088, 0.042, PAL.rubber, -0.365, -0.085, 0, 0, 0, -0.06);
      k.b(0.05, 0.008, 0.012, BLUED, -0.005, -0.05);
      k.seg([0.5, -0.04, 0.026], [0.1, -0.15, 0.026], 0.008, 0.022, SLING); k.seg([0.1, -0.15, 0.026], [-0.3, -0.12, 0.026], 0.008, 0.022, SLING);
      break;
    case 2:
      // A compact SMG: receiver, short shrouded barrel, a curved magazine, the pistol grip and
      // foregrip, the wire stock folded along its side, a sight on top.
      k.b(0.26, 0.065, 0.045, BLUED, 0.04, -0.012); k.b(0.05, 0.068, 0.048, c, -0.06, -0.012);
      k.rod(0.018, 0.018, 0.17, 0.27, STEEL); k.rod(0.008, 0.008, 0.27, 0.31, BLUED);
      k.b(0.036, 0.1, 0.028, STEEL, 0.07, -0.09, 0, 0, 0, 0.12); k.b(0.036, 0.07, 0.028, STEEL, 0.085, -0.165, 0, 0, 0, 0.3);
      k.b(0.035, 0.09, 0.032, POLY, -0.035, -0.08, 0, 0, 0, 0.22); k.b(0.03, 0.07, 0.03, POLY, 0.17, -0.075);
      k.b(0.24, 0.012, 0.012, STEEL, -0.15, 0.0, 0.03); k.b(0.24, 0.012, 0.012, STEEL, -0.15, -0.035, 0.03); k.b(0.012, 0.05, 0.03, STEEL, -0.27, -0.018, 0.03);
      k.b(0.09, 0.02, 0.02, BLUED, 0.02, 0.03);
      k.seg([0.2, -0.04, -0.03], [0.0, -0.13, -0.03], 0.008, 0.02, PAL.webbing); k.seg([0.0, -0.13, -0.03], [-0.25, -0.03, -0.03], 0.008, 0.02, PAL.webbing);
      break;
    case 3:
      if (evo) {
        const { scale: a, x, y } = AWM_HELD;
        for (const q of awmParts(true)) { q.geo.scale(a * GROUP, a * GROUP, a * GROUP); q.geo.translate(x * GROUP, y * GROUP, 0); b.push(q); }
        break;
      }
      // A bolt-action hunting rifle: a long walnut stock, the blued barrel and action, the bolt
      // handle out to the right, a scope on two rings, and a leather sling under it.
      k.rod(0.012, 0.009, 0.16, 0.76, BLUED, 0.002); k.b(0.22, 0.034, 0.03, BLUED, 0.05, 0.002);
      k.b(0.012, 0.012, 0.045, PAL.steelLit, -0.03, 0.006, -0.03); k.ball(0.011, PAL.steelLit, -0.03, 0.006, -0.055);
      k.b(0.38, 0.034, 0.04, WOOD, 0.3, -0.026); k.b(0.25, 0.044, 0.044, WOOD, 0.05, -0.028);
      k.b(0.11, 0.042, 0.038, WOOD, -0.11, -0.05, 0, 0, 0, -0.38); k.b(0.28, 0.08, 0.042, WOOD, -0.29, -0.075, 0, 0, 0, -0.05);
      k.b(0.2, 0.02, 0.036, WOODD, -0.26, -0.03, 0, 0, 0, -0.03); k.b(0.04, 0.083, 0.044, c, -0.2, -0.074, 0, 0, 0, -0.05);
      k.b(0.02, 0.092, 0.044, PAL.rubber, -0.435, -0.08, 0, 0, 0, -0.05); k.b(0.05, 0.008, 0.012, BLUED, -0.01, -0.056);
      k.rod(0.016, 0.016, -0.07, 0.17, BLUED, 0.058); k.rod(0.016, 0.023, 0.17, 0.23, BLUED, 0.058); k.rod(0.02, 0.016, -0.13, -0.07, BLUED, 0.058);
      k.b(0.014, 0.028, 0.02, STEEL, -0.03, 0.034); k.b(0.014, 0.028, 0.02, STEEL, 0.12, 0.034);
      k.seg([0.44, -0.05, 0.024], [0.08, -0.17, 0.024], 0.008, 0.022, SLING); k.seg([0.08, -0.17, 0.024], [-0.33, -0.12, 0.024], 0.008, 0.022, SLING);
      break;
    case 4: {
      // A minigun: the housing, the motor, an ammunition box with its feed chute, spade grips
      // behind, a carrying handle over it; six barrels in a clamp that spin.
      k.b(0.3, 0.16, 0.15, BLUED, 0.0, 0.0); k.b(0.08, 0.165, 0.155, c, 0.1, 0.0); k.rod(0.045, 0.045, -0.05, 0.12, STEEL, 0.05, 0.085);
      k.b(0.18, 0.16, 0.12, PAL.olive, -0.04, -0.17, 0.11); k.b(0.19, 0.02, 0.125, PAL.oliveDark, -0.04, -0.09, 0.11);
      k.seg([0.0, -0.09, 0.08], [0.04, -0.05, 0.03], 0.04, 0.06, PAL.steel);
      k.b(0.03, 0.12, 0.03, PAL.rubber, -0.18, 0.0, 0.06); k.b(0.03, 0.12, 0.03, PAL.rubber, -0.18, 0.0, -0.06); k.b(0.03, 0.03, 0.15, STEEL, -0.17, 0.04);
      k.b(0.2, 0.022, 0.022, STEEL, 0.02, 0.13); k.b(0.02, 0.05, 0.02, STEEL, -0.06, 0.1); k.b(0.02, 0.05, 0.02, STEEL, 0.1, 0.1);
      k.to = s;
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; k.rod(0.011, 0.011, 0.15, 0.78, STEEL, Math.cos(a) * 0.036, Math.sin(a) * 0.036, 5); }
      k.b(0.035, 0.11, 0.11, BLUED, 0.42, 0); k.b(0.03, 0.1, 0.1, BLUED, 0.72, 0);
      break;
    }
    case 6:
      // A crowbar: a hex bar, its gooseneck curling to a split claw at the far end, a bent
      // chisel at the near one, and tape round the grip in the player's colour.
      k.rod(0.013, 0.013, -0.12, 0.6, 0x5a3430, 0, 0, 6);
      k.seg([0.6, 0, 0], [0.67, 0.035, 0], 0.026, 0.026, 0x5a3430); k.seg([0.67, 0.035, 0], [0.7, 0.1, 0], 0.026, 0.03, 0x5a3430);
      k.seg([0.7, 0.1, 0], [0.675, 0.14, 0], 0.02, 0.034, PAL.steel); k.seg([-0.12, 0, 0], [-0.17, -0.025, 0], 0.024, 0.03, PAL.steel);
      k.rod(0.018, 0.018, -0.1, 0.06, c); k.rod(0.019, 0.019, -0.03, -0.01, darker(c, 0.6));
      break;
    case KATANA: {
      // A long hilt bound in the player's colour, a gold guard, and a blade that curves up
      // towards its point in three lengths, its edge underneath.
      const edge = EDGE[KATANA][evo] ?? EDGE[KATANA][0];
      const add = (wd: number, h: number, d: number, col: number, x: number, y: number, z = 0, rz = 0) => b.push(part(box(wd, h, d), col, x, y, z, 0, 0, rz));
      add(0.24, 0.045, 0.045, c, -0.06, 0); add(0.03, 0.05, 0.05, 0x1a1410, -0.19, 0);
      for (const x of [-0.13, -0.06, 0.01]) add(0.02, 0.05, 0.05, shade(c, 0.55), x, 0);
      add(0.025, 0.1, 0.1, 0x9a7a30, 0.075, 0); add(0.03, 0.05, 0.03, 0xc8a050, 0.1, 0);
      const seg = [[0.25, 0.3, 0.0, 0.03], [0.53, 0.28, 0.014, 0.07], [0.77, 0.22, 0.036, 0.15]];
      seg.forEach(([x, l, y, rz], i) => {
        add(l, i === 2 ? 0.03 : 0.04, 0.014, 0xb8bec8, x, y + 0.006, 0, rz);
        gl.push(part(box(l, 0.012, 0.016), edge, x, y - 0.014, 0, 0, 0, rz));
      });
      add(0.05, 0.018, 0.016, 0xe8ecf4, 0.9, 0.055, 0, 0.35);
      return { body: b, spin: s, glow: gl };
    }
    case GREAT: {
      // A great slab of iron: a leather grip and a heavy pommel, a wide crossguard with a
      // stone in the player's colour, and a broad blade with a dark fuller down it.
      const edge = EDGE[GREAT][evo] ?? EDGE[GREAT][0];
      const add = (wd: number, h: number, d: number, col: number, x: number, y: number) => b.push(part(box(wd, h, d), col, x, y));
      add(0.26, 0.06, 0.06, 0x3a2a1c, -0.1, 0); add(0.08, 0.08, 0.08, 0x8a7038, -0.25, 0);
      add(0.06, 0.07, 0.4, 0x4a4e56, 0.05, 0); add(0.065, 0.06, 0.07, c, 0.05, 0);
      add(1.0, 0.15, 0.035, 0x8e949c, 0.58, 0); add(0.86, 0.035, 0.04, 0x5a5e66, 0.54, 0);
      add(0.14, 0.09, 0.034, 0x8e949c, 1.12, 0); add(0.06, 0.04, 0.032, 0x8e949c, 1.21, 0);
      gl.push(part(box(1.0, 0.016, 0.038), edge, 0.58, 0.075), part(box(1.0, 0.016, 0.038), edge, 0.58, -0.075));
      if (evo) for (const x of [0.3, 0.5, 0.7, 0.9]) gl.push(part(box(0.04, 0.05, 0.042), edge, x, 0, 0, 0, 0, 0.6));
      if (temper) {
        // Tempered: the second blade forged into the first, its seam still glowing down the
        // fuller like a bar out of the forge, and a heavier, banded guard.
        gl.push(part(box(0.9, 0.022, 0.044), 0xff7a1c, 0.56, 0), part(box(0.5, 0.012, 0.046), 0xffd070, 0.4, 0));
        add(0.05, 0.1, 0.44, 0x2e3036, 0.08, 0); add(0.03, 0.18, 0.04, 0x2e3036, 0.12, 0);
      }
      return { body: b, spin: s, glow: gl };
    }
    default:
      // A launcher on the shoulder: an olive tube flared at both ends, its sight on the left,
      // pistol grip and foregrip under it, a cheek pad, bands of tape, a sling.
      k.rod(0.05, 0.05, -0.2, 0.7, PAL.olive, 0, 0, 8); k.rod(0.052, 0.062, 0.68, 0.76, PAL.oliveDark, 0, 0, 8); k.rod(0.064, 0.052, -0.28, -0.2, PAL.oliveDark, 0, 0, 8);
      k.rod(0.053, 0.053, 0.46, 0.51, c, 0, 0, 8);
      k.b(0.09, 0.06, 0.03, BLUED, 0.2, 0.04, 0.065); k.b(0.02, 0.04, 0.035, PAL.steelLit, 0.25, 0.05, 0.065);
      k.b(0.035, 0.1, 0.035, PAL.rubber, 0.07, -0.09, 0, 0, 0, 0.15); k.b(0.035, 0.09, 0.035, PAL.rubber, 0.37, -0.085);
      k.b(0.12, 0.035, 0.09, PAL.rubber, -0.04, -0.055);
      k.seg([0.55, -0.05, -0.05], [0.15, -0.16, -0.05], 0.008, 0.024, PAL.webbing); k.seg([0.15, -0.16, -0.05], [-0.18, -0.05, -0.05], 0.008, 0.024, PAL.webbing);
  }
  return { body: toScale(b), spin: toScale(s), glow: gl };
}

// A blade's pose in the torso's space: where its grip is, and its roll, heading (positive
// towards the right) and pitch (positive up), radians.
type Pose = [number, number, number, number, number, number];
const P = (x: number, y: number, z: number, rx: number, ry: number, rz: number): Pose => [x, y, z, rx, ry, rz];
const lerpPose = (o: Pose, a: Pose, b: Pose, u: number): Pose => { for (let i = 0; i < 6; i++) o[i] = a[i] + (b[i] - a[i]) * u; return o; };
const easePose = (o: Pose, g: Pose, k: number, dt: number): void => { const m = Math.min(1, dt * k); for (let i = 0; i < 6; i++) o[i] += (g[i] - o[i]) * m; };
const mirror = (o: Pose, a: Pose): Pose => { o[0] = a[0]; o[1] = a[1]; o[2] = -a[2]; o[3] = -a[3]; o[4] = -a[4]; o[5] = a[5]; return o; };

// The legendaries' moves, after the soulslikes' long blades but in a few sharp frames: a ready
// stance, the run, and a three-cut combo, each cut a windup it is chambered in while the
// survivor keeps attacking, and where it ends. The katana: a flat cut right to left, a rising
// backhand, then an overhead cleave stepping in. The greatsword: a diagonal chop off the
// shoulder, a sweep through the whole front, then the follow-through, a hop and the blade
// brought down two-handed into the ground.
interface Moves { idle: Pose; run: Pose; combo: [Pose, Pose][]; dur: number[]; lunge: number[] }
const MOVES: Record<number, Moves> = {
  [KATANA]: {
    idle: P(0.26, 0.14, -0.2, 0, 0.15, -0.45), run: P(-0.02, 0.22, -0.26, 0, 0, -2.6),
    combo: [
      [P(0.02, 0.42, -0.32, 0, 1.9, 0.15), P(0.28, 0.36, 0.34, 0, -1.7, 0.05)],
      [P(0.22, 0.24, 0.32, 0, -1.8, -0.3), P(0.2, 0.62, -0.34, 0, 1.6, 0.5)],
      [P(-0.05, 0.9, -0.1, 0, 0, 2.3), P(0.5, 0.05, -0.05, 0, 0.1, -0.7)],
    ],
    dur: [330, 330, 420], lunge: [0.12, 0.12, 0.3],
  },
  [GREAT]: {
    idle: P(0, 0.6, -0.22, 0, 0.1, 2.55), run: P(-0.1, 0.2, -0.3, 0, -0.2, -2.75),
    combo: [
      [P(-0.05, 0.95, -0.28, 0, 0.6, 2.1), P(0.5, 0, 0.25, 0, -0.6, -0.8)],
      [P(0.1, 0.38, 0.42, 0, -2, 0.1), P(0.1, 0.38, -0.42, 0, 2, 0.1)],
      [P(-0.15, 1, -0.05, 0, 0, 1.9), P(0.62, -0.18, 0, 0, 0, -1.2)],
    ],
    dur: [700, 700, 900], lunge: [0.2, 0.15, 0.4],
  },
};
// Flash Draw: held low with the blade sheathed at the left hip, then after the cut the blade
// out wide to the right, still, before it is flicked clean and brought back. Skyfall: overhead
// through the leap, then driven into the ground where it lands.
const SHEATHED = P(0.04, 0.1, 0.24, 0, 0.3, -2.85), ZANSHIN = P(0.12, 0.28, -0.46, 0, 2.3, -0.3), CHIBURI = P(0.3, 0.05, -0.3, 0, 1, -1.25);
const SKY = P(-0.08, 1, 0, 0, 0, 1.75), SLAM = P(0.62, -0.18, 0, 0, 0, -1.2);
// Worldsplitter: the blade snapped up overhead in both hands, then hauled back further, past
// upright, as the survivor sinks and leans away from the cut; then one chop all the way down
// into the ground in front, held there while the fissure opens.
const RAISE = P(-0.06, 1.05, 0, 0, 0, 1.55), RAISED = P(-0.2, 1.12, 0, 0, 0, 2.15), CHOP = P(0.7, -0.26, 0, 0, 0, -1.3);
const T1: Pose = P(0, 0, 0, 0, 0, 0), T2: Pose = P(0, 0, 0, 0, 0, 0);

const V = new THREE.Vector3(), TR = new THREE.Vector3(), TL = new THREE.Vector3(), PR = new THREE.Vector3(-0.4, -1, -0.6), PL = new THREE.Vector3(-0.2, -1, 0.8);
const AX = new THREE.Vector3(), MAG = new THREE.Vector3();

// One low-poly puppet per player, dressed as the look the host dealt them in the player's
// colour. The legs go where the hero goes, stepping in time with the ground covered and
// backpedalling when they shoot behind them; the torso turns to the aim, the arms reach for
// the gun by IK and each gun is carried its own way. Springs lean the body into a run, kick
// it back when hit and swing the hair and pack. Poses: walk, run, sprint, dash, reload, the
// taunt, kneeling to search or revive, and lying downed until someone picks them up.
// Milliseconds of Home Run's swing, from the wind-up's end to the bar back at rest. At u of it,
// homeSnap is how far from wound back to swung through (snapped round in three frames, then
// held), and homeBack how far from swung through back to rest.
const HOME_SWING = 600;
const homeSnap = (u: number): number => u < 0.14 ? Math.ceil(u / 0.14 * 3) / 3 : 1;
const homeBack = (u: number): number => u < 0.5 ? 0 : (u - 0.5) / 0.5;
// The bar wound back over the shoulder, swung through flat, and at rest: position, rotation.
const HOME_WOUND = [-0.24, 0.14, -0.16, -0.6, 1.1, 2.3], HOME_THROUGH = [0.26, 0.02, 0.26, 0, -1.5, 0.1], HOME_REST = [0, 0, 0, -0.35, 0, 1.4];

export class Heroes {
  group = new THREE.Group();
  private heroes = new Map<number, Hero>();
  private mat = litMaterial();
  // Night vision goggles' lenses: a faint green glow, lit or not.
  private lensMat = new THREE.MeshBasicNodeMaterial({ color: 0x8cff6a });
  private lensGeo = merge(LENSES);
  private flashMat = new THREE.MeshBasicNodeMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  private bubbleMat = new THREE.MeshBasicNodeMaterial({ color: 0xf4efe0 });
  private starMat = new THREE.MeshBasicNodeMaterial({ color: 0xffe060 });
  private shoutMat = new THREE.MeshBasicNodeMaterial({ color: 0xd8281c });
  private markerMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private crossMat = new THREE.MeshBasicNodeMaterial();
  private progMat = new THREE.MeshBasicNodeMaterial({ color: 0x60ff90, transparent: true, opacity: 0.55, depthWrite: false });
  // A legendary's edge: its own colour, unlit, breathing a little.
  private edgeMat = new THREE.MeshBasicNodeMaterial();
  private bubbleGeo: THREE.BufferGeometry; private shoutGeo: THREE.BufferGeometry;
  private starGeo = merge([part(box(0.13, 0.04, 0.04), 0, 0, 0, 0), part(box(0.04, 0.13, 0.04), 0, 0, 0, 0), part(box(0.04, 0.04, 0.13), 0, 0, 0, 0)]);
  private ringGeo: THREE.BufferGeometry; private discGeo: THREE.BufferGeometry; private crossGeo: THREE.BufferGeometry;
  private serial = 0;
  private q = new THREE.Quaternion();
  private axis = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    const pulse = sin(time.mul(5)).mul(0.2).add(0.5);
    this.markerMat.colorNode = color(0x50ff80).mul(pulse);
    this.edgeMat.colorNode = vertexColor().rgb.mul(sin(time.mul(3.1)).mul(0.18).add(1.05));
    this.markerMat.fog = false;
    this.crossMat.colorNode = color(0x70ff90).mul(sin(time.mul(5)).mul(0.2).add(1.1));
    // A blocky speech bubble with a red "!" on it, a ground ring and a floating "+".
    this.bubbleGeo = merge([part(box(0.44, 0.5, 0.04), 0, 0, 0, 0), part(box(0.34, 0.6, 0.04), 0, 0, 0, 0), part(box(0.1, 0.12, 0.04), 0, -0.1, -0.3, 0, 0, 0, 0.6)]);
    this.shoutGeo = merge([part(box(0.09, 0.26, 0.06), 0, 0, 0.07, 0.01), part(box(0.09, 0.09, 0.06), 0, 0, -0.17, 0.01)]);
    const ring = new THREE.RingGeometry(0.44, 0.52, 20); ring.rotateX(-Math.PI / 2);
    this.ringGeo = ring;
    const disc = new THREE.CircleGeometry(0.6, 20); disc.rotateX(-Math.PI / 2);
    this.discGeo = disc;
    this.crossGeo = merge([part(box(0.36, 0.11, 0.11), 0), part(box(0.11, 0.36, 0.11), 0)]);
  }

  clear(): void { this.group.clear(); this.heroes.clear(); }

  private mesh(parts: Part[], parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Mesh | null {
    if (!parts.length) return null;
    const geo = merge(parts);
    geo.translate(-x, -y, -z);
    const m = new THREE.Mesh(geo, this.mat);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  private make(id: number, look: number, weapon: number): Hero {
    // A survivor: the player's colour as the main garment, the rest from the look the host
    // dealt them, hung on the joints in pieces.
    const L = readLook(look);
    const c = garment(id);
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    const hips = new THREE.Group(), torso = new THREE.Group();
    hips.rotation.order = torso.rotation.order = 'YXZ';
    torso.position.y = WAIST;
    body.add(hips, torso);
    const F = figure(L, c);
    this.mesh(F.torso, torso, 0, WAIST);
    this.mesh(F.hips, hips);
    const head = new THREE.Group();
    head.position.set(0, NECK - WAIST, 0);
    head.rotation.order = 'YXZ';
    torso.add(head);
    this.mesh([...F.head, ...F.eyes, ...F.mouth], head, 0, NECK);
    // Night vision goggles, shown once bought.
    const goggles = new THREE.Group();
    goggles.visible = false;
    head.add(goggles);
    this.mesh(GOGGLES, goggles, 0, NECK);
    const lens = new THREE.Mesh(this.lensGeo, this.lensMat);
    lens.position.set(0, -NECK, 0);
    goggles.add(lens);
    let tail: THREE.Group | null = null;
    if (F.tail.length) {
      tail = new THREE.Group();
      tail.position.set(TAIL[0], TAIL[1] - NECK, 0);
      head.add(tail);
      this.mesh(F.tail, tail, TAIL[0], TAIL[1]);
    }
    const pack = new THREE.Group();
    torso.add(pack);
    this.mesh(F.pack, pack, 0, WAIST);

    // Legs: thigh from the hip, shin and boot from the knee.
    const leg = (i: number, z: number): Limb => {
      const upper = new THREE.Group(), lower = new THREE.Group();
      upper.position.set(0, HIP, z);
      lower.position.set(0, -THIGH, 0);
      upper.add(lower);
      hips.add(upper);
      this.mesh(F.thigh[i], upper, 0, HIP, z);
      this.mesh(F.shin[i], lower, 0, HIP - THIGH, z);
      return { upper, lower };
    };
    const lz = legZ(L.body) * K, legL = leg(0, lz), legR = leg(1, -lz);

    // Arms: shoulder and sleeve from the shoulder, forearm and hand from the elbow.
    const sh = armZ(L.body) * K;
    const arm = (i: number, z: number): Limb => {
      const upper = new THREE.Group(), lower = new THREE.Group();
      upper.position.set(0, J_SHOULDER * K - WAIST, z);
      lower.position.set(0, -UPPER, 0);
      upper.add(lower);
      torso.add(upper);
      this.mesh(F.upper[i], upper, 0, J_SHOULDER * K, z);
      this.mesh(F.fore[i], lower, 0, J_ELBOW * K, z);
      return { upper, lower };
    };
    const armL = arm(0, sh), armR = arm(1, -sh);
    this.mesh(F.hand[0], armL.lower, 0, J_ELBOW * K, sh);
    const hand = this.mesh(F.hand[1], armR.lower, 0, J_ELBOW * K, -sh)!;
    // The taunt's middle finger: a fist on the gun hand with one finger up out of it, a little
    // big so it still reads at pixel scale.
    const skin = L.arch.gloves ?? L.skin;
    const finger = new THREE.Mesh(merge([part(box(0.1, 0.09, 0.08), skin, 0, -FORE, 0), part(box(0.04, 0.16, 0.04), skin, 0, -FORE - 0.11, 0)]), this.mat);
    finger.visible = false;
    armR.lower.add(finger);

    const gun = new THREE.Group(), gun2 = new THREE.Group();
    gun2.visible = false;
    torso.add(gun, gun2);
    const flash = new THREE.Mesh(sphere(0.14, 6, 4), this.flashMat);
    flash.scale.set(1.6, 0.8, 0.8);
    gun.add(flash);
    const shout = new THREE.Group();
    shout.add(new THREE.Mesh(this.bubbleGeo, this.bubbleMat), new THREE.Mesh(this.shoutGeo, this.shoutMat));
    shout.visible = false;
    g.add(shout);
    // Stunned by a slam: stars wheeling round the head.
    const stars = new THREE.Group();
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2, s = new THREE.Mesh(this.starGeo, this.starMat);
      s.position.set(Math.cos(a) * 0.38, 0, Math.sin(a) * 0.38);
      stars.add(s);
    }
    stars.visible = false;
    g.add(stars);
    const marker = new THREE.Mesh(this.ringGeo, this.markerMat);
    marker.position.y = 0.03; marker.renderOrder = 4; marker.visible = false;
    const progress = new THREE.Mesh(this.discGeo, this.progMat);
    progress.position.y = 0.025; progress.renderOrder = 4; progress.visible = false;
    const cross = new THREE.Mesh(this.crossGeo, this.crossMat);
    cross.visible = false;
    g.add(marker, progress, cross);
    g.scale.setScalar(GROUP);
    this.group.add(g);
    const h: Hero = {
      group: g, body, hips, torso, head, tail, pack, legL, legR, armL, armR, gun, gunMesh: null, spin: null, glow: null, flash, finger, hand, gun2, dual: false, alt: false,
      evo: 0, swings: -1, swingAt: -1e9, combo: 0, bp: P(0, 0, 0, 0, 0, 0), bp2: P(0, 0, 0, 0, 0, 0), art: 0, artStart: 0, artEnd: -1e9, artWas: 0, stance: 0,
      shout, stars, goggles, marker, cross, progress, look, wd: L.width, ht: L.height, weapon: -1, color: c,
      phase: 0, seen: 0, down: false, pop: 0, shotAt: -1e9, crouch: 0, downAmt: 0, taunt: 0, reload: 0, sprint: 0, leap: 0, hurt: false, flyAt: -1,
      x: 0, y: 0, vx: 0, vy: 0, legYaw: 0, dirSign: 1, fresh: true,
      leanX: new Spring(2.2, 0.45, 0), leanZ: new Spring(2.2, 0.45, 0), aim: new Spring(4.5, 0.75, 1.6), flinch: new Spring(3, 0.3, 0),
      tailS: new Spring(1.8, 0.25, 0), packS: new Spring(3.5, 0.3, 0), kick: new Spring(9, 0.35, 0),
    };
    this.setWeapon(h, weapon, 0);
    return h;
  }

  private setWeapon(h: Hero, w: number, evo: number): void {
    if (h.weapon === w && h.evo === evo) return;
    if (h.weapon !== w && MOVES[w]) { h.bp = [...MOVES[w].idle]; h.bp2 = mirror(P(0, 0, 0, 0, 0, 0), MOVES[w].idle); }
    h.weapon = w; h.evo = evo;
    if (h.gunMesh) { h.gun.remove(h.gunMesh); h.gunMesh.geometry.dispose(); }
    if (h.spin) { h.gun.remove(h.spin); }
    if (h.glow) { h.gun.remove(h.glow); h.glow.geometry.dispose(); h.glow = null; }
    const g = gunParts(w, h.color, evo & 3, (evo & 4) !== 0);
    h.gunMesh = this.mesh(g.body, h.gun);
    if (g.glow.length) {
      h.glow = new THREE.Mesh(merge(g.glow), this.edgeMat);
      h.gun.add(h.glow);
    }
    h.spin = null;
    if (g.spin.length) {
      h.spin = new THREE.Group();
      h.gun.add(h.spin);
      this.mesh(g.spin, h.spin);
    }
    const hold = holdOf(w, evo);
    h.flash.position.x = hold.muzzle;

    h.group.traverse((c) => { c.userData.hl = h.group.userData.hl ?? 0; });
  }

  // Where the AWM's muzzle is, for the survivor standing at (x, y) with one in hand: the effects
  // draw its flash there, soft, instead of the hero's own flash mesh. Null if nobody is.
  awmMuzzle(x: number, y: number, out: THREE.Vector3): THREE.Vector3 | null {
    for (const h of this.heroes.values()) {
      if (h.weapon !== RIFLE || !h.evo) continue;
      const p = h.group.position;
      if ((p.x - x) ** 2 + (p.z - y) ** 2 > 0.36) continue;
      h.group.updateWorldMatrix(true, true);
      return h.flash.getWorldPosition(out);
    }
    return null;
  }

  // A second pistol or katana in the left hand, once found.
  private setDual(h: Hero, on: boolean): void {
    const kind = on ? h.weapon * 4 + h.evo + 1 : 0;
    if ((h.dual ? h.gun2.userData.kind : 0) === kind) return;
    h.dual = on;
    h.gun2.userData.kind = kind;
    h.gun.add(h.flash);
    h.alt = false;
    for (const c of [...h.gun2.children]) { h.gun2.remove(c); (c as THREE.Mesh).geometry.dispose(); }
    if (on) {
      const g = gunParts(h.weapon, h.color, h.evo & 3);
      this.mesh(g.body, h.gun2);
      if (g.glow.length) h.gun2.add(new THREE.Mesh(merge(g.glow), this.edgeMat));
    }
    h.group.traverse((c) => { c.userData.hl = h.group.userData.hl ?? 0; });
  }

  // Where a legendary's blade (and its pair's) is this frame: snapped through a cut in three
  // frames and held there a beat, the way a sprite's attack reads, then eased back to rest,
  // which is the next cut's windup while the survivor keeps attacking. A pair takes turns,
  // the one not cutting held ready.
  private legendPose(h: Hero, m: Moves, now: number, firing: boolean, su: number, after: number, artU: number, running: boolean, dt: number): void {
    const next = h.weapon === GREAT && h.combo === 2 && su >= 0 ? 2 : now - h.swingAt > 1300 ? 0 : (h.combo + 1) % 3;
    const rest = firing ? m.combo[next][0] : running ? m.run : m.idle;
    let act: Pose = rest, snap = false, k = 18;
    if (h.art === Art.Flash) { act = SHEATHED; k = 22; }
    else if (h.art === Art.Skyfall) { act = SKY; k = 14 + artU * 30; }
    else if (h.art === Art.Split) {
      // Up in three frames, then hauled back slowly, trembling at the top.
      if (artU < 0.15) { act = lerpPose(T1, m.idle, RAISE, Math.ceil(artU / 0.15 * 3) / 3); snap = true; }
      else { act = lerpPose(T1, RAISE, RAISED, (artU - 0.15) / 0.85); act[5] += artU > 0.6 ? Math.sin(now * 0.09) * 0.04 : 0; k = 10; }
    } else if (after >= 0 && h.artWas === Art.Split) {
      // The chop: down in two frames, and held in the ground.
      if (after < 0.08) { act = lerpPose(T1, RAISED, CHOP, after < 0.04 ? 0.5 : 1); snap = true; }
      else if (after < 0.75) { act = CHOP; snap = true; }
    } else if (after >= 0 && h.artWas === Art.Flash) {
      // Zanshin: still, blade out wide where the cut ended; then the flick, and back.
      if (after < 0.55) { act = ZANSHIN; snap = true; } else if (after < 0.7) { act = CHIBURI; k = 40; }
    } else if (after >= 0) {
      if (after < 0.6) { act = SLAM; snap = true; }
    } else if (su >= 0) {
      const [wu, end] = m.combo[h.combo];
      if (su < 0.2) { act = lerpPose(T1, wu, end, Math.min(1, Math.ceil(su / 0.2 * 3) / 3)); snap = true; }
      else if (su < 0.42) { act = end; snap = true; }
    }
    const lead = !h.dual || !h.alt;
    const pass = h.dual ? (firing ? rest : m.idle) : rest;
    const g1 = lead ? act : pass, g2 = mirror(T2, lead ? pass : act);
    if (snap && lead) h.bp = [...g1] as Pose; else easePose(h.bp, g1, lead ? k : 12, dt);
    if (h.dual) { if (snap && !lead) h.bp2 = [...g2] as Pose; else easePose(h.bp2, g2, lead ? 12 : k, dt); }
  }

  setHover(id: number, on: boolean): void {
    const h = this.heroes.get(id);
    if (h) { h.group.userData.hl = on ? 1 : 0; h.group.traverse((c) => { c.userData.hl = on ? 1 : 0; }); }
  }

  update(game: Game, now: number, dt: number, cam?: THREE.Camera): void {
    const f = game.cur;
    const serial = ++this.serial;
    const t = now / 1000;
    if (cam) this.q.copy(cam.quaternion);
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      let h = this.heroes.get(p.id);
      if (h && h.look !== p.look) { this.group.remove(h.group); h = undefined; }
      if (!h) { h = this.make(p.id, p.look, p.cur); this.heroes.set(p.id, h); }
      const awm = p.cur === RIFLE && awmFull(p.levels, RIFLE * 4, game.welcome?.maxLevel ?? 5);
      this.setWeapon(h, p.cur, legendary(p.cur) ? p.evo[p.cur] + (p.cur === GREAT && (p.owned & OWNED_TEMPERED) !== 0 ? 4 : 0) : awm ? 1 : 0);
      this.setDual(h, (p.cur === 0 && (p.owned & OWNED_DUAL) !== 0) || (p.cur === KATANA && (p.owned & OWNED_DUAL_KATANA) !== 0));
      h.seen = serial;
      const alive = (p.flags & PF_ALIVE) !== 0;
      // Standing up again (revived or respawned): a little pop.
      if (h.down && alive) h.pop = 1;
      h.down = !alive;
      // Shielded just after being put back at the base: blinking, and still shooting.
      h.group.visible = !p.aboard && ((p.flags & 1) !== 0 || alive) && !(alive && p.shielded && Math.floor(t * 8) % 2 === 1);
      const x = game.prx[p.id], y = game.pry[p.id], aim = game.paim[p.id];
      // Caught by a mauler or a goliath: held up off the ground, kicking; thrown: arcing high
      // over the throw, tumbling head over heels the way they fly.
      const held = alive && p.held, air = alive && p.airborne;
      if (!air) h.flyAt = -1;
      else if (h.flyAt < 0) h.flyAt = t;

      // A legendary's swings and weapon art, from the counters the frame carries: a new swing
      // goes on to the next cut of the combo if it came soon enough, else starts it over. An art
      // (Worldsplitter's raised blade among them) is timed here from when it was first seen, the
      // frames' progress too coarse to fly by.
      const leg: Moves | null = (alive && !held && !air && MOVES[h.weapon]) || null;
      if (leg) {
        if (h.swings < 0) h.swings = p.swings;
        if (p.art !== h.art) {
          if (p.art !== Art.None) h.artStart = now - p.artFrac * ART_TIME[p.art] * 1000;
          else { h.artEnd = now; h.artWas = h.art; h.swings = p.swings; }
          h.art = p.art;
        }
        if (p.swings !== h.swings) {
          h.swings = p.swings;
          h.combo = now - h.swingAt < 1300 ? (h.combo + 1) % 3 : 0;
          h.swingAt = now;
          if (h.dual) h.alt = !h.alt;
        }
      } else { h.swings = -1; if (h.weapon !== 6) h.art = Art.None; }
      // The crowbar's Home Run, timed the same way: hr through the wind-up, hs through the swing
      // after it, 0..1; -1 when neither.
      let hr = -1, hs = -1;
      if (!leg && h.weapon === 6) {
        const a = alive ? p.art : Art.None;
        if (a !== h.art) {
          if (a === Art.HomeRun) h.artStart = now - p.artFrac * ART_TIME[Art.HomeRun] * 1000;
          else if (h.art === Art.HomeRun && alive) h.artEnd = now;
          h.art = a;
        }
        if (h.art === Art.HomeRun) hr = clamp01((now - h.artStart) / (ART_TIME[Art.HomeRun] * 1000));
        else if (now - h.artEnd < HOME_SWING) hs = (now - h.artEnd) / HOME_SWING;
      }
      const artU = leg && h.art !== Art.None ? clamp01((now - h.artStart) / (ART_TIME[h.art] * 1000)) : 0;
      const sky = leg !== null && h.art === Art.Skyfall, drawing = leg !== null && h.art === Art.Flash;
      // Progress through the cut under way, and the moments after an art: -1 when none.
      let su = leg ? (now - h.swingAt) / (leg.dur[h.combo] * (h.dual ? 0.7 : 1)) : -1;
      if (su > 1 || h.art !== Art.None) su = -1;
      let after = leg && h.art === Art.None ? (now - h.artEnd) / (h.artWas === Art.Flash ? 700 : h.artWas === Art.Split ? 900 : 650) : -1;
      if (after > 1) after = -1;
      // Worldsplitter: the blade raised, and the chop after it.
      const raised = leg !== null && h.art === Art.Split, chop = after >= 0 && h.artWas === Art.Split;
      let lift = 0;
      if (sky) {
        // Skyfall: high over the leap, turning one whole somersault on the way down.
        lift = 3.4 * 4 * artU * (1 - artU);
        const s = artU * artU * (3 - 2 * artU);
        h.group.quaternion.setFromAxisAngle(this.axis.set(Math.sin(aim), 0, -Math.cos(aim)), s * Math.PI * 2);
      } else if (air) {
        const s = Math.min(1, (t - h.flyAt) / THROW_FLIGHT);
        lift = 9.6 * s * (1 - s);
        const v = Math.hypot(h.vx, h.vy);
        if (v > 0.5) h.group.quaternion.setFromAxisAngle(this.axis.set(h.vy / v, 0, -h.vx / v), s * Math.PI * 1.8);
      } else {
        h.group.quaternion.identity();
        if (held) lift = 1.1 + Math.sin(t * 17) * 0.06;
      }
      h.group.position.set(x, lift, y);

      // Velocity, smoothed over the frames' steps; a jump (respawn) starts afresh.
      if (h.fresh || Math.abs(x - h.x) + Math.abs(y - h.y) > 3) {
        h.x = x; h.y = y; h.vx = h.vy = 0; h.legYaw = aim; h.fresh = false;
        h.aim.reset(aim);
      }
      const dx = x - h.x, dy = y - h.y, dist = Math.hypot(dx, dy);
      h.x = x; h.y = y;
      const ovx = h.vx, ovy = h.vy;
      if (dt > 0) { h.vx = ease(h.vx, dx / dt, 14, dt); h.vy = ease(h.vy, dy / dt, 14, dt); }
      const speed = Math.hypot(h.vx, h.vy);
      const ax = dt > 0 ? (h.vx - ovx) / dt : 0, ay = dt > 0 ? (h.vy - ovy) / dt : 0;

      const channel = alive && (p.order === Order.Loot || p.order === Order.Revive) && p.channel > 0;
      const reviving = channel && p.order === Order.Revive;
      const taunting = alive && p.emote === Emote.Taunt && p.emoteLeft > 0;
      const firing = alive && (p.flags & PF_FIRING) !== 0;
      const reloading = alive && (p.flags & PF_RELOADING) !== 0;
      h.downAmt = ease(h.downAmt, alive ? 0 : 1, alive ? 14 : 7, dt);
      h.crouch = ease(h.crouch, channel ? 1 : 0, 10, dt);
      h.taunt = ease(h.taunt, taunting ? 1 : 0, 12, dt);
      h.reload = ease(h.reload, reloading && !channel ? 1 : 0, 10, dt);
      h.sprint = ease(h.sprint, alive && p.sprinting && speed > 2 ? 1 : 0, 6, dt);
      // A dash covers metres in a tick; a sprint, even in the best boots, stays well under this.
      h.leap = ease(h.leap, alive && speed > 20 ? 1 : 0, speed > 20 ? 20 : 6, dt);
      h.pop = Math.max(0, h.pop - dt * 2.2);
      // One kick and flash per shot, at the weapon's own rate: a shotgun booms, an SMG chatters.
      if (!firing || leg) h.shotAt = -1e9;
      else if (now - h.shotAt >= 1000 / (WEAPON_BASE[h.weapon]?.rate ?? 3)) {
        // The AWM slams back and up hard enough to see from the camera: about 0.1 back and 12°
        // up at the top of the kick.
        const awm = h.weapon === RIFLE && h.evo;
        h.shotAt = now; h.kick.kick(h.weapon === 1 || h.weapon === 5 ? 9 : h.weapon === 6 ? -14 : awm ? 26 : 3);
        // Dual pistols fire turn about, the flash at whichever went off.
        if (h.dual) { h.alt = !h.alt; (h.alt ? h.gun2 : h.gun).add(h.flash); }
      }
      const hurt = (p.flags & PF_HURT) !== 0;
      if (hurt && !h.hurt && alive) { h.flinch.kick(7); h.tailS.kick(4); }
      h.hurt = hurt;

      // The legs: towards the way they go, or backpedalling when that is behind the aim; at a
      // standstill they shuffle round once the torso has twisted too far.
      const walk = alive ? clamp01(speed / 1.2) : 0, run = clamp01((speed - 3.2) / 2.5);
      if (speed > 0.4 && alive) {
        const dir = Math.atan2(h.vy, h.vx);
        const back = Math.abs(wrapAngle(dir - aim)) > 1.9;
        h.dirSign = back ? -1 : 1;
        h.legYaw = turnTowards(h.legYaw, back ? dir + Math.PI : dir, dt * 10);
      } else if (Math.abs(wrapAngle(aim - h.legYaw)) > 0.85 || h.crouch > 0.3) {
        const before = h.legYaw;
        h.legYaw = turnTowards(h.legYaw, aim, dt * 7);
        h.phase += Math.abs(wrapAngle(h.legYaw - before)) * 1.4;
      }
      const sk = h.sprint;
      const stepLen = Math.min(1.0 + 0.3 * sk, Math.max(0.36, 0.3 + 0.11 * speed));
      h.phase += h.dirSign * dist / (2 * stepLen) * Math.PI * 2;
      if (speed < 0.2 && alive) {
        // Settle the feet: run the phase on to the nearest stance.
        const k = Math.round(h.phase / Math.PI) * Math.PI;
        h.phase = ease(h.phase, k, 8, dt);
      }
      const ph = h.phase;
      // A sprint: a longer stride, the knees driven high and the heels kicked up behind.
      const amp = (0.45 + 0.35 * run + 0.25 * sk) * walk;
      const bend = (0.7 + 0.8 * run + 0.5 * sk) * walk;
      let thL = Math.sin(ph) * amp, thR = -thL;
      let shL = -Math.max(0, Math.cos(ph)) * bend - 0.1 * walk, shR = -Math.max(0, -Math.cos(ph)) * bend - 0.1 * walk;
      // Kneeling to search or revive: down on the right knee.
      const cr = h.crouch;
      thL = thL * (1 - cr) + 1.45 * cr; shL = shL * (1 - cr) - 1.5 * cr;
      thR = thR * (1 - cr) - 0.1 * cr; shR = shR * (1 - cr) - 1.55 * cr;
      // A dash: a leap, front knee up and the back leg trailing.
      const lp = h.leap;
      thL = thL * (1 - lp) + 1.0 * lp; shL = shL * (1 - lp) - 1.3 * lp;
      thR = thR * (1 - lp) - 0.55 * lp; shR = shR * (1 - lp) - 0.7 * lp;
      // A legendary's fighting stance: feet apart, the left forward, knees bent; deep and low
      // for Flash Draw and after a cut has landed, knees tucked up through Skyfall, sinking
      // lower and lower under Worldsplitter's raised blade.
      h.stance = ease(h.stance, (leg && (firing || su >= 0 || after >= 0 || h.art !== Art.None)) || hr >= 0 || hs >= 0 ? 1 : 0, 9, dt);
      const st = h.stance * (1 - walk * 0.8), low = drawing ? 1 : raised ? 0.25 + 0.5 * artU : after >= 0 ? Math.min(1, (1 - after) * 2.5) : hr >= 0 ? 0.6 * hr : hs >= 0 ? 0.6 * (1 - hs) : 0;
      thL = thL * (1 - st) + (0.55 + 0.4 * low) * st; shL = shL * (1 - st) - (0.55 + 0.7 * low) * st;
      thR = thR * (1 - st) - (0.5 + 0.35 * low) * st; shR = shR * (1 - st) - (0.35 + 0.3 * low) * st;
      if (sky) { thL = 1.3; shL = -1.8; thR = 1.1; shR = -1.6; }
      if (!alive) { thL = 0.35; shL = -0.5; thR = 0.1; shR = -0.15; }
      h.legL.upper.rotation.z = thL; h.legL.lower.rotation.z = shL;
      h.legR.upper.rotation.z = thR; h.legR.lower.rotation.z = shR;

      // The body: a rise at each passing step, kneeling low, the pop on standing up.
      const bob = walk * (0.025 + 0.05 * run + 0.03 * sk) * (1 - Math.abs(Math.sin(ph)));
      const popY = h.pop > 0 ? Math.sin((1 - h.pop) * Math.PI) * 0.35 : 0;
      // A cut steps into it, the follow-through with a hop before it comes down.
      // Worldsplitter's chop steps in hard and stays there.
      const lunge = su >= 0 ? leg!.lunge[h.combo] * (su < 0.2 ? su / 0.2 : 1 - (su - 0.2) / 0.8) : chop ? 0.4 * Math.min(1, after / 0.05) * (after < 0.75 ? 1 : (1 - after) / 0.25) : 0;
      const hop = su >= 0 && h.weapon === GREAT && h.combo === 2 && su < 0.2 ? Math.sin(su / 0.2 * Math.PI) * 0.35 : 0;
      h.body.position.y = bob + popY - cr * 0.39 + lp * 0.15 + h.downAmt * 0.2 - st * 0.11 - low * 0.27 + hop;
      h.body.position.x = Math.cos(aim) * lunge; h.body.position.z = Math.sin(aim) * lunge;
      // Lean: into the run and into the turn (towards the acceleration), overshooting a
      // little on stopping; lying back when downed.
      const lean = 0.035 + 0.03 * h.sprint;
      let lx = h.vx * lean + ax * 0.012, lz = h.vy * lean + ay * 0.012;
      const lm = Math.hypot(lx, lz);
      if (lm > 0.42) { lx *= 0.42 / lm; lz *= 0.42 / lm; }
      lx = h.leanX.update(dt, alive ? lx + lp * Math.cos(h.legYaw) * 0.25 : 0);
      lz = h.leanZ.update(dt, alive ? lz + lp * Math.sin(h.legYaw) * 0.25 : 0);
      const dn = h.downAmt;
      lx = lx * (1 - dn) - Math.cos(aim) * 1.5 * dn; lz = lz * (1 - dn) - Math.sin(aim) * 1.5 * dn;
      const la = Math.hypot(lx, lz);
      if (la > 1e-4) { AX.set(lz / la, 0, -lx / la); h.body.quaternion.setFromAxisAngle(AX, la); } else h.body.quaternion.identity();
      // Width and stature, inside each half's own turn so a twist does not shear them.
      const sq = h.pop > 0 ? 1 + Math.sin(h.pop * Math.PI * 2) * 0.12 * h.pop : 1;
      const thick = 1 + (h.wd - 1) * 0.6;
      h.hips.scale.set(thick / Math.sqrt(sq), sq * h.ht, h.wd / Math.sqrt(sq));
      h.torso.scale.copy(h.hips.scale);
      h.torso.position.y = WAIST * h.hips.scale.y;

      // Hips follow the legs, with a swing of the pelvis; the torso follows the aim on a
      // spring that snaps a little ahead, twisting back against the stride.
      h.hips.rotation.set(Math.sin(ph) * 0.05 * walk, -(h.legYaw + Math.sin(ph) * 0.16 * walk), 0);
      const aimGoal = h.aim.y + wrapAngle(aim - h.aim.y);
      const ay2 = h.aim.update(dt, aimGoal);
      const flinch = h.flinch.update(dt, 0);
      const kick = h.kick.update(dt, 0);
      const tn = h.taunt;
      const jab = Math.max(0, Math.sin(t * 7)) * 0.18;
      const shoutLean = tn * (0.1 + jab * 0.5);
      // A blade's swing turns the shoulders after it and bends the survivor into the cut.
      // Home Run coils the shoulders away from the aim, then unwinds them past it.
      const coil = hr >= 0 ? 0.95 * hr * hr * (3 - 2 * hr) : hs >= 0 ? (0.95 - 2.2 * homeSnap(hs)) * (1 - homeBack(hs)) : 0;
      const twist = leg ? h.bp[4] * 0.3 * (h.dual ? 0.5 : 1) : coil, bow = leg ? lunge * 0.9 + low * 0.35 - (raised ? 0.75 * artU : 0) + (chop ? 0.3 : 0) : low * 0.3;
      h.torso.rotation.set(0, -(ay2 - Math.sin(ph) * 0.1 * walk) + twist, -cr * 0.2 + flinch * 0.6 + kick * 0.15 - shoutLean - lp * 0.25 - h.sprint * 0.12 - bow);
      h.head.rotation.set(0, -wrapAngle(aim - ay2) * 0.6, -flinch * 0.5 + 0.05 * Math.sin(2 * ph) * walk + cr * 0.35 + (alive ? 0 : 0.3));
      if (h.tail) {
        const goal = -0.35 * Math.min(speed, 5) / 5 - 0.12 * Math.abs(Math.sin(2 * ph)) * walk;
        h.tail.rotation.z = h.tailS.update(dt, goal - flinch * 0.4);
      }
      h.pack.position.y = (h.packS.update(dt, bob + popY) - bob - popY) * 0.8;

      // The gun where its hold puts it: kicked back by each shot, carried low at a sprint,
      // canted to the side for a reload.
      const hold = holdOf(h.weapon, h.evo);
      const rl = h.reload, sp = h.sprint * (1 - rl);
      if (leg) {
        this.legendPose(h, leg, now, firing, su, after, artU, sp > 0.5 || run > 0.5, dt);
        h.gun.position.set(h.bp[0], h.bp[1], h.bp[2]); h.gun.rotation.set(h.bp[3], h.bp[4], h.bp[5]);
        if (h.dual) { h.gun2.position.set(h.bp2[0], h.bp2[1], h.bp2[2]); h.gun2.rotation.set(h.bp2[3], h.bp2[4], h.bp2[5]); h.gun2.updateMatrix(); }
      } else if (h.weapon === 6 && hr >= 0) {
        // Home Run wound back: the bar laid over the shoulder, its head hanging out behind,
        // shaking once it is all the way back.
        const e = hr * hr * (3 - 2 * hr), shake = hr > 0.7 ? Math.sin(now * 0.11) * 0.05 : 0;
        const q = HOME_REST.map((r, j) => r + (HOME_WOUND[j] - r) * e);
        h.gun.position.set(hold.at[0] + q[0], hold.at[1] + q[1], hold.at[2] + q[2]);
        h.gun.rotation.set(q[3], q[4], q[5] + shake);
      } else if (h.weapon === 6 && hs >= 0) {
        // The swing: round and level in three frames, held out flat where it finished, then
        // eased back to the shoulder.
        const s = homeSnap(hs), b = homeBack(hs);
        const q = HOME_WOUND.map((wv, j) => { const th = wv + (HOME_THROUGH[j] - wv) * s; return th + (HOME_REST[j] - th) * b; });
        h.gun.position.set(hold.at[0] + q[0], hold.at[1] + q[1], hold.at[2] + q[2]);
        h.gun.rotation.set(q[3], q[4], q[5]);
      } else if (h.weapon === 6) {
        // The crowbar is held up at the right shoulder, ready, tipped out a little; each swing
        // chops it down and across in front, fast, then lifts it back.
        const u = (now - h.shotAt) / 420;
        const sw = u < 0 || u >= 1 ? 0 : u < 0.25 ? Math.sin((u / 0.25) * Math.PI / 2) : 1 - (u - 0.25) / 0.75;
        h.gun.position.set(hold.at[0] + sw * 0.18 - sp * 0.04, hold.at[1] - sw * 0.06 - sp * 0.06, hold.at[2] + sw * 0.22);
        h.gun.rotation.set(-0.35 + sw * 0.75, -sw * 0.5, 1.4 - sw * 2.2 + sp * 0.3);
      } else if (h.dual) {
        // One in each hand, held out apart, each kicking when it fires.
        const k1 = h.alt ? kick * 0.3 : kick, k2 = h.alt ? kick : kick * 0.3;
        h.gun.position.set(hold.at[0] - k1 * 0.25 - sp * 0.06, hold.at[1] - sp * 0.1 - rl * 0.06, -0.17 + sp * 0.05);
        h.gun.rotation.set(rl * 0.7, sp * 0.35 + 0.08, k1 * 0.6 - sp * 0.55 - rl * 0.3);
        h.gun2.position.set(hold.at[0] - k2 * 0.25 - sp * 0.06, hold.at[1] - sp * 0.1 - rl * 0.06, 0.17 - sp * 0.05);
        h.gun2.rotation.set(-rl * 0.7, -sp * 0.35 - 0.08, k2 * 0.6 - sp * 0.55 - rl * 0.3);
        h.gun2.updateMatrix();
      } else {
        h.gun.position.set(hold.at[0] - kick * 0.25 - sp * 0.06, hold.at[1] - sp * 0.1 - rl * 0.06, hold.at[2] + sp * 0.05);
        h.gun.rotation.set(rl * 0.7, sp * 0.35, kick * 0.6 - sp * 0.55 - rl * 0.3);
      }
      h.gun.updateMatrix();
      // A legendary has no muzzle: its flash is the glint at the point, as Flash Draw is about to
      // cut, as Skyfall comes down and as Worldsplitter's blade is about to.
      h.flash.visible = leg ? (drawing && artU > 0.45 && Math.floor(now / 60) % 2 === 0) || (sky && artU > 0.7) || (raised && artU > 0.5 && Math.floor(now / 50) % 2 === 0)
        : h.weapon !== 6 && !(h.weapon === RIFLE && h.evo) && now - h.shotAt < (h.weapon === 1 ? 70 : 45);
      if (h.spin) h.spin.rotation.x += dt * (firing ? 40 : 0);

      // Hands: on the gun, unless kneeling, taunting or down.
      TR.set(...hold.grip).applyMatrix4(h.gun.matrix);
      if (h.dual) TL.set(...hold.grip).applyMatrix4(h.gun2.matrix);
      else TL.set(...hold.fore).applyMatrix4(h.gun.matrix);
      if (rl > 0.01 && !h.dual && !leg) {
        // The off hand to the magazine, down to the belt for a fresh one, and back.
        const u = (t * 1.3) % 1;
        const belt = V.set(0.06, 0.02, 0.2);
        const mag = MAG.set(0.12, -0.12, 0).applyMatrix4(h.gun.matrix);
        const k = u < 0.35 ? 0 : u < 0.6 ? (u - 0.35) / 0.25 : u < 0.8 ? 1 : 1 - (u - 0.8) / 0.2;
        TL.lerp(mag.lerp(belt, k), rl);
      }
      if (cr > 0.01) {
        const rum = reviving ? Math.max(0, Math.sin(t * 12)) * 0.07 : Math.sin(t * 13) * 0.08;
        const rx = reviving ? 0.42 : 0.4, ry = reviving ? -0.33 + rum : -0.38;
        TR.lerp(V.set(rx, ry - (reviving ? 0 : rum), reviving ? -0.03 : -0.13), cr);
        TL.lerp(V.set(rx, ry + (reviving ? 0 : rum), reviving ? 0.03 : 0.13), cr);
      }
      if (tn > 0.01) {
        TR.lerp(V.set(0.14, 0.86 + jab * 0.3, -0.32), tn);
        TL.lerp(V.set(0.22, 0.04, 0.28), tn);
      }
      if (dn > 0.01) {
        TR.lerp(V.set(0.16, 0.3, -0.06), dn);
        TL.lerp(V.set(0.42 + Math.sin(t * 1.3) * 0.04, 0.32 + Math.sin(t * 2.1) * 0.05, 0.22), dn);
      }
      ik2(h.armR.upper, h.armR.lower, UPPER, FORE, TR, PR);
      ik2(h.armL.upper, h.armL.lower, UPPER, FORE, TL, PL);
      h.gun.visible = cr < 0.5 && tn < 0.5 && dn < 0.5;
      h.gun2.visible = h.dual && h.gun.visible;
      h.finger.visible = tn >= 0.5;
      h.hand.visible = tn < 0.5;

      // The shout bubble faces the camera.
      h.shout.visible = tn > 0.05;
      if (h.shout.visible) {
        h.shout.position.set(0, 1.95 + Math.sin(t * 6) * 0.04, 0);
        h.shout.quaternion.copy(this.q);
        h.shout.scale.setScalar(0.6 + tn * 0.5 + jab * 0.5);
      }
      // Night vision goggles, worn at night.
      h.goggles.visible = p.goggles && !!game.welcome?.dark;
      h.stars.visible = alive && p.stunned && !held && !air;
      if (h.stars.visible) {
        h.stars.position.set(0, 1.75 + Math.sin(t * 7) * 0.04, 0);
        h.stars.rotation.set(0, t * 5, 0);
      }
      // Downed: just a small flat ring on the ground; the HUD label draws the cross, countdown
      // and revive progress above them, so nothing 3D floats up into it.
      const down = !alive && (p.flags & 1) !== 0;
      h.marker.visible = down; h.cross.visible = false; h.progress.visible = false;
      if (down) {
        const s = 1 + 0.06 * Math.sin(t * 5);
        h.marker.scale.set(s, 1, s);
      }
    }
    for (const [id, h] of this.heroes) if (h.seen !== serial) { this.group.remove(h.group); this.heroes.delete(id); }
  }
}

// The player's colour as a survivor wears it: muted and worn, to sit in the picture's palette.
export function garment(id: number): number {
  return wear(playerColor(id));
}

// Where the face is, in the hero's units (and the portraits'): the front of the face, the eyes'
// height and how far apart, the brows and the mouth. The head turns on the neck at NECK.
export const NECK = J_NECK * K;
export const FACE = { x: 0.097 * HEAD * K, eyeY: hy(1.672) * K, eyeZ: 0.034 * HEAD * K, browY: hy(1.692) * K, mouthY: hy(1.6) * K, cheekY: hy(1.635) * K };
// Head parts built at true size, made big about the neck.
function bigHead(ps: Part[]): Part[] {
  for (const p of ps) { p.geo.translate(0, -J_NECK, 0); p.geo.scale(HEAD, HEAD, HEAD); p.geo.translate(0, J_NECK, 0); }
  return ps;
}

// Night vision goggles: a strap round the head, a mount on the brow and twin tubes over the
// eyes, and their green lenses. The portraits wear them too.
export const LENSES: Part[] = toScale(bigHead([part(box(0.01, 0.034, 0.034), 0x8cff6a, 0.177, 1.675, 0.036), part(box(0.01, 0.034, 0.034), 0x8cff6a, 0.177, 1.675, -0.036)]));
export const GOGGLES: Part[] = toScale(bigHead([
  part(taper(0.205, 0.175, 0.2, 0.17, 0.03), 0x1c1e1a, -0.008, 1.715),
  part(box(0.04, 0.03, 0.05), 0x2c302a, 0.1, 1.72),
  part(box(0.04, 0.06, 0.13), 0x2c302a, 0.12, 1.69),
  part(box(0.05, 0.045, 0.045), 0x22251f, 0.15, 1.675, 0.036),
  part(box(0.05, 0.045, 0.045), 0x22251f, 0.15, 1.675, -0.036),
]));

type Pair = [Part[], Part[]];
// A figure in pieces, by the joint each hangs from: torso, hips, head (with the hair that
// swings as tail and, for the portraits, the eyes that blink and the mouth that shouts), the
// pack that bounces on the torso, and each limb's pieces, [+z side, -z side]. The hands are
// apart from their forearms so the taunt can swap one for a finger.
export interface Figure {
  torso: Part[]; hips: Part[]; head: Part[]; tail: Part[]; pack: Part[]; eyes: Part[]; mouth: Part[];
  upper: Pair; fore: Pair; hand: Pair; thigh: Pair; shin: Pair;
}

// A survivor dressed: a body of tapered blocks with real proportions (7 heads, shoulders two
// heads wide, hands and boots a little big), the archetype's clothes and kit over it, the
// player's colour on the biggest garment, and a face with a brow, nose and ears under hair or a
// hat. Built in metres standing, scaled to the hero's units.
export function figure(L: Look, c: number): Figure {
  const A = L.arch, skin = L.skin, hair = L.hair;
  const fem = L.body === Body.Fem, masc = L.body === Body.Masc;
  const F: Figure = { torso: [], hips: [], head: [], tail: [], pack: [], eyes: [], mouth: [], upper: [[], []], fore: [[], []], hand: [[], []], thigh: [[], []], shin: [[], []] };
  const k = new Kit();

  // The body's measures: half the chest's width, half the hips', the chest's depth.
  const cw = masc ? 0.18 : fem ? 0.161 : 0.17, hw = masc ? 0.156 : fem ? 0.168 : 0.16, cd = masc ? 0.25 : fem ? 0.228 : 0.24;
  const az = armZ(L.body), lz = legZ(L.body);
  // The torso is stacked: belly from the waist to the chest, chest to the shoulders, and the
  // slope of the shoulders up to the neck. fx(y) is its front's x at a height, sw(y) its side's z.
  const lerp = (a: number, b: number, u: number) => a + (b - a) * Math.min(1, Math.max(0, u));
  const fx = (y: number) => (y < 1.24 ? lerp(0.195, cd * 0.96, (y - 0.97) / 0.27) : y < 1.44 ? lerp(cd * 0.96, cd * 0.84, (y - 1.24) / 0.2) : lerp(cd * 0.84, 0.12, (y - 1.44) / 0.085)) / 2;
  const sw = (y: number) => (y < 1.24 ? lerp(hw * 0.94, cw * 0.94, (y - 0.97) / 0.27) : lerp(cw * 0.94, cw, (y - 1.24) / 0.2));

  const over = A.over, oc = over ? A.overColor ?? c : c;
  const shirt = A.shirtColor ?? c;
  // What shows where: the chest and belly, the sleeves, the trousers.
  const jacket = over === 'jacket';
  const chestC = jacket ? oc : shirt, bellyC = jacket || over === 'overalls' ? oc : shirt, sleeveC = jacket ? oc : shirt;
  const legs = A.legs ?? (over === 'overalls' ? oc : darker(c, 0.88));
  const handC = A.gloves ?? skin;

  // The torso.
  k.to = F.torso;
  k.t(0.195, 2 * hw * 0.94, cd * 0.96, 2 * cw * 0.94, 0.27, bellyC, 0, 0.97);
  k.t(cd * 0.96, 2 * cw * 0.94, cd * 0.84, 2 * cw, 0.2, chestC, 0, 1.24);
  k.t(cd * 0.84, 2 * cw, 0.12, 0.13, 0.085, chestC, -0.01, 1.44);
  if (fem) k.b(0.05, 0.09, 2 * cw * 0.78, chestC, fx(1.33) + 0.004, 1.34);
  const front = (y: number, d = 0) => fx(y) + d;

  // The shirt at the neck, and its pockets where nothing covers them.
  const chestBare = !over;
  switch (A.shirt) {
    case 'collar':
      k.t(0.135, 0.14, 0.125, 0.125, 0.04, lighter(shirt, 0.08), 0.0, 1.49);
      k.b(0.03, 0.04, 0.045, lighter(shirt, 0.12), front(1.47, 0.008), 1.478, 0.034, 0.5);
      k.b(0.03, 0.04, 0.045, lighter(shirt, 0.12), front(1.47, 0.008), 1.478, -0.034, -0.5);
      if (chestBare) for (const z of [0.07, -0.07]) {
        k.b(0.014, 0.07, 0.065, darker(shirt, 0.8), front(1.34, 0.004), 1.34, z);
        k.b(0.02, 0.018, 0.07, darker(shirt, 0.62), front(1.37, 0.007), 1.375, z);
      }
      if (chestBare) k.b(0.012, 0.42, 0.014, darker(shirt, 0.74), front(1.24, 0.003), 1.22);
      break;
    case 'tee':
      k.t(0.13, 0.135, 0.12, 0.125, 0.03, darker(shirt, 0.72), 0.0, 1.5);
      break;
    case 'vneck':
      k.b(0.012, 0.06, 0.05, skin, front(1.47, 0.003), 1.465, 0, 0, 0, 0.2);
      k.b(0.014, 0.012, 0.07, darker(shirt, 0.7), front(1.44, 0.004), 1.44);
      k.b(0.014, 0.07, 0.06, darker(shirt, 0.78), front(1.32, 0.004), 1.34, 0.07);
      break;
    case 'hoodie':
      // The hood bunched behind the neck, its strings, the pouch pocket, a ribbed hem.
      k.t(0.13, 0.22, 0.11, 0.19, 0.09, darker(shirt, 0.82), -0.075, 1.44);
      k.b(0.008, 0.11, 0.008, PAL.medWhite, front(1.42, 0.004), 1.4, 0.03); k.b(0.008, 0.09, 0.008, PAL.medWhite, front(1.42, 0.004), 1.41, -0.03);
      k.b(0.02, 0.1, 0.18, darker(shirt, 0.82), front(1.07, 0.008), 1.07);
      k.t(0.205, 2 * hw * 0.96, 0.205, 2 * hw * 0.96, 0.04, darker(shirt, 0.72), 0, 0.96);
      break;
  }

  // Over the shirt.
  switch (over) {
    case 'overalls': {
      // A bib with its pocket, straps over the shoulders crossing behind, brass buckles.
      k.b(0.024, 0.2, 0.2, oc, front(1.28, 0.006), 1.28);
      k.b(0.012, 0.07, 0.09, darker(oc, 0.72), front(1.3, 0.02), 1.31);
      for (const z of [0.075, -0.075]) {
        k.seg([front(1.37, 0.008), 1.37, z], [0.0, 1.53, z * 1.25], 0.022, 0.04, oc);
        k.seg([0.0, 1.53, z * 1.25], [-front(1.24, 0.008), 1.2, -z * 0.5], 0.022, 0.04, oc);
        k.b(0.016, 0.03, 0.03, 0xa08a4a, front(1.37, 0.018), 1.37, z);
      }
      k.b(0.008, 0.2, 0.012, darker(oc, 0.6), front(1.1, 0.002), 1.1, 0.12);
      break;
    }
    case 'jacket': {
      // Open down the front: the shirt in the gap, the plaid lining along both edges, lapels
      // standing proud, a turned-up collar, a hem below the belt and two flapped pockets.
      for (const [y0, y1] of [[0.92, 1.24], [1.24, 1.46]]) {
        k.seg([front(y0, 0.003), y0, 0], [front(y1, 0.003), y1, 0], 0.012, 0.07, shirt);
        for (const z of [0.042, -0.042]) k.seg([front(y0, 0.008), y0, z], [front(y1, 0.008), y1, z], 0.016, 0.018, A.lining ?? darker(oc, 0.6));
        for (const z of [0.07, -0.07]) k.seg([front(y0, 0.014), y0, z], [front(y1, 0.014), y1, z * (y1 > 1.3 ? 1.2 : 1)], 0.028, 0.04, lighter(oc, 0.06));
      }
      k.b(0.006, 0.3, 0.004, darker(A.lining ?? oc, 0.5), front(1.2, 0.017), 1.2, 0.042);
      k.t(0.18, 0.2, 0.17, 0.19, 0.075, darker(oc, 0.82), -0.015, 1.455);
      k.t(0.215, 2 * hw + 0.03, 0.2, 2 * hw * 0.96 + 0.025, 0.13, oc, 0, 0.88);
      for (const z of [0.09, -0.09]) k.b(0.022, 0.025, 0.08, darker(oc, 0.68), front(1.0, 0.02), 1.0, z);
      break;
    }
    case 'vest': case 'hivis': {
      // A vest over the shirt: a shell over belly and chest, open at the front, the shirt's
      // shoulders and sleeves showing. Hi-vis has its pale bands round and over the shoulders.
      const g = 0.016;
      k.t(0.195 + g * 2, 2 * hw * 0.94 + g * 2, cd * 0.96 + g * 2, 2 * cw * 0.94 + g * 2, 0.27, oc, 0, 0.95);
      k.t(cd * 0.96 + g * 2, 2 * cw * 0.94 + g * 2, cd * 0.84 + g * 2, 2 * cw * 0.9, 0.18, oc, 0, 1.22);
      for (const [y0, y1] of [[0.96, 1.24], [1.24, 1.4]]) k.seg([front(y0, g + 0.004), y0, 0], [front(y1, g + 0.004), y1, 0], 0.012, over === 'hivis' ? 0.045 : 0.08, shirt);
      for (const z of [0.085, -0.085]) {
        k.seg([front(1.38, g), 1.38, z], [0.0, 1.5, z * 0.95], 0.03, 0.05, oc);
        k.seg([0.0, 1.5, z * 0.95], [-front(1.38, g), 1.38, z], 0.03, 0.05, oc);
      }
      if (over === 'hivis') {
        const band = PAL.hiVisBand;
        for (const y of [1.04, 1.16]) { const dx = 2 * fx(y) + g * 2 + 0.012, dz = 2 * sw(y) + g * 2 + 0.012; k.t(dx, dz, dx, dz, 0.03, band, 0, y); }
        for (const z of [0.085, -0.085]) k.seg([front(1.24, g + 0.008), 1.24, z], [front(1.42, g + 0.008), 1.42, z], 0.012, 0.025, band);
        k.b(0.012, 0.06, 0.06, darker(oc, 0.72), front(1.3, g + 0.006), 1.3, -0.08);
      } else {
        for (const z of [0.07, -0.07]) k.seg([front(1.3, g + 0.01), 1.3, z], [front(1.44, g + 0.01), 1.46, z * 1.3], 0.02, 0.04, lighter(oc, 0.08));
        k.b(0.014, 0.03, 0.03, PAL.steelLit, front(1.15, g + 0.006), 1.15, 0.06);
      }
      break;
    }
    case 'carrier': {
      // A plate carrier: front and back plates, a cummerbund, shoulder straps, three magazine
      // pouches and a radio pouch, all webbing and stood off the body so they get their lines.
      const wc = darker(oc, 0.86);
      k.b(0.055, 0.3, 0.27, oc, front(1.3, 0.025), 1.29);
      k.b(0.05, 0.32, 0.27, oc, -front(1.3, 0.022), 1.29);
      k.t(0.195 + 0.04, 2 * sw(1.06) + 0.035, cd * 0.96 + 0.04, 2 * sw(1.2) + 0.035, 0.14, wc, 0, 1.06);
      for (const z of [0.09, -0.09]) k.seg([front(1.44, 0.02), 1.44, z], [-front(1.44, 0.02), 1.44, z], 0.035, 0.05, wc);
      for (const z of [-0.08, 0, 0.08]) {
        k.b(0.045, 0.1, 0.07, wc, front(1.2, 0.07), 1.17, z);
        k.b(0.05, 0.03, 0.072, darker(oc, 0.7), front(1.2, 0.072), 1.215, z);
      }
      k.b(0.04, 0.12, 0.05, wc, 0.0, 1.22, sw(1.2) + 0.04); k.b(0.02, 0.1, 0.012, PAL.ink, 0.0, 1.34, sw(1.2) + 0.04);
      k.b(0.02, 0.05, 0.08, darker(oc, 0.7), front(1.38, 0.055), 1.38);
      break;
    }
  }

  // At the neck.
  switch (A.neck) {
    case 'scarf': {
      const n = A.neckColor ?? PAL.khaki;
      k.t(0.175, 0.2, 0.15, 0.17, 0.065, n, -0.005, 1.47);
      k.b(0.024, 0.16, 0.055, darker(n, 0.85), front(1.36, 0.03), 1.37, 0.045, 0.1);
      break;
    }
    case 'stethoscope':
      for (const z of [0.05, -0.05]) k.seg([0.02, 1.51, z * 1.3], [front(1.34, 0.008), 1.32, z], 0.012, 0.012, 0x2a2a2e);
      k.b(0.016, 0.026, 0.026, PAL.steelLit, front(1.31, 0.012), 1.3, 0.05);
      k.seg([0.04, 1.51, -0.055], [front(1.3, 0.006), 1.27, -0.035], 0.006, 0.012, PAL.medWhite);
      k.b(0.008, 0.06, 0.045, PAL.medWhite, front(1.23, 0.008), 1.23, -0.035);
      break;
    case 'tie': {
      const n = A.neckColor ?? 0x6a2626;
      k.b(0.02, 0.025, 0.03, darker(n, 0.8), front(1.48, 0.008), 1.475);
      k.seg([front(1.46, 0.008), 1.46, 0], [front(1.24, 0.008), 1.24, 0], 0.012, 0.04, n);
      k.seg([front(1.24, 0.008), 1.24, 0], [front(1.1, 0.008), 1.1, 0], 0.012, 0.05, n);
      break;
    }
    case 'bandana': {
      const n = A.neckColor ?? 0x8a3424;
      k.t(0.16, 0.17, 0.145, 0.15, 0.04, n, 0, 1.47);
      k.b(0.02, 0.06, 0.06, n, front(1.43, 0.012), 1.43, 0, Math.PI / 4);
      break;
    }
  }

  // Straps of whatever is on the back, over the shoulders and down the chest.
  const packStrap = (col: number) => {
    for (const z of [0.09, -0.09]) {
      k.seg([-0.1, 1.42, z], [0.02, 1.53, z * 1.05], 0.022, 0.045, col);
      k.seg([0.02, 1.53, z * 1.05], [front(1.36, 0.016), 1.36, z * 1.05], 0.022, 0.045, col);
      k.seg([front(1.36, 0.016), 1.36, z * 1.05], [front(1.18, 0.012), 1.16, z * 1.3], 0.022, 0.04, col);
    }
    k.b(0.016, 0.025, 0.2, col, front(1.3, 0.024), 1.3);
  };

  // What is carried, bouncing on the back (the pack group); the straps stay on the torso.
  const bc = A.back === 'none' ? 0 : A.backColor, bd = darker(bc, 0.78);
  const back = -fx(1.25);
  switch (A.back) {
    case 'daypack':
      packStrap(darker(bc, 0.6));
      k.to = F.pack;
      k.t(0.11, 0.25, 0.1, 0.23, 0.32, bc, back - 0.06, 1.1); k.b(0.06, 0.05, 0.24, bd, back - 0.07, 1.43);
      k.b(0.045, 0.13, 0.18, bd, back - 0.13, 1.2); k.b(0.05, 0.025, 0.19, darker(bc, 0.6), back - 0.13, 1.28);
      break;
    case 'rucksack':
      packStrap(darker(bc, 0.6));
      k.to = F.pack;
      k.t(0.18, 0.31, 0.15, 0.29, 0.4, bc, back - 0.095, 1.06); k.t(0.17, 0.3, 0.14, 0.26, 0.06, bd, back - 0.1, 1.46);
      for (const z of [0.175, -0.175]) k.b(0.11, 0.17, 0.045, bd, back - 0.1, 1.17, z);
      k.b(0.04, 0.16, 0.2, bd, back - 0.2, 1.17); k.b(0.045, 0.035, 0.21, darker(bc, 0.55), back - 0.2, 1.24);
      k.to.push(part(cyl(0.065, 0.065, 0.38, 6), PAL.oliveDark, back - 0.09, 1.585, 0, Math.PI / 2));
      for (const z of [0.11, -0.11]) k.b(0.14, 0.14, 0.02, PAL.leatherDark, back - 0.09, 1.585, z);
      break;
    case 'bigpack':
      packStrap(darker(bc, 0.55));
      k.to = F.pack;
      k.t(0.2, 0.33, 0.18, 0.31, 0.56, bc, back - 0.105, 1.0); k.t(0.2, 0.32, 0.16, 0.27, 0.085, bd, back - 0.115, 1.55);
      for (const z of [0.18, -0.18]) k.b(0.12, 0.2, 0.045, bd, back - 0.1, 1.15, z);
      k.b(0.045, 0.24, 0.24, bd, back - 0.22, 1.24); for (const y of [1.18, 1.32]) k.b(0.05, 0.022, 0.25, darker(bc, 0.55), back - 0.22, y);
      k.to.push(part(cyl(0.08, 0.08, 0.42, 6), 0x5e6650, back - 0.11, 0.93, 0, Math.PI / 2));
      for (const z of [0.12, -0.12]) k.b(0.17, 0.17, 0.02, PAL.leatherDark, back - 0.11, 0.93, z);
      break;
    case 'assault':
      packStrap(darker(bc, 0.8));
      k.to = F.pack;
      k.t(0.15, 0.28, 0.14, 0.27, 0.36, bc, back - 0.11, 1.1);
      for (const y of [1.18, 1.26, 1.34]) k.b(0.16, 0.014, 0.285, darker(bc, 0.7), back - 0.11, y);
      k.b(0.045, 0.14, 0.16, darker(bc, 0.85), back - 0.2, 1.22);
      k.to.push(part(cyl(0.055, 0.055, 0.32, 6), PAL.olive, back - 0.1, 1.5, 0, Math.PI / 2));
      break;
    case 'satchel':
      // A leather satchel at the hip, its strap across the chest from the other shoulder.
      for (const [a, b] of [[[0.0, 1.53, -0.11], [front(1.3, 0.012), 1.3, -0.02]], [[front(1.3, 0.012), 1.3, -0.02], [front(1.02, 0.012), 1.02, 0.15]],
        [[0.0, 1.53, -0.11], [-front(1.24, 0.012), 1.24, 0.0]], [[-front(1.24, 0.012), 1.24, 0.0], [-0.07, 1.0, 0.16]]] as [number, number, number][][])
        k.seg(a, b, 0.014, 0.04, darker(bc, 0.7));
      k.to = F.pack;
      k.b(0.24, 0.2, 0.065, bc, 0.0, 0.93, hw + 0.06); k.b(0.24, 0.1, 0.07, darker(bc, 0.8), 0.0, 0.99, hw + 0.062);
      k.b(0.03, 0.03, 0.074, PAL.steelLit, 0.05, 0.95, hw + 0.062);
      break;
  }

  // The belt and what hangs from it, and the seat of the trousers (hips).
  k.to = F.hips;
  k.t(0.19, 2 * hw * 0.92, 0.205, 2 * hw, 0.17, legs, 0, 0.83);
  for (const z of [0.065, -0.065]) k.b(0.012, 0.07, 0.06, darker(legs, 0.8), -0.104, 0.92, z);
  const beltH = A.belt === 'thin' ? 0.03 : A.belt === 'medic' ? 0.05 : 0.042, beltC = A.beltColor;
  if (over !== 'jacket') {
    k.t(0.212, 2 * hw + 0.014, 0.212, 2 * hw + 0.014, beltH, beltC, 0, 0.975);
    k.b(0.012, beltH * 0.9, 0.045, A.belt === 'medic' ? PAL.ink : 0x9a8a5a, 0.11, 0.975 + beltH / 2);
  }
  const pouch = (x: number, y: number, z: number, w: number, h: number, d: number, col: number) => {
    k.b(d, h, w, col, x, y, z); k.b(d + 0.006, h * 0.3, w + 0.004, darker(col, 0.72), x, y + h * 0.36, z);
  };
  switch (A.belt) {
    case 'medic': {
      // Webbing pouches front and side; a red medkit bag on the hip, a white cross on it.
      const wc = darker(PAL.webbing, 0.9);
      pouch(0.13, 0.95, 0.09, 0.065, 0.085, 0.045, wc); pouch(0.13, 0.95, -0.09, 0.065, 0.085, 0.045, wc);
      pouch(-0.04, 0.95, -hw - 0.025, 0.045, 0.09, 0.08, wc);
      k.b(0.2, 0.15, 0.085, PAL.medRed, -0.01, 0.86, hw + 0.06); k.b(0.21, 0.03, 0.09, darker(PAL.medRed, 0.7), -0.01, 0.93, hw + 0.062);
      k.b(0.07, 0.022, 0.01, PAL.medWhite, -0.01, 0.855, hw + 0.105); k.b(0.022, 0.07, 0.01, PAL.medWhite, -0.01, 0.855, hw + 0.105);
      k.b(0.03, 0.06, 0.02, PAL.ink, -0.01, 0.95, hw + 0.03);
      break;
    }
    case 'tools':
      // A tool belt: leather pouches on both hips, a hammer's handle and a wrench hanging.
      pouch(0.03, 0.9, hw + 0.035, 0.06, 0.13, 0.12, PAL.leatherRed); pouch(0.03, 0.9, -hw - 0.035, 0.06, 0.13, 0.12, PAL.leatherRed);
      k.b(0.02, 0.15, 0.02, PAL.wood, 0.07, 1.0, hw + 0.03, 0, 0, 0.2); k.b(0.07, 0.025, 0.025, PAL.steel, 0.085, 1.07, hw + 0.03);
      k.b(0.025, 0.22, 0.012, PAL.steelLit, -0.06, 0.86, -hw - 0.02, 0, 0, -0.1); k.b(0.05, 0.05, 0.014, PAL.steelLit, -0.05, 0.75, -hw - 0.02);
      break;
    case 'hunter':
      // A knife in its sheath and a cartridge pouch.
      k.b(0.04, 0.17, 0.025, PAL.leatherDark, -0.04, 0.88, hw + 0.02); k.b(0.03, 0.06, 0.03, PAL.woodDark, -0.04, 0.99, hw + 0.02);
      pouch(0.13, 0.95, -0.09, 0.07, 0.07, 0.045, PAL.leatherRed);
      break;
    case 'chain':
      for (let i = 0; i < 5; i++) { const u = i / 4; k.b(0.03, 0.012, 0.012, PAL.steelLit, 0.06 - u * 0.15, 0.93 - Math.sin(u * Math.PI) * 0.07, -hw - 0.012); }
      k.b(0.025, 0.04, 0.05, PAL.steelLit, 0.11, 0.997);
      break;
    case 'fanny':
      k.b(0.06, 0.075, 0.17, beltC, 0.125, 0.97); k.b(0.064, 0.015, 0.172, darker(beltC, 0.7), 0.125, 1.0);
      break;
    case 'plain':
      if (over === 'carrier') { pouch(-0.02, 0.94, hw + 0.03, 0.05, 0.09, 0.08, darker(oc, 0.86)); pouch(-0.02, 0.94, -hw - 0.03, 0.05, 0.09, 0.08, darker(oc, 0.86)); }
      break;
  }

  // Legs: thigh from the hip, shin, knee pad and boot from the knee.
  [lz, -lz].forEach((z, i) => {
    const s = Math.sign(z);
    k.to = F.thigh[i];
    k.c(0.068, 0.092, 0.5, legs, 0, 0.47, z);
    if (A.cargo) { k.b(0.085, 0.11, 0.03, darker(legs, 0.84), 0.0, 0.67, z + s * 0.068); k.b(0.09, 0.025, 0.034, darker(legs, 0.66), 0.0, 0.725, z + s * 0.069); }
    if (over === 'overalls' && i === 1) k.b(0.03, 0.14, 0.012, darker(legs, 0.6), 0.02, 0.72, z - 0.07);
    k.to = F.shin[i];
    const tuck = A.shoes === 'wellie' ? 0.37 : over === 'carrier' ? 0.17 : 0.12;
    k.c(0.06, 0.068, 0.5 - tuck, legs, 0, tuck, z);
    if (A.shoes !== 'wellie' && over !== 'carrier') k.c(0.072, 0.068, 0.06, darker(legs, 0.84), 0, 0.12, z);
    if (A.knees !== undefined) {
      k.b(0.05, 0.11, 0.11, A.knees, 0.066, 0.47, z);
      k.b(0.135, 0.018, 0.135, darker(A.knees, 0.7), 0.0, 0.44, z);
    }
    const sc = A.shoeColor, sole = A.sole;
    switch (A.shoes) {
      case 'boot':
        k.c(0.068, 0.066, 0.13, sc, 0, 0.06, z);
        k.c(0.072, 0.072, 0.03, darker(sc, 0.72), 0, 0.17, z);
        k.t(0.28, 0.12, 0.21, 0.104, 0.085, sc, 0.05, 0.026, z, 0.01);
        k.b(0.1, 0.014, 0.044, lighter(sc, 0.12), 0.1, 0.108, z, 0, 0, -0.35);
        k.b(0.3, 0.028, 0.128, sole, 0.05, 0.014, z);
        break;
      case 'sneaker':
        k.c(0.05, 0.05, 0.05, PAL.medWhite, 0, 0.08, z);
        k.t(0.27, 0.11, 0.21, 0.1, 0.065, sc, 0.045, 0.035, z, 0.01);
        k.b(0.09, 0.012, 0.034, lighter(sc, 0.3), 0.095, 0.09, z, 0, 0, -0.35);
        k.b(0.285, 0.036, 0.118, sole, 0.045, 0.018, z);
        break;
      case 'shoe':
        k.c(0.05, 0.05, 0.06, PAL.ink, 0, 0.07, z);
        k.t(0.25, 0.095, 0.2, 0.08, 0.055, sc, 0.045, 0.02, z);
        k.b(0.26, 0.02, 0.1, sole, 0.045, 0.01, z);
        break;
      case 'wellie':
        k.c(0.068, 0.068, 0.36, sc, 0, 0.03, z);
        k.c(0.072, 0.072, 0.03, darker(sc, 0.7), 0, 0.37, z);
        k.t(0.26, 0.11, 0.22, 0.1, 0.07, sc, 0.045, 0.02, z);
        k.b(0.275, 0.028, 0.118, sole, 0.045, 0.014, z);
        break;
    }
  });

  // Arms: the shoulder, the sleeve and what shows below it; a hand a little big.
  [az, -az].forEach((z, i) => {
    const s = Math.sign(z);
    k.to = F.upper[i];
    k.ball(0.072, sleeveC, 0, 1.425, z, 1.1);
    if (A.sleeve === 'short') {
      k.c(0.07, 0.072, 0.16, sleeveC, 0, 1.28, z);
      k.c(0.073, 0.073, 0.02, darker(sleeveC, 0.75), 0, 1.28, z);
      k.c(0.052, 0.06, 0.16, skin, 0, 1.15, z);
    } else k.c(0.058, 0.068, 0.3, sleeveC, 0, 1.15, z);
    if (A.sleeveMark) {
      k.b(0.055, 0.055, 0.012, PAL.medWhite, 0, 1.36, z + s * 0.058);
      k.b(0.035, 0.011, 0.014, PAL.medRed, 0, 1.36, z + s * 0.058); k.b(0.011, 0.035, 0.014, PAL.medRed, 0, 1.36, z + s * 0.058);
    }
    if (over === 'carrier' || over === 'hivis' || over === 'vest') k.b(0.03, 0.02, 0.06, darker(sleeveC, 0.8), 0, 1.42, z - s * 0.02);
    k.to = F.fore[i];
    if (A.sleeve === 'long') {
      k.c(0.048, 0.057, 0.24, sleeveC, 0, 0.94, z);
      k.c(0.052, 0.052, 0.03, darker(sleeveC, 0.78), 0, 0.94, z);
    } else {
      k.c(0.042, 0.053, 0.25, skin, 0, 0.93, z);
      if (A.sleeve === 'rolled') k.c(0.063, 0.063, 0.06, lighter(sleeveC, 0.05), 0, 1.1, z);
    }
    k.to = F.hand[i];
    k.b(0.095, 0.11, 0.056, handC, 0.004, 0.873, z);
    k.b(0.032, 0.055, 0.028, handC, 0.053, 0.895, z - s * 0.01);
    if (A.gloves !== undefined) k.c(0.05, 0.05, 0.025, darker(handC, 0.75), 0, 0.92, z);
  });

  // The neck and the head: skull, jaw and chin, ears, a brow over shadowed eyes, a nose, a
  // mouth; the beard and glasses.
  k.to = F.head;
  k.c(0.054, 0.05, 0.14, darker(skin, 0.8), 0, 1.47);
  k.t(0.19, 0.155, 0.18, 0.148, 0.14, skin, -0.012, 1.64);
  k.t(0.18, 0.148, 0.12, 0.1, 0.03, skin, -0.014, 1.78);
  k.t(0.11, 0.09, 0.17, 0.14, 0.09, skin, 0.012, 1.555, 0, 0.0);
  k.b(0.028, 0.03, 0.13, skin, 0.083, 1.7);
  k.b(0.012, 0.024, 0.12, darker(skin, 0.52), 0.088, 1.673);
  k.b(0.03, 0.045, 0.026, lighter(skin, 0.05), 0.103, 1.642);
  for (const z of [0.083, -0.083]) k.b(0.035, 0.05, 0.02, darker(skin, 0.85), -0.012, 1.665, z);
  k.to = F.eyes;
  for (const z of [0.034, -0.034]) k.b(0.008, 0.012, 0.022, 0x1e1812, 0.095, 1.672, z);
  k.to = F.mouth;
  k.b(0.008, 0.012, 0.045, darker(skin, 0.5), 0.093, 1.6);
  k.to = F.head;
  if (L.beard === 1) k.t(0.115, 0.095, 0.172, 0.143, 0.06, blend(skin, hair, 0.4), 0.014, 1.553);
  if (L.beard === 2) { k.t(0.12, 0.1, 0.175, 0.146, 0.075, hair, 0.014, 1.55); k.b(0.02, 0.016, 0.06, hair, 0.1, 1.618); }
  if (L.beard === 3) k.b(0.02, 0.016, 0.06, hair, 0.1, 1.618);
  if (L.glasses) { k.b(0.01, 0.024, 0.11, 0x2a2622, 0.099, 1.673); for (const z of [0.07, -0.07]) k.b(0.12, 0.008, 0.008, 0x2a2622, 0.04, 1.68, z); }

  // Hair, and over it the archetype's hat; under a hat only the back and sides show.
  const hat = L.style === 'headwrap' ? 'none' : A.hat;
  const hc = hat === 'scrubcap' ? darker(c, 0.8) : A.hatColor;
  const top = (th: number, col = hair) => k.t(0.205, 0.168, 0.16, 0.13, 0.085 + th, col, -0.02, 1.725);
  const backHair = (len: number, col = hair) => k.b(0.05, len, 0.165, col, -0.088, 1.775 - len / 2);
  const sides = (len: number) => { for (const z of [0.082, -0.082]) k.b(0.09, len, 0.02, hair, -0.04, 1.76 - len / 2, z); };
  const crown = hat === 'none';
  const buzzC = blend(hair, skin, 0.35);
  switch (L.style) {
    case 'buzz': if (crown) top(-0.01, buzzC); backHair(0.11, buzzC); break;
    case 'cornrows':
      if (crown) { top(-0.01, buzzC); for (const z of [-0.05, 0, 0.05]) k.b(0.19, 0.014, 0.018, hair, -0.02, 1.8, z); }
      backHair(0.11, buzzC); break;
    case 'short': if (crown) top(0.012); backHair(0.12); sides(0.06); break;
    case 'crop': if (crown) { top(0.016); k.b(0.03, 0.03, 0.14, hair, 0.075, 1.745); } backHair(0.11); break;
    case 'sidecut': if (crown) { k.t(0.205, 0.1, 0.16, 0.08, 0.11, hair, -0.02, 1.725, 0.04); k.b(0.06, 0.06, 0.08, hair, 0.065, 1.735, 0.04); } backHair(0.1, buzzC); break;
    case 'curly':
      if (crown) { top(0.025); for (const [x, z] of [[0.03, 0.04], [-0.04, -0.04], [-0.05, 0.05]]) k.b(0.06, 0.04, 0.06, darker(hair, 0.85), x, 1.83, z); }
      backHair(0.14); sides(0.08); break;
    case 'afro': k.t(0.24, 0.24, 0.2, 0.2, 0.2, hair, -0.05, crown ? 1.68 : 1.6); break;
    case 'mohawk': if (crown) { top(-0.012, buzzC); k.b(0.21, 0.075, 0.034, hair, -0.03, 1.83); } backHair(0.1, buzzC); break;
    case 'bun': if (crown) top(0.008); backHair(0.1); k.b(0.075, 0.07, 0.075, hair, -0.09, crown ? 1.8 : 1.72); break;
    case 'ponytail': if (crown) top(0.01); backHair(0.1); k.to = F.tail; k.b(0.045, 0.22, 0.05, hair, -0.125, 1.6); k.b(0.05, 0.02, 0.055, darker(hair, 0.6), -0.12, 1.7); k.to = F.head; break;
    case 'long': if (crown) top(0.015); sides(0.2); backHair(0.12); k.to = F.tail; k.b(0.04, 0.3, 0.17, hair, -0.105, 1.55); k.to = F.head; break;
    case 'locs':
      if (crown) top(0.015); sides(0.16); k.to = F.tail;
      for (const z of [-0.07, -0.025, 0.025, 0.07]) k.b(0.03, 0.27, 0.03, hair, -0.105, 1.56, z);
      k.to = F.head; break;
    case 'braids': if (crown) top(0.01); backHair(0.08); k.to = F.tail; for (const z of [0.05, -0.05]) k.b(0.03, 0.3, 0.03, hair, -0.1, 1.53, z); k.to = F.head; break;
    case 'bob': if (crown) top(0.015); sides(0.15); backHair(0.17); break;
    case 'headwrap': k.t(0.22, 0.18, 0.17, 0.145, 0.13, L.wrap, -0.022, 1.7); k.b(0.07, 0.07, 0.09, darker(L.wrap, 0.75), -0.11, 1.79); break;
  }
  const up = L.style === 'afro' ? 0.06 : L.style === 'curly' ? 0.015 : 0;
  switch (hat) {
    case 'cap':
      k.t(0.215, 0.178, 0.17, 0.148, 0.075, hc, -0.012, 1.725 + up);
      k.b(0.12, 0.016, 0.16, darker(hc, 0.85), 0.14, 1.733 + up, 0, 0, 0, -0.16);
      if (A.hatMark !== undefined) { k.b(0.008, 0.034, 0.011, A.hatMark, 0.09, 1.765 + up); k.b(0.008, 0.011, 0.034, A.hatMark, 0.09, 1.765 + up); }
      break;
    case 'beanie':
      k.t(0.215, 0.178, 0.15, 0.125, 0.11, hc, -0.014, 1.715 + up);
      k.t(0.225, 0.188, 0.222, 0.186, 0.04, darker(hc, 0.8), -0.014, 1.705 + up);
      break;
    case 'hardhat':
      k.t(0.235, 0.2, 0.16, 0.14, 0.1, hc, -0.012, 1.745 + up); k.b(0.3, 0.014, 0.245, hc, -0.004, 1.748 + up);
      k.b(0.06, 0.012, 0.19, hc, 0.165, 1.744 + up); k.b(0.2, 0.022, 0.035, lighter(hc, 0.15), -0.012, 1.85 + up);
      k.t(0.22, 0.19, 0.22, 0.19, 0.012, darker(hc, 0.6), -0.012, 1.73 + up);
      break;
    case 'helmet':
      k.t(0.25, 0.225, 0.17, 0.15, 0.11, hc, -0.016, 1.712 + up); k.t(0.262, 0.236, 0.255, 0.23, 0.025, darker(hc, 0.82), -0.016, 1.705 + up);
      k.b(0.015, 0.035, 0.05, PAL.steelDark, 0.105, 1.76 + up); k.t(0.23, 0.2, 0.2, 0.18, 0.02, PAL.webbing, -0.016, 1.77 + up);
      for (const z of [0.088, -0.088]) k.b(0.012, 0.12, 0.012, PAL.webbing, 0.03, 1.64, z, 0, 0, 0.2);
      break;
    case 'straw':
      k.t(0.19, 0.17, 0.15, 0.14, 0.11, hc, -0.012, 1.745 + up); k.t(0.195, 0.175, 0.19, 0.17, 0.025, darker(hc, 0.5), -0.012, 1.75 + up);
      k.to.push(part(cyl(0.23, 0.24, 0.014, 8), lighter(hc, 0.06), -0.008, 1.755 + up));
      break;
    case 'bandana':
      k.t(0.21, 0.174, 0.16, 0.135, 0.085, hc, -0.014, 1.725 + up); k.b(0.05, 0.045, 0.05, darker(hc, 0.8), -0.115, 1.745);
      for (const z of [0.018, -0.018]) k.b(0.015, 0.08, 0.03, hc, -0.125, 1.69, z, z * 8);
      break;
    case 'scrubcap':
      k.t(0.212, 0.175, 0.17, 0.14, 0.08, hc, -0.016, 1.722 + up); k.b(0.008, 0.02, 0.12, darker(hc, 0.75), 0.083, 1.735 + up);
      break;
  }

  for (const ps of [F.head, F.tail, F.eyes, F.mouth]) bigHead(ps);
  for (const ps of [F.torso, F.hips, F.head, F.tail, F.pack, F.eyes, F.mouth, ...F.upper, ...F.fore, ...F.hand, ...F.thigh, ...F.shin]) toScale(ps);
  return F;
}
