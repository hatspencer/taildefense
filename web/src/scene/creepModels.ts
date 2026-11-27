import { J, JOINTS, type RigPart } from './rig';
import { burster, runner, swarmer, walker } from './creeps/common';
import { abomination, broodmother, goliath } from './creeps/bosses';
import { brute, hound, hurler, mauler, spitter } from './creeps/heavy';

// The creeps as puppets: each model facing +x, standing on y = 0, every part hung on a joint
// of the shared skeleton, and per joint how it moves. Angles are radians: z swings a limb
// forward (a hanging limb's foot or hand goes +x; an upright part leans back), x rolls it out
// to the side, y twists it round the vertical.
//
// Parts painted in these exact colours take a per-instance colour, so a horde is a crowd of
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
//   tilt   [roll, twist, roll loll, twist loll]          held off true, and a slow loll about it
export interface JointDef { p: [number, number, number]; walk?: V4; flex?: V4; wind?: V4; strike?: V4; die?: V4; misc?: V4; tilt?: V4 }

export interface CreepRig {
  parts: RigPart[];
  joints: (JointDef | undefined)[];
  stride: number; // model units travelled per gait cycle (two steps)
  bob: number;    // pelvis rise per step
  drop: number;   // how far the body sinks as the knees give
  turn: number;   // turning rate, per second
  flinch: number; // how hard a hit rocks it
  scale?: number; // world units per model unit; unset, the footprint is fitted to the sim radius
  // Dying (all optional; unset, as an upright figure): how far it tips over once its knees
  // have given, radians (1.45; 0 for one already on the ground, which collapses where it is),
  // the edge it tips over, model units ahead of or behind the feet (0.32), and how far it sinks
  // as it tips, so the fallen body lies on the ground (0).
  fall?: number;
  edge?: number;
  lie?: number;
  // A blow (optional, 0 unset): how far the pelvis sinks as it winds up, and how far forward
  // the blow carries the body, model units.
  crouch?: number;
  lunge?: number;
}

// The right-hand twin of a left joint: across the body, the other half of the gait.
export function mirror(d: JointDef): JointDef {
  const m = (v: V4 | undefined, f: (v: V4) => V4) => (v ? f(v) : undefined);
  return {
    p: [d.p[0], d.p[1], -d.p[2]],
    walk: m(d.walk, (v) => [v[0], v[1] + Math.PI, -v[2], v[3]]),
    flex: m(d.flex, (v) => [v[0], v[1], -v[2], v[3]]),
    wind: m(d.wind, (v) => [v[0], -v[1], -v[2], v[3]]),
    strike: m(d.strike, (v) => [v[0], -v[1], -v[2], v[3]]),
    die: m(d.die, (v) => [v[0], -v[1], -v[2], v[3]]),
    misc: m(d.misc, (v) => [v[0], v[1], -v[2], v[3]]),
    tilt: m(d.tilt, (v) => [-v[0], -v[1], v[2], v[3]]),
  };
}

export function rig(parts: RigPart[], j: Partial<Record<number, JointDef>>, o: Omit<CreepRig, 'parts' | 'joints'>): CreepRig {
  for (const [l, r] of [[J.UARM_L, J.UARM_R], [J.FARM_L, J.FARM_R], [J.THIGH_L, J.THIGH_R], [J.SHIN_L, J.SHIN_R]]) {
    if (j[l] && !j[r]) j[r] = mirror(j[l]!);
  }
  const joints: (JointDef | undefined)[] = [];
  for (let i = 0; i < JOINTS; i++) joints.push(j[i]);
  return { parts, joints, ...o };
}

// The rig for a creep kind; the bosses are known by name, whatever their index.
export function creepRig(kind: number, name: string): CreepRig {
  if (name === 'abomination') return abomination();
  if (name === 'broodmother') return broodmother();
  if (name === 'goliath') return goliath();
  if (name === 'mauler') return mauler();
  if (name === 'hound') return hound();
  if (name === 'burster') return burster();
  switch (kind) {
    case 1: return runner();
    case 2: return swarmer();
    case 3: return brute();
    case 4: return spitter();
    case 6: return hurler();
    default: return walker();
  }
}
