import * as THREE from 'three/webgpu';
import { dot, floor, fract, mix, screenCoordinate, sin, step, vec2 } from 'three/tsl';

// What effects, overlays and the fog are drawn with so they are made of the scene's own
// pixels: an ordered dither on the scene pixel grid (a coverage below 1 shows as a pattern of
// whole pixels, never as a see-through smear), and a little value noise for ragged shapes.

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;

const b2 = (p: V2): F => fract(p.x.mul(0.5).add(p.y.mul(p.y).mul(0.75)));

// The 4x4 Bayer threshold of a cell p (whole numbers), 1/32 .. 31/32.
export function bayerAt(p: V2): F {
  return b2(floor(p.mul(0.5))).mul(0.25).add(b2(p)).add(1 / 32);
}

// The threshold of the scene pixel being drawn.
export function bayer(): F {
  return bayerAt(floor(screenCoordinate.xy));
}

// 1 where a coverage of cov (0..1) keeps this pixel, else 0.
export function dither(cov: F): F {
  return step(bayer(), cov);
}

export function hash(p: V2): F {
  return fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
}

// Smooth value noise, 0..1, one feature a unit.
export function noise(p: V2): F {
  const i = floor(p), f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const a = hash(i), b = hash(i.add(vec2(1, 0))), c = hash(i.add(vec2(0, 1))), d = hash(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// A colour brought to sit in the picture: its saturation pulled in and a little of the
// ground's dust over it, its brightness kept, so a flash is still a flash but not a neon one.
export function tame(hex: number, sat = 0.78): number {
  let r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
  // 6% of the canvas tone (#766038), the way dust sits on everything in the picture.
  r += (0x76 - r) * 0.06; g += (0x60 - g) * 0.06; b += (0x38 - b) * 0.06;
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (q(r) << 16) | (q(g) << 8) | q(b);
}
