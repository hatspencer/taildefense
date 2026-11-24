import { box, cyl, part, type Part, sphere } from './util';

// The green AWM: the sniper tower's rifle, and a hero's Rifle once every one of its tracks is
// bought (awmFull). Built facing +x with the bore at y = 0 and the action's middle at x = 0;
// the muzzle is AWM_MUZZLE along it and the laser sight's lens at AWM_LENS.
export const AWM_MUZZLE = 1.3;
export const AWM_LENS: [number, number, number] = [0.6, 0.06, -0.1];

// The AWM in a survivor's hands: drawn at this scale, and moved so its pistol grip is where
// the hand holds a gun (the grip in its hold) and the muzzle AWM_HELD_MUZZLE out in front of it.
export const AWM_HELD = { scale: 0.6, x: 0.12, y: 0.05 };
export const AWM_HELD_MUZZLE = AWM_MUZZLE * AWM_HELD.scale + AWM_HELD.x;

// Whether a weapon's four track levels, from lv[o], are all at the top: the last thing the
// armory sells for a gun that does not evolve.
export function awmFull(lv: ArrayLike<number>, o: number, max: number): boolean {
  for (let t = 0; t < 4; t++) if (lv[o + t] < max) return false;
  return true;
}

// A huge bolt-action rifle, far bigger than life so it reads from the camera: a long, heavy
// fluted barrel with a big slotted muzzle brake, an olive chassis with a thumbhole stock, cheek
// riser and recoil pad, a box magazine, the bolt on the right, a big scope on rings, a bipod
// folded under the fore-end and a laser sight clamped to its right side. No markings.
//
// held: the copy a survivor carries. At its size, seen from above, the black action, barrel and
// scope along its top are most of what shows and it reads as a black gun, so in hand those are
// a dark olive and the chassis a shade lighter: the same green rifle at a glance. The tower's is
// drawn with held false, in its own colours.
export function awmParts(held = false): Part[] {
  const L = AWM_LENS;
  const OD = held ? 0x667446 : 0x4f5a36, ODK = held ? 0x505b36 : 0x3e4729, BLK = held ? 0x2c3220 : 0x1e1f1e;
  const MID = held ? 0x3c4030 : 0x2e302e, PAD = 0x141414;
  const BARREL = held ? 0x3a4230 : 0x262826, FLUTE = held ? 0x58604a : 0x4a4c4a, GLASS = held ? 0x343c26 : 0x1a1b1a;
  const X = Math.PI / 2;
  return [
    // Action, chassis and fore-end, with vents.
    part(box(0.52, 0.12, 0.12), BLK, 0.02, 0, 0),
    part(box(0.56, 0.06, 0.13), OD, 0.04, -0.08, 0),
    part(box(0.42, 0.12, 0.13), OD, 0.5, -0.04, 0),
    ...[0.4, 0.5, 0.6].map((x) => part(box(0.06, 0.04, 0.135), ODK, x, -0.03, 0)),
    part(box(0.12, 0.14, 0.08), BLK, 0.08, -0.17, 0),
    part(box(0.1, 0.03, 0.04), BLK, -0.12, -0.14, 0),
    // The thumbhole stock: the grip, the comb with its cheek riser, the lower bar and the butt.
    part(box(0.08, 0.18, 0.1), OD, -0.2, -0.15, 0, 0, 0, 0.35),
    part(box(0.42, 0.07, 0.11), OD, -0.47, 0.02, 0),
    part(box(0.24, 0.05, 0.1), ODK, -0.5, 0.08, 0),
    part(box(0.34, 0.07, 0.11), OD, -0.5, -0.2, 0),
    part(box(0.12, 0.3, 0.12), OD, -0.7, -0.08, 0),
    part(box(0.04, 0.32, 0.13), PAD, -0.78, -0.08, 0),
    part(cyl(0.015, 0.015, 0.12, 4), BLK, -0.66, -0.29, 0),
    // The bolt, its handle out to the right.
    part(cyl(0.022, 0.022, 0.14, 5), MID, -0.14, 0.03, -0.11, X, 0, 0),
    part(sphere(0.035, 6, 4), BLK, -0.14, 0.03, -0.19),
    // The barrel, heavy and fluted, and the brake with its ports.
    part(cyl(0.04, 0.046, 0.82, 10), BARREL, 0.67, 0, 0, 0, 0, X),
    part(box(0.6, 0.012, 0.02), FLUTE, 0.72, 0.042, 0),
    part(box(0.6, 0.02, 0.012), FLUTE, 0.72, 0, 0.042), part(box(0.6, 0.02, 0.012), FLUTE, 0.72, 0, -0.042),
    part(box(0.22, 0.12, 0.12), MID, 1.18, 0, 0),
    part(box(0.045, 0.08, 0.126), PAD, 1.12, 0, 0), part(box(0.045, 0.08, 0.126), PAD, 1.21, 0, 0),
    part(box(0.03, 0.1, 0.1), BLK, AWM_MUZZLE - 0.015, 0, 0),
    // The scope: tube, objective bell and its lens, eyepiece, turrets and rings.
    part(cyl(0.045, 0.045, 0.5, 10), GLASS, 0, 0.17, 0, 0, 0, X),
    part(cyl(0.05, 0.072, 0.14, 10), GLASS, 0.31, 0.17, 0, 0, 0, X),
    part(box(0.01, 0.1, 0.1), 0x3a6a7a, 0.385, 0.17, 0),
    part(cyl(0.056, 0.045, 0.1, 10), GLASS, -0.29, 0.17, 0, 0, 0, X),
    part(cyl(0.03, 0.03, 0.07, 6), MID, 0.02, 0.23, 0),
    part(cyl(0.03, 0.03, 0.07, 6), MID, 0.02, 0.17, -0.07, X, 0, 0),
    part(box(0.05, 0.08, 0.07), BLK, -0.1, 0.09, 0), part(box(0.05, 0.08, 0.07), BLK, 0.12, 0.09, 0),
    // The bipod, folded forward under the fore-end.
    part(box(0.34, 0.02, 0.02), BLK, 0.6, -0.12, 0.04), part(box(0.34, 0.02, 0.02), BLK, 0.6, -0.12, -0.04),
    part(box(0.05, 0.04, 0.12), MID, 0.78, -0.11, 0),
    // The laser sight on its clamp, its lens at AWM_LENS.
    part(box(0.06, 0.03, 0.04), MID, L[0] - 0.06, L[1], L[2] + 0.03),
    part(box(0.12, 0.05, 0.05), MID, L[0] - 0.06, L[1], L[2]),
    part(box(0.01, 0.03, 0.03), 0xff3020, L[0], L[1], L[2]),
  ];
}
