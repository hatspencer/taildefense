import type * as THREE from 'three/webgpu';
import { build, type Dress, fixedColor, piece, type Use } from './figures';
import { CREEPS, SLOTS } from './figures.gen';
import { J, JOINTS } from './rig';

// The creeps as puppets: each model (built in Blender by tools/blender/figures.py) facing +x,
// standing on y = 0, every vertex hung on a joint of the shared skeleton, and per joint how it
// moves; the rest pose is the model's own, so a rest swing is how far a joint holds off it. Angles are radians: z swings a limb
// forward (a hanging limb's foot or hand goes +x; an upright part leans back), x rolls it out
// to the side, y twists it round the vertical.
//
// Triangles painted in these exact colours take a per-instance colour, so a horde is a crowd of
// different people: shirt, trousers, skin (how far gone) and hair.
export const SHIRT = 0xff00ff, PANTS = 0x00ff00, SKIN = 0x00ffff, HAIR = 0xffff00;

type V4 = [number, number, number, number];
// A joint: its pivot, and its motion.
//   walk   [swing, phase offset, roll, rest swing]       swing and roll with the gait
//   flex   [bend, phase offset, twist, idle]             bend: a knee's one-way fold in the gait
//   wind   [z, x, y, scale]                              the pose winding up a blow
//   strike [z, x, y, scale]                              the pose as it lands
//   die    [z, x, y, scale]                              crumpling; also the sleeper's slump
//   misc   [flinch, flail, side, class]                  side: +1 left, -1 right; class: 0 body, 1 arm, 2 leg
export interface JointDef { p: [number, number, number]; walk?: V4; flex?: V4; wind?: V4; strike?: V4; die?: V4; misc?: V4 }

export interface CreepRig {
  model: string;  // its pieces in figures.gen.ts, creep_<model>_<i>
  aspect: number; // how tall it stands for its footprint: its height is its diameter times this
  joints: (JointDef | undefined)[];
  stride: number; // model units travelled per gait cycle (two steps)
  bob: number;    // pelvis rise per step
  drop: number;   // how far the body sinks as the knees give
  turn: number;   // turning rate, per second
  flinch: number; // how hard a hit rocks it
}

// The right-hand twin of a left joint: across the body, the other half of the gait.
function mirror(d: JointDef): JointDef {
  const m = (v: V4 | undefined, f: (v: V4) => V4) => (v ? f(v) : undefined);
  return {
    p: [d.p[0], d.p[1], -d.p[2]],
    walk: m(d.walk, (v) => [v[0], v[1] + Math.PI, -v[2], v[3]]),
    flex: m(d.flex, (v) => [v[0], v[1], -v[2], v[3]]),
    wind: m(d.wind, (v) => [v[0], -v[1], -v[2], v[3]]),
    strike: m(d.strike, (v) => [v[0], -v[1], -v[2], v[3]]),
    die: m(d.die, (v) => [v[0], -v[1], -v[2], v[3]]),
    misc: m(d.misc, (v) => [v[0], v[1], -v[2], v[3]]),
  };
}

// The model's pivots, from Blender, replace the ones in the tables: each side has its own,
// as a model may reach further with one arm.
function rig(model: string, aspect: number, j: Partial<Record<number, JointDef>>, o: Omit<CreepRig, 'model' | 'aspect' | 'joints'>): CreepRig {
  for (const [l, r] of [[J.UARM_L, J.UARM_R], [J.FARM_L, J.FARM_R], [J.THIGH_L, J.THIGH_R], [J.SHIN_L, J.SHIN_R]]) {
    if (j[l] && !j[r]) j[r] = mirror(j[l]!);
  }
  const pv = CREEPS[model as keyof typeof CREEPS] as Record<string, number[] | number>;
  const at: [number, string][] = [[J.CHEST, 'chest'], [J.HEAD, 'head'], [J.UARM_L, 'uarm'], [J.UARM_R, 'uarmR'], [J.FARM_L, 'farm'],
    [J.FARM_R, 'farmR'], [J.THIGH_L, 'thigh'], [J.THIGH_R, 'thighR'], [J.SHIN_L, 'shin'], [J.SHIN_R, 'shinR'], [J.X, 'x'], [J.X2, 'x2']];
  for (const [i, k] of at) {
    const v = pv[k];
    if (j[i] && Array.isArray(v)) j[i]!.p = [v[0], v[1], v[2]];
  }
  const joints: (JointDef | undefined)[] = [];
  for (let i = 0; i < JOINTS; i++) joints.push(j[i]);
  return { model, aspect, joints, ...o };
}

// The kind's body as one geometry for the shader to pose: its pieces from figures.gen.ts,
// clothes, skin and hair in the colours the shader swaps per creep, each vertex's joint chain
// as `rj` and each triangle's tone as `tone`, applied after the swap.
const MAGIC: Partial<Record<string, number>> = { shirt: SHIRT, pants: PANTS, skin: SKIN, hair: HAIR };
const dress: Dress = (code) => (code >= 64 ? fixedColor(code) : MAGIC[SLOTS[code]] ?? 0x808080);
export function creepGeometry(model: string): THREE.BufferGeometry {
  const uses: Use[] = [];
  for (let i = 0; ; i++) {
    const p = piece(`creep_${model}_${i}`);
    if (!p) break;
    uses.push({ p });
  }
  return build(uses, dress, { rj: true, toneAttr: true });
}

// The shuffling dead: hunched, head pushed forward, a torn short-sleeved shirt untucked.
function walker(): CreepRig {
  return rig('walker', 1.95, {
    [J.CHEST]: { p: [0, 0.6, 0], walk: [0, 0, 0.07, -0.16], flex: [0, 0, 0.12, 0.03], wind: [0.4, 0, 0, 0], strike: [-0.55, 0, 0, 0], die: [-0.5, 0, 0.2, 0], misc: [0.35, 0.3, 0, 0] },
    [J.HEAD]: { p: [0.02, 1.07, 0], walk: [0, 1.2, 0.18, -0.12], flex: [0, 0, 0, 0.08], wind: [0.35, 0, 0, 0], strike: [-0.7, 0, 0, 0], die: [-0.5, 0.3, 0, 0], misc: [0.5, 0.4, 0, 0] },
    [J.UARM_L]: { p: [0, 1.0, 0.28], walk: [0.12, 0.5, -0.05, 0.25], flex: [0, 0, 0, 0.06], wind: [1.4, -0.35, 0, 0], strike: [-0.75, 0.1, 0, 0], die: [-1.0, -0.2, 0, 0], misc: [-0.4, 1.4, 1, 1] },
    [J.FARM_L]: { p: [0, 0.77, 0.28], walk: [0.1, 1.0, 0, 0.1], wind: [0.7, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [-0.2, 0, 0, 0], misc: [0, 0.9, 1, 1] },
    [J.THIGH_L]: { p: [0, 0.56, 0.11], walk: [0.42, 0, 0, 0], wind: [-0.2, 0, 0, 0], strike: [0.35, 0, 0, 0], die: [1.35, 0, 0, 0], misc: [0, 0.5, 1, 2] },
    [J.SHIN_L]: { p: [0, 0.29, 0.11], walk: [0, 0, 0, -0.05], flex: [-0.85, Math.PI / 2, 0, 0], strike: [-0.2, 0, 0, 0], die: [-2.1, 0, 0, 0], misc: [0, 0.4, 1, 2] },
  }, { stride: 0.95, bob: 0.03, drop: 0.24, turn: 7, flinch: 1 });
}

// Lunging from the hips with both arms reaching, its shirt hanging open; it sprints, arms
// pumping, coils low and pounces.
function runner(): CreepRig {
  return rig('runner', 2.07, {
    [J.CHEST]: { p: [0, 0.6, 0], walk: [0, 0, 0.05, -0.45], flex: [0, 0, 0.2, 0.02], wind: [-0.3, 0, 0, 0], strike: [0.2, 0, 0, 0], die: [-0.4, 0, 0.3, 0], misc: [0.4, 0.3, 0, 0] },
    [J.HEAD]: { p: [0.02, 1.07, 0], walk: [0.05, 0, 0.05, 0.3], flex: [0, 0, 0, 0.06], wind: [0.25, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [-0.6, -0.3, 0, 0], misc: [0.5, 0.3, 0, 0] },
    [J.UARM_L]: { p: [0, 1.0, 0.26], walk: [0.85, Math.PI, 0, 0.15], wind: [-0.6, -0.3, 0, 0], strike: [2.2, 0.2, 0, 0], die: [-0.6, -0.4, 0, 0], misc: [-0.3, 1.6, 1, 1] },
    [J.FARM_L]: { p: [0, 0.77, 0.26], walk: [0.3, Math.PI + 0.6, 0, 0.3], wind: [0.4, 0, 0, 0], strike: [-1.1, 0, 0, 0], die: [-0.8, 0, 0, 0], misc: [0, 1, 1, 1] },
    [J.THIGH_L]: { p: [0, 0.56, 0.1], walk: [0.75, 0, 0, 0.05], wind: [0.55, 0, 0, 0], strike: [-0.35, 0, 0, 0], die: [1.3, 0, 0, 0], misc: [0, 0.6, 1, 2] },
    [J.SHIN_L]: { p: [0, 0.29, 0.1], walk: [0, 0, 0, -0.1], flex: [-1.5, Math.PI / 2, 0, 0], wind: [-1.0, 0, 0, 0], strike: [0.1, 0, 0, 0], die: [-2.0, 0, 0, 0], misc: [0, 0.4, 1, 2] },
  }, { stride: 1.5, bob: 0.07, drop: 0.24, turn: 10, flinch: 1.1 });
}

// A bald crawler on its knees and hands, its back arched; it hauls itself on, rears and lunges.
function swarmer(): CreepRig {
  return rig('swarmer', 0.6, {
    [J.CHEST]: { p: [-0.2, 0.16, 0], walk: [0.06, 0, 0.1, 0], flex: [0, 0, 0.15, 0.02], wind: [0.45, 0, 0, 0], strike: [-0.15, 0, 0, 0], die: [-0.1, 0, 0, 0], misc: [0.3, 0.3, 0, 0] },
    [J.HEAD]: { p: [0.33, 0.24, 0], walk: [0.1, 1, 0.15, 0.1], flex: [0, 0, 0, 0.1], wind: [0.3, 0, 0, 0], strike: [-0.5, 0, 0, 0], die: [-0.3, 0.4, 0, 0], misc: [0.4, 0.4, 0, 0] },
    [J.UARM_L]: { p: [0.25, 0.27, 0.22], walk: [0.55, 0, 0, 0], wind: [0.8, -0.2, 0, 0], strike: [1.0, 0, 0, 0], die: [0.2, -0.8, 0, 0], misc: [-0.3, 1.2, 1, 1] },
    [J.FARM_L]: { p: [0.25, 0.05, 0.22], walk: [0, 0, 0, 0], flex: [0.6, 0, 0, 0], wind: [0.4, 0, 0, 0], strike: [-0.5, 0, 0, 0], die: [0, 0, 0, 0], misc: [0, 0.8, 1, 1] },
    [J.THIGH_L]: { p: [-0.35, 0.13, 0.1], walk: [0, 0, 0.12, 0], misc: [0, 0.4, 1, 0] },
    [J.SHIN_L]: { p: [-0.64, 0.08, 0.1], walk: [0, 1, 0.1, 0], misc: [0, 0.4, 1, 0] },
  }, { stride: 0.55, bob: 0.015, drop: 0, turn: 9, flinch: 0.8 });
}

// The builder: broad and heavy in an orange hi-vis vest and a hardhat; it brings both fists down.
function brute(): CreepRig {
  return rig('brute', 1.1, {
    [J.CHEST]: { p: [0, 0.65, 0], walk: [0, 0, 0.1, -0.12], flex: [0, 0, 0.18, 0.03], wind: [0.35, 0, 0, 0], strike: [-0.55, 0, 0, 0], die: [-0.45, 0, 0, 0], misc: [0.12, 0.2, 0, 0] },
    [J.HEAD]: { p: [0.2, 1.38, 0], walk: [0, 0, 0.08, 0], flex: [0, 0, 0, 0.05], wind: [0.25, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [-0.4, 0, 0, 0], misc: [0.2, 0.2, 0, 0] },
    [J.UARM_L]: { p: [0.04, 1.36, 0.62], walk: [0.3, Math.PI, -0.04, 0.05], wind: [2.6, -0.15, 0, 0], strike: [0.9, 0.05, 0, 0], die: [-0.3, -0.3, 0, 0], misc: [-0.15, 0.8, 0.15, 1] },
    [J.FARM_L]: { p: [0.04, 0.88, 0.62], walk: [0.1, Math.PI + 0.5, 0, 0.15], wind: [0.9, 0, 0, 0], strike: [-0.1, 0, 0, 0], die: [0, 0, 0, 0], misc: [0, 0.6, 0.15, 1] },
    [J.THIGH_L]: { p: [0, 0.6, 0.2], walk: [0.3, 0, 0, 0], wind: [-0.1, 0, 0, 0], strike: [0.25, 0, 0, 0], die: [1.2, 0, 0, 0], misc: [0, 0.3, 1, 2] },
    [J.SHIN_L]: { p: [0, 0.3, 0.2], flex: [-0.5, Math.PI / 2, 0, 0], strike: [-0.2, 0, 0, 0], die: [-1.9, 0, 0, 0], misc: [0, 0.2, 1, 2] },
  }, { stride: 1.4, bob: 0.06, drop: 0.25, turn: 3.5, flinch: 0.25 });
}

// Swollen with bile, the belly burst out of its shirt, boils on it (on X) that swell as it fills
// up, head back, and whips the spit out.
function spitter(): CreepRig {
  return rig('spitter', 1.78, {
    [J.CHEST]: { p: [0, 0.52, 0], walk: [0, 0, 0.16, 0.08], flex: [0, 0, 0.06, 0.03], wind: [0.35, 0, 0, 0], strike: [-0.4, 0, 0, 0], die: [-0.4, 0, 0, 0], misc: [0.3, 0.3, 0, 0] },
    [J.X]: { p: [0.08, 0.74, 0], walk: [0, 0, 0.05, 0], flex: [0, 0, 0, 0.04], wind: [0, 0, 0, 0.35], strike: [0, 0, 0, -0.2], die: [0, 0, 0, -0.1], misc: [0.1, 0.2, 0, 0] },
    [J.HEAD]: { p: [0.08, 1.1, 0], walk: [0, 1, 0.12, 0], flex: [0, 0, 0, 0.06], wind: [0.7, 0, 0, 0], strike: [-1.0, 0, 0, 0], die: [-0.5, 0.3, 0, 0], misc: [0.4, 0.4, 0, 0] },
    [J.UARM_L]: { p: [0, 1.02, 0.3], walk: [0.2, Math.PI, -0.1, 0.2], wind: [-0.3, -0.5, 0, 0], strike: [0.6, 0, 0, 0], die: [-0.2, -0.3, 0, 0], misc: [-0.3, 1.2, 1, 1] },
    [J.FARM_L]: { p: [0, 0.79, 0.3], walk: [0.1, Math.PI + 0.5, 0, 0.3], wind: [0.6, 0, 0, 0], strike: [0.2, 0, 0, 0], die: [0, 0, 0, 0], misc: [0, 0.8, 1, 1] },
    [J.THIGH_L]: { p: [0, 0.48, 0.13], walk: [0.32, 0, 0, 0], die: [1.2, 0, 0, 0], misc: [0, 0.4, 1, 2] },
    [J.SHIN_L]: { p: [0, 0.25, 0.13], flex: [-0.5, Math.PI / 2, 0, 0], die: [-1.9, 0, 0, 0], misc: [0, 0.3, 1, 2] },
  }, { stride: 0.75, bob: 0.03, drop: 0.2, turn: 5, flinch: 0.8 });
}

// Gaunt and too tall in a tank top and shorts, barefoot, the arms hanging past its knees, shards
// of its own bone breaking out of its back; it rears up, both arms back over its head, and hurls one.
function hurler(): CreepRig {
  return rig('hurler', 2.33, {
    [J.CHEST]: { p: [0, 0.68, 0], walk: [0, 0, 0.08, -0.12], flex: [0, 0, 0.1, 0.03], wind: [0.55, 0, 0, 0], strike: [-0.6, 0, 0, 0], die: [-0.5, 0, 0.2, 0], misc: [0.35, 0.3, 0, 0] },
    [J.HEAD]: { p: [0.03, 1.2, 0], walk: [0, 1.2, 0.15, -0.1], flex: [0, 0, 0, 0.06], wind: [0.4, 0, 0, 0], strike: [-0.5, 0, 0, 0], die: [-0.5, 0.3, 0, 0], misc: [0.5, 0.4, 0, 0] },
    [J.UARM_L]: { p: [0, 1.15, 0.25], walk: [0.15, 0.5, -0.05, 0.2], flex: [0, 0, 0, 0.05], wind: [-2.6, -0.2, 0, 0], strike: [1.5, 0.1, 0, 0], die: [-1.0, -0.2, 0, 0], misc: [-0.4, 1.4, 1, 1] },
    [J.FARM_L]: { p: [0, 0.8, 0.25], walk: [0.1, 1.0, 0, 0.15], wind: [0.9, 0, 0, 0], strike: [-0.2, 0, 0, 0], die: [-0.2, 0, 0, 0], misc: [0, 0.9, 1, 1] },
    [J.THIGH_L]: { p: [0, 0.66, 0.1], walk: [0.38, 0, 0, 0], wind: [-0.15, 0, 0, 0], strike: [0.3, 0, 0, 0], die: [1.35, 0, 0, 0], misc: [0, 0.5, 1, 2] },
    [J.SHIN_L]: { p: [0, 0.34, 0.1], walk: [0, 0, 0, -0.05], flex: [-0.8, Math.PI / 2, 0, 0], strike: [-0.2, 0, 0, 0], die: [-2.1, 0, 0, 0], misc: [0, 0.4, 1, 2] },
  }, { stride: 1.05, bob: 0.03, drop: 0.26, turn: 5, flinch: 0.9 });
}

// Bodies fused into one hunched hulk: one arm swollen to a club, another torso sunk in its back
// with its head and an arm (X) clawing out of the hump, a fourth arm (X2) out of its ribs, bone
// through the spine; it rears up and sweeps them through everything in front.
function abomination(): CreepRig {
  return rig('abomination', 1.3, {
    [J.CHEST]: { p: [0, 0.6, 0], walk: [0.1, 0, 0.12, -0.05], flex: [0, 0, 0.2, 0.04], wind: [0.4, 0, 0, 0], strike: [-0.5, 0, 0, 0], die: [-0.6, 0, 0, 0], misc: [0.08, 0.15, 0, 0] },
    [J.HEAD]: { p: [0.58, 1.3, 0], walk: [0.1, 1, 0.2, 0], flex: [0, 0, 0, 0.1], wind: [0.4, 0, 0, 0], strike: [-0.5, 0, 0, 0], die: [-0.4, 0, 0, 0], misc: [0.1, 0.2, 0, 0] },
    [J.UARM_L]: { p: [0.3, 1.22, 0.66], walk: [0.5, Math.PI, 0, 0.1], wind: [2.0, -0.2, 0.6, 0], strike: [0.4, 0, -1.2, 0], die: [-0.4, -0.5, 0, 0], misc: [-0.1, 0.8, 0.3, 1] },
    [J.FARM_L]: { p: [0.3, 0.62, 0.66], walk: [0.3, Math.PI + 0.6, 0, 0.1], wind: [0.6, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [0, 0, 0, 0], misc: [0, 0.6, 0.3, 1] },
    [J.X]: { p: [-0.1, 1.7, 0.3], walk: [0.4, 0.5, 0, 0.2], wind: [0.8, 0, 0, 0], strike: [-1.2, 0, 0, 0], die: [-1.5, 0, 0, 0], misc: [0, 0.8, 0, 1] },
    [J.X2]: { p: [0.1, 1.5, -0.4], walk: [0.4, 0.5 + Math.PI, 0, 0.2], wind: [0.9, 0, 0, 0], strike: [-1.0, 0, 0, 0], die: [-1.2, 0, 0, 0], misc: [0, 0.8, 0, 1] },
    [J.THIGH_L]: { p: [0, 0.6, 0.42], walk: [0.3, 0, 0, 0], wind: [-0.15, 0, 0, 0], strike: [0.25, 0, 0, 0], die: [1.0, 0, 0, 0], misc: [0, 0.2, 1, 2] },
    [J.SHIN_L]: { p: [0, 0.3, 0.42], flex: [-0.6, Math.PI / 2, 0, 0], die: [-1.6, 0, 0, 0], misc: [0, 0.2, 1, 2] },
  }, { stride: 1.4, bob: 0.06, drop: 0.25, turn: 2.5, flinch: 0.1 });
}

// A woman once, swollen past bursting: tall and starved on long bent legs, the belly a vast
// veined sac out of her torn gown, things moving in it (X), egg sacs clustered on her back,
// lank hair over her face. She rears
// back, throat bulging, and heaves one up.
function broodmother(): CreepRig {
  return rig('broodmother', 1.6, {
    [J.CHEST]: { p: [0, 0.95, 0], walk: [0.05, 0, 0.15, -0.05], flex: [0, 0, 0.12, 0.05], wind: [0.55, 0, 0, 0], strike: [-0.55, 0, 0, 0], die: [-0.4, 0.5, 0, 0], misc: [0.06, 0.12, 0, 0] },
    [J.HEAD]: { p: [0.35, 2.05, 0], walk: [0.1, 1, 0.15, -0.15], flex: [0, 0, 0, 0.08], wind: [0.6, 0, 0, 0], strike: [-0.8, 0, 0, 0], die: [-0.5, 0.3, 0, 0], misc: [0.1, 0.3, 0, 0] },
    [J.UARM_L]: { p: [0.1, 1.98, 0.42], walk: [0.3, Math.PI, 0, 0.1], wind: [-1.6, -0.3, 0, 0], strike: [1.2, 0, 0, 0], die: [-0.6, -0.4, 0, 0], misc: [-0.1, 1.0, 0.5, 1] },
    [J.FARM_L]: { p: [0.1, 1.4, 0.42], walk: [0.3, Math.PI + 0.6, 0, 0.2], wind: [0.8, 0, 0, 0], strike: [-0.2, 0, 0, 0], die: [0, 0, 0, 0], misc: [0, 0.8, 0.5, 1] },
    [J.THIGH_L]: { p: [0, 1.3, 0.4], walk: [0.3, 0, 0, 0], wind: [-0.2, 0, 0, 0], strike: [0.2, 0, 0, 0], die: [1.1, 0, 0, 0], misc: [0, 0.3, 1, 2] },
    [J.SHIN_L]: { p: [0, 0.68, 0.4], flex: [-0.7, Math.PI / 2, 0, 0], die: [-1.8, 0, 0, 0], misc: [0, 0.3, 1, 2] },
  }, { stride: 1.6, bob: 0.07, drop: 0.2, turn: 2.2, flinch: 0.15 });
}

// A dead dog, mangy and gaunt, ribs through the hide, the lips gone from its teeth; it runs
// flat out in a gallop, crouches, and leaps at the throat.
function hound(): CreepRig {
  const p: RigPart[] = [];
  const FUR = 0x3e3026, FUR2 = 0x2c221c, PAW = 0x221a16, RED = 0xc8301c;
  // The body: deep chest, tucked waist, bony rump; raw patches and the ribs showing.
  p.push(rp(J.CHEST, B(0.36, 0.3, 0.3, FUR, 0.2, 0.6)));
  p.push(rp(J.CHEST, B(0.34, 0.2, 0.22, FUR2, -0.08, 0.62)));
  p.push(rp(J.CHEST, B(0.24, 0.24, 0.26, FUR, -0.32, 0.62)));
  p.push(rp(J.CHEST, B(0.22, 0.1, 0.02, SKIN, 0.05, 0.6, 0.12)));
  for (const x of [0.06, 0.14, 0.22]) for (const z of [0.152, -0.152]) p.push(rp(J.CHEST, B(0.03, 0.2, 0.02, BONE, x, 0.58, z)));
  p.push(rp(J.CHEST, B(0.12, 0.08, 0.02, BLOOD, -0.25, 0.65, -0.13)));
  for (const x of [-0.3, -0.15, 0, 0.15]) p.push(rp(J.CHEST, part(cone(0.025, 0.08, 4), BONE, x, 0.77, 0)));
  // A stump of a tail.
  p.push(rp(J.CHEST, B(0.2, 0.05, 0.05, FUR2, -0.5, 0.7, 0, 0, 0, 0.5)));
  // Neck, the long skull, the bared teeth, the ears flat back, a red eye.
  p.push(rp(J.HEAD, B(0.2, 0.16, 0.16, FUR, 0.42, 0.7, 0, 0, 0, 0.5)));
  p.push(rp(J.HEAD, B(0.2, 0.17, 0.18, FUR, 0.56, 0.78)));
  p.push(rp(J.HEAD, B(0.2, 0.09, 0.11, SKIN, 0.74, 0.76)));
  p.push(rp(J.HEAD, B(0.17, 0.05, 0.1, MOUTH, 0.72, 0.7)));
  for (const z of [0.045, -0.045]) {
    p.push(rp(J.HEAD, B(0.15, 0.03, 0.015, BONE, 0.74, 0.715, z)));
    p.push(rp(J.HEAD, B(0.025, 0.025, 0.025, RED, 0.66, 0.83, z * 1.9)));
    p.push(rp(J.HEAD, part(cone(0.04, 0.13, 4), FUR2, 0.5, 0.89, z * 1.6, 0, 0, 0.9)));
  }
  p.push(rp(J.HEAD, B(0.03, 0.06, 0.06, BLOOD, 0.84, 0.75)));
  // The legs: forelegs on the arm joints, hind legs on the leg joints, each side built.
  for (const s of [1, -1]) {
    const z = 0.1 * s;
    p.push(rp(s > 0 ? J.UARM_L : J.UARM_R, B(0.09, 0.26, 0.08, FUR, 0.28, 0.42, z)));
    p.push(rp(s > 0 ? J.FARM_L : J.FARM_R, B(0.06, 0.24, 0.06, SKIN, 0.28, 0.17, z)));
    p.push(rp(s > 0 ? J.FARM_L : J.FARM_R, B(0.11, 0.05, 0.08, PAW, 0.31, 0.025, z)));
    p.push(rp(s > 0 ? J.THIGH_L : J.THIGH_R, B(0.15, 0.26, 0.09, FUR, -0.3, 0.46, z)));
    p.push(rp(s > 0 ? J.SHIN_L : J.SHIN_R, B(0.06, 0.28, 0.06, FUR2, -0.36, 0.17, z, 0, 0, -0.25)));
    p.push(rp(s > 0 ? J.SHIN_L : J.SHIN_R, B(0.11, 0.05, 0.08, PAW, -0.31, 0.025, z)));
  }
  // A gallop: the forelegs nearly together, the hind legs half a stride behind them.
  const leg = (s: number, d: JointDef): JointDef => ({ ...d, misc: [0, 0.5, s, d.misc![3]], walk: [d.walk![0], d.walk![1] + (s > 0 ? 0 : 0.5), 0, d.walk![3]] });
  const fore: JointDef = { p: [0.28, 0.55, 0.1], walk: [0.75, 0, 0, 0], wind: [-0.7, 0, 0, 0], strike: [1.3, 0, 0, 0], die: [0.9, 0.3, 0, 0], misc: [0, 0.5, 1, 1] };
  const foreLo: JointDef = { p: [0.28, 0.29, 0.1], walk: [0, 0, 0, 0], flex: [-0.9, Math.PI / 2, 0, 0], wind: [1.1, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [0.4, 0, 0, 0], misc: [0, 0.4, 1, 1] };
  const hind: JointDef = { p: [-0.3, 0.58, 0.1], walk: [0.7, Math.PI, 0, 0], wind: [0.6, 0, 0, 0], strike: [-0.9, 0, 0, 0], die: [-0.9, 0.3, 0, 0], misc: [0, 0.5, 1, 2] };
  const hindLo: JointDef = { p: [-0.33, 0.32, 0.1], walk: [0, Math.PI, 0, 0], flex: [-0.9, Math.PI / 2, 0, 0], wind: [-0.8, 0, 0, 0], strike: [0.3, 0, 0, 0], die: [-0.4, 0, 0, 0], misc: [0, 0.4, 1, 2] };
  const right = (d: JointDef): JointDef => ({ ...d, p: [d.p[0], d.p[1], -d.p[2]] });
  return rig(p, {
    [J.CHEST]: { p: [0, 0.6, 0], walk: [0.14, Math.PI / 2, 0.04, 0], flex: [0, 0, 0.08, 0.02], wind: [-0.22, 0, 0, 0], strike: [0.3, 0, 0, 0], die: [0, 1.3, 0, 0], misc: [0.3, 0.3, 0, 0] },
    [J.HEAD]: { p: [0.36, 0.68, 0], walk: [0.12, 1.2, 0.05, -0.1], flex: [0, 0, 0, 0.1], wind: [-0.4, 0, 0, 0], strike: [0.5, 0, 0, 0], die: [-0.6, 0.4, 0, 0], misc: [0.4, 0.5, 0, 0] },
    [J.UARM_L]: leg(1, fore), [J.FARM_L]: leg(1, foreLo),
    [J.UARM_R]: right(leg(-1, fore)), [J.FARM_R]: right(leg(-1, foreLo)),
    [J.THIGH_L]: leg(1, hind), [J.SHIN_L]: leg(1, hindLo),
    [J.THIGH_R]: right(leg(-1, hind)), [J.SHIN_R]: right(leg(-1, hindLo)),
  }, { stride: 1.5, bob: 0.06, drop: 0.12, turn: 12, flinch: 1.2 });
}

// A brute gone further: hunched like an ape, knuckles on the ground, arms as long as it is
// tall and hands like shovels; a butcher's apron, a hook through its belt. It charges, and
// reaches out wide to catch.
function mauler(): CreepRig {
  const p: RigPart[] = [];
  const APRON = 0x8a7a62, STEEL = 0x5a5a56;
  legs(p, 0.5, 0.26, 0.24, 0.3, 0.27);
  p.push(rp(-1, B(0.48, 0.2, 0.66, PANTS, 0, 0.52)));
  p.push(rp(J.CHEST, B(0.7, 0.6, 0.95, SKIN, 0.05, 0.9)));
  p.push(rp(J.CHEST, B(0.62, 0.45, 1.25, SKIN, 0.0, 1.32)));
  p.push(rp(J.CHEST, B(0.05, 0.75, 0.75, APRON, 0.41, 0.95)));
  p.push(rp(J.CHEST, B(0.06, 0.3, 0.3, BLOOD, 0.42, 0.8, 0.15)));
  p.push(rp(J.CHEST, B(0.06, 0.2, 0.16, BLOOD, 0.42, 1.15, -0.2)));
  p.push(rp(J.CHEST, B(0.04, 0.04, 1.0, 0x3a2a20, 0.38, 1.3)));
  p.push(rp(J.CHEST, part(cone(0.04, 0.3, 4), STEEL, 0.3, 0.55, 0.38, Math.PI, 0, 0)));
  for (const [x, z] of [[-0.3, 0.3], [-0.32, 0], [-0.3, -0.3], [-0.15, 0.15]]) p.push(rp(J.CHEST, part(cone(0.08, 0.32, 4), BONE, x, 1.6, z, 0, 0, 0.6)));
  head(p, J.HEAD, 0.3, 1.32, 1.1);
  for (const s of [1, -1]) {
    const z = 0.72 * s, u = s > 0 ? J.UARM_L : J.UARM_R, f = s > 0 ? J.FARM_L : J.FARM_R;
    p.push(rp(u, B(0.4, 0.3, 0.4, SKIN, 0.05, 1.42, z)));
    p.push(rp(u, B(0.32, 0.6, 0.32, SKIN, 0.05, 1.08, z)));
    p.push(rp(f, B(0.3, 0.55, 0.3, SKIN, 0.05, 0.55, z)));
    p.push(rp(f, B(0.42, 0.24, 0.46, SKIN, 0.08, 0.16, z)));
    for (const dz of [-0.15, 0, 0.15]) p.push(rp(f, part(cone(0.04, 0.16, 4), BONE, 0.3, 0.12, z + dz, 0, 0, -Math.PI / 2)));
  }
  return rig(p, {
    [J.CHEST]: { p: [0, 0.55, 0], walk: [0, 0, 0.12, -0.35], flex: [0, 0, 0.15, 0.03], wind: [0.55, 0, 0, 0], strike: [-0.6, 0, 0, 0], die: [-0.5, 0, 0, 0], misc: [0.12, 0.2, 0, 0] },
    [J.HEAD]: { p: [0.3, 1.36, 0], walk: [0, 0, 0.08, 0.3], flex: [0, 0, 0, 0.05], wind: [0.3, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [-0.4, 0, 0, 0], misc: [0.2, 0.2, 0, 0] },
    [J.UARM_L]: { p: [0.05, 1.46, 0.72], walk: [0.55, Math.PI, -0.05, 0.25], wind: [2.2, -0.9, 0, 0], strike: [0.6, 0.2, 0, 0], die: [-0.3, -0.3, 0, 0], misc: [-0.15, 0.8, 0.15, 1] },
    [J.FARM_L]: { p: [0.05, 0.8, 0.72], walk: [0.2, Math.PI + 0.5, 0, 0.1], wind: [0.6, 0, 0, 0], strike: [-0.2, 0, 0, 0], die: [0, 0, 0, 0], misc: [0, 0.6, 0.15, 1] },
    [J.THIGH_L]: { p: [0, 0.5, 0.24], walk: [0.45, 0, 0, 0.1], wind: [0.25, 0, 0, 0], strike: [-0.2, 0, 0, 0], die: [1.2, 0, 0, 0], misc: [0, 0.3, 1, 2] },
    [J.SHIN_L]: { p: [0, 0.26, 0.24], flex: [-0.8, Math.PI / 2, 0, 0], wind: [-0.5, 0, 0, 0], die: [-1.9, 0, 0, 0], misc: [0, 0.2, 1, 2] },
  }, { stride: 1.6, bob: 0.08, drop: 0.2, turn: 5, flinch: 0.25 });
}

// A giant stitched together from the dead, twice a man's height, a tiny head sunk between
// its shoulders, one arm grown monstrous; iron shackles on its wrists with the chains broken
// off. It charges, and what it catches it throws.
function goliath(): CreepRig {
  const p: RigPart[] = [];
  const FLESH = 0x8e7a70, DARK = 0x6a564e, STITCH = 0x2a1a16, IRON = 0x4a4a46, RAG = SHIRT;
  for (const s of [1, -1]) {
    const z = 0.42 * s;
    p.push(rp(s > 0 ? J.THIGH_L : J.THIGH_R, B(0.42, 0.6, 0.42, FLESH, 0, 0.98, z)));
    p.push(rp(s > 0 ? J.SHIN_L : J.SHIN_R, B(0.36, 0.62, 0.36, DARK, 0, 0.36, z)));
    p.push(rp(s > 0 ? J.SHIN_L : J.SHIN_R, B(0.5, 0.1, 0.4, STITCH, 0.08, 0.05, z)));
  }
  p.push(rp(-1, B(0.6, 0.3, 1.05, PANTS, 0, 1.3)));
  // A barrel of a chest, stitched down the middle, the ribs open on one side, rags hanging.
  p.push(rp(J.CHEST, B(0.85, 0.7, 1.3, FLESH, 0.02, 1.75)));
  p.push(rp(J.CHEST, B(0.75, 0.55, 1.8, FLESH, -0.02, 2.3)));
  p.push(rp(J.CHEST, B(0.03, 1.1, 0.06, STITCH, 0.44, 1.95)));
  for (const y of [1.6, 1.8, 2.0, 2.2]) p.push(rp(J.CHEST, B(0.03, 0.04, 0.22, STITCH, 0.44, y)));
  for (const y of [1.65, 1.8, 1.95]) p.push(rp(J.CHEST, B(0.04, 0.05, 0.4, BONE, 0.44, y, -0.38)));
  p.push(rp(J.CHEST, B(0.05, 0.35, 0.35, BLOOD, 0.43, 1.8, -0.38)));
  p.push(rp(J.CHEST, B(0.6, 0.4, 0.3, RAG, -0.05, 1.5, 0.52, 0.2, 0, 0)));
  for (const [x, z, a] of [[-0.35, 0.5, 0.4], [-0.4, 0, 0], [-0.35, -0.5, -0.4]] as const) p.push(rp(J.CHEST, part(cone(0.1, 0.45, 4), BONE, x, 2.55, z, a, 0, 0.5)));
  head(p, J.HEAD, 0.3, 2.5, 1.0, FLESH);
  p.push(rp(J.HEAD, B(0.03, 0.2, 0.03, STITCH, 0.47, 2.7, 0.06)));
  // The left arm big; the right one huge, the fist a boulder.
  const arm = (s: number, k: number) => {
    const z = 1.0 * s * (s < 0 ? 1.1 : 1), u = s > 0 ? J.UARM_L : J.UARM_R, f = s > 0 ? J.FARM_L : J.FARM_R;
    p.push(rp(u, B(0.5 * k, 0.4 * k, 0.5 * k, FLESH, 0.05, 2.5, z)));
    p.push(rp(u, B(0.38 * k, 0.75, 0.38 * k, FLESH, 0.05, 2.0, z)));
    p.push(rp(f, B(0.36 * k, 0.75, 0.36 * k, DARK, 0.05, 1.25, z)));
    p.push(rp(f, B(0.42 * k, 0.15, 0.42 * k, IRON, 0.05, 1.05, z)));
    p.push(rp(f, B(0.06, 0.3, 0.06, IRON, 0.12, 0.85, z + 0.1)));
    p.push(rp(f, B(0.5 * k, 0.42 * k, 0.5 * k, FLESH, 0.08, 0.75 - 0.1 * k, z)));
  };
  arm(1, 1);
  arm(-1, 1.45);
  return rig(p, {
    [J.CHEST]: { p: [0, 1.35, 0], walk: [0.05, 0, 0.12, -0.15], flex: [0, 0, 0.16, 0.04], wind: [0.45, 0, -0.4, 0], strike: [-0.6, 0, 0.5, 0], die: [-0.5, 0, 0, 0], misc: [0.06, 0.12, 0, 0] },
    [J.HEAD]: { p: [0.3, 2.55, 0], walk: [0.06, 1, 0.12, 0.15], flex: [0, 0, 0, 0.06], wind: [0.3, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [-0.4, 0, 0, 0], misc: [0.1, 0.2, 0, 0] },
    [J.UARM_L]: { p: [0.05, 2.6, 1.0], walk: [0.4, Math.PI, -0.05, 0.1], wind: [2.5, -0.6, 0, 0], strike: [0.7, 0.2, 0, 0], die: [-0.4, -0.4, 0, 0], misc: [-0.1, 0.6, 0.2, 1] },
    [J.FARM_L]: { p: [0.05, 1.62, 1.0], walk: [0.2, Math.PI + 0.5, 0, 0.2], wind: [0.8, 0, 0, 0], strike: [-0.2, 0, 0, 0], die: [0, 0, 0, 0], misc: [0, 0.5, 0.2, 1] },
    [J.UARM_R]: { p: [0.05, 2.6, -1.1], walk: [0.35, 0, 0.05, 0.1], wind: [2.7, 0.6, 0, 0], strike: [0.9, -0.2, 0, 0], die: [-0.4, 0.4, 0, 0], misc: [-0.1, 0.6, -0.2, 1] },
    [J.FARM_R]: { p: [0.05, 1.62, -1.1], walk: [0.2, 0.5, 0, 0.2], wind: [0.8, 0, 0, 0], strike: [-0.2, 0, 0, 0], die: [0, 0, 0, 0], misc: [0, 0.5, -0.2, 1] },
    [J.THIGH_L]: { p: [0, 1.28, 0.42], walk: [0.38, 0, 0, 0], wind: [-0.15, 0, 0, 0], strike: [0.25, 0, 0, 0], die: [1.1, 0, 0, 0], misc: [0, 0.2, 1, 2] },
    [J.SHIN_L]: { p: [0, 0.67, 0.42], flex: [-0.7, Math.PI / 2, 0, 0], die: [-1.8, 0, 0, 0], misc: [0, 0.2, 1, 2] },
  }, { stride: 2.2, bob: 0.08, drop: 0.25, turn: 3, flinch: 0.1 });
}

// The rig for a creep kind; the bosses are known by name, whatever their index.
export function creepRig(kind: number, name: string): CreepRig {
  if (name === 'abomination') return abomination();
  if (name === 'broodmother') return broodmother();
  if (name === 'goliath') return goliath();
  if (name === 'mauler') return mauler();
  if (name === 'hound') return hound();
  switch (kind) {
    case 1: return runner();
    case 2: return swarmer();
    case 3: return brute();
    case 4: return spitter();
    case 6: return hurler();
    default: return walker();
  }
}
