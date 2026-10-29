import type { SiteDef } from '../protocol';

// A shrine's plan, as internal/game/legend.go lays it: '#' wall, 'o' a pillar, 'A' the altar,
// '.' flagstones, 's' where it is searched from. Row 0 is the back, behind the altar; the
// gate, between its two posts, is the last row, towards the shrine's yaw.
export const SHRINE_PLAN = [
  '  #########  ',
  ' ##.......## ',
  '##...AAA...##',
  '#.....s.....#',
  '#..o.....o..#',
  '#...........#',
  '...o.....o...',
  '#...........#',
  '#..o.....o..#',
  '#...........#',
  '##.........##',
  ' #.........# ',
  '   o.....o   ',
];
const SX = 6, SY = 3;

// The map tile of plan cell (lx, ly) of shrine s: from the spot it is searched from, its
// gate towards the yaw (one of the four ways) and its plan's +x to the gate's right.
export function shrineTile(s: SiteDef, lx: number, ly: number): [number, number] {
  const fx = Math.round(Math.cos(s.yaw ?? 0)), fy = Math.round(Math.sin(s.yaw ?? 0));
  const ox = lx - SX, oy = ly - SY;
  return [Math.floor(s.sx) + ox * fy + oy * fx, Math.floor(s.sy) - ox * fx + oy * fy];
}

// Where plan cell (lx, ly) lies in the shrine's prop: +x towards the gate, from the search spot.
export function shrineLocal(lx: number, ly: number): [number, number] {
  return [ly - SY, SX - lx];
}
