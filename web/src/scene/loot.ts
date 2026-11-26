import * as THREE from 'three/webgpu';
import { color, positionWorld, sin, time } from 'three/tsl';
import { lootable, propKind, type SiteDef, SiteKind, siteX, siteY, walled, wreck } from '../protocol';
import type { Game } from '../state';
import { painted } from './paint';
import { blend, darker, lighter, PAL } from './palette';
import { box, cyl, lin, merge, octa, part, writeMatrix, type Part } from './util';

function hash(i: number, s: number): number {
  let h = Math.imul(i * 374761393 + s * 668265263, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const PI = Math.PI;

// Sizes. Props are built in metres. A survivor is about 1.53 units tall, so a thing at its
// true size beside one is MAN units a metre. A vehicle is held to the box the host makes it
// solid with (internal/game/wreck.go wreckHalf, a car 1.64 by 0.88), a little proud of it at
// the ends, so vehicles come out at VEH units a metre: about two thirds of their true size
// against a survivor, but in true proportion (default). The plane, its engines, the church
// and the shrine are built in tiles, as the host lays them out.
const MAN = 0.85, VEH = 0.55;

// Car paint, faded: tints over a grey body, so one model takes any of them.
const PAINT = [0x5e686a, 0x6e4232, 0x5e6446, 0x8e846a, 0x76746c, 0x46505a, 0x7a5e34];
const CAR_BODY = 0xa8a8a8;

// Shared colours.
const GLASS = 0x263034, GLASS_LIT = 0x52605e, TYRE = PAL.rubber, RIM = PAL.steel, CHROME = PAL.steelLit, INK = PAL.inkWarm;
const LAMP = 0xc8c2a0, TAIL = 0x7a2a1c, DUST = 0xa89a74, SOOT = 0x2a2620, CARD = 0x8f7448, CARD_DARK = 0x6e5636;

// --- Building blocks ---------------------------------------------------------------------

const bx = (w: number, h: number, d: number, c: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => part(box(w, h, d), c, x, y, z, rx, ry, rz);
// A cylinder standing up (y), or turned with rx/rz.
const cy = (r: number, h: number, c: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, seg = 8, r2 = r) => part(cyl(r, r2, h, seg), c, x, y, z, rx, ry, rz);
// The same parts on both sides: f(1) and f(-1).
const both = (f: (s: number) => Part[]): Part[] => [...f(1), ...f(-1)];

// A side-on outline, (x, y) pairs, pushed out w across z about the middle.
function slab(pts: number[], w: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) s.lineTo(pts[i], pts[i + 1]);
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false, curveSegments: 1 });
  g.deleteAttribute('uv');
  g.translate(0, 0, -w / 2);
  return g;
}
const prof = (pts: number[], w: number, c: number, z = 0) => part(slab(pts, w), c, 0, 0, z);

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
// A bar from a to b, t thick (t2 across, if given).
function rod(ax: number, ay: number, az: number, bx2: number, by: number, bz: number, t: number, c: number, t2 = t): Part {
  const d = V(bx2 - ax, by - ay, bz - az), len = d.length();
  const g = box(len, t, t2);
  const q = new THREE.Quaternion().setFromUnitVectors(V(1, 0, 0), d.normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(V((ax + bx2) / 2, (ay + by) / 2, (az + bz) / 2), q, V(1, 1, 1)));
  return { geo: g, color: c };
}

// Turns parts about a pivot (a door on its hinge, a lid, a bike on its side).
function swing(ps: Part[], px: number, py: number, pz: number, rx: number, ry: number, rz: number): Part[] {
  const m = new THREE.Matrix4().makeTranslation(px, py, pz)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)))
    .multiply(new THREE.Matrix4().makeTranslation(-px, -py, -pz));
  for (const p of ps) p.geo.applyMatrix4(m);
  return ps;
}

// The outline of a wheel arch over a wheel at (wx, wy), R round, from behind to in front,
// cut off at the sill.
function arch(wx: number, wy: number, R: number, base: number, n = 6): number[] {
  const out: number[] = [];
  const a0 = base > wy ? Math.asin(Math.min(1, (base - wy) / R)) : 0;
  if (base < wy) out.push(wx - R, base);
  for (let i = 0; i <= n; i++) {
    const a = PI - a0 - (PI - 2 * a0) * i / n;
    out.push(wx + R * Math.cos(a), wy + R * Math.sin(a));
  }
  if (base < wy) out.push(wx + R, base);
  return out;
}

// A wheel at x on side z: the tyre, the steel rim on its outside, the hub. A flat one sits
// down on its rim.
function wheel(x: number, z: number, r: number, w: number, flat = false, rim: number = RIM): Part[] {
  const s = Math.sign(z), y = flat ? r * 0.8 : r;
  return [
    part(cyl(r, r, w, 12), TYRE, x, y, z, PI / 2, 0, 0, 1, 1, flat ? 0.8 : 1),
    part(cyl(r * 0.6, r * 0.6, 0.03, 8), rim, x, y, z + s * (w / 2 + 0.005), PI / 2),
    part(cyl(r * 0.2, r * 0.2, 0.04, 6), CHROME, x, y, z + s * (w / 2 + 0.02), PI / 2),
  ];
}
// A wheel on each side.
const axle = (x: number, half: number, r: number, w: number, flatL = false, flatR = false, rim: number = RIM) => [...wheel(x, half, r, w, flatR, rim), ...wheel(x, -half, r, w, flatL, rim)];
// The dark inside of a wheel arch, across the body between the tyres.
const well = (x: number, y: number, R: number, W: number) => bx(R * 1.8, R * 0.9, W - 0.2, INK, x, y + R * 0.45, 0);

// A thin patch laid on a side (z = ±half) or on a top (at y).
const sidePatch = (w: number, h: number, c: number, x: number, y: number, half: number) => bx(w, h, 0.014, c, x, y, half + Math.sign(half) * 0.007);
const topPatch = (w: number, d: number, c: number, x: number, y: number, z: number, rz = 0) => bx(w, 0.014, d, c, x, y + 0.007, z, 0, 0, rz);

// Glass shards and small litter on the ground about a wreck.
const shards = (pts: number[][], c = GLASS_LIT) => pts.map(([x, z, a]) => bx(0.14, 0.012, 0.09, c, x, 0.006, z, 0, a, 0));

// --- Vehicles (metres, nose to +x) ----------------------------------------------------------

// A saloon: the body cut round its wheel arches, the glasshouse with its pillars and roof,
// bumpers, lights, mirrors, door seams. Both the car and the police cruiser.
interface Saloon { L: number; W: number; r: number; wb: number; body: number; roof?: number; flat?: [boolean, boolean, boolean, boolean] }
function saloon(o: Saloon): Part[] {
  const { L, W, r, wb, body } = o, h = L / 2, half = W / 2, R = r + 0.06, sill = r + 0.02, roofC = o.roof ?? body;
  const fl = o.flat ?? [false, false, false, false];
  const xf = h - 0.98, xr = -h + 0.75;
  return [
    prof([-h, sill + 0.06, ...arch(-wb, r, R, sill), ...arch(wb, r, R, sill), h - 0.02, sill + 0.02, h + 0.03, 0.52, h, 0.66, h - 0.1, 0.74,
      xf, 0.82, xr + 0.05, 0.86, -h + 0.13, 0.84, -h, 0.72, -h - 0.02, 0.5], W, body),
    well(wb, r, R, W), well(-wb, r, R, W),
    // The glasshouse, the roof over it, and the pillars down its sides.
    prof([xf, 0.8, xf - 0.67, 1.36, xr + 0.53, 1.38, xr, 0.84], W - 0.24, GLASS),
    prof([xf - 0.65, 1.33, xr + 0.5, 1.35, xr + 0.53, 1.42, xf - 0.69, 1.41], W - 0.18, roofC),
    topPatch(0.7, W - 0.5, DUST, -0.25, 1.41, 0.1),
    ...both((s) => [
      rod(xf, 0.82, s * (half - 0.11), xf - 0.67, 1.37, s * (half - 0.11), 0.07, roofC, 0.06),
      bx(0.09, 0.52, 0.06, roofC, (xf + xr) / 2 - 0.12, 1.1, s * (half - 0.11)),
      rod(xr - 0.02, 0.85, s * (half - 0.12), xr + 0.5, 1.38, s * (half - 0.12), 0.16, roofC, 0.06),
      // Door seams and handles, a rubbing strip, the mirror.
      bx(0.02, 0.46, 0.012, INK, xf - 0.03, 0.6, s * (half + 0.006)),
      bx(0.02, 0.46, 0.012, INK, (xf + xr) / 2 - 0.12, 0.6, s * (half + 0.006)),
      bx(0.02, 0.46, 0.012, INK, xr - 0.05, 0.62, s * (half + 0.006)),
      bx(0.12, 0.03, 0.025, CHROME, xf - 0.35, 0.74, s * (half + 0.012)),
      bx(0.12, 0.03, 0.025, CHROME, (xf + xr) / 2 - 0.45, 0.74, s * (half + 0.012)),
      bx(L - 1.0, 0.04, 0.03, PAL.steelDark, 0, 0.5, s * (half + 0.012)),
      bx(0.08, 0.09, 0.16, body, xf - 0.08, 0.92, s * (half + 0.06)),
      // Headlamps and tail lamps.
      bx(0.04, 0.09, 0.3, LAMP, h + 0.005, 0.6, s * (half - 0.28)),
      bx(0.04, 0.1, 0.32, TAIL, -h - 0.015, 0.66, s * (half - 0.26)),
    ]),
    bx(0.13, 0.17, W + 0.04, PAL.steelDark, h + 0.02, 0.42, 0),
    bx(0.13, 0.17, W + 0.04, PAL.steelDark, -h - 0.02, 0.44, 0),
    bx(0.03, 0.12, W * 0.42, INK, h + 0.02, 0.6, 0),
    bx(0.02, 0.1, 0.32, 0xb8b090, h + 0.09, 0.42, 0),
    ...axle(wb, half - 0.13, r, 0.2, fl[0], fl[1]), ...axle(-wb, half - 0.13, r, 0.2, fl[2], fl[3]),
  ];
}
// A saloon's front door on side s, swung open: the hole it leaves and the door itself.
function saloonDoor(o: Saloon, s: number, body: number, a = 0.9): Part[] {
  const xf = o.L / 2 - 0.98, xm = (xf + (-o.L / 2 + 0.75)) / 2 - 0.12, half = o.W / 2, len = xf - xm;
  return [
    sidePatch(len - 0.04, 0.44, INK, (xf + xm) / 2, 0.6, s * half),
    bx(0.4, 0.06, 0.5, PAL.leatherDark, (xf + xm) / 2, 0.55, s * (half - 0.35)),
    ...swing([
      bx(len, 0.46, 0.05, body, xf - len / 2, 0.6, s * (half + 0.02)),
      bx(len - 0.12, 0.38, 0.03, GLASS, xf - len / 2 - 0.04, 1.02, s * (half - 0.04)),
      bx(len - 0.05, 0.04, 0.04, body, xf - len / 2 - 0.02, 1.22, s * (half - 0.04)),
    ], xf, 0, s * half, 0, s * a, 0),
  ];
}
// A saloon's bonnet up over its engine bay.
function saloonBonnet(o: Saloon, body: number): Part[] {
  const h = o.L / 2, xf = h - 0.98;
  return [
    bx(0.86, 0.02, o.W - 0.3, INK, (xf + h - 0.1) / 2, 0.79, 0, 0, 0, -0.09),
    bx(0.4, 0.14, 0.5, PAL.steel, (xf + h) / 2, 0.82, 0.15),
    bx(0.2, 0.12, 0.2, PAL.steelDark, (xf + h) / 2 + 0.1, 0.82, -0.45),
    ...swing([bx(h - 0.1 - xf, 0.04, o.W - 0.08, body, (xf + h - 0.1) / 2, 0.84, 0)], xf, 0.84, 0, 0, 0, 1.0),
  ];
}
// A saloon's boot lid up on an emptied boot.
function saloonBoot(o: Saloon, body: number): Part[] {
  const h = o.L / 2, xr = -h + 0.75;
  return [
    bx(0.56, 0.02, o.W - 0.3, INK, (xr - h + 0.13) / 2, 0.85, 0),
    ...swing([bx(0.62, 0.04, o.W - 0.08, body, (xr - h + 0.13) / 2, 0.87, 0)], xr, 0.87, 0, 0, 0, -1.2),
  ];
}

const CAR: Saloon = { L: 3.9, W: 1.74, r: 0.31, wb: 1.22, body: CAR_BODY, flat: [false, false, true, false] };
function carProp(open: boolean): Part[] {
  const p = saloon(CAR);
  // Rust round the arches and along the sills, on the bonnet and the roof.
  p.push(
    ...both((s) => [sidePatch(0.5, 0.14, PAL.rust, -1.45, 0.45, s * 0.87), sidePatch(0.4, 0.08, PAL.rust, 0.2, 0.38, s * 0.87)]),
    topPatch(0.3, 0.3, PAL.rust, 1.35, 0.775, 0.35, -0.09),
    topPatch(0.24, 0.3, PAL.rust, -0.5, 1.41, -0.35),
  );
  if (open) p.push(
    ...saloonDoor(CAR, 1, CAR_BODY), ...saloonBonnet(CAR, CAR_BODY),
    // A suitcase dragged out and burst on the ground, clothes about it.
    bx(0.6, 0.16, 0.42, 0x4e4434, 0.2, 0.08, 1.75, 0, 0.4, 0),
    bx(0.58, 0.04, 0.4, 0x4e4434, -0.1, 0.18, 2.15, 1.1, 0.4, 0),
    bx(0.4, 0.03, 0.3, PAL.shirtWhite, 0.7, 0.015, 2.1, 0, 1.2, 0),
    bx(0.36, 0.03, 0.26, PAL.denim, -0.55, 0.015, 1.5, 0, -0.5, 0),
    ...shards([[0.9, 1.1, 0.3], [1.1, 1.3, 1.2], [0.6, 1.2, 2.0]]),
  );
  else p.push(
    // A roof bag strapped down.
    bx(0.7, 0.2, 0.9, PAL.canvas, -0.3, 1.52, 0),
    ...both((s) => [bx(0.04, 0.22, 0.04, PAL.leatherDark, -0.3 + s * 0.2, 1.52, 0, 0, 0, 0)]),
    bx(0.72, 0.03, 0.05, PAL.webbing, -0.3, 1.63, 0.2), bx(0.72, 0.03, 0.05, PAL.webbing, -0.3, 1.63, -0.2),
  );
  return p;
}

const COP: Saloon = { L: 4.0, W: 1.78, r: 0.32, wb: 1.25, body: 0x23241f, roof: 0xbeb8a6, flat: [true, false, false, false] };
function policeProp(open: boolean): Part[] {
  const white = 0xbeb8a6, half = COP.W / 2;
  const p = saloon(COP);
  p.push(
    // White doors, the light bar on the roof (red and blue, long dead), the push bar.
    ...both((s) => [sidePatch(2.0, 0.38, white, -0.1, 0.63, s * half), sidePatch(0.5, 0.08, 0x2a3e6a, -0.1, 0.72, s * (half + 0.008))]),
    bx(0.3, 0.1, 1.3, PAL.steelDark, -0.15, 1.47, 0),
    bx(0.24, 0.09, 0.56, 0x8e2a20, -0.15, 1.53, 0.32), bx(0.24, 0.09, 0.56, 0x2a3e7a, -0.15, 1.53, -0.32),
    ...both((s) => [rod(2.05, 0.3, s * 0.45, 2.22, 0.78, s * 0.45, 0.06, PAL.steelDark), rod(2.22, 0.78, s * 0.45, 2.22, 0.78, -s * 0.05, 0.05, PAL.steelDark)]),
    bx(0.06, 0.32, 1.0, PAL.steelDark, 2.2, 0.55, 0),
    rod(-1.6, 0.84, -0.6, -1.9, 1.6, -0.6, 0.015, INK),
    topPatch(0.4, 0.4, DUST, 1.4, 0.775, -0.2, -0.09),
  );
  if (open) p.push(
    ...saloonDoor(COP, -1, white, 1.1), ...saloonBoot(COP, COP.body),
    // The shotgun rack emptied onto the road, a vest and a box of shells.
    bx(0.5, 0.06, 0.4, PAL.olive, -2.6, 0.03, 0.4, 0, 0.6, 0),
    bx(0.18, 0.1, 0.12, PAL.medRed, -2.4, 0.05, -0.5, 0, 0.3, 0),
    bx(0.03, 0.03, 0.9, PAL.steelDark, -0.3, 0.02, -1.6, 0, 0.4, 0),
    ...shards([[0.4, -1.2, 0.5], [0.2, -1.4, 1.5]]),
  );
  return p;
}

// A pickup: cab up front, an open bed behind with a toolbox and a load. Paint-tinted.
function pickupProp(open: boolean): Part[] {
  const body = CAR_BODY, half = 0.9, r = 0.36, R = 0.43, sill = 0.44;
  const p: Part[] = [
    prof([-2.15, 0.48, ...arch(-1.3, r, R, sill), ...arch(1.38, r, R, sill), 2.12, sill, 2.18, 0.66, 2.12, 0.94, 1.95, 1.0, 1.1, 1.04, -0.2, 1.04, -0.2, 0.68, -2.15, 0.68], 1.8, body),
    well(1.38, r, R, 1.8), well(-1.3, r, R, 1.8),
    prof([1.1, 1.02, 0.6, 1.58, -0.1, 1.6, -0.18, 1.02], 1.58, GLASS),
    prof([0.62, 1.56, -0.13, 1.57, -0.15, 1.65, 0.58, 1.64], 1.66, body),
    topPatch(0.6, 1.2, DUST, 0.22, 1.64, 0),
    ...both((s) => [
      rod(1.1, 1.04, s * 0.8, 0.6, 1.6, s * 0.8, 0.07, body, 0.06),
      bx(0.12, 0.56, 0.06, body, -0.14, 1.3, s * 0.8),
      bx(0.02, 0.56, 0.012, INK, 1.08, 0.76, s * (half + 0.006)), bx(0.02, 0.56, 0.012, INK, -0.17, 0.76, s * (half + 0.006)),
      bx(0.12, 0.03, 0.025, CHROME, 0.0, 0.92, s * (half + 0.012)),
      bx(0.09, 0.12, 0.18, PAL.steelDark, 1.0, 1.15, s * (half + 0.08)),
      // The bed's sides with their rails.
      bx(1.95, 0.4, 0.07, body, -1.18, 0.88, s * 0.865), bx(1.97, 0.04, 0.11, PAL.steelDark, -1.18, 1.09, s * 0.865),
      bx(0.04, 0.1, 0.3, LAMP, 2.19, 0.84, s * 0.6), bx(0.04, 0.2, 0.1, TAIL, -2.16, 0.9, s * 0.8),
      sidePatch(0.6, 0.16, PAL.rust, -1.75, 0.6, s * half), sidePatch(0.3, 0.1, PAL.rust, 0.6, 0.52, s * half),
      // A faded firm's name on the doors.
      sidePatch(0.6, 0.14, 0xb8ae8a, 0.45, 0.82, s * half),
    ]),
    bx(1.95, 0.02, 1.66, PAL.steelDark, -1.18, 0.69, 0),
    bx(0.07, 0.4, 1.8, body, -0.24, 0.88, 0),
    bx(0.04, 0.3, 1.1, 0x3a3a34, 2.19, 0.8, 0),
    bx(0.14, 0.18, 1.86, CHROME, 2.2, 0.5, 0), bx(0.14, 0.16, 1.84, PAL.steelDark, -2.2, 0.52, 0),
    // A headache rack behind the cab.
    ...both((s) => [rod(-0.3, 1.08, s * 0.82, -0.3, 1.6, s * 0.82, 0.05, PAL.steelDark)]), rod(-0.3, 1.6, -0.82, -0.3, 1.6, 0.82, 0.05, PAL.steelDark),
    ...axle(1.38, 0.78, r, 0.24, true, false), ...axle(-1.3, 0.78, r, 0.24),
  ];
  // The toolbox across the bed, the tailgate, the load.
  if (open) p.push(
    bx(0.4, 0.3, 1.62, PAL.steelLit, -0.48, 0.84, 0),
    bx(0.36, 0.02, 1.56, INK, -0.48, 1.0, 0),
    ...swing([bx(0.4, 0.03, 1.62, PAL.steelLit, -0.48, 1.0, 0)], -0.68, 1.0, 0, 0, 0, 1.4),
    ...swing([bx(0.07, 0.42, 1.8, body, -2.14, 0.89, 0)], -2.15, 0.68, 0, 0, 0, 1.5),
    // The jerrycan tipped in the road, the tarp thrown off, a spilled crate.
    bx(0.36, 0.34, 0.16, 0x8a3a24, -3.0, 0.08, 0.5, PI / 2, 0.5, 0),
    bx(1.0, 0.03, 0.8, PAL.canvas, -2.9, 0.015, -0.6, 0, 0.3, 0),
    bx(0.4, 0.3, 0.3, CARD, -1.2, 0.15, 1.5, 0, 0.6, 0.1),
    bx(0.2, 0.04, 0.2, CARD_DARK, -1.6, 0.02, 1.8, 0, 0.2, 0),
  );
  else p.push(
    bx(0.4, 0.3, 1.62, PAL.steelLit, -0.48, 0.84, 0),
    bx(0.42, 0.02, 1.64, PAL.steel, -0.48, 1.0, 0),
    bx(0.07, 0.42, 1.8, body, -2.14, 0.88, 0),
    bx(0.16, 0.34, 0.36, 0x8a3a24, -1.2, 0.87, 0.55),
    bx(0.75, 0.32, 0.8, PAL.canvas, -1.5, 0.84, -0.3, 0, 0.2, 0),
    bx(0.04, 0.34, 0.84, PAL.webbing, -1.3, 0.85, -0.25, 0, 0.2, 0),
    cy(0.3, 0.2, TYRE, -1.75, 0.8, 0.45),
  );
  return p;
}

// An ambulance: a van's cab and a tall box body, red band and crosses, beacons on the roof.
function ambulanceProp(open: boolean): Part[] {
  const white = 0xbcb6a0, red = PAL.medRed, r = 0.36, R = 0.43;
  const cross = (x: number, y: number, z: number, n: number, k = 1) => [bx(0.5 * k, 0.14 * k, n, red, x, y, z), bx(0.14 * k, 0.5 * k, n, red, x, y, z)];
  const p: Part[] = [
    prof([0.7, 0.48, ...arch(1.55, r, R, 0.46), 2.28, 0.46, 2.32, 0.7, 2.25, 1.02, 1.8, 1.12, 0.7, 1.14], 1.9, white),
    prof([1.8, 1.1, 1.3, 1.85, 0.78, 1.9, 0.76, 1.1], 1.74, GLASS),
    prof([1.32, 1.82, 0.74, 1.86, 0.74, 1.96, 1.28, 1.94], 1.84, white),
    prof([-2.3, 0.5, ...arch(-1.35, r, R, 0.5), 0.78, 0.5, 0.78, 2.4, 0.7, 2.48, -2.25, 2.48, -2.3, 2.4], 2.04, white),
    well(1.55, r, R, 1.9), well(-1.35, r, R, 2.04),
    // The red band round the box and the cab, the crosses on the sides and the back.
    bx(3.1, 0.18, 2.06, red, -0.76, 1.2, 0), bx(1.6, 0.12, 1.92, red, 1.5, 0.84, 0),
    ...cross(-1.0, 1.85, 0, 2.06),
    ...both((s) => [
      rod(1.8, 1.12, s * 0.88, 1.3, 1.9, s * 0.88, 0.07, white, 0.05),
      bx(0.12, 0.08, 0.2, PAL.steelDark, 1.68, 1.25, s * 1.0),
      bx(0.02, 0.6, 0.012, INK, 1.75, 0.8, s * 0.956),
      bx(0.04, 0.1, 0.3, LAMP, 2.3, 0.82, s * 0.62),
      bx(0.12, 0.12, 0.26, 0x9a2a1e, 0.68, 2.54, s * 0.82), bx(0.12, 0.12, 0.26, 0x9a2a1e, -2.22, 2.54, s * 0.82),
      // A side window in the box, a grab rail, dirt kicked up the sides.
      bx(0.6, 0.36, 0.014, GLASS, 0.1, 1.9, s * 1.027),
      sidePatch(1.4, 0.2, DUST, -0.8, 0.62, s * 1.02), sidePatch(0.4, 0.12, PAL.rust, -2.05, 0.6, s * 1.02),
      bx(0.04, 0.14, 0.3, TAIL, -2.31, 0.9, s * 0.8),
    ]),
    bx(0.6, 0.06, 1.2, PAL.steelLit, -0.6, 2.51, 0),
    topPatch(1.6, 1.4, DUST, -1.1, 2.48, 0),
    bx(0.14, 0.2, 1.96, PAL.steelDark, 2.33, 0.52, 0), bx(0.04, 0.24, 0.9, 0x3a3a34, 2.3, 0.82, 0),
    bx(0.3, 0.08, 1.4, PAL.steelDark, -2.42, 0.48, 0),
    ...axle(1.55, 0.82, r, 0.22), ...axle(-1.35, 0.88, r, 0.22, false, true),
  ];
  if (open) p.push(
    // Back doors swung wide on a dark, ransacked inside; the stretcher pulled out and a bag.
    bx(0.02, 1.75, 1.9, INK, -2.31, 1.45, 0),
    bx(1.4, 0.04, 0.8, PAL.steelDark, -1.6, 0.9, 0.3),
    ...both((s) => swing([bx(0.05, 1.78, 0.98, white, -2.33, 1.45, s * 0.5), bx(0.02, 0.36, 0.6, GLASS, -2.36, 1.95, s * 0.45), ...cross(-2.36, 1.3, s * 0.5, 0.02, 0.6)], -2.33, 0, s * 1.0, 0, s * 1.9, 0)),
    bx(1.6, 0.06, 0.5, PAL.steelLit, -3.3, 0.38, 0.1, 0, 0.1, 0.12),
    bx(1.55, 0.08, 0.46, 0x6a7a80, -3.3, 0.44, 0.1, 0, 0.1, 0.12),
    ...both((s) => [rod(-3.9, 0.0, 0.1 + s * 0.2, -3.9, 0.3, 0.1 + s * 0.2, 0.04, PAL.steelDark)]),
    bx(0.4, 0.24, 0.26, PAL.medRed, -2.8, 0.12, -1.1, 0, 0.7, 0),
    bx(0.12, 0.04, 0.04, PAL.medWhite, -2.8, 0.25, -1.1, 0, 0.7, 0),
    bx(0.3, 0.02, 0.24, PAL.medWhite, -3.2, 0.01, 1.2, 0, 0.3, 0),
  );
  else p.push(
    bx(0.03, 1.75, 1.92, white, -2.31, 1.45, 0), bx(0.012, 1.7, 0.02, INK, -2.33, 1.45, 0),
    ...both((s) => [bx(0.02, 0.36, 0.6, GLASS, -2.33, 1.95, s * 0.45)]),
    ...cross(-2.34, 1.3, 0.5, 0.02, 0.6), ...cross(-2.34, 1.3, -0.5, 0.02, 0.6),
  );
  return p;
}

// A short school bus, faded yellow: a bonnet, the box with its band of windows, black rails.
function busProp(open: boolean): Part[] {
  const yel = 0xb48a2c, black = 0x26231c, r = 0.44, R = 0.52, half = 1.1;
  const p: Part[] = [
    prof([-3.2, 0.6, ...arch(-1.85, r, R, 0.56), ...arch(1.95, r, R, 0.56), 3.15, 0.56, 3.22, 0.8, 3.18, 1.32, 2.5, 1.4, 2.42, 1.55, 2.3, 2.55, 2.18, 2.68, -3.12, 2.7, -3.2, 2.6], 2.2, yel),
    well(1.95, r, R, 2.2), well(-1.85, r, R, 2.2),
    // The windows: a dark band down each side and across the back, pillars between them.
    bx(5.2, 0.56, 2.214, GLASS, -0.55, 1.98, 0),
    ...[2.0, 1.3, 0.6, -0.1, -0.8, -1.5, -2.2, -2.9].map((x) => bx(0.12, 0.58, 2.226, yel, x, 1.98, 0)),
    rod(2.42, 1.56, 0, 2.3, 2.5, 0, 0.04, GLASS, 1.98),
    bx(0.04, 0.2, 1.4, black, 2.24, 2.58, 0),
    // Rails along the sides, the roof, its hatch, the lights at its corners.
    bx(6.3, 0.06, 2.24, black, -0.4, 1.66, 0),
    bx(2.7, 0.06, 2.24, black, 0.05, 1.0, 0), bx(0.6, 0.06, 2.24, black, -2.9, 1.0, 0),
    topPatch(5.0, 1.8, blend(yel, DUST, 0.5), -0.5, 2.7, 0),
    bx(0.6, 0.06, 0.6, PAL.steelLit, -1.2, 2.73, 0),
    ...both((s) => [
      bx(0.1, 0.12, 0.18, 0x9a2a1e, 2.14, 2.6, s * 0.85), bx(0.1, 0.12, 0.18, 0xa86a24, 2.14, 2.6, s * 0.6),
      bx(0.1, 0.12, 0.18, 0x9a2a1e, -3.18, 2.6, s * 0.85),
      bx(0.04, 0.1, 0.24, LAMP, 3.2, 1.0, s * 0.65), bx(0.04, 0.16, 0.14, TAIL, -3.22, 1.2, s * 0.85),
      bx(0.08, 0.1, 0.2, black, 2.4, 1.85, s * (half + 0.12)),
      sidePatch(0.9, 0.3, PAL.rust, -2.6, 0.75, s * half), sidePatch(0.5, 0.2, PAL.rust, 0.5, 0.7, s * half),
      sidePatch(1.6, 0.16, DUST, -0.4, 0.68, s * half),
    ]),
    // The stop arm folded on the driver's side.
    cy(0.22, 0.03, 0x8e2a20, 1.9, 1.75, -half - 0.03, PI / 2, 0, 0, 8),
    bx(0.04, 0.6, 1.6, 0x3a3a34, 3.22, 1.0, 0),
    bx(0.18, 0.22, 2.3, black, 3.25, 0.62, 0), bx(0.18, 0.22, 2.3, black, -3.25, 0.66, 0),
    ...axle(1.95, 0.96, r, 0.26, false, true), ...axle(-1.85, 0.96, r, 0.26, true, false),
  ];
  if (open) p.push(
    // The folding door gaping, the back door hanging off, seats and bags thrown out.
    bx(0.55, 1.7, 0.014, INK, 2.06, 1.38, half + 0.008),
    bx(0.08, 1.6, 0.25, GLASS, 1.8, 1.42, half + 0.1, 0, 0.5, 0),
    bx(0.02, 1.9, 1.0, INK, -3.205, 1.6, 0),
    ...swing([bx(0.05, 1.9, 1.0, yel, -3.23, 1.6, 0), bx(0.02, 0.5, 0.8, GLASS, -3.26, 2.15, 0)], -3.23, 0, -0.5, 0, -1.7, 0),
    bx(0.5, 0.4, 0.9, 0x4e3a2a, -4.1, 0.2, 0.6, 0, 0.5, 1.1),
    bx(0.36, 0.22, 0.14, PAL.purple, 2.6, 0.11, 1.6, 0, 0.3, 0),
    bx(0.32, 0.2, 0.14, PAL.teal, 1.6, 0.1, 1.9, 0, -0.6, 0),
    bx(0.3, 0.03, 0.22, PAL.shirtWhite, 2.2, 0.015, 2.2, 0, 0.9, 0),
  );
  else p.push(
    bx(0.55, 1.7, 0.014, GLASS, 2.06, 1.38, half + 0.008),
    bx(0.04, 1.7, 0.02, yel, 2.06, 1.38, half + 0.016),
    bx(0.02, 1.9, 1.0, yel, -3.205, 1.6, 0), bx(0.02, 0.5, 0.8, GLASS, -3.215, 2.15, 0),
  );
  return p;
}

// An army truck: a long bonnet, an open cab with a canvas top, the bed under a canvas tilt.
function armyProp(open: boolean): Part[] {
  const olive = 0x4e5434, od = PAL.oliveDark, can = 0x6e6a48, rim = 0x3e4228, r = 0.47;
  const hoop = (x: number) => [rod(x, 1.6, 1.05, x, 2.55, 1.05, 0.05, od), rod(x, 1.6, -1.05, x, 2.55, -1.05, 0.05, od), rod(x, 2.58, -1.05, x, 2.58, 1.05, 0.05, od)];
  const p: Part[] = [
    bx(5.0, 0.24, 1.0, od, -0.1, 0.72, 0),
    // Bonnet and grille, flat mudguards.
    prof([1.45, 0.9, 2.6, 0.9, 2.62, 1.42, 1.45, 1.52], 1.2, olive),
    bx(0.05, 0.48, 1.1, od, 2.64, 1.15, 0),
    ...[0.96, 1.12, 1.28].map((y) => bx(0.04, 0.04, 1.0, olive, 2.67, y, 0)),
    ...both((s) => [
      bx(1.35, 0.05, 0.5, olive, 1.82, 1.18, s * 0.87),
      bx(0.05, 0.3, 0.5, olive, 2.47, 1.03, s * 0.87), bx(0.05, 0.36, 0.5, olive, 1.17, 1.0, s * 0.87),
      cy(0.09, 0.08, LAMP, 2.4, 1.3, s * 0.75, 0, 0, PI / 2),
      // The cab: its sides, a star on the door, the step and a jerrycan.
      bx(0.9, 0.75, 0.05, olive, 1.0, 1.32, s * 1.0),
      bx(0.36, 0.08, 0.012, 0xb8b090, 1.0, 1.38, s * 1.03), bx(0.08, 0.36, 0.012, 0xb8b090, 1.0, 1.38, s * 1.03),
      bx(0.5, 0.05, 0.3, od, 1.0, 0.78, s * 1.08),
      bx(0.16, 0.46, 0.34, od, 0.62, 1.0, s * 1.1),
      // The bed's sides with stake pockets, the tail lamps.
      bx(3.1, 0.45, 0.06, olive, -1.1, 1.43, s * 1.07),
      ...[-0.1, -1.1, -2.1].map((x) => bx(0.08, 0.45, 0.03, od, x, 1.43, s * 1.1)),
      bx(0.04, 0.12, 0.14, TAIL, -2.68, 1.0, s * 0.9),
    ]),
    bx(0.16, 0.22, 2.4, od, 2.72, 0.8, 0),
    // The cab's floor and back, the windscreen in its frame, the canvas top.
    bx(0.9, 0.6, 2.0, olive, 1.0, 1.25, 0),
    bx(0.04, 0.5, 1.9, GLASS, 1.46, 1.97, 0),
    rod(1.46, 1.7, -0.97, 1.46, 2.24, -0.97, 0.05, od), rod(1.46, 1.7, 0.97, 1.46, 2.24, 0.97, 0.05, od), rod(1.46, 2.24, -0.97, 1.46, 2.24, 0.97, 0.05, od),
    prof([0.55, 1.7, 1.42, 2.24, 1.42, 2.3, 0.55, 2.3], 2.04, can),
    bx(0.08, 0.6, 2.0, olive, 0.52, 1.9, 0),
    // The spare on its bracket behind the cab.
    cy(r, 0.3, TYRE, 0.32, 1.85, 0, PI / 2, 0, 0, 12), cy(0.26, 0.32, rim, 0.32, 1.85, 0, PI / 2),
    // The bed's floor.
    bx(3.1, 0.12, 2.2, olive, -1.1, 1.15, 0),
    ...axle(1.85, 0.86, r, 0.3, false, false, rim), ...axle(-0.95, 0.82, r, 0.42, false, false, rim), ...axle(-1.95, 0.82, r, 0.42, true, false, rim),
  ];
  if (open) p.push(
    // The tilt rolled back over bare hoops, the tailgate down, ammo crates spilled behind.
    ...hoop(-0.3), ...hoop(-1.2), ...hoop(-2.1),
    rod(0.4, 2.58, 0, -2.6, 2.58, 0, 0.04, od),
    bx(0.5, 0.5, 2.24, can, 0.18, 2.35, 0),
    ...swing([bx(0.06, 0.45, 2.2, olive, -2.63, 1.43, 0)], -2.65, 1.2, 0, 0, 0, 1.55),
    bx(0.7, 0.3, 0.42, olive, -3.6, 0.15, 0.4, 0, 0.5, 0), bx(0.6, 0.3, 0.4, olive, -3.4, 0.15, -0.5, 0, -0.3, 0),
    bx(0.66, 0.02, 0.38, INK, -3.6, 0.31, 0.4, 0, 0.5, 0),
    bx(0.7, 0.05, 0.42, olive, -3.9, 0.03, -0.1, 0, 1.2, 0),
    bx(0.3, 0.06, 0.12, 0xb8b090, -3.25, 0.31, -0.5, 0, -0.3, 0),
  );
  else p.push(
    prof([0.45, 1.6, 0.45, 2.45, 0.3, 2.62, -2.5, 2.62, -2.66, 2.45, -2.66, 1.6], 2.22, can),
    ...[-0.3, -1.2, -2.1].map((x) => bx(0.07, 0.03, 2.24, 0x5e5a3c, x, 2.635, 0)),
    bx(0.08, 0.2, 2.24, 0x5e5a3c, -2.7, 2.4, 0),
    bx(0.06, 0.45, 2.2, olive, -2.63, 1.43, 0),
    bx(0.4, 0.14, 0.012, 0xb8b090, -1.0, 1.95, 1.122),
  );
  return p;
}

// A fire engine: a crew cab, the body of lockers, a white band, the ladder racked on the roof.
function fireProp(open: boolean): Part[] {
  const red = 0x8a2a1c, white = 0xc0b8a0, steel = PAL.steelLit, r = 0.48, half = 1.15;
  const p: Part[] = [
    prof([1.4, 0.6, ...arch(2.1, r, 0.56, 0.6), 3.08, 0.58, 3.12, 0.9, 3.1, 1.5, 2.95, 1.55, 2.85, 2.5, 2.7, 2.6, 1.4, 2.62], 2.3, red),
    prof([2.99, 1.55, 2.88, 2.45, 1.5, 2.45, 1.5, 1.6], 2.314, GLASS),
    bx(0.12, 0.92, 2.328, red, 2.2, 2.0, 0), bx(0.1, 0.92, 2.328, red, 1.55, 2.0, 0),
    prof([-3.1, 0.65, ...arch(-1.5, r, 0.58, 0.62), 1.35, 0.62, 1.35, 2.35, -3.1, 2.35], 2.3, red),
    well(2.1, r, 0.56, 2.3), well(-1.5, r, 0.58, 2.3),
    bx(6.24, 0.12, 2.33, white, 0, 1.25, 0),
    // Beacons and siren on the cab, bumper, grille and lamps.
    bx(0.25, 0.12, 1.6, 0x8e2a20, 2.3, 2.68, 0), bx(0.2, 0.06, 1.62, PAL.steelDark, 2.3, 2.61, 0),
    bx(0.18, 0.26, 2.4, steel, 3.17, 0.7, 0), bx(0.03, 0.5, 1.1, PAL.steelDark, 3.12, 1.15, 0),
    ...both((s) => [
      bx(0.04, 0.12, 0.26, LAMP, 3.12, 1.0, s * 0.8),
      bx(0.1, 0.16, 0.22, PAL.steelDark, 2.85, 1.9, s * (half + 0.08)),
      bx(0.02, 0.9, 0.012, INK, 1.9, 1.05, s * (half + 0.006)),
      // The ladder's rail on this side, and the rail's supports.
      rod(2.0, 2.52, s * 0.35, -3.0, 2.52, s * 0.35, 0.06, steel),
      ...[1.0, -2.3].map((x) => bx(0.06, 0.18, 0.06, PAL.steelDark, x, 2.43, s * 0.35)),
      bx(0.04, 0.16, 0.18, TAIL, -3.12, 0.95, s * 0.9),
      sidePatch(0.5, 0.25, PAL.rust, -2.7, 0.85, s * half), sidePatch(1.4, 0.18, DUST, 0.3, 0.75, s * half),
    ]),
    ...[1.6, 1.0, 0.4, -0.2, -0.8, -1.4, -2.0, -2.6].map((x) => bx(0.04, 0.04, 0.7, steel, x, 2.52, 0)),
    // The hose reel on the back.
    cy(0.28, 0.5, 0xb8a870, -3.25, 1.6, 0, PI / 2, 0, 0, 10), cy(0.32, 0.04, PAL.steelDark, -3.25, 1.6, 0.27, PI / 2), cy(0.32, 0.04, PAL.steelDark, -3.25, 1.6, -0.27, PI / 2),
    topPatch(2.0, 1.4, DUST, -1.0, 2.35, 0),
    ...axle(2.1, 0.95, r, 0.26), ...axle(-1.5, 0.92, r, 0.4, false, true),
  ];
  // Lockers on each side: roll-up doors shut, or rolled up on emptied shelves.
  for (const s of [1, -1]) for (const [x, y, h] of [[0.7, 1.82, 0.9], [-0.2, 1.82, 0.9], [-1.1, 1.82, 0.9], [-2.4, 1.82, 0.9], [0.7, 0.92, 0.5], [-2.55, 0.92, 0.5]]) {
    const z = s * (half + 0.006);
    if (open) p.push(bx(0.8, h, 0.014, INK, x, y, z), bx(0.78, 0.03, 0.12, steel, x, y - 0.05, s * (half - 0.04)), cy(0.06, 0.8, steel, x, y + h / 2 - 0.04, s * (half + 0.03), 0, 0, PI / 2));
    else p.push(bx(0.82, h, 0.014, 0x9a988c, x, y, z), bx(0.82, 0.02, 0.02, PAL.steel, x, y - h / 4, s * (half + 0.016)), bx(0.82, 0.02, 0.02, PAL.steel, x, y + h / 4, s * (half + 0.016)));
  }
  if (open) p.push(
    // Hose run out across the road, a helmet and an axe dropped.
    cy(0.5, 0.1, 0xb8a870, 0.3, 0.05, 2.0, 0, 0, 0, 10),
    rod(0.3, 0.06, 2.5, 2.6, 0.06, 2.2, 0.1, 0xb8a870),
    part(cyl(0.14, 0.2, 0.14, 8), PAL.hardHat, -0.8, 0.07, 1.8),
    rod(-1.8, 0.03, 1.7, -2.6, 0.03, 2.1, 0.04, PAL.wood), bx(0.2, 0.04, 0.12, PAL.medRed, -2.65, 0.03, 2.12, 0, 0.45, 0),
  );
  return p;
}

// An armoured cash van: a squat cab, a tall steel body, slits for windows, a faded firm's
// band, heavy doors at the back.
function armoredProp(open: boolean): Part[] {
  const grey = 0x5f645a, dark = PAL.steelDark, band = blend(PAL.teal, grey, 0.3), r = 0.4, R = 0.48;
  const p: Part[] = [
    prof([0.95, 0.55, ...arch(1.5, r, R, 0.52), 2.32, 0.52, 2.36, 0.8, 2.3, 1.15, 1.95, 1.25, 1.6, 1.95, 0.95, 2.0], 2.06, grey),
    prof([-2.35, 0.55, ...arch(-1.45, r, R, 0.55), 1.0, 0.55, 1.0, 2.25, 0.9, 2.32, -2.3, 2.32, -2.35, 2.25], 2.1, grey),
    well(1.5, r, R, 2.06), well(-1.45, r, R, 2.1),
    rod(1.97, 1.27, 0, 1.63, 1.9, 0, 0.03, GLASS, 1.7),
    ...[1.45, 1.6, 1.75].map((y) => bx(0.04, 0.03, 1.74, dark, 1.95 - (y - 1.27) * 0.53, y, 0)),
    bx(3.36, 0.24, 2.12, band, -0.68, 1.55, 0),
    bx(0.4, 0.4, 2.13, 0xb8ae8a, -0.4, 1.55, 0),
    bx(0.36, 0.36, 2.14, band, -0.4, 1.55, 0, 0.785, 0, 0),
    ...both((s) => [
      bx(0.4, 0.12, 0.014, GLASS, 1.35, 1.62, s * 1.037),
      ...[-1.9, -0.9, 0.3].map((x) => bx(0.1, 0.08, 0.02, INK, x, 1.15, s * 1.06)),
      ...[-1.8, -0.4, 0.95].map((x) => bx(0.02, 1.6, 0.012, dark, x, 1.45, s * 1.056)),
      bx(0.04, 0.1, 0.28, LAMP, 2.36, 0.86, s * 0.65),
      bx(0.04, 0.16, 0.14, TAIL, -2.37, 1.0, s * 0.9),
      sidePatch(0.6, 0.2, PAL.rust, -2.0, 0.7, s * 1.05), sidePatch(1.8, 0.2, DUST, 0.2, 0.68, s * 1.05),
    ]),
    bx(0.22, 0.32, 2.2, dark, 2.42, 0.66, 0),
    ...[-0.6, 0, 0.6].map((z) => rod(2.42, 0.5, z, 2.62, 0.95, z, 0.06, dark)), rod(2.62, 0.95, -0.7, 2.62, 0.95, 0.7, 0.07, dark),
    bx(0.6, 0.12, 0.6, dark, -0.8, 2.38, 0),
    topPatch(2.4, 1.6, DUST, -0.7, 2.32, 0),
    ...axle(1.5, 0.84, r, 0.26), ...axle(-1.45, 0.84, r, 0.26, true, false),
  ];
  if (open) p.push(
    // The back doors cut and hanging open on an empty strongroom; bags and coins in the dirt.
    bx(0.02, 1.6, 1.9, INK, -2.36, 1.42, 0),
    ...both((s) => swing([bx(0.07, 1.62, 0.96, PAL.steelLit, -2.38, 1.42, s * 0.5), bx(0.08, 0.08, 0.2, INK, -2.42, 1.4, s * 0.15)], -2.38, 0, s * 1.0, 0, s * 1.6, 0)),
    bx(0.4, 0.3, 0.3, PAL.canvas, -3.0, 0.15, 0.3, 0, 0.4, 0.1), bx(0.34, 0.26, 0.28, PAL.canvasLight, -3.4, 0.13, -0.4, 0, -0.6, 0),
    bx(0.08, 0.1, 0.08, PAL.leatherDark, -3.0, 0.34, 0.3, 0, 0.4, 0),
    ...[[-3.5, 0.5], [-3.7, 0.1], [-3.3, -0.9], [-2.9, 1.0], [-3.9, -0.3]].map(([x, z], i) => bx(0.07, 0.015, 0.07, PAL.hardHat, x, 0.008, z, 0, i, 0)),
  );
  else p.push(
    bx(0.04, 1.6, 1.94, PAL.steelLit, -2.37, 1.42, 0), bx(0.012, 1.6, 0.02, INK, -2.395, 1.42, 0),
    bx(0.06, 0.12, 0.28, PAL.hardHat, -2.41, 1.4, 0.15),
    ...[0.9, 1.9].map((y) => bx(0.04, 0.08, 0.1, dark, -2.4, y, 0.92)), ...[0.9, 1.9].map((y) => bx(0.04, 0.08, 0.1, dark, -2.4, y, -0.92)),
  );
  return p;
}

// A camper: a van's cab, the bunk over it, the box behind, cream with faded stripes.
function camperProp(open: boolean): Part[] {
  const cream = 0xb8ae92, brown = 0x6a4a2c, orange = blend(PAL.capOrange, cream, 0.35), r = 0.38, R = 0.46, half = 1.1;
  const win = (x: number, w: number) => [bx(w + 0.08, 0.5, 2.212, INK, x, 1.75, 0), bx(w, 0.42, 2.222, 0x7a6a4c, x, 1.75, 0), bx(w, 0.14, 2.226, GLASS, x, 1.89, 0)];
  const p: Part[] = [
    prof([1.3, 0.5, ...arch(1.7, r, R, 0.48), 2.66, 0.48, 2.72, 0.75, 2.62, 1.05, 2.15, 1.15, 1.3, 1.18], 1.95, cream),
    prof([2.15, 1.13, 1.75, 1.78, 1.32, 1.8, 1.3, 1.13], 1.85, GLASS),
    prof([-2.7, 0.55, ...arch(-1.4, r, 0.48, 0.52), 1.3, 0.52, 1.3, 1.85, 2.15, 1.9, 2.25, 2.1, 2.1, 2.82, -2.6, 2.85, -2.7, 2.75], 2.2, cream),
    well(1.7, r, R, 1.95), well(-1.4, r, 0.48, 2.2),
    // The stripes, round the box and over the cab's bunk.
    bx(4.0, 0.16, 2.222, brown, -0.7, 1.22, 0), bx(4.0, 0.07, 2.222, orange, -0.7, 1.36, 0),
    bx(0.9, 0.12, 2.222, brown, 1.75, 2.2, 0, 0, 0, 0.05),
    ...win(-1.9, 0.8), ...win(0.6, 0.6), bx(0.5, 0.3, 2.222, INK, 1.75, 2.45, 0),
    // The roof: an air conditioner, a vent, the rolled awning down one side, a ladder behind.
    bx(0.7, 0.26, 0.7, 0xa8a492, 0.1, 2.97, 0), bx(0.4, 0.1, 0.4, PAL.steelLit, -1.6, 2.9, 0),
    cy(0.08, 3.2, blend(cream, brown, 0.4), -0.6, 2.62, half + 0.08, 0, 0, PI / 2),
    ...both((s) => [
      rod(-2.74, 0.9, s * 0.35, -2.74, 2.8, s * 0.35, 0.04, PAL.steel),
      rod(1.75, 1.15, s * 0.94, 1.32, 1.8, s * 0.94, 0.06, cream, 0.05),
      bx(0.04, 0.1, 0.3, LAMP, 2.71, 0.82, s * 0.62), bx(0.04, 0.18, 0.12, TAIL, -2.72, 1.0, s * 0.9),
      bx(0.08, 0.12, 0.18, PAL.steelDark, 1.95, 1.3, s * 1.06),
      sidePatch(0.8, 0.3, blend(cream, PAL.rust, 0.6), -2.3, 0.8, s * half), sidePatch(1.4, 0.2, DUST, 0.2, 0.68, s * half),
    ]),
    ...[1.2, 1.6, 2.0, 2.4].map((y) => rod(-2.74, y, -0.35, -2.74, y, 0.35, 0.03, PAL.steel)),
    cy(0.34, 0.2, TYRE, -2.82, 1.2, 0, 0, 0, PI / 2, 12),
    bx(0.14, 0.2, 2.0, PAL.steelDark, 2.74, 0.52, 0), bx(0.14, 0.2, 2.2, PAL.steelDark, -2.75, 0.55, 0),
    topPatch(3.6, 1.8, DUST, -0.7, 2.83, 0),
    ...axle(1.7, 0.84, r, 0.22), ...axle(-1.4, 0.94, r, 0.22, true, false),
  ];
  if (open) p.push(
    // The door wrenched open, the awning torn down, a mattress and a cooler dragged out.
    bx(0.62, 1.75, 0.014, INK, -0.55, 1.42, half + 0.008),
    ...swing([bx(0.62, 1.75, 0.05, lighterCream(cream), -0.55, 1.42, half + 0.03), bx(0.3, 0.3, 0.02, GLASS, -0.55, 1.9, half + 0.06)], -0.24, 0, half, 0, -1.3, 0),
    bx(3.0, 0.03, 1.3, blend(orange, cream, 0.5), -0.6, 2.05, half + 0.7, -0.5, 0, 0.12),
    rod(-1.9, 0.0, half + 1.3, -1.9, 1.8, half + 1.3, 0.04, PAL.steel), rod(0.6, 0.0, half + 1.6, 0.9, 0.9, half + 1.3, 0.04, PAL.steel),
    bx(1.8, 0.16, 0.9, 0x7a6a7e, -0.2, 0.08, 2.9, 0, 0.3, 0),
    bx(0.55, 0.36, 0.36, PAL.teal, 1.3, 0.18, 2.4, 0, -0.4, 0), bx(0.57, 0.08, 0.38, PAL.medWhite, 1.3, 0.38, 2.4, 0, -0.4, 0),
  );
  else p.push(
    bx(0.62, 1.75, 0.014, lighterCream(cream), -0.55, 1.42, half + 0.008),
    bx(0.3, 0.3, 0.016, GLASS, -0.55, 1.9, half + 0.012),
    bx(0.12, 0.03, 0.03, CHROME, -0.35, 1.3, half + 0.02),
  );
  return p;
}
function lighterCream(c: number): number { return lighter(c, 0.12); }

// A motorbike left on its side stand, panniers on the back. Paint-tinted. Built a little
// over the vehicles' scale: at theirs it would be lost in the grass.
function motoProp(open: boolean): Part[] {
  const body = CAR_BODY, r = 0.32;
  const wheelUp = (x: number) => [part(cyl(r, r, 0.12, 12), TYRE, x, r, 0, PI / 2), part(cyl(r * 0.6, r * 0.6, 0.13, 8), PAL.steelDark, x, r, 0, PI / 2), part(cyl(0.06, 0.06, 0.15, 6), CHROME, x, r, 0, PI / 2)];
  const bike: Part[] = [
    ...wheelUp(0.72), ...wheelUp(-0.7),
    // Tank, seat, engine, the exhaust down the right, forks, bars, lamp, the rear frame.
    bx(0.52, 0.22, 0.32, body, 0.2, 0.88, 0), bx(0.3, 0.06, 0.2, lighter(body, 0.2), 0.22, 1.0, 0),
    bx(0.62, 0.1, 0.28, PAL.leatherDark, -0.32, 0.86, 0),
    bx(0.42, 0.34, 0.28, PAL.steel, 0.02, 0.5, 0), bx(0.3, 0.2, 0.32, PAL.steelDark, 0.05, 0.42, 0),
    rod(0.2, 0.36, 0.18, -0.85, 0.46, 0.18, 0.08, CHROME),
    rod(0.55, 1.05, 0.08, 0.72, r, 0.08, 0.05, CHROME), rod(0.55, 1.05, -0.08, 0.72, r, -0.08, 0.05, CHROME),
    rod(0.52, 1.1, -0.38, 0.52, 1.1, 0.38, 0.04, PAL.steelDark),
    cy(0.1, 0.1, LAMP, 0.66, 1.0, 0, 0, 0, PI / 2),
    rod(-0.1, 0.8, 0, -0.7, r, 0, 0.06, PAL.steelDark),
    bx(0.5, 0.05, 0.22, body, -0.7, 0.7, 0, 0, 0, 0.25), bx(0.35, 0.05, 0.2, body, 0.75, 0.68, 0, 0, 0, -0.5),
    bx(0.04, 0.06, 0.12, TAIL, -0.96, 0.66, 0),
    bx(0.44, 0.34, 0.17, PAL.leather, -0.55, 0.66, 0.25),
    bx(0.44, 0.34, 0.17, PAL.leather, -0.55, 0.66, -0.25),
  ];
  if (open) bike.push(bx(0.4, 0.02, 0.17, INK, -0.55, 0.84, 0.25), ...swing([bx(0.44, 0.04, 0.18, PAL.leatherDark, -0.55, 0.84, 0.34)], -0.55, 0.84, 0.34, -1.6, 0, 0));
  else bike.push(bx(0.46, 0.06, 0.19, PAL.leatherDark, -0.55, 0.85, -0.25), bx(0.46, 0.06, 0.19, PAL.leatherDark, -0.55, 0.85, 0.25), part(new THREE.SphereGeometry(0.15, 8, 5), 0x6a2a20, 0.48, 1.0, 0.36));
  // Leaning over onto its stand.
  swing(bike, 0, 0, 0, -0.2, 0, 0);
  const p = [...bike, rod(-0.05, 0.3, -0.12, -0.15, 0.0, -0.36, 0.04, PAL.steelDark), bx(1.3, 0.012, 0.6, 0x2a261c, 0.1, 0.006, -0.1, 0, 0.2, 0)];
  if (open) p.push(
    // What was in the panniers, strewn; the helmet rolled off.
    bx(0.3, 0.04, 0.24, PAL.shirtGrey, -1.2, 0.02, 0.5, 0, 1.1, 0),
    bx(0.2, 0.08, 0.12, PAL.medRed, -0.6, 0.04, 0.8, 0, 0.3, 0),
    bx(0.26, 0.03, 0.2, PAL.denim, -1.0, 0.015, 0.9, 0, 0.5, 0),
    part(new THREE.SphereGeometry(0.15, 8, 5), 0x6a2a20, 0.6, 0.15, 0.8),
  );
  return p;
}

// --- Props at a survivor's scale (metres) ---------------------------------------------------

// A house's stash, facing +x: a fridge, a kitchen unit and a stack of moving boxes with a bag
// on top.
function houseProp(open: boolean): Part[] {
  const white = 0xaea890, wood = PAL.wood, top = 0x8a7a5a;
  const p: Part[] = [
    // The fridge: its body, rust round its foot, a sticker.
    bx(0.62, 1.7, 0.64, white, 0, 0.85, 0),
    bx(0.64, 0.08, 0.66, darkerOf(white), 0, 0.04, 0),
    bx(0.02, 0.1, 0.4, PAL.rust, 0.316, 0.12, 0.05),
    // The kitchen unit: carcass, worktop, doors and drawers.
    bx(0.58, 0.86, 1.2, wood, 0.0, 0.43, 0.95),
    bx(0.64, 0.04, 1.26, top, 0.03, 0.88, 0.95),
    bx(0.04, 0.08, 1.2, PAL.woodDark, 0.27, 0.04, 0.95),
    // The boxes, taped; a canvas bag on them.
    bx(0.5, 0.42, 0.5, CARD, 0.0, 0.21, -0.75, 0, 0.12, 0),
    bx(0.44, 0.36, 0.44, CARD_DARK, -0.1, 0.18, -1.3, 0, -0.2, 0),
  ];
  if (open) p.push(
    // The door hangs wide on a dark, empty fridge; a drawer on the floor; boxes torn open.
    bx(0.02, 1.6, 0.58, INK, 0.31, 0.88, 0),
    ...[0.5, 0.9, 1.3].map((y) => bx(0.04, 0.02, 0.56, 0x8a867a, 0.29, y, 0)),
    ...swing([bx(0.06, 1.62, 0.62, white, 0.34, 0.86, 0), bx(0.04, 0.3, 0.04, PAL.steel, 0.38, 1.0, -0.26)], 0.34, 0, 0.31, 0, -1.6, 0),
    bx(0.02, 0.8, 1.14, INK, 0.29, 0.42, 0.95),
    ...swing([bx(0.03, 0.56, 0.56, PAL.woodDark, 0.3, 0.32, 0.67)], 0.3, 0, 0.4, 0, 1.0, 0),
    bx(0.4, 0.12, 0.5, PAL.woodDark, 0.75, 0.06, 1.2, 0, 0.6, 0.15),
    bx(0.5, 0.02, 0.5, INK, 0.0, 0.43, -0.75, 0, 0.12, 0),
    ...[[0.25, 0], [-0.25, 0]].map(([dx]) => bx(0.02, 0.3, 0.5, CARD, dx, 0.52, -0.75, 0, 0.12, dx > 0 ? -0.6 : 0.6)),
    bx(0.6, 0.06, 0.4, PAL.olive, 0.7, 0.03, -0.9, 0, 0.8, 0),
    bx(0.3, 0.01, 0.22, PAL.shirtWhite, 0.9, 0.005, -0.3, 0, 0.3, 0), bx(0.22, 0.01, 0.3, PAL.shirtWhite, 1.1, 0.005, 0.4, 0, 1.4, 0),
    cy(0.04, 0.1, PAL.steelLit, 0.8, 0.04, 0.0, PI / 2, 0.4, 0),
  );
  else p.push(
    bx(0.04, 1.08, 0.62, white, 0.33, 0.6, 0), bx(0.04, 0.5, 0.62, white, 0.33, 1.42, 0),
    bx(0.03, 0.28, 0.04, PAL.steel, 0.36, 0.92, -0.25), bx(0.03, 0.18, 0.04, PAL.steel, 0.36, 1.3, -0.25),
    bx(0.01, 0.1, 0.08, PAL.medRed, 0.356, 1.5, 0.12), bx(0.01, 0.08, 0.06, PAL.teal, 0.356, 1.42, 0.0),
    ...[0.66, 1.24].map((z) => bx(0.03, 0.18, 0.56, PAL.woodDark, 0.3, 0.74, z)),
    ...[0.66, 1.24].map((z) => bx(0.03, 0.5, 0.56, wood, 0.3, 0.32, z)),
    ...[0.66, 1.24].map((z) => bx(0.03, 0.03, 0.16, PAL.steel, 0.32, 0.74, z)),
    bx(0.52, 0.04, 0.08, 0xb8a878, 0.0, 0.43, -0.75, 0, 0.12, 0),
    bx(0.62, 0.26, 0.32, PAL.olive, -0.02, 0.55, -0.8, 0, 0.5, 0),
    bx(0.2, 0.04, 0.06, PAL.leatherDark, -0.02, 0.69, -0.8, 0, 0.5, 0),
  );
  return p;
}
function darkerOf(c: number): number { return darker(c, 0.6); }

// A supply drop come down in the wilds: a crate strapped to its pallet, the parachute
// collapsed beside it with its cords. Opened: the straps cut, the lid off, the crate empty.
function crateProp(open: boolean): Part[] {
  const crate = 0x4e5432, cd = PAL.oliveDark, chute = blend(PAL.capOrange, PAL.canvas, 0.55), chute2 = blend(PAL.canvasLight, PAL.khaki, 0.5), stencil = 0xb8b090;
  const p: Part[] = [
    // The pallet: deck boards on three runners.
    ...[-0.4, 0, 0.4].map((z) => bx(1.2, 0.1, 0.1, PAL.woodDark, 0, 0.05, z)),
    ...[-0.5, -0.25, 0, 0.25, 0.5].map((x) => bx(0.16, 0.03, 1.0, PAL.wood, x, 0.115, 0)),
    // The crate: its box, the corner battens, rope handles, the stencil.
    bx(1.1, 0.7, 0.86, crate, 0, 0.48, 0),
    ...both((s) => [
      bx(0.06, 0.7, 0.06, cd, s * 0.55, 0.48, 0.43), bx(0.06, 0.7, 0.06, cd, s * 0.55, 0.48, -0.43),
      bx(0.2, 0.05, 0.04, PAL.canvasLight, 0, 0.62, s * 0.45),
      bx(0.04, 0.12, 0.5, stencil, s * 0.552, 0.45, 0), bx(0.04, 0.4, 0.12, stencil, s * 0.552, 0.45, 0),
    ]),
    bx(0.5, 0.08, 0.014, stencil, 0, 0.6, 0.437),
    // The chute: canopy panels lying in folds, the cords up to the crate.
    // The chute: its canopy fallen in folds behind the crate, panels by turns, the cords
    // running back up to the crate's top.
    ...[[-1.3, 0.1, 0.9, 0.5, 0.1], [-1.55, -0.35, 0.8, 0.45, -0.3], [-1.8, 0.35, 0.9, 0.5, 0.5], [-2.1, -0.1, 0.8, 0.55, 0.2], [-1.25, 0.65, 0.7, 0.4, 0.8], [-2.25, 0.55, 0.6, 0.4, -0.4]]
      .map(([x, z, w, d, a], i) => bx(w, 0.06 + (i % 3) * 0.04, d, i % 2 ? chute2 : chute, x, 0.03 + (i % 3) * 0.02, z, (i % 2 ? 0.1 : -0.08), a, (i % 3 - 1) * 0.06)),
    ...[[-0.95, 0.3], [-1.0, -0.25], [-1.0, 0.7]].map(([x, z]) => rod(-0.5, 0.82, 0, x, 0.1, z, 0.025, 0x9a9478)),
  ];
  if (open) p.push(
    bx(1.0, 0.02, 0.78, INK, 0, 0.835, 0),
    // The lid against the side, the cut straps, the packing strewn.
    bx(1.1, 0.06, 0.86, crate, 0.5, 0.4, -0.75, 1.3, 0, 0.1),
    bx(0.06, 0.012, 1.2, PAL.webbing, 0.8, 0.006, 0.4, 0, 0.3, 0), bx(0.06, 0.012, 1.0, PAL.webbing, -0.3, 0.006, 0.9, 0, 1.4, 0),
    bx(0.3, 0.12, 0.2, CARD, 0.9, 0.06, 0.6, 0, 0.7, 0), bx(0.24, 0.04, 0.2, CARD_DARK, 1.2, 0.02, 0.1, 0, 0.2, 0),
  );
  else p.push(
    bx(1.14, 0.06, 0.9, cd, 0, 0.86, 0),
    bx(0.08, 0.76, 0.92, PAL.webbing, 0.3, 0.5, 0), bx(0.08, 0.76, 0.92, PAL.webbing, -0.3, 0.5, 0),
    bx(0.08, 0.02, 0.92, PAL.webbing, 0.3, 0.9, 0), bx(0.08, 0.02, 0.92, PAL.webbing, -0.3, 0.9, 0),
    bx(0.12, 0.06, 0.06, PAL.steel, 0.3, 0.92, 0), bx(0.12, 0.06, 0.06, PAL.steel, -0.3, 0.92, 0),
  );
  return p;
}

// The gas station's counter, facing +x: a till on a long counter, the gun rack on the wall
// behind.
function counterProp(open: boolean): Part[] {
  const front = 0x7a7466, top = 0x8a7a5a, rack = PAL.woodDark, gunWood = PAL.wood, gun = PAL.steelDark;
  const p: Part[] = [
    bx(0.6, 0.98, 1.9, front, 0, 0.49, 0),
    bx(0.68, 0.04, 1.96, top, 0.02, 1.0, 0),
    bx(0.04, 0.08, 1.9, INK, 0.29, 0.04, 0),
    // Snack shelves along its front, and what is left on them.
    bx(0.2, 0.06, 1.7, PAL.steel, 0.42, 0.3, 0), bx(0.2, 0.06, 1.7, PAL.steel, 0.42, 0.62, 0),
    bx(0.02, 0.7, 1.7, PAL.steelDark, 0.32, 0.45, 0),
    // The till.
    bx(0.36, 0.16, 0.42, 0x3a3c38, -0.02, 1.1, -0.5),
    bx(0.04, 0.16, 0.26, 0x3a3c38, -0.12, 1.24, -0.5, 0, 0, -0.3),
    bx(0.01, 0.1, 0.2, 0x4a6a4a, -0.095, 1.25, -0.5, 0, 0, -0.3),
    // The rack on the wall behind: its board, the rests.
    bx(0.06, 1.3, 1.6, rack, -0.9, 1.25, 0),
    bx(0.16, 0.05, 1.5, rack, -0.84, 0.75, 0), bx(0.16, 0.05, 1.5, rack, -0.84, 1.6, 0),
    bx(0.3, 0.04, 1.3, rack, -0.78, 2.0, 0),
  ];
  const snacks = [PAL.medRed, PAL.hardHat, PAL.teal, PAL.capOrange, PAL.purple, PAL.shirtWhite];
  if (open) p.push(
    // Bare rests; the till's drawer out on the floor; the shelves knocked over.
    ...[-0.45, 0, 0.45].map((z) => bx(0.1, 0.05, 0.06, PAL.steelLit, -0.82, 1.35, z)),
    bx(0.3, 0.08, 0.34, 0x3a3c38, 0.6, 0.04, -0.7, 0, 0.6, 0),
    ...[[0.7, 0.3], [0.9, -0.2], [0.6, 0.8], [1.0, 0.5]].map(([x, z], i) => bx(0.1, 0.12, 0.08, snacks[i], x, 0.04, z, PI / 2, i, 0)),
    bx(0.2, 0.08, 0.14, PAL.medRed, 0.75, 0.04, 0.05, 0, 0.7, 0),
    ...[[0.95, 0.15], [1.05, -0.05], [0.85, 0.25]].map(([x, z]) => bx(0.04, 0.02, 0.02, PAL.hardHat, x, 0.01, z)),
  );
  else p.push(
    // Long guns racked on the wall, a red box of shells on the counter, full shelves.
    ...[-0.45, 0, 0.45].flatMap((z, i) => [bx(0.06, 0.62 - i * 0.06, 0.06, gun, -0.82, 1.62, z), bx(0.08, 0.42, 0.1, gunWood, -0.82, 1.0, z, 0.08, 0, 0), bx(0.1, 0.16, 0.06, gun, -0.82, 1.28, z)]),
    bx(0.18, 0.1, 0.12, PAL.medRed, 0.06, 1.07, 0.4),
    ...[0.33, 0.65].flatMap((y) => [-0.6, -0.3, 0, 0.3, 0.6].map((z, i) => bx(0.12, 0.14, 0.2, snacks[(i + (y > 0.5 ? 2 : 0)) % snacks.length], 0.44, y + 0.1, z))),
  );
  return p;
}

// A fuel pump on its island, faces ±z, the island along x. Blown: a scorched stump.
function pumpProp(open: boolean): Part[] {
  const island = PAL.concrete, white = 0xb2ac98, red = 0x9a3424, bollard = blend(PAL.hardHat, PAL.canvas, 0.3);
  const p: Part[] = [
    bx(2.2, 0.15, 1.0, island, 0, 0.075, 0),
    bx(2.24, 0.04, 1.04, darker(island, 0.7), 0, 0.02, 0),
    ...both((s) => [cy(0.08, 0.8, bollard, s * 0.95, 0.55, s * 0.36), bx(0.17, 0.08, 0.17, PAL.ink, s * 0.95, 0.75, s * 0.36)]),
  ];
  if (open) p.push(
    bx(1.8, 0.012, 0.9, SOOT, 0, 0.152, 0, 0, 0.2, 0),
    bx(1.6, 0.012, 1.4, darker(PAL.ground, 0.6), 0.3, 0.004, 0.2, 0, 0.6, 0),
    bx(0.8, 0.4, 0.42, SOOT, 0, 0.35, 0, 0, 0, 0.2),
    bx(0.6, 0.3, 0.38, 0x3a2a20, 0.1, 0.62, 0.02, 0.3, 0.5, 0.4),
    bx(0.5, 0.04, 0.3, red, 1.2, 0.05, 0.9, 0.2, 0.8, 0.1),
    bx(0.5, 0.03, 0.6, white, -1.1, 0.17, -0.8, 0.15, -0.5, 0),
    rod(0.2, 0.18, 0.4, 1.0, 0.03, 1.2, 0.05, INK),
  );
  else p.push(
    // The dispenser: plinth, cabinet, the head with its readouts, the brand band, the nozzles
    // in their holsters with their hoses.
    bx(0.92, 0.12, 0.46, PAL.steelDark, 0, 0.21, 0),
    bx(0.86, 1.1, 0.42, white, 0, 0.82, 0),
    bx(0.92, 0.5, 0.48, white, 0, 1.62, 0),
    bx(0.94, 0.16, 0.5, red, 0, 1.94, 0),
    bx(0.96, 0.04, 0.52, PAL.steelDark, 0, 2.04, 0),
    ...both((s) => [
      bx(0.6, 0.24, 0.014, 0x1e2620, 0, 1.64, s * 0.245), bx(0.2, 0.05, 0.016, 0x6a8a5a, -0.15, 1.68, s * 0.246),
      bx(0.7, 0.6, 0.014, darker(white, 0.85), 0, 0.82, s * 0.215),
      bx(0.1, 0.22, 0.1, INK, 0.3, 1.2, s * 0.26), bx(0.1, 0.22, 0.1, INK, -0.3, 1.2, s * 0.26),
      rod(0.3, 1.1, s * 0.3, 0.42, 0.4, s * 0.42, 0.04, INK), rod(0.42, 0.4, s * 0.42, 0.2, 0.18, s * 0.5, 0.04, INK),
      bx(0.04, 0.4, 0.014, PAL.rust, 0.3, 0.45, s * 0.217),
    ]),
  );
  return p;
}

// --- Landmarks (tiles) --------------------------------------------------------------------

// Turns lx, lz about the origin by a, the way the server turns its frames (+x towards +z).
function turn(lx: number, lz: number, a: number): [number, number] {
  const c = Math.cos(a), s = Math.sin(a);
  return [lx * c - lz * s, lx * s + lz * c];
}

// The crashed plane, in the server's frame (game/plane.go): the hull along x with its nose at
// +x and its back broken at -x, the tail section thrown behind it, one wing on, the other in
// pieces, and the scar it burnt into the ground.
const TAIL_X = -9.1, TAIL_Z = 1.6, TAIL_TURN = 0.5;
function planeProp(open: boolean): Part[] {
  const skin = 0x8a8c80, belly = 0x5e6056, stripe = 0x3a4658, dark = INK, burnt = 0x2e2820, scorch = 0x3a3428;
  const p: Part[] = [];
  // The scar: overlapping patches of scorched earth along the line it came down on.
  const scar = [[-14, 0, 3, 1.6, 0.3], [-11, 0.8, 3.4, 2, 1.1], [-8, -0.6, 4, 2.4, 0.5], [-5.5, 2.2, 3, 2.2, 1.3], [-1, 3, 3.6, 2.4, 0.2],
    [2, -2.8, 3.2, 2.2, 0.9], [6.5, 1, 3, 2.4, 0.4], [7.5, -1.6, 2.4, 1.8, 1.2], [-3, -6, 3, 2, 0.6], [0.5, 5.6, 2.6, 2, -0.4], [-6.5, -3, 2.4, 1.6, 0.2]];
  scar.forEach(([x, z, w, d, a], i) => p.push(bx(w, 0.02, d, i % 3 ? scorch : SOOT, x, 0.012 + i * 0.001, z, 0, a, 0)));
  // The hull: a round fuselage crushed into the dirt, a stripe and a row of windows each side.
  p.push(
    part(cyl(1.1, 1.1, 9.7, 12), skin, -0.65, 1.12, 0, 0, 0, PI / 2),
    bx(9.7, 0.5, 2.0, belly, -0.65, 0.2, 0),
    ...both((s) => [
      bx(9.7, 0.16, 0.02, stripe, -0.65, 1.28, s * 1.1),
      ...[-4.2, -3.4, -2.6, -1.8, -1.0, -0.2, 0.6, 1.4, 2.2, 3.0].map((x) => bx(0.24, 0.26, 0.02, dark, x, 1.62, s * 1.035)),
      // Rivet seams round the hull.
      ...[-3.8, -1.4, 1.0, 3.4].map((x) => bx(0.03, 1.6, 0.02, darker(skin, 0.8), x, 1.2, s * 1.105)),
    ]),
    bx(9.7, 0.02, 0.9, darker(skin, 0.85), -0.65, 2.23, 0),
    // The cargo door on the left, the crew door on the right.
    bx(1.6, 1.3, 0.03, darker(skin, 0.75), -2.6, 1.05, -1.1),
    bx(0.6, 1.2, 0.03, darker(skin, 0.75), 3.4, 1.05, 1.1),
    // The nose, dipped into the ground, the cockpit glass.
    part(cyl(0.45, 1.1, 1.8, 12), skin, 5.1, 0.95, 0, 0, 0, -PI / 2 - 0.12),
    part(cyl(0.12, 0.45, 0.6, 10), skin, 6.2, 0.8, 0, 0, 0, -PI / 2 - 0.2),
    bx(0.7, 0.3, 1.5, dark, 5.0, 1.75, 0, 0, 0, -0.5),
    ...both((s) => [bx(0.8, 0.3, 0.04, dark, 5.1, 1.5, s * 0.92, 0, s * 0.18, -0.15)]),
    // The broken end: torn skin round a dark hole, ribs showing.
    bx(0.05, 1.9, 2.0, 0x141410, -5.49, 1.15, 0),
    ...[[0.7, -0.5], [1.6, 0.4], [2.2, -0.2], [0.4, 0.8], [1.2, -0.95]].map(([y, z], i) => bx(0.5 + (i % 2) * 0.3, 0.1, 0.1, belly, -5.6, y, z, 0.3 * i, 0.4, 0.2)),
    ...[-5.2, -4.9].map((x) => part(new THREE.TorusGeometry(1.08, 0.04, 4, 12, PI), darker(skin, 0.7), x, 1.12, 0, 0, PI / 2, 0)),
    // The wing still on: high on the hull, drooping to the ground at its tip; flaps hanging.
    bx(2.4, 0.2, 6.6, skin, 0.4, 1.7, 4.2, 0.22, 0, 0),
    bx(0.5, 0.06, 4.0, darker(skin, 0.8), -0.85, 1.6, 4.6, 0.3, 0, 0.3),
    bx(2.42, 0.06, 0.4, stripe, 0.4, 1.86, 2.0, 0.22, 0, 0),
    bx(1.0, 0.5, 0.6, belly, 0.4, 1.85, 1.8, 0.2, 0, 0),
    // Its root on the other side, burnt off.
    bx(2.2, 0.2, 2.0, skin, 0.4, 2.15, -1.9, -0.15, 0, 0),
    bx(1.6, 0.22, 0.9, burnt, 0.6, 2.05, -3.0, -0.4, 0.3, 0.2),
    // What is left of the other wing, lying out on its own.
    bx(2.1, 0.18, 4.6, skin, -3.5, 0.18, -8.3, 0.08, 0.7, 0),
    bx(2.12, 0.04, 0.5, stripe, -3.5, 0.29, -6.4, 0.08, 0.7, 0),
    bx(0.6, 0.05, 2.8, darker(skin, 0.8), -4.1, 0.3, -8.9, 0.08, 0.7, 0),
    // Soot where it burnt: over the hull, along the wing, round the break.
    bx(2.6, 0.04, 1.2, SOOT, -3.6, 2.22, 0.1, 0, 0.2, 0),
    bx(1.6, 0.04, 1.0, burnt, 1.6, 2.22, -0.2, 0, -0.3, 0),
    bx(1.4, 0.06, 2.2, SOOT, 0.2, 1.62, 5.4, 0.22, 0.2, 0),
    bx(0.06, 1.2, 1.6, SOOT, -5.2, 1.1, 1.11, 0, 0, 0),
    bx(1.6, 1.0, 0.04, burnt, -4.4, 1.3, -1.12),
    // The nose gear folded under, a main wheel off.
    cy(0.35, 0.25, TYRE, 4.4, 0.35, 1.0, PI / 2, 0, 0, 10),
    cy(0.42, 0.3, TYRE, -1.0, 0.15, 3.2, 0, 0, 0.2, 10),
  );
  // The tail section, turned off the hull's line: a tapering cone, the fin and the tailplane.
  const tail = (lx: number, y: number, lz: number, g: THREE.BufferGeometry, col: number, rx = 0, rz = 0) => {
    const [ox, oz] = turn(lx, lz, TAIL_TURN);
    p.push(part(g, col, TAIL_X + ox, y, TAIL_Z + oz, rx, -TAIL_TURN, rz));
  };
  tail(0.4, 0.95, 0, cyl(0.75, 0.95, 3.4, 12), skin, 0, PI / 2);
  tail(-1.8, 1.1, 0, cyl(0.3, 0.72, 1.2, 10), skin, 0, PI / 2 + 0.2);
  tail(0.6, 1.05, 0, box(3.2, 0.14, 1.92), stripe);
  tail(2.1, 0.95, 0, box(0.05, 1.8, 1.8), 0x141410);
  tail(-1.5, 2.6, 0, box(1.8, 2.6, 0.18), skin, 0, -0.35);
  tail(-1.7, 3.2, 0, box(1.0, 0.8, 0.2), 0x8e2a20, 0, -0.35);
  tail(-1.95, 2.9, 0, box(0.5, 1.6, 0.21), darker(skin, 0.8), 0, -0.35);
  tail(-1.6, 1.5, 0, box(1.1, 0.12, 3.8), skin);
  // Debris: panels, seats and cargo strewn along the scar.
  const junk = [[-12, 1.5, 0.6], [-11, -2, 1.1], [7, 3, 0.4], [7.5, -2.5, 2.2], [3, -5, 0.9], [-6.5, 4.5, 1.7], [9, 0.5, 2.8], [-7, -4.5, 0.3]];
  junk.forEach(([x, z, a], i) => p.push(bx(0.9 - (i % 3) * 0.2, 0.06, 0.6, i % 2 ? skin : burnt, x, 0.04, z, 0.1, a, 0.05)));
  p.push(
    bx(0.5, 0.5, 0.5, 0x4a5a6a, -11.5, 0.25, -0.5, 0, 0.4, 0),
    bx(0.5, 0.06, 0.5, 0x4a5a6a, -11.4, 0.6, -0.4, 0.5, 0.4, 0),
    bx(0.5, 0.45, 0.45, PAL.leatherDark, 8.0, 0.22, -0.5, 0, 0.6, 0.3),
  );
  // The hold, seen through the break: cargo cases strapped in, or broken open and scattered.
  if (open) p.push(
    bx(0.8, 0.5, 0.6, PAL.olive, -6.4, 0.25, 0.6, 0, 0.5, 0),
    bx(0.76, 0.02, 0.56, INK, -6.4, 0.51, 0.6, 0, 0.5, 0),
    bx(0.8, 0.06, 0.6, PAL.oliveDark, -6.9, 0.04, -0.6, 0, 1.2, 0),
    bx(0.7, 0.44, 0.5, PAL.wood, -7.4, 0.22, 0.3, 0, -0.4, 0),
    bx(0.3, 0.2, 0.4, PAL.steelDark, -6.0, 0.1, -1.4, 0, 0.9, 0),
  );
  else p.push(
    bx(1.4, 0.7, 1.6, PAL.olive, -4.5, 0.75, 0),
    bx(1.42, 0.08, 1.62, 0xb8b090, -4.5, 0.95, 0),
    bx(1.0, 0.6, 1.2, PAL.steel, -3.0, 0.7, 0),
    bx(0.8, 0.5, 0.6, PAL.olive, -5.9, 0.25, 0.4, 0, 0.3, 0),
  );
  return p;
}

// One of the plane's engines on the ground: the nacelle, its propeller bent back, fuel
// pooling under it. Blown: a burnt-out shell.
function engineProp(open: boolean): Part[] {
  const skin = 0x8a8c80, dark = PAL.steelDark;
  const p: Part[] = [bx(1.9, 0.02, 1.4, 0x24201a, -0.2, 0.012, 0.1, 0, 0.3, 0)];
  if (open) p.push(
    part(cyl(0.46, 0.5, 1.6, 10), SOOT, -0.1, 0.44, 0, 0.2, 0, PI / 2),
    bx(0.6, 0.3, 0.7, 0x2a2420, 0.5, 0.2, 0.3, 0.4, 0.6, 0.3),
    bx(0.9, 0.04, 0.2, dark, 0.9, 0.06, -0.5, 0, 0.9, 0),
    bx(2.4, 0.012, 1.8, SOOT, 0, 0.02, 0, 0, 0.6, 0),
  );
  else p.push(
    part(cyl(0.48, 0.55, 1.9, 12), skin, 0, 0.55, 0, 0, 0, PI / 2),
    part(cyl(0.5, 0.5, 0.12, 12), darker(skin, 0.75), 0.9, 0.55, 0, 0, 0, PI / 2),
    part(cyl(0.12, 0.3, 0.3, 10), dark, 1.05, 0.55, 0, 0, 0, -PI / 2),
    // Three blades, two bent back by the ground.
    bx(0.08, 1.2, 0.18, dark, 1.12, 1.1, 0.0, 0.2, 0, -0.2),
    bx(0.08, 0.9, 0.18, dark, 1.0, 0.3, 0.45, -1.9, 0, 0.5),
    bx(0.08, 0.9, 0.18, dark, 1.0, 0.3, -0.45, 1.9, 0, 0.5),
    bx(1.0, 0.3, 0.6, skin, -0.2, 1.05, 0, 0, 0, 0.1),
    ...both((s) => [rod(-0.2, 0.4, s * 0.48, -0.9, 0.42, s * 0.5, 0.06, SOOT)]),
    bx(1.1, 0.012, 0.8, 0x3a3448, -0.5, 0.02, 0.5, 0, 0.5, 0),
  );
  return p;
}

// How far the church's tower stands past the middle of its nave, towards its yaw: the nave is
// 14 tiles long, the tower's three rows beyond its end wall (internal/game/church.go).
const TOWER_OFF = 8.5;

// The church's bell tower, +x the way it faces, with the nave behind it on -x: a stone shaft
// with dressed corners, a door, an open belfry with the bell hung in it, a slate spire and a
// cross. Inside the nave, the rope hangs at its foot, the pews stand in rows and the altar at
// the far end. Rung (open), the bell hangs swung over on its yoke and the rope is pulled taut.
function churchProp(open: boolean): Part[] {
  const stone = 0x9a9280, dressed = 0xaca48e, dark = 0x6a6454, slate = 0x3e424a, bronze = 0x9a7a3a, wood = PAL.wood;
  const p: Part[] = [
    bx(3.3, 0.5, 3.3, dark, 0, 0.25, 0),
    bx(3, 5, 3, stone, 0, 2.75, 0),
    ...[1.6, 3.2, 4.6].map((y) => bx(3.1, 0.1, 3.1, dressed, 0, y, 0)),
    // Quoins: long and short stones up each corner by turns.
    ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].flatMap(([sx, sz]) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) =>
      bx(k % 2 ? 0.6 : 0.36, 0.42, k % 2 ? 0.36 : 0.6, dressed, sx * (1.5 - (k % 2 ? 0.27 : 0.15)), 0.75 + k * 0.48, sz * (1.5 - (k % 2 ? 0.15 : 0.27))))),
    // The door with its pointed head, a clock long stopped, a lancet window.
    bx(0.08, 1.5, 1.0, INK, 1.5, 1.25, 0),
    rod(1.51, 2.0, -0.55, 1.51, 2.45, 0, 0.14, dressed, 0.14), rod(1.51, 2.0, 0.55, 1.51, 2.45, 0, 0.14, dressed, 0.14),
    part(cyl(0.55, 0.55, 0.08, 14), 0xbab29a, 1.52, 4.0, 0, 0, 0, PI / 2),
    part(cyl(0.6, 0.6, 0.06, 14), dressed, 1.5, 4.0, 0, 0, 0, PI / 2),
    bx(0.04, 0.4, 0.05, INK, 1.57, 4.1, 0), bx(0.04, 0.3, 0.05, INK, 1.57, 3.98, 0.12, 0.9, 0, 0),
    bx(0.08, 0.9, 0.3, INK, 1.5, 2.9, 0),
    ...both((s) => [bx(0.3, 0.8, 0.08, INK, 0, 2.9, s * 1.5)]),
    // The belfry: its floor, a pillar at each corner, louvres in the openings, a cornice.
    bx(3.1, 0.2, 3.1, dark, 0, 5.3, 0),
    ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([x, z]) => bx(0.45, 1.7, 0.45, stone, x * 1.27, 6.25, z * 1.27)),
    ...[5.7, 5.95].flatMap((y) => [bx(0.06, 0.08, 2.1, PAL.woodDark, 1.3, y, 0, 0, 0, 0.4), bx(0.06, 0.08, 2.1, PAL.woodDark, -1.3, y, 0, 0, 0, -0.4), bx(2.1, 0.08, 0.06, PAL.woodDark, 0, y, 1.3, -0.4), bx(2.1, 0.08, 0.06, PAL.woodDark, 0, y, -1.3, 0.4)]),
    bx(3.3, 0.3, 3.3, dressed, 0, 7.2, 0),
    bx(3.4, 0.08, 3.4, dark, 0, 7.06, 0),
    // The spire, its corners to the corners of the tower, its slates weathered, a lucarne on
    // each face, and the cross.
    part(cyl(0.04, 2.1, 3.4, 4), slate, 0, 9.05, 0, 0, PI / 4, 0),
    part(cyl(0.04, 1.2, 1.9, 4), 0x4e5048, 0, 9.85, 0.01, 0, PI / 4, 0),
    ...[0, 1, 2, 3].map((k) => part(cyl(0.02, 0.34, 0.5, 4), slate, Math.cos(k * PI / 2) * 0.8, 8.3, Math.sin(k * PI / 2) * 0.8, 0, PI / 4, 0)),
    ...[0, 1, 2, 3].map((k) => bx(0.3, 0.36, 0.3, INK, Math.cos(k * PI / 2) * 0.82, 8.0, Math.sin(k * PI / 2) * 0.82)),
    bx(0.1, 0.9, 0.1, INK, 0, 11.1, 0),
    bx(0.1, 0.1, 0.5, INK, 0, 11.25, 0),
    // The yoke across the belfry.
    bx(0.18, 0.18, 2.6, wood, 0, 6.75, 0),
    // The beam out of the tower's back wall that the rope comes down from, into the nave.
    bx(1.7, 0.18, 0.18, wood, -2.3, 3.55, 0),
    // Pews in two rows either side of the aisle, a few knocked askew, and the altar.
    ...[-5, -6.4, -7.8, -9.2, -10.6].flatMap((x, i) => [-1, 1].flatMap((z) => swing([
      bx(0.42, 0.06, 2.2, wood, x, 0.42, z * 1.8),
      bx(0.06, 0.5, 2.2, PAL.woodDark, x - 0.22, 0.65, z * 1.8),
      bx(0.44, 0.42, 0.06, PAL.woodDark, x, 0.21, z * 1.8 + 1.08), bx(0.44, 0.42, 0.06, PAL.woodDark, x, 0.21, z * 1.8 - 1.08),
    ], x, 0, z * 1.8, 0, i === 2 && z > 0 ? 0.4 : i === 4 && z < 0 ? -0.25 : 0, 0))),
    bx(1, 0.95, 2.4, 0xb4ac96, -13.4, 0.48, 0),
    bx(1.1, 0.06, 2.6, dressed, -13.4, 0.97, 0),
    bx(1.04, 0.5, 1.2, PAL.purple, -13.4, 0.78, 0),
    ...both((s) => [cy(0.04, 0.4, bronze, -13.4, 1.2, s * 0.9)]),
  ];
  if (open) p.push(
    // The bell swung up on its yoke, mouth out, the clapper against its lip; the rope taut.
    part(cyl(0.38, 0.8, 0.95, 12), bronze, 0.3, 6.25, 0, 0, 0, -0.75),
    part(cyl(0.24, 0.24, 0.15, 10), bronze, 0.05, 6.6, 0, 0, 0, -0.75),
    bx(0.1, 0.55, 0.1, 0x3a3428, 0.62, 6.15, 0, 0, 0, -1.1),
    bx(0.05, 3.1, 0.05, 0x8a7a5a, -3.1, 2.0, 0, 0, 0, 0.1),
  );
  else p.push(
    part(cyl(0.38, 0.8, 0.95, 12), bronze, 0, 6.1, 0),
    part(cyl(0.24, 0.24, 0.15, 10), bronze, 0, 6.6, 0),
    bx(0.1, 0.55, 0.1, 0x3a3428, 0, 5.75, 0),
    bx(0.05, 3.0, 0.05, 0x8a7a5a, -3, 2.05, 0),
    cy(0.1, 0.08, 0x8a7a5a, -3, 0.55, 0, PI / 2, 0, 0),
  );
  return p;
}

// A shrine, from the spot before its altar, +x towards its gate (the altar's stones and the
// pillars are its walls, terrain.ts). On the altar an old sword stands driven point down into
// the stone, a red cloth knotted round its guard, candles in jars round it and what people
// left at its foot: flowers gone dry in a tin, photographs, coins. Stone lanterns flank the
// court and the gate's fallen lintel lies outside it. Taken (open), there is only the slot it
// stood in, the cloth dropped and the candles cold.
function shrineProp(open: boolean): Part[] {
  const stone = 0x7e8070, gold = 0x9a7a38, wax = 0xc8bea0, steel = 0xa8aca4, top = 0.82, ax = -1;
  const p: Part[] = [];
  if (!open) p.push(
    // The blade in the stone, its fuller, the cross guard, the wrapped grip and the pommel.
    bx(0.06, 1.05, 0.2, steel, ax, top + 0.52, 0),
    bx(0.065, 0.85, 0.04, darker(steel, 0.75), ax, top + 0.58, 0),
    bx(0.1, 0.08, 0.66, PAL.steelDark, ax, top + 1.08, 0),
    ...both((s) => [bx(0.11, 0.1, 0.08, PAL.steelDark, ax, top + 1.1, s * 0.33)]),
    bx(0.08, 0.34, 0.08, PAL.leatherDark, ax, top + 1.29, 0),
    ...[1.18, 1.26, 1.34, 1.42].map((y) => bx(0.085, 0.02, 0.085, PAL.leather, ax, top + y, 0)),
    part(new THREE.OctahedronGeometry(0.08, 0), gold, ax, top + 1.52, 0),
    // The red cloth knotted at the guard, its ends hanging.
    bx(0.1, 0.08, 0.1, PAL.medRed, ax, top + 1.08, 0.12),
    bx(0.03, 0.4, 0.08, PAL.medRed, ax + 0.03, top + 0.86, 0.16, 0.1, 0, 0.1),
    bx(0.03, 0.3, 0.07, darker(PAL.medRed, 0.8), ax - 0.02, top + 0.9, 0.08, -0.1, 0, -0.05),
  );
  else p.push(
    bx(0.08, 0.02, 0.24, INK, ax, top + 0.01, 0),
    bx(0.4, 0.02, 0.1, PAL.medRed, ax + 0.9, 0.01, 0.6, 0, 0.6, 0),
  );
  // Candles in jars along the altar, lit while the blade is there.
  for (const z of [-1.2, -0.75, 0.75, 1.2]) {
    const h = 0.12 + Math.abs(z) * 0.05;
    p.push(bx(0.1, h + 0.02, 0.1, 0x6a7a70, ax - 0.05, top + (h + 0.02) / 2, z), bx(0.07, h, 0.07, wax, ax - 0.05, top + h / 2 + 0.01, z));
    if (!open) p.push(bx(0.04, 0.07, 0.04, 0xffc040, ax - 0.05, top + h + 0.06, z));
  }
  p.push(
    // At the altar's foot: dry flowers in a tin, photographs propped, a bowl and coins.
    cy(0.08, 0.18, PAL.steel, -0.4, 0.09, 0.55),
    ...[[-0.08, 0.04], [0.05, -0.06], [0.0, 0.08]].map(([dx, dz], i) => rod(-0.4, 0.15, 0.55, -0.4 + dx * 3, 0.45, 0.55 + dz * 3, 0.025, i === 1 ? 0x6a4a3a : 0x6a6a3e)),
    ...[[-0.4, 0.5], [-0.38, 0.95]].map(([x, z]) => bx(0.02, 0.18, 0.13, 0xb4ac94, x, top + 0.09, z, 0, 0, 0.25)),
    bx(0.01, 0.13, 0.09, 0x5a4e3e, -0.385, top + 0.1, 0.5, 0, 0, 0.25),
    part(cyl(0.13, 0.08, 0.08, 8), 0x6a5a40, -0.35, 0.04, -0.5),
    ...[[-0.45, -0.3], [-0.3, -0.25], [-0.5, -0.15]].map(([x, z]) => bx(0.06, 0.015, 0.06, gold, x, 0.008, z)),
  );
  // Stone lanterns either side of the court: a foot, a post, the light box, a roof.
  for (const z of [-4.5, 4.5]) p.push(
    bx(0.5, 0.15, 0.5, 0x5e6052, 5, 0.08, z),
    bx(0.18, 0.7, 0.18, stone, 5, 0.5, z),
    bx(0.42, 0.34, 0.42, 0x8a8c7c, 5, 1.02, z),
    bx(0.2, 0.18, 0.44, open ? 0x2a2a26 : 0xe0a040, 5, 1.02, z),
    part(cyl(0.05, 0.42, 0.22, 4), 0x5e6052, 5, 1.3, z, 0, PI / 4, 0),
  );
  // The gate's lintel, fallen across outside it, and a block knocked off with it.
  p.push(bx(0.42, 0.34, 7.6, 0x6e7062, 10.4, 0.17, 0.3, 0, 0.12, 0.05), bx(0.6, 0.4, 0.6, stone, 11.1, 0.2, -2.6, 0, 0.6, 0.2));
  // Broken flagstones heaved up in the court.
  p.push(bx(0.7, 0.08, 0.6, 0x76766a, 2.2, 0.06, 1.6, 0.1, 0.4, 0.06), bx(0.6, 0.08, 0.7, 0x7a7a6e, 6.4, 0.06, -1.4, -0.08, 0.2, 0.1));
  return p;
}

// The gas station's canopy over its pumps, rusted through: posts on the islands, the fascia
// round the edge, cross beams, and what is left of the roof; and the price sign by the road.
function canopy(sites: SiteDef[]): THREE.BufferGeometry | null {
  // The shop's own pumps: those on its forecourt.
  const shop = sites.find((s) => s.kind === SiteKind.Station);
  if (!shop) return null;
  const pumps = sites.filter((s) => s.kind === SiteKind.Pump && Math.hypot(s.sx - shop.sx, s.sy - shop.sy) < 16);
  if (!pumps.length) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, fx = 0, fz = 0;
  for (const p of pumps) {
    x0 = Math.min(x0, p.sx); x1 = Math.max(x1, p.sx); z0 = Math.min(z0, p.sy); z1 = Math.max(z1, p.sy);
    fx += p.sx / pumps.length; fz += p.sy / pumps.length;
  }
  x0 -= 1.9; x1 += 1.9; z0 -= 1.9; z1 += 1.9;
  const top = 3.3, w = x1 - x0, d = z1 - z0, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const white = 0xb2ac98, red = 0x9a3424, steel = PAL.steel, rust = PAL.rust;
  const p: Part[] = [];
  // A post between the two pumps of each island, on a plinth.
  for (let i = 0; i < pumps.length; i++) for (let j = i + 1; j < pumps.length; j++) {
    const a = pumps[i], b = pumps[j];
    if (Math.abs(Math.hypot(a.sx - b.sx, a.sy - b.sy) - 2) < 0.1) {
      const px = (a.sx + b.sx) / 2, pz = (a.sy + b.sy) / 2;
      p.push(bx(0.22, top, 0.22, 0xa8a290, px, top / 2, pz), bx(0.34, 0.4, 0.34, PAL.concrete, px, 0.2, pz), bx(0.24, 0.3, 0.012, rust, px, 0.55, pz + 0.116));
    }
  }
  // The fascia: white with a red band, a gap torn out of one side.
  for (const z of [z0, z1]) p.push(bx(w, 0.42, 0.12, white, mx, top + 0.1, z), bx(w + 0.02, 0.12, 0.14, red, mx, top + 0.04, z), bx(w * 0.3, 0.2, 0.13, rust, mx + w * 0.2, top + 0.2, z));
  for (const x of [x0, x1]) {
    p.push(bx(0.12, 0.42, d * 0.55, white, x, top + 0.1, z0 + d * 0.275), bx(0.14, 0.12, d * 0.55 + 0.02, red, x, top + 0.04, z0 + d * 0.275));
    p.push(bx(0.12, 0.42, d * 0.3, white, x, top - 0.25, z1 - d * 0.15, 0.35, 0, 0));
  }
  // Beams across, and the roof panels still up, a few hanging.
  for (let z = z0 + 1; z < z1; z += 1.6) p.push(bx(w, 0.1, 0.1, steel, mx, top + 0.18, z));
  let k = 0;
  for (let x = x0 + 0.8; x < x1 - 0.4; x += 1.6) for (let z = z0 + 0.8; z < z1 - 0.4; z += 1.6) {
    const h = hash(k++, 41);
    // Never over a pump: the pumps are what a survivor has to see from up here.
    if (pumps.some((q) => Math.abs(q.sx - x) < 0.9 && Math.abs(q.sy - z) < 0.9)) continue;
    if (h < 0.4) p.push(bx(1.55, 0.05, 1.55, h < 0.1 ? rust : 0x9a968a, x, top + 0.26, z));
    else if (h < 0.5) p.push(bx(1.5, 0.04, 1.5, rust, x, top - 0.35, z, h * 6, 0, 0.5));
  }
  // The price sign on its pole at the kerb, facing the road.
  const dx = fx - (shop.x + shop.w / 2), dz = fz - (shop.y + shop.h / 2), along = Math.abs(dx) > Math.abs(dz);
  const ux = along ? Math.sign(dx) : 0, uz = along ? 0 : Math.sign(dz);
  const sx = mx + ux * (along ? w / 2 + 1.6 : 0) + (along ? 0 : w / 2 + 1.2), sz = mz + uz * (along ? 0 : d / 2 + 1.6) + (along ? d / 2 + 1.2 : 0);
  const thin = (a: number, b: number) => (along ? [a, b] : [b, a]);
  const [bw, bd] = thin(0.18, 1.3), [lw, ld] = thin(0.2, 1.32);
  p.push(
    part(cyl(0.09, 0.11, 4.6, 6), steel, sx, 2.3, sz),
    bx(bw, 0.7, bd, red, sx, 4.6, sz),
    bx(lw, 1.0, ld, white, sx, 3.75, sz),
    ...[3.95, 3.6].map((y) => bx(lw + 0.02, 0.1, ld * 0.7, INK, sx, y, sz)),
  );
  return merge(p);
}

// Indexed by propKind, with the units a metre each is built in.
const PROPS: [(open: boolean) => Part[], number][] = [[houseProp, MAN], [carProp, VEH], [crateProp, MAN], [pickupProp, VEH], [policeProp, VEH], [ambulanceProp, VEH],
  [busProp, VEH], [armyProp, VEH], [counterProp, MAN], [pumpProp, MAN], [fireProp, VEH], [armoredProp, VEH], [camperProp, VEH], [motoProp, 0.7],
  [planeProp, 1], [engineProp, 1], [churchProp, 1], [shrineProp, 1]];
// Wrecks that take a coat of faded paint.
const PAINTED = new Set<number>([SiteKind.Car, SiteKind.Pickup, SiteKind.Moto]);
// The glint over the plane is over its hold, not its tail.
const PLANE_GLINT = 3.4;

// Loot sites: a prop per site, instanced per kind and state, and a pulsing glint over the
// ones nobody has searched yet.
export class Loot {
  group = new THREE.Group();
  private mat = painted(new THREE.MeshLambertNodeMaterial({ vertexColors: true }));
  private glintMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private geos: THREE.BufferGeometry[] = [];
  // How high each kind's glint hangs: over the top of its closed prop.
  private glintY: number[] = [];
  // [kind * 2 + opened]
  private meshes: THREE.InstancedMesh[] = [];
  private glints: THREE.InstancedMesh;
  private sites: SiteDef[] = [];
  // Per site: where the prop stands and which way it faces.
  private px = new Float32Array(0); private pz = new Float32Array(0); private yaw = new Float32Array(0);
  private sig = '';
  private roof: THREE.Mesh | null = null;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    for (const [mk, k] of PROPS) for (const open of [false, true]) {
      const g = merge(mk(open));
      if (k !== 1) g.scale(k, k, k);
      g.computeBoundingBox();
      if (!open) this.glintY.push(mk === planeProp ? PLANE_GLINT : g.boundingBox!.max.y + 0.4);
      this.geos.push(g);
    }
    const pulse = sin(time.mul(3.2).add(positionWorld.x.mul(1.7)).add(positionWorld.z.mul(2.3))).mul(0.4).add(0.8);
    this.glintMat.colorNode = color(0xffc850).mul(pulse);
    this.glintMat.fog = false;
    this.glints = new THREE.InstancedMesh(octa(0.15), this.glintMat, 1);
    this.glints.frustumCulled = false;
    this.glints.count = 0;
    this.glints.renderOrder = 3;
    this.group.add(this.glints);
  }

  setup(sites: SiteDef[]): void {
    for (const m of this.meshes) { this.group.remove(m); m.dispose(); }
    this.meshes = [];
    if (this.roof) { this.group.remove(this.roof); this.roof.geometry.dispose(); this.roof = null; }
    const roof = canopy(sites);
    if (roof) {
      this.roof = new THREE.Mesh(roof, this.mat);
      this.roof.castShadow = true; this.roof.receiveShadow = true;
      this.group.add(this.roof);
    }
    // The pumps face the road: away from the shop. The plane's engines lie along its line.
    const shop = sites.find((s) => s.kind === SiteKind.Station), plane = sites.find((s) => s.kind === SiteKind.Plane);
    this.sites = sites;
    this.sig = '';
    const n = sites.length;
    this.px = new Float32Array(n); this.pz = new Float32Array(n); this.yaw = new Float32Array(n);
    const counts = PROPS.map(() => 0);
    sites.forEach((s, i) => {
      counts[propKind(s.kind)] = (counts[propKind(s.kind)] ?? 0) + 1;
      if (s.kind === SiteKind.Pump) {
        this.px[i] = s.sx; this.pz[i] = s.sy;
        const dx = shop ? s.sx - (shop.x + shop.w / 2) : 1, dz = shop ? s.sy - (shop.y + shop.h / 2) : 0;
        this.yaw[i] = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 0 : Math.PI) : (dz > 0 ? Math.PI / 2 : -Math.PI / 2);
        return;
      }
      if (s.kind === SiteKind.Plane || s.kind === SiteKind.Tank) {
        this.px[i] = s.sx; this.pz[i] = s.sy;
        this.yaw[i] = (plane?.yaw ?? 0) + (s.kind === SiteKind.Tank ? (hash(i, 1) - 0.5) * 1.2 : 0);
        return;
      }
      if (s.kind === SiteKind.Church) {
        const y = s.yaw ?? 0;
        this.px[i] = s.x + s.w / 2 + Math.cos(y) * TOWER_OFF; this.pz[i] = s.y + s.h / 2 + Math.sin(y) * TOWER_OFF;
        this.yaw[i] = y;
        return;
      }
      if (s.kind === SiteKind.Shrine) {
        this.px[i] = s.sx; this.pz[i] = s.sy; this.yaw[i] = Math.round((s.yaw ?? 0) / (Math.PI / 2)) * Math.PI / 2;
        return;
      }
      if (!walled(s.kind)) {
        this.px[i] = siteX(s); this.pz[i] = siteY(s);
        this.yaw[i] = wreck(s.kind) ? s.yaw ?? hash(i, 1) * 6.28 : (Math.floor(hash(i, 1) * 4) + (hash(i, 2) - 0.5) * 0.4) * Math.PI / 2;
        return;
      }
      // Beside the searcher, towards the roomiest side of the house, facing back at the spot.
      const room = [s.x + s.w - 1 - s.sx, s.y + s.h - 1 - s.sy, s.sx - s.x - 1, s.sy - s.y - 1];
      let k = 0;
      for (let d = 1; d < 4; d++) if (room[d] > room[k]) k = d;
      const off = Math.max(0, Math.min(0.75, room[k] - 0.6));
      const a = k * Math.PI / 2;
      this.px[i] = s.sx + Math.cos(a) * off; this.pz[i] = s.sy + Math.sin(a) * off;
      this.yaw[i] = a + Math.PI;
    });
    for (let k = 0; k < PROPS.length * 2; k++) {
      const cap = Math.max(1, counts[k >> 1] ?? 0);
      const m = new THREE.InstancedMesh(this.geos[k], this.mat, cap);
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.meshes.push(m);
      this.group.add(m);
    }
    if (this.glints.instanceMatrix.count < n) {
      this.group.remove(this.glints);
      this.glints.dispose();
      this.glints = new THREE.InstancedMesh(this.glints.geometry, this.glintMat, Math.max(1, n));
      this.glints.frustumCulled = false; this.glints.renderOrder = 3; this.glints.count = 0;
      this.group.add(this.glints);
    }
  }

  // Re-lays the props when a site changes state.
  private lay(game: Game): void {
    const f = game.cur;
    const fill = this.meshes.map(() => 0);
    const c = new THREE.Color();
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      const pk = propKind(s.kind);
      if (pk < 0 || pk >= PROPS.length) continue;
      const open = f.siteSearched(i);
      const k = pk * 2 + (open ? 1 : 0), m = this.meshes[k], j = fill[k]++;
      writeMatrix(m.instanceMatrix.array as Float32Array, j * 16, this.px[i], 0, this.pz[i], this.yaw[i], 1);
      if (PAINTED.has(s.kind)) c.copy(lin(PAINT[Math.floor(hash(i, 3) * PAINT.length)])).multiplyScalar(1 / lin(CAR_BODY).r);
      else c.setRGB(1, 1, 1);
      // Searched props sit a shade darker, picked over and dusty.
      const b = (open ? 0.72 : 1) * (0.9 + hash(i, 4) * 0.2);
      (m.instanceColor!.array as Float32Array).set([c.r * b, c.g * b, c.b * b], j * 3);
    }
    this.meshes.forEach((m, k) => {
      m.count = fill[k];
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.needsUpdate = true;
    });
  }

  update(game: Game, now: number): void {
    // The lab's line-up (#lab=loot) brings sites of its own after the welcome, and stands them
    // on its stage.
    const ws = game.welcome?.sites;
    if (ws && ws !== this.sites && ws.length > this.sites.length) { this.setup(ws); this.group.visible = true; }
    const f = game.cur;
    if (!this.sites.length) { this.glints.count = 0; return; }
    let sig = '' + f.nSites;
    for (let i = 0; i < f.nSites; i++) sig += ',' + f.sites[i];
    if (sig !== this.sig) { this.sig = sig; this.lay(game); }
    // Glints bob and turn; each its own phase.
    const t = now / 1000, a = this.glints.instanceMatrix.array as Float32Array;
    // In brutal's night a glint shows only where someone lights it.
    const lit = game.lightOnly() ? game.vision : null;
    let n = 0;
    for (let i = 0; i < this.sites.length; i++) {
      if (f.siteSearched(i) || !lootable(this.sites[i].kind) || game.unfound(i)) continue;
      if (lit && !lit.sees(this.px[i], this.pz[i])) continue;
      const k = propKind(this.sites[i].kind), ph = hash(i, 5) * 6.28;
      const s = 1 + 0.18 * Math.sin(t * 3.2 + ph);
      writeMatrix(a, n++ * 16, this.px[i], (this.glintY[k] ?? 1.2) + Math.sin(t * 1.8 + ph) * 0.08, this.pz[i], t * 1.5 + ph, s, s * 1.6);
    }
    this.glints.count = n;
    this.glints.instanceMatrix.needsUpdate = true;
  }
}
