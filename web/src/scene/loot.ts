import * as THREE from 'three/webgpu';
import { color, positionWorld, sin, time } from 'three/tsl';
import { lootable, propKind, type SiteDef, SiteKind, siteX, siteY, walled, wreck } from '../protocol';
import type { Game } from '../state';
import { box, cyl, lin, merge, octa, part, writeMatrix, type Part } from './util';

function hash(i: number, s: number): number {
  let h = Math.imul(i * 374761393 + s * 668265263, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Car paint, faded: tints over a light grey body.
const PAINT = [0x7d8c99, 0x8f5a48, 0x6d7a58, 0xb2a88c, 0x9a9890, 0x5e6a78];
const CAR_BODY = 0xc8c8c8;
const GLINT_Y = [1.65, 1.35, 1.05, 1.35, 1.45, 1.8, 1.85, 1.85, 1.75, 0, 1.75, 1.55, 1.85, 0.9, 3.4, 0];

// Props face +x and stand on y = 0. Each kind comes closed (still worth a search) and opened.
function houseProp(open: boolean): Part[] {
  const p: Part[] = [
    // A fridge, a kitchen cabinet and a stack of moving boxes.
    part(box(0.5, 1.1, 0.5), 0xd2cebe, 0, 0.55, 0),
    part(box(0.52, 0.04, 0.52), 0x9a968a, 0, 0.72, 0),
    part(box(0.42, 0.62, 0.72), 0x7a5a3a, 0.02, 0.31, 0.66),
    part(box(0.48, 0.05, 0.78), 0x5a4028, 0.02, 0.64, 0.66),
  ];
  if (open) p.push(
    // The fridge door hangs open on a dark, empty inside; a drawer is pulled; the boxes are tipped.
    part(box(0.02, 1.0, 0.44), 0x2e2c28, 0.26, 0.55, 0),
    part(box(0.48, 1.0, 0.04), 0xc4c0b0, 0.42, 0.55, -0.42, 0, -0.5, 0),
    part(box(0.3, 0.14, 0.62), 0x8a6a46, 0.32, 0.45, 0.66),
    part(box(0.36, 0.3, 0.36), 0x9a7e52, 0.32, 0.15, -0.62, 0, 0.6, 1.3),
    part(box(0.3, 0.02, 0.3), 0xa88a5a, 0.55, 0.02, -0.35, 0, 0.3, 0),
    part(box(0.26, 0.24, 0.26), 0xb89a68, 0.05, 0.12, -0.85, 0, 0.2, 0),
  );
  else p.push(
    part(box(0.02, 1.0, 0.46), 0xb8b4a4, 0.26, 0.55, 0),
    part(box(0.04, 0.26, 0.04), 0x55524a, 0.28, 0.82, 0.17),
    part(box(0.04, 0.03, 0.3), 0x55524a, 0.24, 0.46, 0.66),
    part(box(0.36, 0.3, 0.36), 0xa88a5a, 0.3, 0.15, -0.55, 0, 0.3, 0),
    part(box(0.38, 0.02, 0.06), 0xc8b890, 0.3, 0.305, -0.55, 0, 0.3, 0),
    part(box(0.3, 0.26, 0.3), 0xb89a68, 0.32, 0.43, -0.52, 0, -0.2, 0),
  );
  return p;
}

function carProp(open: boolean): Part[] {
  const dark = 0x24282a, rust = 0x6a3a22;
  const p: Part[] = [
    part(box(1.6, 0.34, 0.86), CAR_BODY, 0, 0.36, 0),
    part(box(0.86, 0.3, 0.78), CAR_BODY, -0.12, 0.68, 0),
    part(box(0.7, 0.17, 0.8), dark, -0.12, 0.7, 0),
    part(box(0.03, 0.22, 0.7), dark, 0.32, 0.68, 0, 0, 0, 0.5),
    part(box(0.03, 0.2, 0.7), dark, -0.56, 0.68, 0, 0, 0, -0.4),
    part(box(0.06, 0.1, 0.88), 0x6a6a64, 0.81, 0.27, 0),
    part(box(0.06, 0.1, 0.88), 0x6a6a64, -0.81, 0.27, 0),
    part(box(0.03, 0.06, 0.16), 0xb8b090, 0.81, 0.4, 0.3),
    part(box(0.03, 0.06, 0.16), 0x5a2a20, -0.81, 0.4, -0.3),
    // Rust on the roof, the boot and down one flank.
    part(box(0.26, 0.02, 0.22), rust, -0.3, 0.835, 0.16, 0, 0.3, 0),
    part(box(0.34, 0.02, 0.5), rust, -0.62, 0.535, -0.1),
    part(box(0.45, 0.2, 0.02), rust, 0.2, 0.32, 0.435),
    // Flat tyres.
    ...[[0.5, 0.4], [0.5, -0.4], [-0.5, 0.4], [-0.5, -0.4]].map(([x, z]) => part(cyl(0.18, 0.18, 0.12, 8), 0x1c1c1c, x, 0.14, z, Math.PI / 2, 0, 0, 1, 1, 0.8)),
  ];
  if (open) p.push(
    // Bonnet up over a dark engine bay; the driver's door hangs open.
    part(box(0.5, 0.03, 0.84), CAR_BODY, 0.48, 0.82, 0, 0, 0, 1.0),
    part(box(0.46, 0.04, 0.74), 0x2a2826, 0.56, 0.53, 0),
    part(box(0.18, 0.1, 0.2), 0x4a4a46, 0.6, 0.57, 0.15),
    part(box(0.5, 0.3, 0.03), CAR_BODY, 0.2, 0.5, 0.62, 0, -0.75, 0),
    part(box(0.48, 0.03, 0.04), dark, 0.2, 0.62, 0.66, 0, -0.75, 0),
  );
  else p.push(
    part(box(0.5, 0.03, 0.84), CAR_BODY, 0.55, 0.545, 0),
    part(box(0.45, 0.24, 0.02), 0x8a8a84, -0.12, 0.42, 0.435),
  );
  return p;
}

function crateProp(open: boolean): Part[] {
  const green = 0x4e5a34, band = 0xc8b674;
  const p: Part[] = [
    part(box(0.92, 0.06, 0.72), 0x7a6040, 0, 0.1, 0),
    ...[-0.3, 0, 0.3].map((z) => part(box(0.92, 0.07, 0.1), 0x6a5034, 0, 0.035, z)),
    part(box(0.8, 0.46, 0.56), green, 0, 0.36, 0),
    part(box(0.82, 0.08, 0.58), band, 0, 0.42, 0),
    // Stencilled marks on the front and a rope handle each end.
    part(box(0.02, 0.06, 0.22), 0xded6b4, 0.41, 0.25, -0.08),
    part(box(0.02, 0.06, 0.08), 0xded6b4, 0.41, 0.25, 0.15),
    part(box(0.08, 0.05, 0.03), 0x2a2a22, 0, 0.5, 0.29),
    part(box(0.08, 0.05, 0.03), 0x2a2a22, 0, 0.5, -0.29),
  ];
  if (open) p.push(
    // The lid leans against the side; the crate stands empty and dark.
    part(box(0.72, 0.02, 0.48), 0x1a1c14, 0, 0.585, 0),
    part(box(0.84, 0.05, 0.6), 0x445030, 0, 0.34, -0.42, 1.25, 0, 0),
    part(box(0.2, 0.08, 0.12), 0x8a7a50, 0.55, 0.04, 0.3, 0, 0.5, 0),
  );
  else p.push(
    part(box(0.84, 0.06, 0.6), 0x445030, 0, 0.62, 0),
    part(box(0.86, 0.02, 0.08), band, 0, 0.655, 0),
  );
  return p;
}

const tyre = (x: number, z: number, r = 0.18) => part(cyl(r, r, 0.12, 8), 0x1c1c1c, x, r * 0.78, z, Math.PI / 2, 0, 0, 1, 1, 0.8);

// A pickup: cab up front, an open bed behind with a toolbox and a jerrycan. Paint-tinted.
function pickupProp(open: boolean): Part[] {
  const dark = 0x24282a, rust = 0x6a3a22;
  const p: Part[] = [
    part(box(0.62, 0.32, 0.9), CAR_BODY, 0.6, 0.38, 0),
    part(box(0.56, 0.62, 0.9), CAR_BODY, 0.06, 0.53, 0),
    part(box(0.03, 0.24, 0.8), dark, 0.35, 0.72, 0, 0, 0, 0.3),
    part(box(0.4, 0.2, 0.92), dark, 0.06, 0.72, 0),
    part(box(0.96, 0.1, 0.9), 0x8a8a84, -0.7, 0.3, 0),
    part(box(0.96, 0.3, 0.06), CAR_BODY, -0.7, 0.5, 0.42),
    part(box(0.96, 0.3, 0.06), CAR_BODY, -0.7, 0.5, -0.42),
    part(box(0.06, 0.1, 0.9), 0x6a6a64, 0.92, 0.27, 0),
    part(box(0.03, 0.06, 0.16), 0xb8b090, 0.92, 0.42, 0.3),
    part(box(0.3, 0.02, 0.4), rust, 0.6, 0.545, 0.1),
    part(box(0.4, 0.18, 0.02), rust, -0.6, 0.48, 0.455),
    tyre(0.58, 0.42), tyre(0.58, -0.42), tyre(-0.66, 0.42), tyre(-0.66, -0.42),
  ];
  if (open) p.push(
    // The tailgate down, the toolbox open and empty, the can tipped over.
    part(box(0.06, 0.3, 0.84), CAR_BODY, -1.3, 0.24, 0, 0, 0, 1.3),
    part(box(0.5, 0.06, 0.24), 0x8a2a20, -0.5, 0.38, -0.2),
    part(box(0.5, 0.2, 0.02), 0x8a2a20, -0.5, 0.48, -0.33, 0.9, 0, 0),
    part(box(0.18, 0.14, 0.26), 0x5a6a3a, -1.5, 0.07, 0.25, 0, 0.4, Math.PI / 2),
  );
  else p.push(
    part(box(0.06, 0.3, 0.9), CAR_BODY, -1.18, 0.5, 0),
    part(box(0.5, 0.18, 0.24), 0xb83a2a, -0.5, 0.44, -0.2),
    part(box(0.18, 0.26, 0.14), 0x5a6a3a, -0.95, 0.48, 0.24),
    part(box(0.36, 0.2, 0.3), 0xa88a5a, -0.8, 0.45, -0.05),
  );
  return p;
}

// A police cruiser: black and white with the light bar still on the roof.
function policeProp(open: boolean): Part[] {
  const white = 0xd8d6cc, black = 0x1c1e22, dark = 0x24282a;
  const p: Part[] = [
    part(box(1.66, 0.34, 0.88), black, 0, 0.36, 0),
    part(box(0.6, 0.3, 0.9), white, 0.0, 0.37, 0),
    part(box(0.88, 0.3, 0.8), white, -0.12, 0.68, 0),
    part(box(0.72, 0.17, 0.82), dark, -0.12, 0.7, 0),
    part(box(0.2, 0.08, 0.6), 0x2a2a2e, -0.12, 0.87, 0),
    part(box(0.18, 0.07, 0.24), 0xc02a22, -0.12, 0.9, 0.17),
    part(box(0.18, 0.07, 0.24), 0x2a4ac0, -0.12, 0.9, -0.17),
    part(box(0.1, 0.12, 0.86), 0x3a3a3a, 0.86, 0.3, 0),
    part(box(0.03, 0.06, 0.16), 0xd8d4b0, 0.84, 0.42, 0.3),
    part(box(0.03, 0.06, 0.16), 0xd8d4b0, 0.84, 0.42, -0.3),
    part(box(0.3, 0.06, 0.02), 0xc8b674, 0.0, 0.44, 0.452),
    tyre(0.52, 0.4), tyre(0.52, -0.4), tyre(-0.52, 0.4), tyre(-0.52, -0.4),
  ];
  if (open) p.push(
    // The boot lid up on an empty rack; a door wide open.
    part(box(0.4, 0.03, 0.84), black, -0.86, 0.75, 0, 0, 0, -1.1),
    part(box(0.36, 0.04, 0.74), 0x2a2826, -0.62, 0.53, 0),
    part(box(0.5, 0.3, 0.03), white, 0.2, 0.5, 0.64, 0, -0.8, 0),
  );
  else p.push(
    part(box(0.5, 0.03, 0.86), black, 0.56, 0.545, 0),
    part(box(0.4, 0.03, 0.86), black, -0.62, 0.545, 0),
  );
  return p;
}

// An ambulance: a cab and a tall white box with the red stripe and cross.
function ambulanceProp(open: boolean): Part[] {
  const white = 0xe2e0d6, red = 0xb8302a, dark = 0x24282a;
  const p: Part[] = [
    part(box(0.56, 0.4, 0.92), white, 0.78, 0.42, 0),
    part(box(0.36, 0.34, 0.92), white, 0.48, 0.78, 0),
    part(box(0.03, 0.22, 0.84), dark, 0.67, 0.78, 0, 0, 0, 0.35),
    part(box(1.26, 1.04, 1.0), white, -0.36, 0.72, 0),
    part(box(1.28, 0.1, 1.02), red, -0.36, 0.62, 0),
    part(box(0.36, 0.1, 0.02), red, -0.36, 0.95, 0.51),
    part(box(0.1, 0.36, 0.02), red, -0.36, 0.95, 0.51),
    part(box(0.36, 0.1, 0.02), red, -0.36, 0.95, -0.51),
    part(box(0.1, 0.36, 0.02), red, -0.36, 0.95, -0.51),
    part(box(0.12, 0.06, 0.6), 0x8a2a24, 0.48, 0.98, 0),
    part(box(0.06, 0.1, 0.9), 0x6a6a64, 1.06, 0.27, 0),
    part(box(0.3, 0.3, 0.02), 0x8a6a4a, -0.6, 0.86, 0.505),
    tyre(0.74, 0.44, 0.2), tyre(0.74, -0.44, 0.2), tyre(-0.62, 0.44, 0.2), tyre(-0.62, -0.44, 0.2),
  ];
  if (open) p.push(
    // Back doors swung wide on a dark, ransacked inside; the stretcher pulled out.
    part(box(0.02, 0.9, 0.92), 0x2a2622, -0.995, 0.72, 0),
    part(box(0.48, 0.88, 0.04), white, -1.2, 0.72, 0.68, 0, -1.2, 0),
    part(box(0.48, 0.88, 0.04), white, -1.2, 0.72, -0.68, 0, 1.2, 0),
    part(box(0.9, 0.06, 0.34), 0x9a9a92, -1.45, 0.42, 0, 0, 0, 0.15),
    part(box(0.86, 0.04, 0.3), 0x5a7a8a, -1.45, 0.47, 0, 0, 0, 0.15),
    part(box(0.04, 0.38, 0.04), 0x6a6a64, -1.85, 0.2, 0.12),
  );
  else p.push(
    part(box(0.02, 0.88, 0.9), 0xd0cec4, -0.995, 0.72, 0),
    part(box(0.02, 0.2, 0.3), 0x3a4a50, -1.0, 0.98, 0.22),
    part(box(0.02, 0.2, 0.3), 0x3a4a50, -1.0, 0.98, -0.22),
  );
  return p;
}

// A school bus, rusting yellow, its windows a dark band down each side.
function busProp(open: boolean): Part[] {
  const yellow = 0xd0a028, black = 0x22201c, rust = 0x7a4020;
  const p: Part[] = [
    part(box(2.9, 0.62, 1.06), yellow, -0.1, 0.62, 0),
    part(box(2.9, 0.4, 1.0), yellow, -0.1, 1.13, 0),
    part(box(2.92, 0.06, 1.08), black, -0.1, 0.92, 0),
    part(box(2.92, 0.06, 1.08), black, -0.1, 0.5, 0),
    part(box(2.6, 0.24, 1.02), 0x2a2e30, -0.2, 1.12, 0),
    part(box(0.5, 0.48, 1.04), yellow, 1.5, 0.5, 0),
    part(box(0.06, 0.12, 1.0), black, 1.76, 0.36, 0),
    part(box(0.03, 0.34, 0.86), 0x2a2e30, 1.25, 1.08, 0, 0, 0, 0.12),
    part(box(0.03, 0.08, 0.2), 0xd8d4b0, 1.76, 0.56, 0.36),
    part(box(0.03, 0.08, 0.2), 0xd8d4b0, 1.76, 0.56, -0.36),
    part(box(0.18, 0.04, 0.02), 0xc02a22, 1.2, 1.16, 0.525),
    part(box(0.8, 0.02, 0.6), rust, -0.6, 1.335, 0.1),
    part(box(0.7, 0.3, 0.02), rust, -1.0, 0.62, -0.535),
    part(box(0.5, 0.2, 0.02), rust, 0.5, 0.48, 0.535),
    tyre(1.25, 0.48, 0.22), tyre(1.25, -0.48, 0.22), tyre(-0.9, 0.48, 0.22), tyre(-0.9, -0.48, 0.22),
  ];
  if (open) p.push(
    // The folding door gaping, the rear emergency door hanging off, seats and bags thrown out.
    part(box(0.34, 0.8, 0.02), 0x1a1a18, 1.0, 0.72, 0.535),
    part(box(0.04, 0.8, 0.5), yellow, -1.6, 0.6, 0.55, 0, 0.9, 0),
    part(box(0.02, 0.8, 0.6), 0x1a1a18, -1.555, 0.78, 0),
    part(box(0.5, 0.12, 0.3), 0x6a3a2a, -2.0, 0.06, 0.4, 0, 0.6, 0),
    part(box(0.22, 0.18, 0.12), 0x3a5a8a, 0.9, 0.09, 0.85, 0, 0.3, 0),
    part(box(0.2, 0.16, 0.12), 0xc84a2a, 0.6, 0.08, 1.05, 0, -0.5, 0),
  );
  else p.push(
    part(box(0.34, 0.8, 0.02), 0x2a2e30, 1.0, 0.72, 0.535),
    part(box(0.02, 0.8, 0.6), yellow, -1.555, 0.78, 0),
    part(box(0.02, 0.24, 0.4), 0x2a2e30, -1.565, 1.08, 0),
  );
  return p;
}

// An army truck: olive cab, a canvas tilt over the bed, a spare wheel and jerrycans.
function armyProp(open: boolean): Part[] {
  const olive = 0x4e5636, canvas = 0x6e6a48, dark = 0x22241c;
  const p: Part[] = [
    part(box(0.56, 0.42, 1.0), olive, 0.98, 0.52, 0),
    part(box(0.5, 0.42, 1.0), olive, 0.5, 0.92, 0),
    part(box(0.03, 0.26, 0.86), dark, 0.76, 0.98, 0),
    part(box(0.08, 0.16, 1.0), 0x3a3e28, 1.28, 0.42, 0),
    part(box(1.56, 0.12, 1.06), olive, -0.5, 0.5, 0),
    part(box(1.56, 0.26, 0.06), olive, -0.5, 0.69, 0.5),
    part(box(1.56, 0.26, 0.06), olive, -0.5, 0.69, -0.5),
    part(box(0.08, 0.36, 0.36), 0x1c1c1c, 0.28, 0.8, 0.52, 0, 0, 0),
    part(box(0.02, 0.06, 0.2), 0xe0dcc8, 1.0, 0.75, 0.505),
    part(box(0.12, 0.2, 0.16), 0x4a5230, 0.3, 0.42, -0.6),
    part(box(0.12, 0.2, 0.16), 0x4a5230, 0.12, 0.42, -0.6),
    tyre(0.96, 0.48, 0.24), tyre(0.96, -0.48, 0.24), tyre(-0.3, 0.48, 0.24), tyre(-0.3, -0.48, 0.24), tyre(-0.9, 0.48, 0.24), tyre(-0.9, -0.48, 0.24),
  ];
  if (open) p.push(
    // The tilt rolled back over bare hoops; ammo crates spilled off the tailgate.
    part(box(0.5, 0.62, 1.04), canvas, 0.0, 1.11, 0),
    ...[-0.5, -0.9, -1.25].map((x) => part(box(0.04, 0.6, 1.0), 0x3a3e28, x, 1.1, 0)),
    part(box(1.3, 0.04, 0.04), 0x3a3e28, -0.6, 1.4, 0.48),
    part(box(1.3, 0.04, 0.04), 0x3a3e28, -0.6, 1.4, -0.48),
    part(box(0.44, 0.22, 0.28), 0x4e5a34, -1.55, 0.11, 0.2, 0, 0.5, 0),
    part(box(0.4, 0.2, 0.26), 0x4e5a34, -1.7, 0.1, -0.35, 0, -0.3, 0),
    part(box(0.02, 0.24, 0.94), 0x1c1e18, -1.28, 0.7, 0),
  );
  else p.push(
    part(box(1.56, 0.66, 1.08), canvas, -0.5, 1.09, 0),
    part(box(1.58, 0.06, 1.1), 0x5e5a3c, -0.5, 1.43, 0),
    part(box(0.02, 0.5, 0.9), 0x5a5638, -1.29, 1.0, 0),
    part(box(0.02, 0.12, 0.3), 0xe0dcc8, -0.5, 1.06, 0.55),
  );
  return p;
}

// The gas station's counter: a till on a long counter, the gun rack on the wall behind.
function counterProp(open: boolean): Part[] {
  const wood = 0x6a4a30, rack = 0x4a3a2a, gun = 0x26282a;
  const p: Part[] = [
    part(box(0.5, 0.9, 1.5), 0x8a8478, 0, 0.45, 0),
    part(box(0.56, 0.05, 1.56), wood, 0, 0.92, 0),
    part(box(0.3, 0.2, 0.34), 0x3a3c3e, 0.02, 1.05, -0.4),
    part(box(0.04, 0.12, 0.26), 0x4a8a5a, 0.18, 1.14, -0.4, 0, 0, 0.3),
    part(box(0.06, 1.1, 1.3), rack, -0.62, 1.15, 0),
    part(box(0.12, 0.04, 1.3), rack, -0.56, 0.75, 0),
    part(box(0.12, 0.04, 1.3), rack, -0.56, 1.55, 0),
    // Shelves of oil and snacks along the counter's front.
    part(box(0.04, 0.5, 1.3), 0x2a5a8a, 0.27, 0.45, 0),
    part(box(0.05, 0.06, 1.3), 0xc8a030, 0.28, 0.3, 0),
  ];
  if (open) p.push(
    // Bare pegs; the till's drawer hangs out empty; a box of shells spilled.
    ...[-0.4, 0, 0.4].map((z) => part(box(0.1, 0.05, 0.05), 0x8a8478, -0.53, 1.3, z)),
    part(box(0.26, 0.06, 0.3), 0x3a3c3e, 0.22, 0.92, -0.4),
    part(box(0.2, 0.08, 0.14), 0xb83a2a, 0.5, 0.04, 0.3, 0, 0.7, 0),
  );
  else p.push(
    // Long guns racked on the wall, a red box of shells on the counter.
    ...[-0.4, 0, 0.4].map((z, i) => part(box(0.07, 0.95 - i * 0.1, 0.08), gun, -0.54, 1.12, z, 0.06 * (i - 1), 0, 0)),
    ...[-0.4, 0, 0.4].map((z) => part(box(0.08, 0.26, 0.1), wood, -0.54, 0.8, z)),
    part(box(0.18, 0.1, 0.12), 0xb83a2a, 0.02, 1.0, 0.35),
  );
  return p;
}

// A fuel pump on its slab: faces +x, towards the road. Blown: a scorched stump.
function pumpProp(open: boolean): Part[] {
  const slab = 0x9a968a, bollard = 0xd8b020;
  const p: Part[] = [
    part(box(1.7, 0.14, 0.8), slab, 0, 0.07, 0),
    part(cyl(0.07, 0.07, 0.6, 6), bollard, 0.78, 0.3, 0.26),
    part(cyl(0.07, 0.07, 0.6, 6), bollard, -0.78, 0.3, -0.26),
  ];
  if (open) p.push(
    part(box(0.44, 0.4, 0.62), 0x1e1c1a, 0, 0.34, 0, 0, 0, 0.25),
    part(box(0.3, 0.3, 0.5), 0x2a2420, 0.05, 0.6, 0.05, 0.3, 0.5, 0.4),
    part(box(0.5, 0.03, 0.4), 0x5a2a22, 0.6, 0.16, -0.45, 0.2, 0.8, 0.1),
    part(box(0.34, 0.03, 0.3), 0x8a8478, -0.55, 0.15, 0.5, 0.15, -0.5, 0),
    part(cyl(0.02, 0.02, 0.9, 4), 0x141414, 0.3, 0.16, 0.42, 0, 0.6, Math.PI / 2),
  );
  else p.push(
    part(box(0.42, 1.3, 0.62), 0xd8d4c8, 0, 0.79, 0),
    part(box(0.44, 0.24, 0.64), 0xb8302a, 0, 1.36, 0),
    part(box(0.46, 0.05, 0.66), 0x2a2a2a, 0, 1.5, 0),
    part(box(0.3, 0.22, 0.02), 0x1a2a22, 0, 1.05, 0.315),
    part(box(0.3, 0.22, 0.02), 0x1a2a22, 0, 1.05, -0.315),
    part(box(0.2, 0.04, 0.02), 0x8aff9a, 0, 1.1, 0.33),
    part(box(0.2, 0.04, 0.02), 0x8aff9a, 0, 1.1, -0.33),
    part(box(0.1, 0.18, 0.08), 0x2a2a2a, 0.12, 0.7, 0.35),
    part(box(0.1, 0.18, 0.08), 0x2a2a2a, 0.12, 0.7, -0.35),
    part(cyl(0.025, 0.025, 0.7, 4), 0x141414, 0.2, 0.5, 0.38, 0.3, 0, 0),
  );
  return p;
}

// The gas station's canopy over its pumps, rusted through: posts on the islands, the fascia
// round the edge, cross beams, and what is left of the roof; and the price sign by the road.
function canopy(sites: SiteDef[]): THREE.BufferGeometry | null {
  const pumps = sites.filter((s) => s.kind === SiteKind.Pump), shop = sites.find((s) => s.kind === SiteKind.Station);
  if (!pumps.length || !shop) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, fx = 0, fz = 0;
  for (const p of pumps) {
    x0 = Math.min(x0, p.sx); x1 = Math.max(x1, p.sx); z0 = Math.min(z0, p.sy); z1 = Math.max(z1, p.sy);
    fx += p.sx / pumps.length; fz += p.sy / pumps.length;
  }
  x0 -= 1.9; x1 += 1.9; z0 -= 1.9; z1 += 1.9;
  const top = 3.3, w = x1 - x0, d = z1 - z0, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const white = 0xd8d4c6, red = 0xb02a24, steel = 0x6a6a64, rust = 0x7a4a2a;
  const p: Part[] = [];
  // A post between the two pumps of each island.
  for (let i = 0; i < pumps.length; i++) for (let j = i + 1; j < pumps.length; j++) {
    const a = pumps[i], b = pumps[j];
    if (Math.abs(Math.hypot(a.sx - b.sx, a.sy - b.sy) - 2) < 0.1) p.push(part(box(0.22, top, 0.22), 0xc0bcb0, (a.sx + b.sx) / 2, top / 2, (a.sy + b.sy) / 2));
  }
  // The fascia: white with a red band, a gap torn out of one side.
  for (const z of [z0, z1]) {
    p.push(part(box(w, 0.42, 0.12), white, mx, top + 0.1, z), part(box(w + 0.02, 0.12, 0.14), red, mx, top + 0.04, z));
  }
  for (const x of [x0, x1]) {
    p.push(part(box(0.12, 0.42, d * 0.55), white, x, top + 0.1, z0 + d * 0.275), part(box(0.14, 0.12, d * 0.55 + 0.02), red, x, top + 0.04, z0 + d * 0.275));
    p.push(part(box(0.12, 0.42, d * 0.3), white, x, top - 0.25, z1 - d * 0.15, 0.35, 0, 0));
  }
  // Beams across, and the roof panels still up, a few hanging.
  for (let z = z0 + 1; z < z1; z += 1.6) p.push(part(box(w, 0.1, 0.1), steel, mx, top + 0.18, z));
  let k = 0;
  for (let x = x0 + 0.8; x < x1 - 0.4; x += 1.6) for (let z = z0 + 0.8; z < z1 - 0.4; z += 1.6) {
    const h = hash(k++, 41);
    // Never over a pump: the pumps are what a survivor has to see from up here.
    if (pumps.some((q) => Math.abs(q.sx - x) < 0.9 && Math.abs(q.sy - z) < 0.9)) continue;
    if (h < 0.4) p.push(part(box(1.55, 0.05, 1.55), h < 0.1 ? rust : 0xb0aca0, x, top + 0.26, z));
    else if (h < 0.5) p.push(part(box(1.5, 0.04, 1.5), rust, x, top - 0.35, z, h * 6, 0, 0.5));
  }
  // The price sign on its pole at the kerb, facing the road.
  const dx = fx - (shop.x + shop.w / 2), dz = fz - (shop.y + shop.h / 2), along = Math.abs(dx) > Math.abs(dz);
  const ux = along ? Math.sign(dx) : 0, uz = along ? 0 : Math.sign(dz);
  const sx = mx + ux * (along ? w / 2 + 1.6 : 0) + (along ? 0 : w / 2 + 1.2), sz = mz + uz * (along ? 0 : d / 2 + 1.6) + (along ? d / 2 + 1.2 : 0);
  const thin = (a: number, b: number) => (along ? [a, b] : [b, a]);
  const [bw, bd] = thin(0.18, 1.3), [lw, ld] = thin(0.2, 1.32);
  p.push(
    part(cyl(0.09, 0.11, 4.6, 6), steel, sx, 2.3, sz),
    part(box(bw, 0.7, bd), red, sx, 4.6, sz),
    part(box(lw, 1.0, ld), white, sx, 3.75, sz),
    ...[3.95, 3.6].map((y) => part(box(lw + 0.02, 0.1, ld * 0.7), 0x2a2a2a, sx, y, sz)),
  );
  return merge(p);
}

// A fire engine: red, a white band, the ladder racked on the roof and lockers down the side.
function fireProp(open: boolean): Part[] {
  const red = 0xa8281e, white = 0xd8d4c6, dark = 0x24282a, steel = 0x9a9a92;
  const p: Part[] = [
    part(box(0.7, 0.84, 1.02), red, 1.06, 0.62, 0),
    part(box(0.03, 0.3, 0.9), dark, 1.415, 0.84, 0),
    part(box(0.5, 0.3, 1.04), dark, 1.05, 0.84, 0),
    part(box(2.2, 0.86, 1.04), red, -0.38, 0.63, 0),
    part(box(2.92, 0.08, 1.06), white, 0, 0.5, 0),
    part(box(0.6, 0.08, 0.3), 0x3a5ac8, 1.05, 1.08, 0),
    part(box(0.08, 0.14, 1.04), steel, 1.44, 0.3, 0),
    // The ladder on the roof, its rails and rungs.
    part(box(2.6, 0.05, 0.05), steel, -0.25, 1.14, 0.22),
    part(box(2.6, 0.05, 0.05), steel, -0.25, 1.14, -0.22),
    ...[-1.3, -0.9, -0.5, -0.1, 0.3, 0.7].map((x) => part(box(0.04, 0.04, 0.44), steel, x + 0.25, 1.14, 0)),
    // Hose reel on the back, rust down the flank.
    part(cyl(0.24, 0.24, 0.3, 10), 0xc8b674, -1.48, 0.62, 0, 0, 0, Math.PI / 2),
    part(box(0.5, 0.24, 0.02), 0x6a3a22, -0.6, 0.36, 0.525),
    tyre(1.0, 0.48, 0.22), tyre(1.0, -0.48, 0.22), tyre(-0.95, 0.48, 0.22), tyre(-0.95, -0.48, 0.22),
  ];
  // Lockers: shut, or rolled up on emptied shelves with a coat of hose on the ground.
  for (const x of [-1.15, -0.55, 0.05]) {
    if (open) p.push(part(box(0.5, 0.56, 0.02), 0x1e1c1a, x, 0.68, 0.522), part(box(0.48, 0.03, 0.06), steel, x, 0.6, 0.5));
    else p.push(part(box(0.5, 0.56, 0.02), 0xb8b8b0, x, 0.68, 0.522), part(box(0.1, 0.03, 0.02), dark, x, 0.5, 0.535));
  }
  if (open) p.push(
    part(cyl(0.3, 0.3, 0.08, 10), 0xc8b674, 0.1, 0.04, 0.95),
    part(box(0.22, 0.2, 0.14), 0xb8302a, -0.5, 0.1, 0.85, 0, 0.5, 0),
  );
  return p;
}

// An armoured cash van: squat, grey, slits for windows and heavy doors at the back.
function armoredProp(open: boolean): Part[] {
  const grey = 0x6a7076, dark = 0x22262a, steel = 0x8a8e90;
  const p: Part[] = [
    part(box(0.5, 0.5, 0.98), grey, 0.8, 0.5, 0),
    part(box(0.03, 0.12, 0.8), dark, 1.06, 0.66, 0),
    part(box(1.66, 0.96, 1.0), grey, -0.24, 0.68, 0),
    part(box(1.68, 0.06, 1.02), 0x2a5a3a, -0.24, 0.58, 0),
    part(box(0.3, 0.06, 0.02), dark, 0.3, 0.9, 0.505),
    part(box(0.3, 0.06, 0.02), dark, 0.3, 0.9, -0.505),
    part(box(0.08, 0.16, 1.0), 0x3a3e40, 1.06, 0.3, 0),
    part(box(1.0, 0.02, 0.6), 0x4a4e52, -0.3, 1.17, 0),
    tyre(0.7, 0.46, 0.2), tyre(0.7, -0.46, 0.2), tyre(-0.75, 0.46, 0.2), tyre(-0.75, -0.46, 0.2),
  ];
  if (open) p.push(
    // The back doors cut and hanging open on an empty strongroom; bags and coins in the dirt.
    part(box(0.02, 0.86, 0.92), 0x141618, -1.075, 0.68, 0),
    part(box(0.46, 0.84, 0.05), steel, -1.3, 0.68, 0.66, 0, -1.25, 0),
    part(box(0.46, 0.84, 0.05), steel, -1.3, 0.68, -0.66, 0, 1.25, 0),
    part(box(0.26, 0.2, 0.2), 0x8a8060, -1.6, 0.1, 0.2, 0, 0.4, 0),
    part(box(0.2, 0.16, 0.18), 0x8a8060, -1.5, 0.08, -0.35, 0, -0.6, 0),
    part(box(0.3, 0.02, 0.3), 0xd8b84a, -1.85, 0.01, -0.05),
  );
  else p.push(
    part(box(0.03, 0.84, 0.94), steel, -1.075, 0.68, 0),
    part(box(0.04, 0.84, 0.02), dark, -1.09, 0.68, 0),
    part(box(0.05, 0.08, 0.2), 0xc8b674, -1.1, 0.68, 0.12),
  );
  return p;
}

// A camper van: cream with a brown stripe, the bunk over the cab, curtains drawn.
function camperProp(open: boolean): Part[] {
  const cream = 0xd8d0b4, brown = 0x7a5034, dark = 0x24282a;
  const p: Part[] = [
    part(box(0.5, 0.56, 1.0), cream, 1.0, 0.48, 0),
    part(box(0.03, 0.26, 0.86), dark, 1.255, 0.66, 0, 0, 0, 0.25),
    part(box(1.96, 1.12, 1.04), cream, -0.24, 0.82, 0),
    part(box(0.62, 0.42, 1.04), cream, 0.98, 1.17, 0),
    part(box(2.6, 0.12, 1.06), brown, 0.06, 0.66, 0),
    part(box(0.36, 0.26, 0.02), 0x5a6a5a, -0.6, 1.02, 0.525),
    part(box(0.36, 0.26, 0.02), 0x5a6a5a, -0.6, 1.02, -0.525),
    part(box(0.3, 0.22, 0.02), 0x5a6a5a, 0.2, 1.02, -0.525),
    part(box(0.5, 0.06, 0.4), 0x9a968a, -0.7, 1.41, 0),
    part(box(0.08, 0.14, 1.0), 0x6a6a64, 1.26, 0.3, 0),
    part(box(0.6, 0.3, 0.02), 0x6a3a22, -1.0, 0.5, -0.525),
    tyre(0.8, 0.46, 0.2), tyre(0.8, -0.46, 0.2), tyre(-0.75, 0.46, 0.2), tyre(-0.75, -0.46, 0.2),
  ];
  if (open) p.push(
    // The door off its hinges, the awning torn down, a mattress and a cooler dragged out.
    part(box(0.36, 0.86, 0.02), 0x1a1a18, 0.2, 0.74, 0.525),
    part(box(0.04, 0.86, 0.36), cream, 0.55, 0.1, 0.95, 0, 0.3, Math.PI / 2),
    part(box(1.2, 0.04, 0.5), 0x8a6a3a, -0.4, 0.82, 0.85, -0.7, 0, 0),
    part(box(0.9, 0.12, 0.55), 0x8a7a98, -0.6, 0.06, 1.3, 0, 0.3, 0),
    part(box(0.3, 0.22, 0.2), 0x2a6aa0, 0.6, 0.11, 1.5, 0, -0.4, 0),
  );
  else p.push(
    part(box(0.36, 0.86, 0.02), 0xc4bca0, 0.2, 0.74, 0.525),
    part(box(1.2, 0.06, 0.12), brown, -0.4, 1.3, 0.56),
  );
  return p;
}

// A motorbike lying on its side, panniers strapped behind the seat. Paint-tinted.
function motoProp(open: boolean): Part[] {
  const dark = 0x1c1c1c, chrome = 0x9a9a92;
  const wheel = (x: number) => part(cyl(0.24, 0.24, 0.08, 10), dark, x, 0.08, 0);
  const p: Part[] = [
    wheel(0.42), wheel(-0.42),
    part(box(0.5, 0.18, 0.2), CAR_BODY, 0.06, 0.16, -0.06),
    part(box(0.34, 0.1, 0.16), 0x2a2622, -0.22, 0.2, -0.04),
    part(box(0.5, 0.05, 0.05), chrome, 0.18, 0.12, 0.08, 0, 0, -0.4),
    part(box(0.05, 0.05, 0.5), chrome, 0.46, 0.3, -0.15),
    part(box(0.5, 0.06, 0.06), chrome, -0.2, 0.06, 0.12),
  ];
  if (open) p.push(
    // Panniers ripped open, a helmet rolled off.
    part(box(0.24, 0.1, 0.2), 0x3a2a1a, -0.4, 0.05, -0.3, 0, 0.6, 0),
    part(box(0.22, 0.02, 0.18), 0x2a1e14, -0.62, 0.01, -0.5, 0, 0.3, 0),
    part(octa(0.14), 0x8a2a20, 0.3, 0.12, -0.55),
  );
  else p.push(
    part(box(0.26, 0.2, 0.22), 0x4a3422, -0.38, 0.14, -0.12),
    part(octa(0.14), 0x8a2a20, -0.1, 0.32, -0.2),
  );
  return p;
}

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
  const skin = 0x8e928c, belly = 0x6a6e68, stripe = 0x3a4a6a, dark = 0x1e2022, burnt = 0x2a2420, scorch = 0x3a3428, soot = 0x26221e;
  const p: Part[] = [];
  // The scar: overlapping patches of scorched earth along the line it came down on.
  const scar = [[-14, 0, 3, 1.6, 0.3], [-11, 0.8, 3.4, 2, 1.1], [-8, -0.6, 4, 2.4, 0.5], [-5.5, 2.2, 3, 2.2, 1.3], [-1, 3, 3.6, 2.4, 0.2],
    [2, -2.8, 3.2, 2.2, 0.9], [6.5, 1, 3, 2.4, 0.4], [7.5, -1.6, 2.4, 1.8, 1.2], [-3, -6, 3, 2, 0.6], [0.5, 5.6, 2.6, 2, -0.4], [-6.5, -3, 2.4, 1.6, 0.2]];
  scar.forEach(([x, z, w, d, a], i) => p.push(part(box(w, 0.02, d), i % 3 ? scorch : soot, x, 0.012 + i * 0.001, z, 0, a, 0)));
  // The hull, its belly crushed into the dirt, a stripe down each side.
  p.push(
    part(box(9.7, 2.0, 2.2), skin, -0.65, 1.2, 0),
    part(box(9.7, 0.4, 2.0), belly, -0.65, 0.2, 0),
    part(box(9.72, 0.14, 2.22), stripe, -0.65, 1.55, 0),
    part(box(9.0, 0.3, 1.6), skin, -0.9, 2.3, 0),
    ...[-4, -2.8, -1.6, -0.4, 0.8, 2.0, 3.2].map((x) => part(box(0.28, 0.24, 2.24), 0x3a4048, x, 1.85, 0)),
    // The nose, dipped into the ground, and the cockpit glass.
    part(box(1.5, 1.7, 2.0), skin, 4.8, 1.0, 0, 0, 0, -0.18),
    part(box(0.8, 1.1, 1.6), skin, 5.55, 0.75, 0, 0, 0, -0.35),
    part(box(0.6, 0.36, 1.7), dark, 5.0, 1.75, 0, 0, 0, -0.5),
    // The broken end: jagged ribs round a dark hole.
    part(box(0.05, 1.9, 2.0), 0x141414, -5.49, 1.2, 0),
    ...[[0.7, -0.5], [1.6, 0.4], [2.2, -0.2], [0.4, 0.8]].map(([y, z], i) => part(box(0.5 + (i % 2) * 0.3, 0.12, 0.1), belly, -5.6, y, z, 0.3 * i, 0.4, 0.2)),
    // The wing still on: high on the hull, drooping to the ground at its tip; its root stub.
    part(box(2.4, 0.2, 6.6), skin, 0.4, 1.7, 4.2, 0.22, 0, 0),
    part(box(2.42, 0.06, 0.4), stripe, 0.4, 1.86, 2.0, 0.22, 0, 0),
    part(box(2.2, 0.2, 2.0), skin, 0.4, 2.15, -1.9, -0.15, 0, 0),
    part(box(1.6, 0.22, 0.9), burnt, 0.6, 2.05, -3.0, -0.4, 0.3, 0.2),
    // What is left of the other wing, lying out on its own.
    part(box(2.1, 0.18, 4.6), skin, -3.5, 0.18, -8.3, 0.08, 0.7, 0),
    part(box(2.12, 0.04, 0.5), stripe, -3.5, 0.29, -6.4, 0.08, 0.7, 0),
    // Soot where it burnt: over the hull, along the wing, round the break.
    part(box(2.6, 0.04, 1.4), soot, -3.6, 2.46, 0.1, 0, 0.2, 0),
    part(box(1.6, 0.04, 1.2), burnt, 1.6, 2.46, -0.2, 0, -0.3, 0),
    part(box(1.4, 0.06, 2.2), soot, 0.2, 1.62, 5.4, 0.22, 0.2, 0),
    part(box(0.06, 1.2, 1.6), soot, -5.2, 1.1, 1.11, 0, 0, 0),
    part(box(1.6, 1.0, 0.04), burnt, -4.4, 1.3, -1.11),
  );
  // The tail section, turned off the hull's line: a tapering cone, the fin and the tailplane.
  const tail = (lx: number, y: number, lz: number, g: THREE.BufferGeometry, col: number, rx = 0, rz = 0) => {
    const [ox, oz] = turn(lx, lz, TAIL_TURN);
    p.push(part(g, col, TAIL_X + ox, y, TAIL_Z + oz, rx, -TAIL_TURN, rz));
  };
  tail(0.6, 0.95, 0, box(3.2, 1.7, 1.8), skin);
  tail(-1.4, 1.05, 0, box(1.4, 1.2, 1.2), skin, 0, 0.25);
  tail(0.6, 1.3, 0, box(3.22, 0.12, 1.82), stripe);
  tail(2.2, 0.95, 0, box(0.05, 1.6, 1.7), 0x141414);
  tail(-1.5, 2.6, 0, box(1.8, 2.6, 0.18), skin, 0, -0.35);
  tail(-1.7, 3.2, 0, box(1.0, 0.8, 0.2), 0xb02a24, 0, -0.35);
  tail(-1.6, 1.5, 0, box(1.1, 0.12, 3.8), skin);
  // Debris: panels, seats and cargo strewn along the scar.
  const junk = [[-12, 1.5, 0.6], [-11, -2, 1.1], [7, 3, 0.4], [7.5, -2.5, 2.2], [3, -5, 0.9], [-6.5, 4.5, 1.7], [9, 0.5, 2.8], [-7, -4.5, 0.3]];
  junk.forEach(([x, z, a], i) => p.push(part(box(0.9 - (i % 3) * 0.2, 0.06, 0.6), i % 2 ? skin : burnt, x, 0.04, z, 0.1, a, 0.05)));
  p.push(
    part(box(0.5, 0.5, 0.5), 0x4a5a6a, -11.5, 0.25, -0.5, 0, 0.4, 0),
    part(box(0.5, 0.06, 0.5), 0x4a5a6a, -11.4, 0.6, -0.4, 0.5, 0.4, 0),
  );
  // The hold, seen through the break: cargo cases strapped in, or broken open and scattered.
  if (open) p.push(
    part(box(0.8, 0.5, 0.6), 0x4e5a34, -6.4, 0.25, 0.6, 0, 0.5, 0),
    part(box(0.76, 0.02, 0.56), 0x1a1c14, -6.4, 0.51, 0.6, 0, 0.5, 0),
    part(box(0.8, 0.06, 0.6), 0x445030, -6.9, 0.04, -0.6, 0, 1.2, 0),
    part(box(0.7, 0.44, 0.5), 0x7a6040, -7.4, 0.22, 0.3, 0, -0.4, 0),
    part(box(0.3, 0.2, 0.4), 0x2a2a28, -6.0, 0.1, -1.4, 0, 0.9, 0),
  );
  else p.push(
    part(box(1.4, 0.7, 1.6), 0x4e5a34, -4.5, 0.75, 0),
    part(box(1.42, 0.08, 1.62), 0xc8b674, -4.5, 0.95, 0),
    part(box(1.0, 0.6, 1.2), 0x6a6a5a, -3.0, 0.7, 0),
    part(box(0.8, 0.5, 0.6), 0x4e5a34, -5.9, 0.25, 0.4, 0, 0.3, 0),
  );
  return p;
}

// One of the plane's engines on the ground: a nacelle, its propeller bent back, fuel pooling
// under it. Blown: a burnt-out shell.
function engineProp(open: boolean): Part[] {
  const skin = 0xa8aca6, dark = 0x2a2a2a;
  const p: Part[] = [part(box(1.9, 0.02, 1.4), 0x24201a, -0.2, 0.012, 0.1, 0, 0.3, 0)];
  if (open) p.push(
    part(cyl(0.46, 0.5, 1.6, 8), 0x1e1c1a, -0.1, 0.44, 0, 0.2, 0, Math.PI / 2),
    part(box(0.6, 0.3, 0.7), 0x2a2420, 0.5, 0.2, 0.3, 0.4, 0.6, 0.3),
    part(box(0.9, 0.04, 0.2), dark, 0.9, 0.06, -0.5, 0, 0.9, 0),
  );
  else p.push(
    part(cyl(0.48, 0.55, 1.9, 10), skin, 0, 0.55, 0, 0, 0, Math.PI / 2),
    part(cyl(0.3, 0.3, 0.2, 8), dark, 0.98, 0.55, 0, 0, 0, Math.PI / 2),
    part(box(0.12, 1.4, 0.16), dark, 1.1, 0.55, 0.1, 0.5, 0, -0.4),
    part(box(0.12, 0.9, 0.16), dark, 1.1, 0.4, -0.35, -1.6, 0, 0.3),
    part(box(1.0, 0.3, 0.6), skin, -0.2, 1.05, 0, 0, 0, 0.1),
    part(box(1.1, 0.02, 0.8), 0x4a3a5a, -0.5, 0.02, 0.5, 0, 0.5, 0),
  );
  return p;
}

// Indexed by propKind.
const PROPS = [houseProp, carProp, crateProp, pickupProp, policeProp, ambulanceProp, busProp, armyProp, counterProp, pumpProp, fireProp, armoredProp, camperProp, motoProp, planeProp, engineProp];
// Wrecks that take a coat of faded paint.
const PAINTED = new Set<number>([SiteKind.Car, SiteKind.Pickup, SiteKind.Moto]);

// Loot sites: a prop per site, instanced per kind and state, and a pulsing glint over the
// ones nobody has searched yet.
export class Loot {
  group = new THREE.Group();
  private mat = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
  private glintMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private geos: THREE.BufferGeometry[] = [];
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
    for (const mk of PROPS) for (const open of [false, true]) this.geos.push(merge(mk(open)));
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
    const f = game.cur;
    if (!this.sites.length) { this.glints.count = 0; return; }
    let sig = '' + f.nSites;
    for (let i = 0; i < f.nSites; i++) sig += ',' + f.sites[i];
    if (sig !== this.sig) { this.sig = sig; this.lay(game); }
    // Glints bob and turn; each its own phase.
    const t = now / 1000, a = this.glints.instanceMatrix.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.sites.length; i++) {
      if (f.siteSearched(i) || !lootable(this.sites[i].kind)) continue;
      const k = propKind(this.sites[i].kind), ph = hash(i, 5) * 6.28;
      const s = 1 + 0.18 * Math.sin(t * 3.2 + ph);
      writeMatrix(a, n++ * 16, this.px[i], (GLINT_Y[k] ?? 1.2) + Math.sin(t * 1.8 + ph) * 0.08, this.pz[i], t * 1.5 + ph, s, s * 1.6);
    }
    this.glints.count = n;
    this.glints.instanceMatrix.needsUpdate = true;
  }
}
