import type * as THREE from 'three/webgpu';
import { Ruin, SiteKind, type SiteDef } from '../protocol';
import { darker, mute, PAL } from './palette';
import { box, cyl, dodeca, merge, part, type Part } from './util';

// The places of internal/game/landmarks.go, drawn from the same plans: the army checkpoint
// across a road, the cemetery, the quarantine camp, and the two house shapes the hamlets
// brought (a terrace's brick and a burnt-out shell). terrain.ts builds their walls in the
// styles here; loot.ts stands their props.

// The plans, cell for cell as landmarks.go has them. Each plan's 's' is where the site is
// searched from; its rows run towards the site's yaw, its columns to the yaw's right.
export const CHECKPOINT_PLAN = [
  '                       ',
  '  SSS           ccccccc',
  '  S     b       c.....c',
  '  SSS   b       c..s..c',
  '        b  T    c.....c',
  '        b       cc..ccc',
  '        b     b        ',
  '========b=====b========',
  '========b=====b========',
  '        b     b        ',
  '              b        ',
  '   T          b    T   ',
  '              b        ',
  '              b  SSS   ',
  '                 S     ',
  '                 SSS   ',
];
export const CEMETERY_PLAN = [
  'fffffffffffffffffff',
  'f......#####......f',
  'f..g...#,,,#...g..f',
  'f......#,s,#......f',
  'f..g...##,##...g..f',
  'f.................f',
  'f..g..g.....g..g..f',
  'f.................f',
  'f.................f',
  'f..g..g.....g..g...',
  'f..................',
  'f.................f',
  'f..g..g.....g..g..f',
  'f.................f',
  'f.................f',
  'f..g..g.....g..g..f',
  'fffffff.....fffffff',
];
export const CAMP_PLAN = [
  'wwwwwwwwwwwwwwwwwwwwwww',
  'w.....................w',
  'w.ccc...ccccccc...ccc.w',
  'w.c.....c,,,,,c.....c.w',
  'w.ccc...c,,s,,c...ccc.w',
  'w.......c,,,,,c.......w',
  'w.......cc,,,cc.......w',
  'w.....................w',
  'w.ccc.............ccc.w',
  'w.c.................c.w',
  'w.ccc.............ccc..',
  'w......................',
  'w.ccc.............ccc.w',
  'w.c.................c.w',
  'w.ccc.............ccc.w',
  'w.....................w',
  'wwwwwwwww.....wwwwwwwww',
];

const PLANS: Partial<Record<number, string[]>> = { [SiteKind.Checkpoint]: CHECKPOINT_PLAN, [SiteKind.Cemetery]: CEMETERY_PLAN, [SiteKind.Camp]: CAMP_PLAN };

// The way a site's plan rows run: one of the four, from its yaw.
export function planFacing(s: SiteDef): [number, number] {
  return [Math.round(Math.cos(s.yaw ?? 0)), Math.round(Math.sin(s.yaw ?? 0))];
}

// The map tile of cell lx, ly of site s's plan (landmarks.go planOrigin and planAt).
export function planTile(plan: string[], s: SiteDef, lx: number, ly: number): [number, number] {
  const [fx, fy] = planFacing(s);
  let sx = 0, sy = 0;
  plan.some((row, y) => { const x = row.indexOf('s'); if (x >= 0) { sx = x; sy = y; } return x >= 0; });
  const ox = lx - sx, oy = ly - sy;
  return [Math.floor(s.sx) + ox * fy + oy * fx, Math.floor(s.sy) - ox * fx + oy * fy];
}

// The wall styles of these places, numbered on from terrain.ts's own (its Wall enum), in the
// order of PLACE_WALLS. Literal numbers: esbuild counts on from a literal only.
export const PLACE_WALL0 = 11;
export const enum PlaceWall { Burnt = 11, Sandbag = 12, Barrier = 13, Railing = 14, Wire = 15, Canvas = 16, Grave = 17, Crypt = 18 }

// A gravestone stands alone and is still a wall, not a boulder.
export function standsAlone(st: number): boolean { return st === PlaceWall.Grave; }

// A ruin's parts merged, worn into the picture's colours (terrain.ts's own ruin()).
const worn = (ps: Part[]) => merge(ps.map((p) => ({ geo: p.geo, color: mute(p.color, 0.8, 0.18) })));
const bx = (w: number, h: number, d: number, c: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => part(box(w, h, d), c, x, y, z, rx, ry, rz);

// Each built along +x, a tile long, as terrain.ts's walls are; lo..hi how tall it stands.
export const PLACE_WALLS: { lo: number; hi: number; geo: () => THREE.BufferGeometry }[] = [
  // Burnt: a house the fire took, brick gone black at the top, soot up its faces, a charred
  // joist end still in it.
  { lo: 0.5, hi: 1.5, geo: () => worn([
    bx(1, 0.5, 0.72, 0x6e3c2c, 0, 0.25, 0),
    bx(1, 0.5, 0.72, 0x3e2a22, 0, 0.75, 0),
    bx(1.01, 0.035, 0.73, 0x6a5e52, 0, 0.3, 0),
    bx(0.55, 0.22, 0.72, 0x241c18, -0.22, 1.1, 0),
    bx(0.2, 0.1, 0.6, PAL.ink, 0.25, 1.02, 0.1, 0, 0.4, 0.3),
    bx(0.08, 0.08, 0.9, 0x1e1814, 0.1, 0.9, 0.2, 0.2, 0.3, 0),
  ]) },
  // Sandbags: three courses of bags, staggered, sagging, a tear or two.
  { lo: 0.95, hi: 1.1, geo: () => {
    const p: Part[] = [];
    for (let row = 0; row < 3; row++) for (let i = 0; i < 3 - (row === 2 ? 1 : 0); i++) {
      const x = -0.34 + i * 0.34 + (row % 2) * 0.17, c = [PAL.khaki, PAL.canvas, 0x857a52][(row + i) % 3];
      p.push(part(dodeca(0.2), c, x, 0.14 + row * 0.27, ((row + i) % 2 - 0.5) * 0.06, 0, 0.3 * i, 0, 1.0, 0.55, 1.5));
    }
    return worn(p);
  } },
  // A jersey barrier: a concrete wedge, the road's paint worn off its face, a coil of wire
  // laid along the top.
  { lo: 1.0, hi: 1.05, geo: () => worn([
    bx(1, 0.3, 0.7, 0x8c897e, 0, 0.15, 0),
    bx(1, 0.6, 0.34, 0x9a978a, 0, 0.6, 0),
    bx(1, 0.1, 0.24, 0x8c897e, 0, 0.95, 0),
    bx(0.4, 0.2, 0.36, 0xa8321e, -0.25, 0.6, 0),
    bx(0.3, 0.2, 0.36, 0xc8c2a0, 0.12, 0.6, 0),
    part(cyl(0.14, 0.14, 1, 6), PAL.steelDark, 0, 1.12, 0, 0, 0, Math.PI / 2, 1, 1, 0.5),
  ]) },
  // An iron railing on a stone kerb: thin bars, a top rail, the run leaning a little.
  { lo: 1.0, hi: 1.3, geo: () => {
    const iron = 0x2a2c28, p: Part[] = [bx(1, 0.22, 0.34, 0x6f6a58, 0, 0.11, 0), bx(1, 0.05, 0.05, iron, 0, 1.0, 0, 0.06, 0, 0)];
    for (let i = 0; i < 5; i++) p.push(bx(0.035, 0.85, 0.035, iron, -0.4 + i * 0.2, 0.62, 0.02, 0.06, 0, 0), bx(0.06, 0.1, 0.06, iron, -0.4 + i * 0.2, 1.08, 0.05, 0.06, 0, 0));
    return worn(p);
  } },
  // The camp's wire: a post, chain link (dark, as it reads from above), barbed strands on top.
  { lo: 1.6, hi: 1.8, geo: () => worn([
    part(cyl(0.05, 0.05, 1, 5), PAL.steel, -0.45, 0.5, 0),
    bx(1, 0.86, 0.03, 0x4a4c46, 0, 0.5, 0),
    bx(1, 0.04, 0.05, PAL.steelLit, 0, 0.94, 0),
    bx(0.2, 0.3, 0.04, 0x3a3c36, 0.3, 0.2, 0.02, 0, 0, 0.4),
    ...[0.99, 1.04].map((y, k) => bx(1, 0.015, 0.02, PAL.steelDark, 0, y, 0.04 + k * 0.05)),
  ]) },
  // Canvas: a tent's side between its poles, olive drab, slack, a torn flap hanging.
  { lo: 1.4, hi: 1.7, geo: () => worn([
    bx(1, 1, 0.08, PAL.olive, 0, 0.5, 0, 0.1, 0, 0),
    bx(1, 0.08, 0.12, PAL.oliveDark, 0, 0.98, -0.05),
    part(cyl(0.04, 0.04, 1.1, 5), PAL.woodDark, -0.46, 0.55, 0),
    bx(0.3, 0.45, 0.04, 0x5a5c3a, 0.25, 0.3, 0.07, 0.3, 0, 0.15),
    bx(1, 0.1, 0.1, darker(PAL.olive, 0.7), 0, 0.05, 0),
  ]) },
  // A gravestone on its mound: a rounded headstone, a little askew, lichen on its shoulder.
  { lo: 0.75, hi: 1.05, geo: () => worn([
    part(dodeca(0.4), 0x4d4325, 0, 0.02, 0.15, 0, 0, 0, 1.1, 0.18, 1.6),
    bx(0.62, 0.68, 0.14, 0x8a8676, 0, 0.36, -0.3, 0.08, 0, 0.05),
    part(cyl(0.31, 0.31, 0.14, 8), 0x8a8676, 0, 0.7, -0.3, Math.PI / 2 + 0.08, 0, 0.05, 1, 1, 1),
    bx(0.24, 0.05, 0.16, 0x55783a, 0.15, 0.74, -0.3),
    bx(0.7, 0.08, 0.22, 0x6a6658, 0, 0.04, -0.3),
  ]) },
  // The crypt: dark granite blocks, a moulded cornice, the top broken where the urns stood.
  { lo: 1.8, hi: 2.2, geo: () => worn([
    bx(1, 1, 0.86, 0x5e5c56, 0, 0.5, 0),
    bx(1.02, 0.2, 0.9, 0x46443e, 0, 0.1, 0),
    bx(1.01, 0.03, 0.87, 0x4e4c46, 0, 0.5, 0),
    bx(1.04, 0.08, 0.92, 0x6c6a62, 0, 0.92, 0),
    bx(0.3, 0.16, 0.3, 0x5e5c56, 0.25, 1.04, 0),
    bx(0.08, 0.5, 0.02, 0x3e5a26, -0.3, 0.6, 0.44),
  ]) },
];

// The style of each of these places' wall tiles: paint(x, y, w, h, style) as terrain.ts's
// wallStyles has it, called before the houses so a house never restyles them. The hamlets'
// terraces and shells come after, in houseStyle.
export function placeStyles(sites: SiteDef[], paint: (x: number, y: number, w: number, h: number, st: number) => void): void {
  for (const s of sites) {
    const plan = PLANS[s.kind];
    if (!plan) continue;
    plan.forEach((row, ly) => [...row].forEach((c, lx) => {
      const st = s.kind === SiteKind.Checkpoint ? { b: PlaceWall.Barrier, S: PlaceWall.Sandbag, c: PlaceWall.Canvas }[c]
        : s.kind === SiteKind.Cemetery ? { f: PlaceWall.Railing, g: PlaceWall.Grave, '#': PlaceWall.Crypt }[c]
          : { w: PlaceWall.Wire, c: PlaceWall.Canvas }[c];
      if (st !== undefined) { const [x, y] = planTile(plan, s, lx, ly); paint(x, y, 1, 1, st); }
    }));
  }
}

// Which way a wall tile of these places faces, where it is not to be guessed from its
// neighbours: the gravestones all face the cemetery's gate.
export function placeHeadings(sites: SiteDef[], w: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of sites) {
    if (s.kind !== SiteKind.Cemetery) continue;
    // The mound (the block's +z) towards the gate, so the stone is read from the path.
    const [fx, fy] = planFacing(s), head = Math.atan2(-fx, fy);
    CEMETERY_PLAN.forEach((row, ly) => [...row].forEach((c, lx) => {
      if (c === 'g') { const [x, y] = planTile(CEMETERY_PLAN, s, lx, ly); out.set(y * w + x, head); }
    }));
  }
  return out;
}

// A house shape of the hamlets' own, or -1 for terrain.ts to style as before: a terrace in
// brick or render, a shell burnt.
export function houseStyle(ruin: number | undefined, r: number): number {
  if (ruin === Ruin.Shell) return PlaceWall.Burnt;
  if (ruin === Ruin.Terrace) return r < 0.6 ? 1 /* Brick */ : r < 0.85 ? 0 /* Siding */ : PlaceWall.Burnt;
  return -1;
}

// ---- the props searched ----

// The checkpoint's command tent: a trestle table with its field radio, the ammunition boxes
// stacked beside it, a rack of rifles. Searched, the boxes are open and the rack is bare.
export function checkpointProp(open: boolean): Part[] {
  const p: Part[] = [
    bx(0.7, 0.05, 1.3, PAL.woodDark, 0, 0.74, 0),
    ...[-0.55, 0.55].map((z) => bx(0.6, 0.72, 0.05, PAL.steelDark, 0, 0.36, z)),
    bx(0.34, 0.22, 0.26, PAL.olive, 0.05, 0.88, -0.3),
    bx(0.02, 0.4, 0.02, PAL.steel, 0.12, 1.15, -0.38, 0, 0, 0.1),
    bx(0.2, 0.03, 0.14, 0xa8321e, -0.1, 0.78, 0.35),
  ];
  for (let i = 0; i < 3; i++) p.push(bx(0.42, 0.26, 0.26, PAL.oliveDark, -0.1, 0.13 + i * 0.27, 0.95, 0, i * 0.1, 0));
  if (open) p.push(bx(0.4, 0.02, 0.26, PAL.ink, -0.1, 0.81, 0.95), bx(0.42, 0.03, 0.26, PAL.oliveDark, 0.15, 0.03, 1.35, 0, 0.7, 0));
  else for (let i = 0; i < 3; i++) p.push(bx(0.06, 1.0, 0.05, PAL.inkWarm, -0.35, 0.5, -0.9 + i * 0.16, 0, 0, 0.2));
  p.push(bx(0.08, 0.06, 0.6, PAL.woodDark, -0.32, 0.9, -0.74), bx(0.08, 0.06, 0.6, PAL.woodDark, -0.32, 0.3, -0.74));
  return p;
}

// The family's stone coffin in the crypt: a carved chest, its lid on. Robbed, the lid has
// been pushed half off and lies cracked against it, the inside dark.
export function cemeteryProp(open: boolean): Part[] {
  const stone = 0x8a8676, p: Part[] = [
    bx(0.7, 0.18, 1.7, 0x5e5c56, 0, 0.09, 0),
    bx(0.62, 0.55, 1.6, stone, 0, 0.45, 0),
    bx(0.64, 0.04, 1.62, 0x6c6a62, 0, 0.3, 0),
  ];
  if (open) p.push(bx(0.5, 0.02, 1.48, PAL.ink, 0, 0.73, 0), bx(0.66, 0.1, 1.1, stone, 0.32, 0.55, 0.45, 0, 0.3, 0.6), bx(0.1, 0.05, 0.2, PAL.bone, 0.05, 0.75, -0.4));
  else p.push(bx(0.7, 0.1, 1.68, stone, 0, 0.77, 0), bx(0.5, 0.06, 0.08, 0x9a7a30, 0, 0.84, -0.3), bx(0.08, 0.06, 0.5, 0x9a7a30, 0, 0.84, -0.3));
  return p;
}

// The field hospital: a cot with its blanket, a drip stand, a shelf of red-crossed boxes.
// Searched, the shelf is bare and the boxes lie torn open on the boards.
export function campProp(open: boolean): Part[] {
  const p: Part[] = [
    bx(0.7, 0.06, 1.8, PAL.olive, 0, 0.45, 0.2),
    ...[-0.32, 0.32].map((x) => bx(0.04, 0.45, 1.8, PAL.steel, x, 0.22, 0.2)),
    bx(0.62, 0.08, 1.1, PAL.wool, 0, 0.51, 0.45),
    part(cyl(0.015, 0.015, 1.6, 4), PAL.steelLit, 0.45, 0.8, -0.65),
    bx(0.12, 0.18, 0.04, 0xb9b196, 0.45, 1.5, -0.65),
    bx(0.4, 1.3, 0.05, PAL.steel, -0.3, 0.65, -1.0),
    ...[0.35, 0.8, 1.2].map((y) => bx(0.4, 0.03, 0.4, PAL.steel, -0.3, y, -0.82)),
  ];
  const crossBox = (x: number, y: number, z: number, ry: number) => [bx(0.3, 0.2, 0.3, PAL.medWhite, x, y, z, 0, ry, 0), bx(0.31, 0.06, 0.08, PAL.medRed, x, y + 0.03, z, 0, ry, 0), bx(0.08, 0.06, 0.31, PAL.medRed, x, y + 0.03, z, 0, ry, 0)];
  if (open) p.push(...crossBox(0.3, 0.1, -1.0, 0.6), ...crossBox(-0.1, 0.1, 1.4, 1.3), bx(0.2, 0.01, 0.14, PAL.medWhite, 0.5, 0.005, -0.4, 0, 0.4, 0));
  else p.push(...crossBox(-0.3, 0.48, -0.82, 0.1), ...crossBox(-0.3, 0.93, -0.82, -0.1));
  return p;
}

// Where a place's prop stands: a tile in from its search spot, deeper into the tent or the
// crypt, its +x towards the plan's yaw.
export function placeProp(s: SiteDef): [number, number, number] | null {
  if (!PLANS[s.kind]) return null;
  const [fx, fy] = planFacing(s);
  return [s.sx - fx * 0.9, s.sy - fy * 0.9, Math.atan2(fy, fx)];
}
