import * as THREE from 'three/webgpu';
import { color, sin, time, vertexColor } from 'three/tsl';
import { WEAPON_BASE } from '../demo/defs';
import { Art, ART_TIME, Emote, GREAT, KATANA, legendary, Order, PF_ALIVE, PF_FIRING, PF_HURT, PF_RELOADING, OWNED_DUAL, OWNED_DUAL_KATANA, THROW_FLIGHT } from '../protocol';
import type { Game } from '../state';
import { litMaterial } from './structs';
import { Body, type Look, readLook, shade } from './look';
import { ik2, Spring, turnTowards, wrapAngle } from './rig';
import { box, merge, part, type Part, playerColor, sphere } from './util';

interface Limb { upper: THREE.Group; lower: THREE.Group }
interface Hero {
  group: THREE.Group; body: THREE.Group; hips: THREE.Group; torso: THREE.Group; head: THREE.Group; tail: THREE.Group | null; pack: THREE.Group;
  legL: Limb; legR: Limb; armL: Limb; armR: Limb;
  gun: THREE.Group; gunMesh: THREE.Mesh | null; spin: THREE.Group | null; glow: THREE.Mesh | null; flash: THREE.Object3D; finger: THREE.Object3D; hand: THREE.Object3D;
  gun2: THREE.Group; dual: boolean; alt: boolean; // the second pistol or katana, in the left hand; alt: the last shot was its
  evo: number; // the legendary's evolution its blade is dressed for
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

// Limb lengths, shoulder to elbow and elbow to the middle of the hand.
const UPPER = 0.23, FORE = 0.2;
const WAIST = 0.6, HIP = 0.58, THIGH = 0.28;

// How each weapon is carried: where it sits in the torso's space (origin at the waist, +x the
// way the hero faces), where each hand holds it in its own, and where its muzzle is.
interface Hold { at: [number, number, number]; grip: [number, number, number]; fore: [number, number, number]; muzzle: number }
const HOLDS: Hold[] = [
  { at: [0.44, 0.36, -0.05], grip: [0, -0.05, 0], fore: [-0.01, -0.08, 0.06], muzzle: 0.28 },   // pistol, both hands out
  { at: [0.16, 0.38, -0.15], grip: [0, -0.04, 0], fore: [0.42, -0.02, 0], muzzle: 0.64 },       // shotgun, shouldered
  { at: [0.24, 0.32, -0.12], grip: [0, -0.05, 0], fore: [0.13, -0.13, 0], muzzle: 0.42 },       // SMG
  { at: [0.15, 0.39, -0.15], grip: [0, -0.04, 0], fore: [0.36, -0.03, 0], muzzle: 0.74 },       // rifle
  { at: [0.24, 0.13, -0.1], grip: [-0.1, 0.02, -0.06], fore: [0.02, 0.15, 0.06], muzzle: 0.68 }, // minigun, braced at the hip
  { at: [0.0, 0.55, -0.2], grip: [0.06, -0.09, 0], fore: [0.32, -0.09, 0.02], muzzle: 0.62 },   // launcher, on the shoulder
  { at: [0.16, 0.24, -0.17], grip: [0, 0, 0], fore: [-0.09, 0, 0], muzzle: 0.6 },             // crowbar, both hands on the tape, up at the shoulder
];

// The legendaries are held two-handed, the off hand behind the grip on the hilt; their poses
// are set by the swing (legendPose), so at is only where a fresh one starts.
HOLDS[KATANA] = { at: [0.26, 0.14, -0.2], grip: [0, 0, 0], fore: [-0.11, 0, 0], muzzle: 0.9 };
HOLDS[GREAT] = { at: [0, 0.6, -0.22], grip: [0, 0, 0], fore: [-0.14, 0, 0], muzzle: 1.3 };

// A legendary's edge, lit: plain steel's shine, then by evolution (Crimson Fang, Moonlit Edge;
// Ashen Colossus, Stormbreaker).
const EDGE: Record<number, number[]> = { [KATANA]: [0xc8d2e4, 0xff2030, 0x9fdcff], [GREAT]: [0x8a8e96, 0xff6a10, 0xb080ff] };

// The gun in the hand, facing +x from the grip, dressed in the player's colour. glow: the parts
// drawn lit, a legendary's edge.
export function gunParts(w: number, c: number, evo = 0): { body: Part[]; spin: Part[]; glow: Part[] } {
  const D = 0x2b2b2b, M = 0x3e3e40, W = 0x5a3e24, O = 0x4e5236;
  const b: Part[] = [], s: Part[] = [], gl: Part[] = [];
  const add = (to: Part[], wd: number, h: number, d: number, col: number, x: number, y: number, z = 0, rz = 0) => to.push(part(box(wd, h, d), col, x, y, z, 0, 0, rz));
  switch (w) {
    case 0:
      add(b, 0.3, 0.09, 0.07, D, 0.1, 0.05); add(b, 0.08, 0.15, 0.07, W, 0, -0.03, 0, 0.25); add(b, 0.08, 0.03, 0.075, c, 0.12, 0.1); break;
    case 1:
      add(b, 0.62, 0.06, 0.06, D, 0.3, 0.06); add(b, 0.18, 0.07, 0.09, W, 0.42, 0.0); add(b, 0.22, 0.1, 0.08, M, 0.03, 0.04);
      add(b, 0.28, 0.09, 0.07, W, -0.21, 0.0, 0, -0.12); add(b, 0.1, 0.035, 0.085, c, 0.02, 0.1); break;
    case 2:
      add(b, 0.36, 0.11, 0.08, D, 0.1, 0.04); add(b, 0.06, 0.18, 0.06, M, 0.13, -0.1); add(b, 0.12, 0.04, 0.04, D, 0.34, 0.06);
      add(b, 0.18, 0.035, 0.035, M, -0.16, 0.02); add(b, 0.06, 0.12, 0.06, D, 0, -0.06, 0, 0.2); add(b, 0.12, 0.03, 0.085, c, 0.08, 0.1); break;
    case 3:
      add(b, 0.5, 0.1, 0.08, D, 0.15, 0.04); add(b, 0.3, 0.04, 0.04, D, 0.56, 0.05); add(b, 0.26, 0.11, 0.07, W, -0.2, 0.0, 0, -0.08);
      add(b, 0.2, 0.06, 0.06, 0x1a1a1c, 0.12, 0.13); add(b, 0.07, 0.13, 0.06, M, 0.18, -0.08); add(b, 0.12, 0.03, 0.085, c, 0.3, 0.09); break;
    case 4:
      add(b, 0.3, 0.16, 0.16, D, 0.0, 0.02); add(b, 0.15, 0.04, 0.04, M, 0.0, 0.13); add(b, 0.16, 0.14, 0.12, O, -0.02, -0.12, 0.08);
      add(b, 0.1, 0.06, 0.18, c, 0.12, 0.02);
      for (const [y, z] of [[0.04, 0.04], [0.04, -0.04], [-0.03, 0], [0.09, 0]]) add(s, 0.56, 0.035, 0.035, M, 0.4, y - 0.02, z);
      break;
    case 6:
      // A bar, bent to a claw at the far end, and tape on the grip in the player's colour.
      add(b, 0.62, 0.035, 0.035, 0x4a4f57, 0.24, 0.0, 0, 0.12); add(b, 0.14, 0.035, 0.035, 0x4a4f57, 0.56, 0.1, 0, 1.2);
      add(b, 0.14, 0.05, 0.05, c, 0.0, -0.02, 0, 0.12); break;
    case KATANA: {
      // A long hilt bound in the player's colour, a gold guard, and a blade that curves up
      // towards its point in three lengths, its edge underneath.
      const edge = EDGE[KATANA][evo] ?? EDGE[KATANA][0];
      add(b, 0.24, 0.045, 0.045, c, -0.06, 0); add(b, 0.03, 0.05, 0.05, 0x1a1410, -0.19, 0);
      for (const x of [-0.13, -0.06, 0.01]) add(b, 0.02, 0.05, 0.05, shade(c, 0.55), x, 0);
      add(b, 0.025, 0.1, 0.1, 0x9a7a30, 0.075, 0); add(b, 0.03, 0.05, 0.03, 0xc8a050, 0.1, 0);
      const seg = [[0.25, 0.3, 0.0, 0.03], [0.53, 0.28, 0.014, 0.07], [0.77, 0.22, 0.036, 0.15]];
      seg.forEach(([x, l, y, rz], i) => {
        add(b, l, i === 2 ? 0.03 : 0.04, 0.014, 0xb8bec8, x, y + 0.006, 0, rz);
        gl.push(part(box(l, 0.012, 0.016), edge, x, y - 0.014, 0, 0, 0, rz));
      });
      add(b, 0.05, 0.018, 0.016, 0xe8ecf4, 0.9, 0.055, 0, 0.35);
      break;
    }
    case GREAT: {
      // A great slab of iron: a leather grip and a heavy pommel, a wide crossguard with a
      // stone in the player's colour, and a broad blade with a dark fuller down it.
      const edge = EDGE[GREAT][evo] ?? EDGE[GREAT][0];
      add(b, 0.26, 0.06, 0.06, 0x3a2a1c, -0.1, 0); add(b, 0.08, 0.08, 0.08, 0x8a7038, -0.25, 0);
      add(b, 0.06, 0.07, 0.4, 0x4a4e56, 0.05, 0); add(b, 0.065, 0.06, 0.07, c, 0.05, 0);
      add(b, 1.0, 0.15, 0.035, 0x8e949c, 0.58, 0); add(b, 0.86, 0.035, 0.04, 0x5a5e66, 0.54, 0);
      add(b, 0.14, 0.09, 0.034, 0x8e949c, 1.12, 0); add(b, 0.06, 0.04, 0.032, 0x8e949c, 1.21, 0);
      gl.push(part(box(1.0, 0.016, 0.038), edge, 0.58, 0.075), part(box(1.0, 0.016, 0.038), edge, 0.58, -0.075));
      if (evo) for (const x of [0.3, 0.5, 0.7, 0.9]) gl.push(part(box(0.04, 0.05, 0.042), edge, x, 0, 0, 0, 0, 0.6));
      break;
    }
    default:
      add(b, 0.8, 0.13, 0.13, O, 0.15, 0.03); add(b, 0.08, 0.17, 0.17, 0x3a3e28, 0.56, 0.03); add(b, 0.06, 0.14, 0.06, D, 0.05, -0.08);
      add(b, 0.06, 0.08, 0.02, D, 0.0, 0.12, 0.06); add(b, 0.1, 0.135, 0.135, c, -0.2, 0.03);
  }
  return { body: b, spin: s, glow: gl };
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
    // A survivor: the player's colour as the main garment (a little faded), the rest from the
    // look the host dealt them.
    const L = readLook(look), A = L.arch;
    const c = garment(id);
    const dark = shade(c, 0.6);
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    const hips = new THREE.Group(), torso = new THREE.Group();
    hips.rotation.order = torso.rotation.order = 'YXZ';
    torso.position.y = WAIST;
    body.add(hips, torso);
    const F = figure(L, c);
    this.mesh(F.torso, torso, 0, WAIST);
    const head = new THREE.Group();
    head.position.set(0.01, 1.1 - WAIST, 0);
    head.rotation.order = 'YXZ';
    torso.add(head);
    this.mesh([...F.head, ...F.eyes, ...F.mouth], head, 0.01, 1.1);
    // Night vision goggles, shown once bought.
    const goggles = new THREE.Group();
    goggles.visible = false;
    head.add(goggles);
    this.mesh(GOGGLES, goggles, 0.01, 1.1);
    const lens = new THREE.Mesh(this.lensGeo, this.lensMat);
    lens.position.set(-0.01, -1.1, 0);
    goggles.add(lens);
    let tail: THREE.Group | null = null;
    if (F.tail.length) {
      tail = new THREE.Group();
      tail.position.set(-0.12, 0.25, 0);
      head.add(tail);
      this.mesh(F.tail, tail, -0.11, 1.35);
    }
    const pack = new THREE.Group();
    pack.position.set(0, 0, 0);
    torso.add(pack);
    this.mesh(F.pack, pack, 0, WAIST);

    // Legs: thigh from the hip, shin and boot from the knee.
    const legs = A.pcLegs ? shade(c, 0.85) : A.legs;
    this.mesh([part(box(0.3, 0.13, (L.body === Body.Fem ? 0.44 : 0.42)), legs, 0, HIP - 0.02, 0)], hips);
    const leg = (z: number): Limb => {
      const upper = new THREE.Group(), lower = new THREE.Group();
      upper.position.set(0, HIP, z);
      lower.position.set(0, -THIGH, 0);
      upper.add(lower);
      hips.add(upper);
      this.mesh([part(box(0.17, 0.31, 0.17), legs, 0, -0.14, 0)], upper);
      this.mesh([part(box(0.15, 0.27, 0.15), legs, 0, -0.13, 0), part(box(0.25, 0.09, 0.19), A.boots, 0.04, -0.255, 0),
        part(box(0.155, 0.07, 0.155), shade(legs, 0.85), 0, 0.0, 0)], lower);
      return { upper, lower };
    };
    const legL = leg(0.12), legR = leg(-0.12);

    // Arms: shoulder, sleeve, forearm and hand.
    const sh = 0.3 * (L.body === Body.Fem ? 0.93 : 1);
    const open = A.overKind === 'open' && A.over !== undefined;
    const sleeve = open ? A.over! : c;
    const arm = (z: number): Limb => {
      const upper = new THREE.Group(), lower = new THREE.Group();
      upper.position.set(0, 1.0 - WAIST, z);
      lower.position.set(0, -UPPER, 0);
      upper.add(lower);
      torso.add(upper);
      this.mesh([part(box(0.15, 0.15, 0.15), open ? shade(A.over!, 0.8) : dark, 0, -0.02, 0), part(box(0.12, 0.22, 0.12), sleeve, 0, -0.13, 0)], upper);
      return { upper, lower };
    };
    const armL = arm(sh), armR = arm(-sh);
    const forearm = (sk: boolean) => [part(box(0.105, 0.15, 0.105), sk ? L.skin : sleeve, 0, -0.07, 0), part(box(0.1, 0.1, 0.11), L.skin, 0, -FORE, 0)];
    this.mesh(forearm(open || A.name === 'nurse'), armL.lower);
    const hand = this.mesh(forearm(open || A.name === 'nurse'), armR.lower)!;
    // The taunt's middle finger: a fist on the gun hand with one chunky finger up out of it,
    // oversized so it still reads at pixel scale.
    const finger = new THREE.Mesh(merge([part(box(0.15, 0.13, 0.15), L.skin, 0, -FORE, 0), part(box(0.07, 0.3, 0.07), L.skin, 0, -FORE - 0.2, 0)]), this.mat);
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
    g.scale.setScalar(1.15);
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
    const g = gunParts(w, h.color, evo);
    h.gunMesh = this.mesh(g.body, h.gun);
    if (g.glow.length) {
      h.glow = new THREE.Mesh(merge(g.glow), this.edgeMat);
      h.gun.add(h.glow);
    }
    h.spin = null;
    if (g.spin.length) {
      h.spin = new THREE.Group();
      h.spin.position.set(0, 0.02, 0);
      h.gun.add(h.spin);
      this.mesh(g.spin, h.spin, 0, 0.02);
    }
    const hold = HOLDS[w] ?? HOLDS[0];
    h.flash.position.x = hold.muzzle;
    h.group.traverse((c) => { c.userData.hl = h.group.userData.hl ?? 0; });
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
      const g = gunParts(h.weapon, h.color, h.evo);
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
    else if (after >= 0 && h.artWas === Art.Flash) {
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
      this.setWeapon(h, p.cur, legendary(p.cur) ? p.evo[p.cur] : 0);
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
      // goes on to the next cut of the combo if it came soon enough, else starts it over; under
      // Titan's Wrath every one is the follow-through. An art is timed here from when it was
      // first seen, the frames' progress too coarse to fly by.
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
          const wrath = h.weapon === GREAT && p.buff === GREAT + 1 && p.buffLeft > 0;
          h.combo = wrath ? 2 : now - h.swingAt < 1300 ? (h.combo + 1) % 3 : 0;
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
      let after = leg && h.art === Art.None ? (now - h.artEnd) / (h.artWas === Art.Flash ? 700 : 650) : -1;
      if (after > 1) after = -1;
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
        h.shotAt = now; h.kick.kick(h.weapon === 1 || h.weapon === 5 ? 9 : h.weapon === 6 ? -14 : 3);
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
      // for Flash Draw and after a cut has landed, knees tucked up through Skyfall.
      h.stance = ease(h.stance, (leg && (firing || su >= 0 || after >= 0 || h.art !== Art.None)) || hr >= 0 || hs >= 0 ? 1 : 0, 9, dt);
      const st = h.stance * (1 - walk * 0.8), low = drawing ? 1 : after >= 0 ? Math.min(1, (1 - after) * 2.5) : hr >= 0 ? 0.6 * hr : hs >= 0 ? 0.6 * (1 - hs) : 0;
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
      const lunge = su >= 0 ? leg!.lunge[h.combo] * (su < 0.2 ? su / 0.2 : 1 - (su - 0.2) / 0.8) : 0;
      const hop = su >= 0 && h.weapon === GREAT && h.combo === 2 && su < 0.2 ? Math.sin(su / 0.2 * Math.PI) * 0.35 : 0;
      h.body.position.y = bob + popY - cr * 0.27 + lp * 0.12 + h.downAmt * 0.2 - st * 0.08 - low * 0.2 + hop;
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
      const twist = leg ? h.bp[4] * 0.3 * (h.dual ? 0.5 : 1) : coil, bow = leg ? lunge * 0.9 + low * 0.35 : low * 0.3;
      h.torso.rotation.set(0, -(ay2 - Math.sin(ph) * 0.1 * walk) + twist, -cr * 0.2 + flinch * 0.6 + kick * 0.15 - shoutLean - lp * 0.25 - h.sprint * 0.12 - bow);
      h.head.rotation.set(0, -wrapAngle(aim - ay2) * 0.6, -flinch * 0.5 + 0.05 * Math.sin(2 * ph) * walk + cr * 0.35 + (alive ? 0 : 0.3));
      if (h.tail) {
        const goal = -0.35 * Math.min(speed, 5) / 5 - 0.12 * Math.abs(Math.sin(2 * ph)) * walk;
        h.tail.rotation.z = h.tailS.update(dt, goal - flinch * 0.4);
      }
      h.pack.position.y = (h.packS.update(dt, bob + popY) - bob - popY) * 0.8;

      // The gun where its hold puts it: kicked back by each shot, carried low at a sprint,
      // canted to the side for a reload.
      const hold = HOLDS[h.weapon] ?? HOLDS[0];
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
      // cut and as Skyfall comes down.
      h.flash.visible = leg ? (drawing && artU > 0.45 && Math.floor(now / 60) % 2 === 0) || (sky && artU > 0.7)
        : h.weapon !== 6 && now - h.shotAt < (h.weapon === 1 ? 70 : 45);
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

// The player's colour as a survivor wears it: a little faded.
export function garment(id: number): number {
  return new THREE.Color(playerColor(id)).lerp(new THREE.Color(0x6a6658), 0.3).getHex();
}

// Night vision goggles: a strap round the head, a mount on top and twin tubes over the eyes,
// and their green lenses. The portraits wear them too.
export const LENSES: Part[] = [part(box(0.012, 0.05, 0.05), 0x8cff6a, 0.263, 1.255, 0.06), part(box(0.012, 0.05, 0.05), 0x8cff6a, 0.263, 1.255, -0.06)];
export const GOGGLES: Part[] = [
  part(box(0.29, 0.05, 0.29), 0x1c1e1a, 0.02, 1.27),
  part(box(0.05, 0.04, 0.06), 0x2c302a, 0.12, 1.33),
  part(box(0.06, 0.09, 0.22), 0x2c302a, 0.165, 1.255),
  part(box(0.08, 0.07, 0.07), 0x22251f, 0.22, 1.255, 0.06),
  part(box(0.08, 0.07, 0.07), 0x22251f, 0.22, 1.255, -0.06),
];

export interface Figure { torso: Part[]; head: Part[]; tail: Part[]; pack: Part[]; eyes: Part[]; mouth: Part[] }

// The figure above the hips, facing +x, at its height standing: torso shaped by body, outfit
// over it, head, face, hair and headgear, and what they carry on their back; in the pieces
// that move apart (the hair that swings, the pack that bounces, and for the portraits the
// eyes that blink and the mouth that shouts).
export function figure(L: Look, c: number): Figure {
  const A = L.arch, skin = L.skin, hair = L.hair;
  const fem = L.body === Body.Fem, masc = L.body === Body.Masc;
  const torso: Part[] = [], head: Part[] = [], tail: Part[] = [], pack: Part[] = [], eyes: Part[] = [], mouth: Part[] = [];
  let p = torso;
  const add = (w: number, h: number, d: number, col: number, x: number, y: number, z = 0, rx = 0, ry = 0, rz = 0) => p.push(part(box(w, h, d), col, x, y, z, rx, ry, rz));

  // Torso: broader in the shoulders, or in the hips; a belt where they meet the legs.
  const chestD = masc ? 0.48 : fem ? 0.42 : 0.45;
  add(0.34, 0.3, chestD, c, 0, 0.93);
  add(0.31, 0.22, fem ? 0.36 : 0.42, c, 0, 0.69);
  if (fem) add(0.08, 0.1, 0.3, c, 0.15, 0.95);
  add(0.32, 0.08, fem ? 0.44 : 0.42, A.pcLegs ? shade(c, 0.85) : A.legs, 0, 0.6);
  add(0.33, 0.04, fem ? 0.45 : 0.43, 0x2a2018, 0, 0.64);

  // Over the shirt.
  const o = A.over;
  if (o !== undefined) switch (A.overKind) {
    case 'vest': add(0.37, 0.42, chestD + 0.03, o, 0, 0.84); break;
    case 'plate': add(0.4, 0.34, chestD + 0.05, o, 0, 0.9); add(0.06, 0.12, 0.12, shade(o, 0.7), 0.21, 0.82, 0.1); add(0.06, 0.12, 0.12, shade(o, 0.7), 0.21, 0.82, -0.1); break;
    case 'bib': add(0.36, 0.26, 0.32, o, 0.01, 0.74); add(0.36, 0.22, 0.05, o, 0.01, 0.96, 0.1); add(0.36, 0.22, 0.05, o, 0.01, 0.96, -0.1); break;
    case 'open': add(0.36, 0.5, 0.15, o, 0, 0.83, chestD / 2 - 0.07); add(0.36, 0.5, 0.15, o, 0, 0.83, -chestD / 2 + 0.07); add(0.36, 0.08, chestD + 0.02, o, 0, 1.06); break;
  }
  if (A.stripe !== undefined) {
    const w = o !== undefined ? 0.38 : 0.36, d = chestD + (o !== undefined ? 0.04 : 0.02);
    add(w, 0.035, d, A.stripe, 0, 0.78);
    if (A.name === 'hunter') { add(w, 0.035, d, A.stripe, 0, 0.92); add(0.36, 0.5, 0.035, A.stripe, 0, 0.83, 0.06); add(0.36, 0.5, 0.035, A.stripe, 0, 0.83, -0.1); }
    else add(w, 0.035, d, A.stripe, 0, 0.98);
  }
  switch (A.chest) {
    case 'cross': add(0.02, 0.1, 0.03, 0xd03030, 0.18, 0.98, -0.11); add(0.02, 0.03, 0.1, 0xd03030, 0.18, 0.98, -0.11); add(0.02, 0.18, 0.05, 0xd03030, -0.18, 0.92); add(0.02, 0.05, 0.18, 0xd03030, -0.18, 0.92); break;
    case 'tie': add(0.02, 0.36, 0.12, 0xe6e2d8, 0.17, 0.88); add(0.02, 0.3, 0.04, 0x8a2a2a, 0.185, 0.88); break;
    case 'lanyard': add(0.02, 0.2, 0.02, 0xe8e8e8, 0.175, 1.0, 0.06); add(0.02, 0.2, 0.02, 0xe8e8e8, 0.175, 1.0, -0.06); add(0.02, 0.08, 0.07, 0xe8e8e8, 0.18, 0.86); break;
    case 'pocket': add(0.02, 0.08, 0.1, shade(c, 0.7), 0.175, 0.98, -0.1); break;
  }

  // What they carry, bouncing on their back.
  p = pack;
  switch (A.back) {
    case 'medbag': add(0.18, 0.18, 0.1, 0xb83a2a, -0.02, 0.66, 0.27); add(0.02, 0.06, 0.06, 0xf0f0e8, 0.07, 0.68, 0.27); add(0.36, 0.04, 0.03, 0x2a2018, 0, 0.9, 0.23, 0.9); break;
    case 'wrench': add(0.03, 0.4, 0.06, 0x8a8c90, -0.19, 0.9, 0, 0.7); add(0.04, 0.08, 0.12, 0x8a8c90, -0.19, 1.06, 0.12, 0.7); break;
    case 'pack': add(0.18, 0.34, 0.32, 0x55593c, -0.26, 0.88); add(0.08, 0.12, 0.26, 0x44482f, -0.36, 0.82); break;
    case 'bigpack': add(0.24, 0.48, 0.36, 0x2c5a8a, -0.28, 0.88); add(0.18, 0.1, 0.38, 0xc84a2a, -0.28, 1.14); add(0.06, 0.16, 0.24, 0x24486e, -0.41, 0.8); break;
    case 'toolbelt': add(0.36, 0.06, (fem ? 0.45 : 0.43) + 0.02, 0x6a4a28, 0, 0.62); add(0.1, 0.12, 0.08, 0x5a3e22, 0.08, 0.56, 0.22); add(0.1, 0.12, 0.08, 0x5a3e22, -0.06, 0.56, -0.22); break;
    case 'satchel': add(0.08, 0.2, 0.26, 0x5a3a22, 0, 0.66, 0.26); add(0.4, 0.035, 0.03, 0x3a2616, 0, 0.88, 0.02, 0.9); break;
    case 'bedroll': add(0.16, 0.3, 0.28, 0x5a4a2a, -0.25, 0.86); add(0.14, 0.14, 0.44, 0x3e5a34, -0.25, 1.08); break;
  }

  // Neck and head; a face on the +x side.
  p = head;
  add(0.12, 0.08, 0.12, shade(skin, 0.88), 0.01, 1.11);
  add(0.26, 0.26, 0.26, skin, 0.02, 1.22);
  add(0.04, 0.06, 0.05, shade(skin, 0.9), 0.16, 1.21);
  p = eyes;
  add(0.03, 0.04, 0.05, 0x141010, 0.15, 1.255, 0.06);
  add(0.03, 0.04, 0.05, 0x141010, 0.15, 1.255, -0.06);
  p = mouth;
  add(0.02, 0.02, 0.08, shade(skin, 0.6), 0.15, 1.15);
  p = head;
  if (L.beard === 1) add(0.05, 0.08, 0.27, shade(skin, 0.72), 0.12, 1.13);
  if (L.beard === 2) { add(0.07, 0.12, 0.28, hair, 0.12, 1.13); add(0.14, 0.1, 0.03, hair, 0.04, 1.18, 0.135); add(0.14, 0.1, 0.03, hair, 0.04, 1.18, -0.135); }
  if (L.beard === 3) add(0.03, 0.03, 0.12, hair, 0.15, 1.185);
  if (L.glasses) { add(0.02, 0.06, 0.1, 0x2a2a30, 0.155, 1.255, 0.06); add(0.02, 0.06, 0.1, 0x2a2a30, 0.155, 1.255, -0.06); add(0.02, 0.025, 0.02, 0x2a2a30, 0.155, 1.265); }

  // Hair.
  const cap = (h = 0.07) => { add(0.28, h, 0.28, hair, 0.01, 1.35 + h / 2); add(0.05, 0.16, 0.28, hair, -0.11, 1.27); };
  const sides = (len: number) => { add(0.12, len, 0.03, hair, -0.04, 1.34 - len / 2, 0.135); add(0.12, len, 0.03, hair, -0.04, 1.34 - len / 2, -0.135); };
  switch (L.style) {
    case 'buzz': add(0.27, 0.03, 0.27, hair, 0.02, 1.36); add(0.03, 0.14, 0.27, hair, -0.115, 1.27); break;
    case 'cornrows': add(0.27, 0.03, 0.27, hair, 0.02, 1.36); add(0.03, 0.14, 0.27, hair, -0.115, 1.27);
      for (const z of [-0.08, 0, 0.08]) add(0.27, 0.025, 0.03, shade(hair, 1.6), 0.01, 1.38, z); break;
    case 'short': cap(); sides(0.08); break;
    case 'crop': cap(0.05); add(0.06, 0.04, 0.26, hair, 0.14, 1.36); break;
    case 'sidecut': add(0.28, 0.09, 0.18, hair, 0.01, 1.39, 0.05); add(0.04, 0.14, 0.28, hair, -0.115, 1.27); add(0.1, 0.12, 0.03, hair, 0.08, 1.3, 0.14); break;
    case 'curly': add(0.32, 0.12, 0.32, hair, 0, 1.39); add(0.08, 0.2, 0.32, hair, -0.1, 1.27); add(0.06, 0.06, 0.3, hair, 0.12, 1.34); break;
    case 'afro': add(0.36, 0.26, 0.38, hair, -0.04, 1.43); add(0.1, 0.22, 0.36, hair, -0.12, 1.26); break;
    case 'mohawk': add(0.03, 0.12, 0.27, hair, -0.115, 1.27); add(0.26, 0.13, 0.05, hair, 0, 1.41); break;
    case 'bun': cap(0.05); add(0.12, 0.11, 0.12, hair, -0.08, 1.44); break;
    case 'ponytail': cap(); p = tail; add(0.07, 0.26, 0.08, hair, -0.17, 1.2, 0, 0, 0, -0.3); p = head; break;
    case 'long': cap(); sides(0.26); p = tail; add(0.06, 0.4, 0.3, hair, -0.12, 1.13); p = head; break;
    case 'locs': cap(); sides(0.22); p = tail; for (const z of [-0.11, -0.04, 0.04, 0.11]) add(0.05, 0.38, 0.05, hair, -0.13, 1.12, z); p = head; break;
    case 'braids': cap(0.05); p = tail; add(0.04, 0.42, 0.04, hair, -0.14, 1.08, 0.07); add(0.04, 0.42, 0.04, hair, -0.14, 1.08, -0.07); p = head; break;
    case 'bob': cap(); sides(0.2); add(0.05, 0.22, 0.3, hair, -0.115, 1.24); break;
    case 'headwrap': add(0.3, 0.17, 0.3, L.wrap, -0.01, 1.37); add(0.14, 0.18, 0.3, L.wrap, -0.08, 1.28); add(0.08, 0.08, 0.1, shade(L.wrap, 0.8), -0.15, 1.42); break;
  }

  // Headgear, sitting higher on big hair; a headwrap is worn instead.
  const hc = A.hatColor, up = L.style === 'afro' ? 0.1 : L.style === 'curly' || L.style === 'mohawk' ? 0.04 : 0;
  switch (L.style === 'headwrap' ? 'none' : A.hat) {
    case 'cap': add(0.29, 0.08, 0.29, hc, 0.01, 1.39 + up); add(0.14, 0.025, 0.22, hc, 0.2, 1.36 + up); break;
    case 'hardhat': add(0.3, 0.11, 0.3, hc, 0.01, 1.42 + up); add(0.38, 0.025, 0.36, hc, 0.02, 1.37 + up); add(0.26, 0.03, 0.06, shade(hc, 0.8), 0.01, 1.48 + up); break;
    case 'helmet': add(0.33, 0.12, 0.33, hc, 0, 1.41 + up); add(0.3, 0.07, 0.34, hc, -0.01, 1.34 + up); add(0.02, 0.12, 0.02, 0x2a2a20, 0.08, 1.18, 0.13); add(0.02, 0.12, 0.02, 0x2a2a20, 0.08, 1.18, -0.13); break;
    case 'straw': add(0.24, 0.11, 0.24, hc, 0, 1.42 + up); add(0.25, 0.03, 0.25, shade(hc, 0.6), 0, 1.39 + up); add(0.54, 0.025, 0.54, hc, 0, 1.37 + up); break;
    case 'bandana': add(0.29, 0.06, 0.29, hc, 0.01, 1.37 + up); add(0.06, 0.08, 0.1, hc, -0.16, 1.33 + up); break;
    case 'beanie': add(0.29, 0.13, 0.29, hc, 0.01, 1.41 + up); add(0.3, 0.04, 0.3, shade(hc, 1.5), 0.01, 1.35 + up); break;
    case 'nursecap': add(0.14, 0.06, 0.2, hc, 0.02, 1.39 + up); add(0.02, 0.03, 0.03, 0xd03030, 0.095, 1.4 + up); break;
  }
  return { torso, head, tail, pack, eyes, mouth };
}
