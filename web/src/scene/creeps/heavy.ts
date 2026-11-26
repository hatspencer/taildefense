import * as THREE from 'three/webgpu';
import { HAIR, PANTS, SHIRT, SKIN, mirror, rig, type CreepRig, type JointDef } from '../creepModels';
import { PAL, blend, darker, lighter } from '../palette';
import { J, rp, type RigPart } from '../rig';
import { box, part } from '../util';

// The heavy and the special dead: the brute, the mauler, the hound, the spitter and the
// hurler. Each is built in the survivors' units (a man's hips at 0.58, shoulders at 1.0, the
// top of his head at 1.35) and stands beside them at its true size, whatever its radius in
// the sim: the rig's scale makes a man here a survivor's 1.8 in the world.
//
// The far model keeps the parts at least a tenth of the figure's height across (farParts), so
// each figure is a few big volumes in its main colours, which is all the far model draws, and
// every detail on them is smaller than that: a long band or stain is cut short or in pieces.
const UNIT = 1.8 / 1.35; // a man is built 1.35 of these units tall, and a survivor is 1.8 in the world

// Fixed colours, from the picture's palette. Everything painted in SHIRT, PANTS, SKIN or HAIR
// takes the instance's own.
const BOOT = PAL.leather, SOLE = PAL.rubber, BLOOD = PAL.blood, GORE = PAL.bloodFresh, CLOT = PAL.bloodDark;
const MOUTH = 0x2a120c, SOCKET = PAL.ink, EYE = 0xb0aa88, BONE = PAL.bone;

type V4 = [number, number, number, number];
type V3 = [number, number, number];

// A box whose top and bottom differ: w across x (front to back), d across z (side to side),
// h tall; the top shifted forward by lean. Twelve triangles, like a box, but a limb that
// tapers to the wrist or a chest wider at the shoulders than at the belly.
function slab(w0: number, d0: number, w1: number, d1: number, h: number, lean = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, h, 1);
  const a = g.getAttribute('position');
  for (let i = 0; i < a.count; i++) {
    const top = a.getY(i) > 0;
    a.setXYZ(i, a.getX(i) * (top ? w1 : w0) + (top ? lean : 0), a.getY(i), a.getZ(i) * (top ? d1 : d0));
  }
  return g;
}

// A part of colour c on joint j: a box, or any geometry placed and turned.
const B = (j: number, w: number, h: number, d: number, c: number, x: number, y: number, z = 0, rx = 0, ry = 0, rz = 0): RigPart =>
  rp(j, part(box(w, h, d), c, x, y, z, rx, ry, rz));
const G = (j: number, g: THREE.BufferGeometry, c: number, x: number, y: number, z = 0, rx = 0, ry = 0, rz = 0): RigPart =>
  rp(j, part(g, c, x, y, z, rx, ry, rz));
// A limb (or a trunk) from y0 up to y1: w and d its size at the bottom, w1 and d1 at the top.
const L = (j: number, y0: number, y1: number, w: number, d: number, w1: number, d1: number, c: number, x = 0, z = 0, lean = 0): RigPart =>
  G(j, slab(w, d, w1, d1, y1 - y0, lean), c, x, (y0 + y1) / 2, z);

const side = (s: number, l: number, r: number) => (s > 0 ? l : r);

// A dead face on a neck that starts at (x, y), facing +x, s times a man's: the jaw hanging,
// the eyes sunk, blood down the chin. hair: a crop on top and round the back, or none.
function deadHead(p: RigPart[], j: number, x: number, y: number, s: number, o: { hair?: boolean; jaw?: number } = {}): void {
  const k = (v: number) => v * s, jaw = o.jaw ?? 0.03;
  p.push(B(j, k(0.1), k(0.09), k(0.1), SKIN, x - k(0.01), y + k(0.04)));
  p.push(G(j, slab(k(0.2), k(0.18), k(0.21), k(0.19), k(0.16)), SKIN, x + k(0.02), y + k(0.18)));
  p.push(B(j, k(0.13), k(0.06), k(0.13), SKIN, x + k(0.05), y + k(0.07) - jaw, 0, 0, 0, -0.15));
  p.push(B(j, k(0.02), k(0.03) + jaw, k(0.09), MOUTH, x + k(0.11), y + k(0.1) - jaw / 2));
  p.push(B(j, k(0.03), k(0.045), k(0.03), SKIN, x + k(0.125), y + k(0.15)));
  for (const z of [k(0.048), -k(0.048)]) {
    p.push(B(j, k(0.02), k(0.04), k(0.05), SOCKET, x + k(0.115), y + k(0.19), z));
    p.push(B(j, k(0.022), k(0.016), k(0.018), EYE, x + k(0.117), y + k(0.19), z));
  }
  p.push(B(j, k(0.014), k(0.05), k(0.035), BLOOD, x + k(0.113), y + k(0.05) - jaw, k(0.03)));
  if (o.hair !== false) {
    p.push(B(j, k(0.17), k(0.035), k(0.17), HAIR, x - k(0.005), y + k(0.27)));
    p.push(B(j, k(0.04), k(0.1), k(0.13), HAIR, x - k(0.08), y + k(0.2)));
  }
}

// A work boot under a shin at (x, z): the upper (kept far), the sole and the heel under it in
// pieces short enough to go there.
function boot(p: RigPart[], j: number, x: number, z: number, l: number, w: number, c: number = BOOT): void {
  p.push(B(j, l, 0.085, w, c, x + l * 0.15, 0.06, z));
  p.push(B(j, l * 0.5, 0.025, w, SOLE, x + l * 0.42, 0.012, z));
  p.push(B(j, l * 0.4, 0.025, w, SOLE, x - l * 0.12, 0.012, z));
  p.push(B(j, l * 0.45, 0.05, w * 0.92, c, x, 0.12, z));
}

// A gait with the knees: the hip swings and the knee folds in the second half of each step.
function legJoints(hip: number, knee: number, hz: number, swing: number, fold: number, extra: { thigh?: Partial<JointDef>; shin?: Partial<JointDef> } = {}): Partial<Record<number, JointDef>> {
  return {
    [J.THIGH_L]: { p: [0, hip, hz], walk: [swing, 0, 0, 0], wind: [-0.15, 0, 0, 0], strike: [0.3, 0, 0, 0], die: [1.3, 0, 0, 0], misc: [0, 0.4, 1, 2], ...extra.thigh },
    [J.SHIN_L]: { p: [0, knee, hz], walk: [0, 0, 0, -0.05], flex: [-fold, Math.PI / 2, 0, 0], strike: [-0.2, 0, 0, 0], die: [-2.0, 0, 0, 0], misc: [0, 0.3, 1, 2], ...extra.shin },
  };
}

// A hand at the end of a forearm, its fingers hanging and curled, the thumb in front.
function hand(p: RigPart[], j: number, x: number, y: number, z: number, s: number, c: number = SKIN, blood: number = CLOT): void {
  p.push(B(j, 0.11 * s, 0.1 * s, 0.07 * s, c, x, y, z));
  p.push(B(j, 0.1 * s, 0.07 * s, 0.065 * s, c, x + 0.012 * s, y - 0.075 * s, z, 0, 0, 0.25));
  p.push(B(j, 0.05 * s, 0.05 * s, 0.035 * s, c, x + 0.06 * s, y - 0.01 * s, z - Math.sign(z) * 0.03 * s));
  p.push(B(j, 0.04 * s, 0.05 * s, 0.07 * s, blood, x + 0.04 * s, y - 0.1 * s, z, 0, 0, 0.25));
}

// The picture's brute: a big man a head taller than anyone, in a hi-vis vest hanging open
// over a grey work shirt, pale bands up the fronts and one round the belly, a yellow hard hat,
// heavy boots, big hands hanging; bloodied. He raises both fists and brings them down.
export function brute(): CreepRig {
  const p: RigPart[] = [];
  const VIS = PAL.hiVis, VISD = darker(PAL.hiVis, 0.62), BAND = PAL.hiVisBand, HAT = PAL.hardHat;
  const WORK = blend(PAL.denimLight, PAL.shirtGrey, 0.3);
  const hip = 0.68, knee = 0.36, hz = 0.13, sh = 1.2, el = 0.93, sz = 0.31;
  for (const s of [1, -1]) {
    const z = hz * s, th = side(s, J.THIGH_L, J.THIGH_R), sn = side(s, J.SHIN_L, J.SHIN_R);
    p.push(L(th, knee - 0.02, hip + 0.1, 0.17, 0.17, 0.22, 0.22, PANTS, 0, z));
    p.push(L(sn, 0.1, knee + 0.02, 0.15, 0.15, 0.17, 0.17, PANTS, 0, z));
    boot(p, sn, 0.03, z, 0.3, 0.165);
  }
  // Both knees torn through, blood down the trousers.
  for (const [j, z] of [[J.SHIN_L, hz], [J.SHIN_R, -hz]] as const) {
    p.push(B(j, 0.03, 0.08, 0.1, SKIN, 0.09, knee - 0.01, z));
    p.push(B(j, 0.03, 0.035, 0.07, GORE, 0.093, knee - 0.06, z));
  }
  p.push(B(J.THIGH_R, 0.025, 0.14, 0.08, BLOOD, 0.11, hip - 0.1, -hz - 0.02));
  // The work shirt: a barrel of a chest, the shoulders sloping off a thick neck, its front
  // showing down the vest's open middle.
  p.push(L(J.CHEST, 0.74, 1.2, 0.36, 0.5, 0.34, 0.56, WORK, 0.02));
  p.push(L(J.CHEST, 1.16, 1.31, 0.32, 0.56, 0.2, 0.26, WORK, 0.0));
  // The vest: its two fronts and the back in one piece each side, ragged at the hem, a strap
  // over each shoulder; a pale band round the belly and up each front; blood smeared on it.
  const front = (y: number) => 0.237 - ((y - 0.74) / 0.46) * 0.02;
  for (const s of [1, -1]) {
    p.push(L(J.CHEST, 0.74, 1.17, 0.42, 0.245, 0.36, 0.23, VIS, 0.02, s * 0.1475));
    p.push(B(J.CHEST, 0.16, 0.03, 0.1, VIS, 0.0, 1.235, s * 0.2, s * 0.78));
    p.push(B(J.CHEST, 0.06, 0.06, 0.05, VISD, 0.21, 0.73, s * 0.1));
    p.push(B(J.CHEST, 0.08, 0.05, 0.06, VISD, -0.12, 0.73, s * 0.22));
    for (const [y, h] of [[0.93, 0.13], [1.065, 0.13], [1.18, 0.07]]) p.push(B(J.CHEST, 0.02, h, 0.05, BAND, front(y), y, s * 0.17));
    for (const z of [0.087, 0.21]) p.push(B(J.CHEST, 0.02, 0.045, 0.125, BAND, front(0.85), 0.85, s * z));
    p.push(B(J.CHEST, 0.15, 0.045, 0.02, BAND, 0.13, 0.85, s * 0.272));
  }
  p.push(B(J.CHEST, 0.03, 0.12, 0.09, BLOOD, 0.24, 0.93, 0.08));
  p.push(B(J.CHEST, 0.03, 0.08, 0.07, CLOT, 0.23, 1.1, -0.2));
  p.push(B(J.CHEST, 0.1, 0.08, 0.03, BLOOD, 0.1, 0.95, -0.27));
  p.push(B(J.CHEST, 0.03, 0.12, 0.04, BLOOD, 0.205, 1.0, 0.0));
  // The head: heavy-jawed, thrust forward, a moustache; the hard hat on it.
  const hx = 0.07, hy = 1.28;
  deadHead(p, J.HEAD, hx, hy, 1.12, { hair: false, jaw: 0.035 });
  p.push(B(J.HEAD, 0.03, 0.025, 0.1, HAIR, hx + 0.13, hy + 0.135));
  p.push(G(J.HEAD, new THREE.CylinderGeometry(0.095, 0.13, 0.1, 8), HAT, hx + 0.02, hy + 0.33));
  p.push(G(J.HEAD, new THREE.CircleGeometry(0.155, 8), HAT, hx + 0.045, hy + 0.282, 0, -Math.PI / 2));
  p.push(B(J.HEAD, 0.15, 0.03, 0.035, lighter(HAT, 0.25), hx + 0.02, hy + 0.385));
  // The arms: rolled grey sleeves, thick forearms, hands like shovels down at the thigh.
  for (const s of [1, -1]) {
    const z = sz * s, u = side(s, J.UARM_L, J.UARM_R), f = side(s, J.FARM_L, J.FARM_R);
    p.push(B(u, 0.15, 0.11, 0.15, WORK, 0, sh - 0.05, z));
    p.push(L(u, el + 0.03, sh - 0.06, 0.15, 0.15, 0.16, 0.16, WORK, 0, z));
    p.push(B(u, 0.16, 0.05, 0.16, lighter(WORK, 0.2), 0, el + 0.04, z));
    p.push(L(f, 0.66, el + 0.01, 0.115, 0.115, 0.14, 0.14, SKIN, 0.01, z));
    hand(p, f, 0.02, 0.6, z, 1.5);
  }
  return rig(p, {
    [J.CHEST]: { p: [0, 0.72, 0], walk: [0, 0, 0.09, -0.1], flex: [0, 0, 0.16, 0.03], wind: [0.35, 0, 0, 0], strike: [-0.55, 0, 0, 0], die: [-0.45, 0, 0, 0], misc: [0.12, 0.2, 0, 0] },
    [J.HEAD]: { p: [hx, hy, 0], walk: [0, 0, 0.08, 0.04], flex: [0, 0, 0, 0.05], wind: [0.25, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [-0.4, 0, 0, 0], misc: [0.2, 0.2, 0, 0] },
    [J.UARM_L]: { p: [0, sh, sz], walk: [0.28, Math.PI, -0.04, 0.14], flex: [0, 0, 0, 0.04], wind: [2.6, -0.15, 0, 0], strike: [0.9, 0.05, 0, 0], die: [-0.3, -0.3, 0, 0], misc: [-0.15, 0.8, 0.15, 1] },
    [J.FARM_L]: { p: [0, el, sz], walk: [0.12, Math.PI + 0.5, 0, 0.3], wind: [0.9, 0, 0, 0], strike: [-0.1, 0, 0, 0], die: [0, 0, 0, 0], misc: [0, 0.6, 0.15, 1] },
    ...legJoints(hip, knee, hz, 0.3, 0.55, { thigh: { misc: [0, 0.3, 1, 2], die: [1.2, 0, 0, 0] }, shin: { die: [-1.9, 0, 0, 0] } }),
  }, { stride: 1.05, bob: 0.05, drop: 0.28, turn: 3.5, flinch: 0.25, scale: UNIT });
}

// A slaughterman: thick in the belly and the neck, bald, hunched over with his head down
// between his shoulders, in a long rubber apron and wellingtons, a cleaver in one fist. He
// charges, and brings the cleaver down.
export function mauler(): CreepRig {
  const p: RigPart[] = [];
  const APRON = 0xa49c80, APROND = darker(APRON, 0.7), WELLY = 0x2c2e24, STEEL = PAL.steelLit, HANDLE = PAL.woodDark;
  const hip = 0.6, knee = 0.32, hz = 0.15, sh = 1.17, el = 0.9, sz = 0.37;
  for (const s of [1, -1]) {
    const z = hz * s, th = side(s, J.THIGH_L, J.THIGH_R), sn = side(s, J.SHIN_L, J.SHIN_R);
    p.push(L(th, knee - 0.02, hip + 0.1, 0.18, 0.18, 0.23, 0.24, PANTS, 0, z));
    // Wellingtons to the knee, the trousers tucked in.
    p.push(L(sn, 0.03, knee, 0.17, 0.17, 0.19, 0.19, WELLY, 0, z));
    p.push(B(sn, 0.28, 0.07, 0.18, WELLY, 0.04, 0.035, z));
  }
  // The apron's skirt, hanging to the knees in front of the legs, blood down it.
  p.push(L(-1, 0.3, 0.72, 0.03, 0.52, 0.03, 0.46, APRON, 0.26));
  p.push(B(-1, 0.035, 0.13, 0.12, BLOOD, 0.265, 0.5, 0.1));
  p.push(B(-1, 0.035, 0.1, 0.06, CLOT, 0.265, 0.37, -0.14));
  p.push(B(-1, 0.035, 0.05, 0.13, APROND, 0.265, 0.32, 0.05));
  // A belly like a barrel, a hump of a back, a neck as wide as the head.
  p.push(L(J.CHEST, 0.66, 0.94, 0.44, 0.52, 0.5, 0.6, SHIRT, 0.04));
  p.push(L(J.CHEST, 0.94, 1.2, 0.5, 0.6, 0.4, 0.72, SHIRT, 0.0));
  p.push(L(J.CHEST, 1.16, 1.3, 0.36, 0.64, 0.22, 0.34, SHIRT, -0.06));
  // The apron's bib over the belly and chest, the strap round the neck, the tie at the back.
  p.push(L(J.CHEST, 0.7, 1.18, 0.03, 0.48, 0.03, 0.34, APRON, 0.3));
  for (const z of [0.12, -0.12]) p.push(B(J.CHEST, 0.12, 0.03, 0.03, APROND, 0.24, 1.23, z, 0, 0, -0.7));
  for (const z of [0.1, -0.1]) p.push(B(J.CHEST, 0.04, 0.03, 0.12, APROND, -0.235, 0.86, z));
  p.push(B(J.CHEST, 0.04, 0.12, 0.06, APROND, -0.24, 0.8, 0.04));
  p.push(B(J.CHEST, 0.035, 0.13, 0.13, BLOOD, 0.305, 0.94, -0.08));
  p.push(B(J.CHEST, 0.035, 0.1, 0.1, GORE, 0.307, 1.05, 0.1));
  p.push(B(J.CHEST, 0.035, 0.13, 0.05, CLOT, 0.305, 0.78, 0.15));
  p.push(B(J.CHEST, 0.035, 0.05, 0.12, APROND, 0.305, 1.16, 0));
  // The head, low and forward: bald, stubble round the back, jowls, small eyes.
  const hx = 0.2, hy = 1.13;
  deadHead(p, J.HEAD, hx, hy, 1.08, { hair: false, jaw: 0.02 });
  p.push(B(J.HEAD, 0.08, 0.1, 0.14, HAIR, hx - 0.07, hy + 0.18));
  for (const z of [0.08, -0.08]) p.push(B(J.HEAD, 0.1, 0.07, 0.06, SKIN, hx + 0.05, hy + 0.08, z));
  // Bare arms as thick as a man's legs, the sleeves torn off at the shoulder; fists hanging at
  // the apron's hem, the cleaver in the right.
  for (const s of [1, -1]) {
    const z = sz * s, u = side(s, J.UARM_L, J.UARM_R), f = side(s, J.FARM_L, J.FARM_R);
    p.push(L(u, el, sh - 0.04, 0.17, 0.17, 0.2, 0.2, SKIN, 0.01, z));
    p.push(B(u, 0.04, 0.05, 0.1, SHIRT, 0.1, sh - 0.06, z, 0, 0, 0.3));
    p.push(L(f, 0.66, el + 0.02, 0.14, 0.14, 0.19, 0.18, SKIN, 0.02, z));
    p.push(B(f, 0.14, 0.13, 0.13, SKIN, 0.03, 0.6, z));
    p.push(B(f, 0.06, 0.08, 0.12, CLOT, 0.1, 0.57, z));
  }
  p.push(B(J.FARM_L, 0.02, 0.1, 0.1, BLOOD, 0.115, 0.78, sz));
  // The cleaver: a handle through the fist, the blade forward and down.
  p.push(B(J.FARM_R, 0.04, 0.12, 0.04, HANDLE, 0.06, 0.6, -sz));
  p.push(B(J.FARM_R, 0.26, 0.14, 0.02, STEEL, 0.22, 0.6, -sz, 0, 0, -0.15));
  p.push(B(J.FARM_R, 0.12, 0.03, 0.025, GORE, 0.27, 0.53, -sz, 0, 0, -0.15));
  return rig(p, {
    [J.CHEST]: { p: [0, 0.64, 0], walk: [0, 0, 0.11, -0.3], flex: [0, 0, 0.15, 0.03], wind: [0.55, 0, 0, 0], strike: [-0.6, 0, 0, 0], die: [-0.5, 0, 0, 0], misc: [0.12, 0.2, 0, 0] },
    [J.HEAD]: { p: [hx, hy, 0], walk: [0, 0, 0.08, 0.28], flex: [0, 0, 0, 0.05], wind: [0.3, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [-0.4, 0, 0, 0], misc: [0.2, 0.2, 0, 0] },
    [J.UARM_L]: { p: [0.01, sh, sz], walk: [0.45, Math.PI, -0.05, 0.3], wind: [2.4, -0.5, 0, 0], strike: [0.4, 0.15, 0, 0], die: [-0.3, -0.3, 0, 0], misc: [-0.15, 0.8, 0.15, 1] },
    [J.FARM_L]: { p: [0.01, el, sz], walk: [0.2, Math.PI + 0.5, 0, 0.35], wind: [0.8, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [0, 0, 0, 0], misc: [0, 0.6, 0.15, 1] },
    ...legJoints(hip, knee, hz, 0.42, 0.8, { thigh: { walk: [0.42, 0, 0, 0.1], wind: [0.25, 0, 0, 0], strike: [-0.2, 0, 0, 0], die: [1.2, 0, 0, 0], misc: [0, 0.3, 1, 2] }, shin: { wind: [-0.5, 0, 0, 0], die: [-1.9, 0, 0, 0] } }),
  }, { stride: 1.25, bob: 0.07, drop: 0.24, turn: 5, flinch: 0.25, scale: UNIT });
}

// A dead dog: a shepherd's frame gone to bone, ribs through a hide worn through in patches,
// the head carried low, lips gone from the teeth. It runs in a gallop, crouches and leaps.
// The coat is the instance's hair colour, the bare patches its skin.
export function hound(): CreepRig {
  const p: RigPart[] = [];
  const PAW = 0x2a221a, NOSE = PAL.ink;
  // The body along x: a deep chest, the waist tucked up under the spine, a bony rump.
  p.push(B(J.CHEST, 0.24, 0.17, 0.15, HAIR, 0.12, 0.43));
  p.push(B(J.CHEST, 0.14, 0.1, 0.13, HAIR, 0.13, 0.32));
  p.push(G(J.CHEST, slab(0.17, 0.11, 0.17, 0.12, 0.1), HAIR, -0.07, 0.46));
  p.push(B(J.CHEST, 0.18, 0.15, 0.14, HAIR, -0.21, 0.45, 0, 0, 0, 0.12));
  // The spine's knobs, the ribs down each side through bare skin, raw patches, a wound.
  for (const x of [0.16, 0.05, -0.06, -0.17]) p.push(B(J.CHEST, 0.03, 0.02, 0.03, darker(BONE, 0.7), x, 0.52));
  for (const z of [0.078, -0.078]) {
    for (const [x, y] of [[0.06, 0.41], [0.12, 0.42], [0.18, 0.42], [0.09, 0.37], [0.15, 0.37]]) p.push(B(J.CHEST, 0.02, 0.05, 0.012, BONE, x, y, z * 1.06));
    p.push(B(J.CHEST, 0.05, 0.05, 0.012, SKIN, 0.03, 0.37, z));
  }
  p.push(B(J.CHEST, 0.05, 0.045, 0.02, GORE, -0.2, 0.47, 0.072));
  p.push(B(J.CHEST, 0.05, 0.05, 0.02, SKIN, -0.05, 0.47, -0.065));
  p.push(B(J.CHEST, 0.05, 0.02, 0.05, SKIN, -0.14, 0.525, 0.02));
  // The tail, thin and hanging.
  p.push(B(J.CHEST, 0.03, 0.2, 0.03, HAIR, -0.33, 0.42, 0, 0, 0, -0.5));
  // Neck and head, low and forward: the long skull, the muzzle, the jaw open on the teeth,
  // the ears laid back, milky eyes.
  p.push(G(J.HEAD, slab(0.12, 0.1, 0.1, 0.085, 0.14), HAIR, 0.24, 0.47, 0, 0, 0, -1.05));
  p.push(B(J.HEAD, 0.13, 0.1, 0.1, HAIR, 0.35, 0.46));
  p.push(G(J.HEAD, slab(0.12, 0.07, 0.11, 0.06, 0.05), SKIN, 0.46, 0.445));
  p.push(B(J.HEAD, 0.03, 0.03, 0.04, NOSE, 0.525, 0.455));
  p.push(B(J.HEAD, 0.11, 0.025, 0.055, HAIR, 0.45, 0.395, 0, 0, 0, -0.25));
  p.push(B(J.HEAD, 0.05, 0.02, 0.05, MOUTH, 0.43, 0.415));
  for (const z of [0.024, -0.024]) {
    p.push(B(J.HEAD, 0.05, 0.015, 0.01, BONE, 0.48, 0.423, z));
    p.push(B(J.HEAD, 0.018, 0.018, 0.018, EYE, 0.4, 0.485, z * 1.9));
    p.push(B(J.HEAD, 0.045, 0.03, 0.025, HAIR, 0.31, 0.52, z * 2.5, 0, 0, 0.5));
  }
  p.push(B(J.HEAD, 0.03, 0.04, 0.03, GORE, 0.5, 0.41, 0.02));
  // Forelegs on the arm joints, hind legs on the leg joints: the hind thigh a haunch, the hock
  // turned back.
  for (const s of [1, -1]) {
    const z = 0.06 * s;
    const ua = side(s, J.UARM_L, J.UARM_R), fa = side(s, J.FARM_L, J.FARM_R), th = side(s, J.THIGH_L, J.THIGH_R), sn = side(s, J.SHIN_L, J.SHIN_R);
    p.push(L(ua, 0.2, 0.42, 0.05, 0.045, 0.09, 0.055, HAIR, 0.17, z));
    p.push(L(fa, 0.03, 0.2, 0.035, 0.035, 0.045, 0.04, side(s, HAIR, SKIN), 0.17, z));
    p.push(B(fa, 0.05, 0.03, 0.045, PAW, 0.185, 0.015, z));
    p.push(G(th, slab(0.07, 0.05, 0.15, 0.06, 0.2, 0.03), HAIR, -0.22, 0.36, z));
    p.push(B(sn, 0.035, 0.16, 0.035, side(s, HAIR, SKIN), -0.25, 0.17, z, 0, 0, 0.3));
    p.push(B(sn, 0.03, 0.1, 0.03, HAIR, -0.21, 0.06, z));
    p.push(B(sn, 0.05, 0.03, 0.045, PAW, -0.195, 0.015, z));
  }
  // A gallop: the forelegs nearly together, the hind legs half a stride behind them.
  const leg = (s: number, d: JointDef): JointDef => ({ ...d, misc: [0, 0.5, s, d.misc![3]], walk: [d.walk![0], d.walk![1] + (s > 0 ? 0 : 0.5), 0, d.walk![3]] as V4 });
  const fore: JointDef = { p: [0.17, 0.42, 0.06], walk: [0.75, 0, 0, 0], wind: [-0.7, 0, 0, 0], strike: [1.3, 0, 0, 0], die: [0.9, 0.3, 0, 0], misc: [0, 0.5, 1, 1] };
  const foreLo: JointDef = { p: [0.17, 0.2, 0.06], walk: [0, 0, 0, 0], flex: [-0.9, Math.PI / 2, 0, 0], wind: [1.1, 0, 0, 0], strike: [-0.3, 0, 0, 0], die: [0.4, 0, 0, 0], misc: [0, 0.4, 1, 1] };
  const hind: JointDef = { p: [-0.21, 0.44, 0.06], walk: [0.7, Math.PI, 0, 0], wind: [0.6, 0, 0, 0], strike: [-0.9, 0, 0, 0], die: [-0.9, 0.3, 0, 0], misc: [0, 0.5, 1, 2] };
  const hindLo: JointDef = { p: [-0.26, 0.25, 0.06], walk: [0, Math.PI, 0, 0], flex: [-0.9, Math.PI / 2, 0, 0], wind: [-0.8, 0, 0, 0], strike: [0.3, 0, 0, 0], die: [-0.4, 0, 0, 0], misc: [0, 0.4, 1, 2] };
  const right = (d: JointDef): JointDef => ({ ...d, p: [d.p[0], d.p[1], -d.p[2]] as V3 });
  return rig(p, {
    [J.CHEST]: { p: [0, 0.44, 0], walk: [0.14, Math.PI / 2, 0.04, 0], flex: [0, 0, 0.08, 0.02], wind: [-0.22, 0, 0, 0], strike: [0.3, 0, 0, 0], die: [0, 1.3, 0, 0], misc: [0.3, 0.3, 0, 0] },
    [J.HEAD]: { p: [0.2, 0.47, 0], walk: [0.12, 1.2, 0.05, -0.05], flex: [0, 0, 0, 0.1], wind: [-0.4, 0, 0, 0], strike: [0.5, 0, 0, 0], die: [-0.6, 0.4, 0, 0], misc: [0.4, 0.5, 0, 0] },
    [J.UARM_L]: leg(1, fore), [J.FARM_L]: leg(1, foreLo),
    [J.UARM_R]: right(leg(-1, fore)), [J.FARM_R]: right(leg(-1, foreLo)),
    [J.THIGH_L]: leg(1, hind), [J.SHIN_L]: leg(1, hindLo),
    [J.THIGH_R]: right(leg(-1, hind)), [J.SHIN_R]: right(leg(-1, hindLo)),
  }, { stride: 1.2, bob: 0.04, drop: 0.09, turn: 12, flinch: 1.2, scale: UNIT });
}

// The picture's grabber, as the one that spits: gaunt, leaning in with both arms out, the
// throat swollen and the jaw hanging slack under it, a sickly yellow-green stained down the
// front from the mouth to the belt. It fills its throat, head back, and whips the spit out.
export function spitter(): CreepRig {
  const p: RigPart[] = [];
  const BILE = 0x8e8c3a, BILED = 0x5e6428, SAC = 0x9a9466, SACD = 0x6e6a44;
  const hip = 0.57, knee = 0.3, hz = 0.1, sh = 1.0, el = 0.78, sz = 0.25;
  for (const s of [1, -1]) {
    const z = hz * s, th = side(s, J.THIGH_L, J.THIGH_R), sn = side(s, J.SHIN_L, J.SHIN_R);
    p.push(L(th, knee - 0.02, hip + 0.08, 0.11, 0.11, 0.15, 0.15, PANTS, 0, z));
    p.push(L(sn, 0.09, knee + 0.02, 0.1, 0.1, 0.12, 0.12, PANTS, 0, z));
    boot(p, sn, 0.02, z, 0.24, 0.12, PAL.leatherDark);
  }
  // A thin chest in a torn shirt, the collarbones showing at the neck, a flap hanging.
  p.push(L(J.CHEST, 0.6, 0.86, 0.2, 0.3, 0.22, 0.32, SHIRT, 0.0));
  p.push(L(J.CHEST, 0.86, 1.04, 0.22, 0.32, 0.2, 0.42, SHIRT, 0.0));
  p.push(L(J.CHEST, 0.96, 1.07, 0.03, 0.1, 0.03, 0.13, SKIN, 0.1));
  p.push(B(J.CHEST, 0.12, 0.05, 0.08, SHIRT, -0.02, 0.58, 0.12, 0.3, 0, 0));
  // The stain: down the throat and the chest and on to the belt, in runs.
  p.push(L(J.CHEST, 0.74, 1.04, 0.02, 0.1, 0.02, 0.22, BILE, 0.118));
  for (const [z, y0, y1] of [[0.07, 0.66, 0.79], [-0.05, 0.62, 0.75], [0.0, 0.68, 0.8], [-0.05, 0.75, 0.8]] as const) p.push(L(J.CHEST, y0, y1, 0.02, 0.035, 0.02, 0.04, BILED, 0.113, z));
  p.push(B(J.CHEST, 0.02, 0.06, 0.12, BILED, 0.122, 0.98, -0.02));
  p.push(B(J.CHEST, 0.02, 0.06, 0.06, BILED, 0.113, 0.6, 0.06));
  // The throat: a swollen sac under the jaw, veined, on its own joint so it fills.
  p.push(G(J.X, new THREE.SphereGeometry(0.1, 6, 4).scale(1, 0.9, 1.15), SAC, 0.12, 1.09));
  p.push(B(J.X, 0.03, 0.1, 0.02, SACD, 0.21, 1.1, 0.04, 0.3));
  p.push(B(J.X, 0.03, 0.09, 0.02, SACD, 0.2, 1.08, -0.06, -0.3));
  p.push(B(J.X, 0.03, 0.07, 0.1, BILE, 0.205, 1.03, -0.01));
  // The head: thin hair, the jaw slack and too wide, bile running from the mouth.
  const hx = 0.07, hy = 1.07;
  deadHead(p, J.HEAD, hx, hy, 1.0, { jaw: 0.05 });
  p.push(B(J.HEAD, 0.1, 0.07, 0.13, SKIN, hx + 0.06, hy + 0.03));
  p.push(B(J.HEAD, 0.02, 0.12, 0.05, BILE, hx + 0.13, hy + 0.0, -0.02));
  // Thin arms, sleeves to the elbow, out in front reaching; the hands clawed and stained.
  for (const s of [1, -1]) {
    const z = sz * s, u = side(s, J.UARM_L, J.UARM_R), f = side(s, J.FARM_L, J.FARM_R);
    p.push(B(u, 0.12, 0.11, 0.12, SHIRT, 0, sh - 0.01, z));
    p.push(L(u, el + 0.02, sh - 0.05, 0.095, 0.095, 0.11, 0.11, SHIRT, 0, z));
    p.push(L(f, 0.57, el + 0.02, 0.075, 0.075, 0.085, 0.085, SKIN, 0, z));
    hand(p, f, 0.01, 0.52, z, 0.95, SKIN, BILED);
  }
  p.push(B(J.FARM_L, 0.02, 0.1, 0.06, BLOOD, 0.045, 0.68, sz));
  return rig(p, {
    [J.CHEST]: { p: [0, 0.6, 0], walk: [0, 0, 0.12, -0.35], flex: [0, 0, 0.08, 0.03], wind: [0.35, 0, 0, 0], strike: [-0.45, 0, 0, 0], die: [-0.4, 0, 0.2, 0], misc: [0.3, 0.3, 0, 0] },
    [J.X]: { p: [0.1, 1.1, 0], walk: [0, 0, 0.05, 0], flex: [0, 0, 0, 0.04], wind: [0, 0, 0, 0.4], strike: [0, 0, 0, -0.25], die: [0, 0, 0, -0.1], misc: [0.1, 0.2, 0, 0] },
    [J.HEAD]: { p: [hx, hy, 0], walk: [0, 1, 0.12, 0.25], flex: [0, 0, 0, 0.06], wind: [0.7, 0, 0, 0], strike: [-1.0, 0, 0, 0], die: [-0.5, 0.3, 0, 0], misc: [0.4, 0.4, 0, 0] },
    [J.UARM_L]: { p: [0, sh, sz], walk: [0.12, 0.5, -0.05, 1.45], flex: [0, 0, 0, 0.06], wind: [-0.9, -0.4, 0, 0], strike: [0.4, 0, 0, 0], die: [-1.0, -0.2, 0, 0], misc: [-0.4, 1.4, 1, 1] },
    [J.FARM_L]: { p: [0, el, sz], walk: [0.1, 1.0, 0, -0.3], wind: [0.4, 0, 0, 0], strike: [-0.2, 0, 0, 0], die: [-0.2, 0, 0, 0], misc: [0, 0.9, 1, 1] },
    ...legJoints(hip, knee, hz, 0.38, 0.75),
  }, { stride: 0.85, bob: 0.03, drop: 0.22, turn: 5, flinch: 0.8, scale: UNIT });
}

// The thrower: tall and rangy in a torn work jacket, one arm grown long and heavy (the jacket's
// sleeve split off it), a lump of broken concrete in that hand hanging at its knee. It rears,
// the long arm back over its head, and throws.
export function hurler(): CreepRig {
  const p: RigPart[] = [];
  const JACKET = PAL.canvas, JACKETD = darker(PAL.canvas, 0.7), ROCK = PAL.concrete, REBAR = PAL.rust;
  const hip = 0.7, knee = 0.37, hz = 0.1, sh = 1.18, el = 0.9, sz = 0.26;
  for (const s of [1, -1]) {
    const z = hz * s, th = side(s, J.THIGH_L, J.THIGH_R), sn = side(s, J.SHIN_L, J.SHIN_R);
    p.push(L(th, knee - 0.02, hip + 0.08, 0.11, 0.11, 0.15, 0.15, PANTS, 0, z));
    p.push(L(sn, 0.09, knee + 0.02, 0.095, 0.095, 0.12, 0.12, PANTS, 0, z));
    boot(p, sn, 0.02, z, 0.25, 0.12);
  }
  // A long thin trunk; the shirt between the jacket's open fronts, the jacket torn at the hem.
  p.push(L(J.CHEST, 0.72, 1.18, 0.18, 0.28, 0.21, 0.36, SHIRT, 0.0));
  for (const z of [0.12, -0.12]) p.push(L(J.CHEST, 0.66, 1.18, 0.24, 0.1, 0.25, 0.14, JACKET, -0.005, z));
  p.push(L(J.CHEST, 0.68, 1.18, 0.04, 0.3, 0.04, 0.36, JACKET, -0.11));
  for (const z of [0.1, -0.1]) p.push(B(J.CHEST, 0.06, 0.08, 0.14, JACKETD, -0.08, 1.22, z));
  p.push(B(J.CHEST, 0.12, 0.12, 0.05, JACKET, 0.0, 0.6, 0.15, 0.25));
  p.push(B(J.CHEST, 0.03, 0.12, 0.05, JACKETD, 0.12, 0.62, -0.13));
  p.push(B(J.CHEST, 0.02, 0.13, 0.08, BLOOD, 0.106, 0.92, 0.02));
  p.push(B(J.CHEST, 0.02, 0.06, 0.04, CLOT, 0.106, 0.82, -0.03));
  // The long arm's shoulder: swollen, the skin split over it.
  p.push(B(J.CHEST, 0.2, 0.16, 0.18, SKIN, 0.0, 1.17, sz - 0.04));
  p.push(B(J.CHEST, 0.08, 0.04, 0.06, GORE, 0.06, 1.25, sz - 0.04));
  const hx = 0.06, hy = 1.17;
  deadHead(p, J.HEAD, hx, hy, 0.95, { jaw: 0.03 });
  // The long arm (left): thick to the elbow, a forearm like a club, the rock in the hand.
  p.push(L(J.UARM_L, el, sh - 0.04, 0.13, 0.13, 0.17, 0.17, SKIN, 0.0, sz));
  p.push(L(J.FARM_L, 0.44, el, 0.13, 0.13, 0.17, 0.16, SKIN, 0.01, sz));
  p.push(B(J.FARM_L, 0.02, 0.13, 0.06, BLOOD, 0.09, 0.66, sz));
  hand(p, J.FARM_L, 0.03, 0.38, sz, 1.25);
  p.push(G(J.FARM_L, slab(0.2, 0.18, 0.15, 0.16, 0.16, 0.03), ROCK, 0.08, 0.26, sz, 0.3, 0.4, 0.2));
  p.push(B(J.FARM_L, 0.015, 0.12, 0.015, REBAR, 0.1, 0.36, sz + 0.06, 0.5, 0, -0.5));
  // The other arm, a thin one in the jacket's sleeve.
  p.push(B(J.UARM_R, 0.12, 0.11, 0.12, JACKET, 0, sh - 0.02, -sz + 0.02));
  p.push(L(J.UARM_R, el + 0.03, sh - 0.05, 0.1, 0.1, 0.11, 0.11, JACKET, 0, -sz + 0.02));
  p.push(L(J.FARM_R, 0.66, el + 0.02, 0.075, 0.075, 0.095, 0.095, JACKET, 0, -sz + 0.02));
  hand(p, J.FARM_R, 0.01, 0.62, -sz + 0.02, 0.85);
  const big: JointDef = { p: [0, sh, sz], walk: [0.15, 0.5, -0.05, 0.12], flex: [0, 0, 0, 0.04], wind: [-2.6, -0.2, 0, 0], strike: [1.5, 0.1, 0, 0], die: [-1.0, -0.2, 0, 0], misc: [-0.3, 1.0, 1, 1] };
  const bigLo: JointDef = { p: [0, el, sz], walk: [0.1, 1.0, 0, 0.12], wind: [0.9, 0, 0, 0], strike: [-0.2, 0, 0, 0], die: [-0.2, 0, 0, 0], misc: [0, 0.7, 1, 1] };
  const small = mirror({ ...big, p: [0, sh, sz - 0.02], walk: [0.3, 0.5, -0.05, 0.1], wind: [0.6, -0.3, 0, 0], strike: [-0.4, 0, 0, 0], misc: [-0.4, 1.4, 1, 1] });
  const smallLo = mirror({ ...bigLo, p: [0, el, sz - 0.02], walk: [0.15, 1.0, 0, 0.3], wind: [0.4, 0, 0, 0], strike: [0.1, 0, 0, 0], misc: [0, 0.9, 1, 1] });
  return rig(p, {
    [J.CHEST]: { p: [0, 0.7, 0], walk: [0, 0, 0.08, -0.15], flex: [0, 0, 0.1, 0.03], wind: [0.55, 0, -0.3, 0], strike: [-0.6, 0, 0.3, 0], die: [-0.5, 0, 0.2, 0], misc: [0.35, 0.3, 0, 0] },
    [J.HEAD]: { p: [hx, hy, 0], walk: [0, 1.2, 0.15, 0.05], flex: [0, 0, 0, 0.06], wind: [0.4, 0, 0, 0], strike: [-0.5, 0, 0, 0], die: [-0.5, 0.3, 0, 0], misc: [0.5, 0.4, 0, 0] },
    [J.UARM_L]: big, [J.FARM_L]: bigLo, [J.UARM_R]: small, [J.FARM_R]: smallLo,
    ...legJoints(hip, knee, hz, 0.38, 0.8),
  }, { stride: 1.05, bob: 0.03, drop: 0.28, turn: 5, flinch: 0.9, scale: UNIT });
}
