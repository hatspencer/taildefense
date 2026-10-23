import * as THREE from 'three/webgpu';
import { color, float, sin, time, uv } from 'three/tsl';
import { WEAPON_BASE } from '../demo/defs';
import { Emote, Order, PF_ALIVE, PF_FIRING, PF_HURT, PF_RELOADING, OWNED_DUAL, THROW_FLIGHT } from '../protocol';
import type { Game } from '../state';
import { litMaterial } from './structs';
import { build, fixedColor, piece, type Piece, type Use } from './figures';
import { SURVIVOR } from './figures.gen';
import { Body, readLook } from './look';
import { ik2, J, Spring, turnTowards, wrapAngle } from './rig';
import { survivor } from './survivor';
import { box, merge, part, playerColor, sphere } from './util';

interface Limb { upper: THREE.Object3D; lower: THREE.Object3D }
interface Hero {
  group: THREE.Group; body: THREE.Group; hips: THREE.Object3D; torso: THREE.Object3D; head: THREE.Object3D; tail: THREE.Object3D | null; pack: THREE.Object3D;
  legL: Limb; legR: Limb; armL: Limb; armR: Limb;
  gun: THREE.Group; gunMesh: THREE.Mesh | null; spin: THREE.Group | null; flash: THREE.Object3D; finger: THREE.Object3D; hand: THREE.Object3D;
  gun2: THREE.Group; dual: boolean; alt: boolean; // the second pistol, in the left hand; alt: the last shot was its
  shout: THREE.Object3D; stars: THREE.Object3D; nv: boolean; marker: THREE.Object3D; cross: THREE.Object3D; progress: THREE.Object3D;
  look: number; wd: number; ht: number; weapon: number; color: number;
  phase: number; seen: number; down: boolean; pop: number; shotAt: number; crouch: number; downAmt: number; taunt: number; reload: number;
  sprint: number; leap: number; hurt: boolean; flyAt: number; // when a throw took them off their feet, -1 on them
  x: number; y: number; vx: number; vy: number; legYaw: number; dirSign: number; fresh: boolean;
  leanX: Spring; leanZ: Spring; aim: Spring; flinch: Spring; tailS: Spring; packS: Spring; kick: Spring;
}

// A pose blend towards a goal at rate k per second.
const ease = (v: number, goal: number, k: number, dt: number) => v + (goal - v) * Math.min(1, dt * k);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// The figure's skeleton (tools/blender/figures.py): limb lengths, shoulder to elbow and elbow
// to the middle of the hand, hip to knee.
const SV = SURVIVOR;
const UPPER = SV.shY - SV.elbowY, FORE = SV.elbowY - SV.handY;
const WAIST = SV.waist, HIP = SV.hipY, THIGH = SV.hipY - SV.kneeY, HIP_Z = SV.hipZ;

// How each weapon is carried: where it sits in the torso's space (origin at the waist, +x the
// way the hero faces), where each hand holds it in its own (the gun's grip and forend, as
// tools/blender/figures.py models them), where its muzzle is, and the blade: how far the
// shoulders turn off the aim for it (right shoulder back, the gun turned back onto the aim),
// so a stock sits in the right shoulder and the left hand reaches the forend, as anyone
// shouldering a long gun stands. The shouldered guns' 'at' puts the butt in the shoulder.
interface Hold { at: [number, number, number]; grip: [number, number, number]; fore: [number, number, number]; muzzle: number; blade: number }
const HOLDS: Hold[] = [
  { at: [0.42, 0.4, 0.0], grip: [0, -0.05, 0], fore: [-0.01, -0.08, 0.05], muzzle: 0.28, blade: 0.25 },     // pistol, both hands out
  { at: [0.286, 0.415, 0.092], grip: [0, -0.04, 0], fore: [0.29, -0.01, 0], muzzle: 0.64, blade: 0.75 },     // shotgun, shouldered
  { at: [0.238, 0.4, 0.008], grip: [0, -0.06, 0], fore: [0.14, -0.11, 0], muzzle: 0.42, blade: 0.6 },        // SMG, its wire stock in the shoulder
  { at: [0.278, 0.415, 0.084], grip: [0, -0.04, 0], fore: [0.28, -0.01, 0], muzzle: 0.74, blade: 0.75 },     // rifle, shouldered
  { at: [0.24, 0.13, -0.1], grip: [-0.1, 0.02, -0.06], fore: [0.02, 0.15, 0.06], muzzle: 0.68, blade: 0.2 }, // minigun, braced at the hip
  { at: [0.14, 0.45, -0.15], grip: [0.06, -0.09, 0], fore: [0.28, -0.09, 0.02], muzzle: 0.62, blade: 0.3 },  // launcher, on the shoulder
  { at: [0.16, 0.24, -0.17], grip: [0, 0, 0], fore: [-0.09, 0, 0], muzzle: 0.6, blade: 0 },                 // crowbar, both hands on the tape, up at the shoulder
];
// Guns in the hand are drawn smaller than on the ground: the figures are stylised short, and at
// full size a long gun is out of their reach.
const HELD = 0.75;

// The gun in the hand, modelled in Blender (tools/blender/figures.py): facing +x from the
// grip, taped in the player's colour. 'spin' is the minigun's barrels, turning about y = 0.02;
// 'all' is both, for a gun on the ground. Null when the weapon has no such piece.
export function gunGeometry(w: number, c: number, which: 'body' | 'spin' | 'all' = 'body'): THREE.BufferGeometry | null {
  const k = w >= 0 && w < HOLDS.length ? w : 5;
  const uses: Use[] = [];
  const body = piece(`gun_${k}`), spin = piece(`gun_${k}_spin`);
  if (body && which !== 'spin') uses.push({ p: body });
  if (spin && which !== 'body') uses.push({ p: spin });
  return uses.length ? build(uses, (code) => (code >= 64 ? fixedColor(code) : c)) : null;
}

const V = new THREE.Vector3(), TR = new THREE.Vector3(), TL = new THREE.Vector3(), PR = new THREE.Vector3(-0.4, -1, -0.6), PL = new THREE.Vector3(-0.2, -1, 0.8);
const AX = new THREE.Vector3(), MAG = new THREE.Vector3();

// One low-poly puppet per player, dressed as the look the host dealt them in the player's
// colour. The legs go where the hero goes, stepping in time with the ground covered and
// backpedalling when they shoot behind them; the torso turns to the aim, the arms reach for
// the gun by IK and each gun is carried its own way. Springs lean the body into a run, kick
// it back when hit and swing the hair and pack. Poses: walk, run, sprint, dash, reload, the
// taunt, kneeling to search or revive, and lying downed until someone picks them up.
export class Heroes {
  group = new THREE.Group();
  private heroes = new Map<number, Hero>();
  private mat = litMaterial();
  // Night vision goggles: two lenses lit green from inside, a halo round each, so at night a
  // survivor looks out of two green eyes.
  private lensMat = new THREE.MeshBasicNodeMaterial();
  private haloMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private flashMat = new THREE.MeshBasicNodeMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  private bubbleMat = new THREE.MeshBasicNodeMaterial({ color: 0xf4efe0 });
  private starMat = new THREE.MeshBasicNodeMaterial({ color: 0xffe060 });
  private shoutMat = new THREE.MeshBasicNodeMaterial({ color: 0xd8281c });
  private markerMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private crossMat = new THREE.MeshBasicNodeMaterial();
  private progMat = new THREE.MeshBasicNodeMaterial({ color: 0x60ff90, transparent: true, opacity: 0.55, depthWrite: false });
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
    // The goggles' glow: the tubes hum, flickering faintly as image intensifiers do.
    const hum = sin(time.mul(2.3)).mul(0.08).add(sin(time.mul(31)).mul(0.03)).add(1);
    this.lensMat.colorNode = color(0xb4ff8c).mul(hum.mul(1.25));
    this.lensMat.fog = false;
    const d = uv().sub(0.5).length().mul(2);
    this.haloMat.colorNode = color(0x6aff48);
    this.haloMat.opacityNode = float(1).sub(d).clamp(0, 1).pow(2.4).mul(hum).mul(0.7);
    this.haloMat.fog = false;
  }

  clear(): void { this.group.clear(); this.heroes.clear(); }

  private make(id: number, look: number, weapon: number, nv: boolean): Hero {
    // A survivor: the player's colour as the main garment (a little faded), the rest from the
    // look the host dealt them.
    const L = readLook(look);
    const c = garment(id);
    const fem = L.body === Body.Fem;
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    // The skeleton, at the Blender figure's pivots: each group is a bone the body's one
    // skinned mesh follows, numbered as the figure's joints are (see rig.ts; 12 the pelvis).
    const bone = () => { const b = new THREE.Bone(); b.rotation.order = 'YXZ'; return b; };
    const hips = bone(), torso = bone(), head = bone(), tail = bone(), pack = bone();
    torso.position.y = WAIST;
    body.add(hips, torso);
    head.position.set(SV.neck[0], SV.neck[1] - WAIST, 0);
    torso.add(head);
    tail.position.set(SV.tail[0] - SV.neck[0], SV.tail[1] - SV.neck[1], 0);
    head.add(tail);
    torso.add(pack);
    const hz = HIP_Z * (fem ? 1.07 : 1);
    const leg = (z: number): Limb => {
      const upper = bone(), lower = bone();
      upper.position.set(0, HIP, z);
      lower.position.set(0, -THIGH, 0);
      upper.add(lower);
      hips.add(upper);
      return { upper, lower };
    };
    const legL = leg(hz), legR = leg(-hz);
    const sh = SV.shZ * (fem ? 0.93 : 1);
    const arm = (z: number): Limb => {
      const upper = bone(), lower = bone();
      upper.position.set(0, SV.shY - WAIST, z);
      lower.position.set(0, -UPPER, 0);
      upper.add(lower);
      torso.add(upper);
      return { upper, lower };
    };
    const armL = arm(sh), armR = arm(-sh);
    const bones = [pack, torso, head, armL.upper, armL.lower, armR.upper, armR.lower, legL.upper, legL.lower, legR.upper, legR.lower, tail, hips];
    const S = survivor(L, c, nv);
    const lens = piece('nvg_lens');
    const skinned = new THREE.SkinnedMesh(build(S.uses.filter((u) => u.p !== lens), S.dress, { bone: (j) => j }), this.mat);
    skinned.castShadow = true;
    skinned.frustumCulled = false;
    g.add(skinned);
    g.updateMatrixWorld(true);
    skinned.bind(new THREE.Skeleton(bones as THREE.Bone[]));
    const tailed = S.uses.some((u) => u.p.j0.includes(J.X));
    if (nv && lens) this.glow(head, lens);
    // The taunt's middle finger: a fist on the gun hand with one finger up out of it,
    // oversized so it still reads at pixel scale; it closes over the hand.
    const fp = piece(`finger_${fem ? 'f' : 'm'}`)!;
    const fgeo = build([{ p: fp }], S.dress);
    fgeo.translate(0, -SV.elbowY, sh);
    const finger = new THREE.Mesh(fgeo, this.mat);
    finger.visible = false;
    armR.lower.add(finger);
    const hand = new THREE.Object3D();

    const gun = new THREE.Group(), gun2 = new THREE.Group();
    gun.scale.setScalar(HELD); gun2.scale.setScalar(HELD);
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
      group: g, body, hips, torso, head, tail: tailed ? tail : null, pack, legL, legR, armL, armR, gun, gunMesh: null, spin: null, flash, finger, hand, gun2, dual: false, alt: false,
      shout, stars, nv, marker, cross, progress, look, wd: L.width, ht: L.height, weapon: -1, color: c,
      phase: 0, seen: 0, down: false, pop: 0, shotAt: -1e9, crouch: 0, downAmt: 0, taunt: 0, reload: 0, sprint: 0, leap: 0, hurt: false, flyAt: -1,
      x: 0, y: 0, vx: 0, vy: 0, legYaw: 0, dirSign: 1, fresh: true,
      leanX: new Spring(2.2, 0.45, 0), leanZ: new Spring(2.2, 0.45, 0), aim: new Spring(4.5, 0.75, 1.6), flinch: new Spring(3, 0.3, 0),
      tailS: new Spring(1.8, 0.25, 0), packS: new Spring(3.5, 0.3, 0), kick: new Spring(9, 0.35, 0),
    };
    this.setWeapon(h, weapon);
    return h;
  }

  // The goggles' lenses on the head bone, lit, with a halo on each.
  private glow(head: THREE.Object3D, lens: Piece): void {
    const geo = build([{ p: lens }], () => 0xffffff);
    geo.translate(-SV.neck[0], -SV.neck[1], 0);
    head.add(new THREE.Mesh(geo, this.lensMat));
    // Each lens's middle: its vertices, left and right.
    const at = new Map<number, THREE.Vector3[]>();
    for (let i = 0; i < lens.pos.length; i += 3) {
      const k = Math.sign(lens.pos[i + 2]);
      if (!at.has(k)) at.set(k, []);
      at.get(k)!.push(new THREE.Vector3(lens.pos[i], lens.pos[i + 1], lens.pos[i + 2]));
    }
    for (const vs of at.values()) {
      const c = vs.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(vs.length);
      const halo = new THREE.Sprite(this.haloMat);
      halo.position.set(c.x + 0.012 - SV.neck[0], c.y - SV.neck[1], c.z);
      halo.scale.setScalar(0.11);
      halo.renderOrder = 3;
      head.add(halo);
    }
  }

  private setWeapon(h: Hero, w: number): void {
    if (h.weapon === w) return;
    h.weapon = w;
    if (h.gunMesh) { h.gun.remove(h.gunMesh); h.gunMesh.geometry.dispose(); }
    if (h.spin) { h.gun.remove(h.spin); }
    const body = gunGeometry(w, h.color)!;
    h.gunMesh = new THREE.Mesh(body, this.mat);
    h.gunMesh.castShadow = true;
    h.gun.add(h.gunMesh);
    h.spin = null;
    const spin = gunGeometry(w, h.color, 'spin');
    if (spin) {
      h.spin = new THREE.Group();
      h.spin.position.set(0, 0.02, 0);
      h.gun.add(h.spin);
      spin.translate(0, -0.02, 0);
      const m = new THREE.Mesh(spin, this.mat);
      m.castShadow = true;
      h.spin.add(m);
    }
    const hold = HOLDS[w] ?? HOLDS[0];
    h.flash.position.x = hold.muzzle;
    h.group.traverse((c) => { c.userData.hl = h.group.userData.hl ?? 0; });
  }

  // A second pistol in the left hand, once one has been found.
  private setDual(h: Hero, on: boolean): void {
    if (h.dual === on) return;
    h.dual = on;
    h.gun.add(h.flash);
    h.alt = false;
    for (const c of [...h.gun2.children]) { h.gun2.remove(c); (c as THREE.Mesh).geometry.dispose(); }
    if (on) {
      const m = new THREE.Mesh(gunGeometry(0, h.color)!, this.mat);
      m.castShadow = true;
      h.gun2.add(m);
    }
    h.group.traverse((c) => { c.userData.hl = h.group.userData.hl ?? 0; });
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
      // Night vision goggles, worn at night once bought, change the figure: build it again.
      const nv = p.goggles && !!game.welcome?.dark;
      if (h && (h.look !== p.look || h.nv !== nv)) { this.group.remove(h.group); h = undefined; }
      if (!h) { h = this.make(p.id, p.look, p.cur, nv); this.heroes.set(p.id, h); }
      this.setWeapon(h, p.cur);
      this.setDual(h, p.cur === 0 && (p.owned & OWNED_DUAL) !== 0);
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
      let lift = 0;
      if (air) {
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
      if (!firing) h.shotAt = -1e9;
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
      if (!alive) { thL = 0.35; shL = -0.5; thR = 0.1; shR = -0.15; }
      h.legL.upper.rotation.z = thL; h.legL.lower.rotation.z = shL;
      h.legR.upper.rotation.z = thR; h.legR.lower.rotation.z = shR;

      // The body: a rise at each passing step, kneeling low, the pop on standing up.
      const bob = walk * (0.025 + 0.05 * run + 0.03 * sk) * (1 - Math.abs(Math.sin(ph)));
      const popY = h.pop > 0 ? Math.sin((1 - h.pop) * Math.PI) * 0.35 : 0;
      h.body.position.y = bob + popY - cr * 0.27 + lp * 0.12 + h.downAmt * 0.2;
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
      // Bladed to the gun while it is up: none at a sprint, kneeling, taunting, reloading or down.
      const hold = HOLDS[h.weapon] ?? HOLDS[0];
      const rl = h.reload, sp = h.sprint * (1 - rl);
      const blade = hold.blade * (1 - h.sprint) * (1 - cr) * (1 - tn) * (1 - dn) * (1 - rl * 0.5);
      h.torso.rotation.set(0, -(ay2 - Math.sin(ph) * 0.1 * walk) + blade, -cr * 0.2 + flinch * 0.6 + kick * 0.15 - shoutLean - lp * 0.25 - h.sprint * 0.12);
      // The head looks along the gun, its cheek to a shouldered stock.
      h.head.rotation.set(0, -wrapAngle(aim - ay2) * 0.6 - blade * 0.85, -flinch * 0.5 + 0.05 * Math.sin(2 * ph) * walk + cr * 0.35 + (alive ? 0 : 0.3) + blade * 0.12);
      if (h.tail) {
        const goal = -0.35 * Math.min(speed, 5) / 5 - 0.12 * Math.abs(Math.sin(2 * ph)) * walk;
        h.tail.rotation.z = h.tailS.update(dt, goal - flinch * 0.4);
      }
      h.pack.position.y = (h.packS.update(dt, bob + popY) - bob - popY) * 0.8;

      // The gun where its hold puts it: kicked back by each shot, carried low at a sprint,
      // canted to the side for a reload.
      if (h.weapon === 6) {
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
        h.gun.rotation.set(rl * 0.7, sp * 0.35 - blade, kick * 0.6 - sp * 0.55 - rl * 0.3);
      }
      h.gun.updateMatrix();
      h.flash.visible = h.weapon !== 6 && now - h.shotAt < (h.weapon === 1 ? 70 : 45);
      if (h.spin) h.spin.rotation.x += dt * (firing ? 40 : 0);

      // Hands: on the gun, unless kneeling, taunting or down.
      TR.set(...hold.grip).applyMatrix4(h.gun.matrix);
      if (h.dual) TL.set(...hold.grip).applyMatrix4(h.gun2.matrix);
      else TL.set(...hold.fore).applyMatrix4(h.gun.matrix);
      if (rl > 0.01 && !h.dual) {
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
