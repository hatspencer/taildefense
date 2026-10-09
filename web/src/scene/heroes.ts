import * as THREE from 'three/webgpu';
import { color, sin, time } from 'three/tsl';
import { Emote, Order, PF_ALIVE, PF_FIRING, PF_MOVING } from '../protocol';
import type { Game } from '../state';
import { litMaterial } from './structs';
import { Body, type Look, readLook, shade } from './look';
import { box, merge, part, type Part, playerColor, sphere } from './util';

interface Hero {
  group: THREE.Group; body: THREE.Group; legL: THREE.Object3D; legR: THREE.Object3D;
  armL: THREE.Object3D; armR: THREE.Object3D; gun: THREE.Object3D; flash: THREE.Object3D; finger: THREE.Object3D;
  shout: THREE.Object3D; marker: THREE.Object3D; cross: THREE.Object3D; progress: THREE.Object3D;
  look: number; wd: number; ht: number;
  phase: number; seen: number; down: boolean; pop: number; recoil: number; crouch: number; downAmt: number; taunt: number;
}

// A pose blend towards a goal at rate k per second.
const ease = (v: number, goal: number, k: number, dt: number) => v + (goal - v) * Math.min(1, dt * k);

// One low-poly figure per player, dressed as the look the host dealt them in the player's colour, the gun along `aim`. Poses: walk,
// recoil, the taunt (a hop with arms up and a shout bubble), crouched while searching or
// reviving, and lying downed with a pulsing marker until someone picks them up.
export class Heroes {
  group = new THREE.Group();
  private heroes = new Map<number, Hero>();
  private mat = litMaterial();
  private flashMat = new THREE.MeshBasicNodeMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  private bubbleMat = new THREE.MeshBasicNodeMaterial({ color: 0xf4efe0 });
  private shoutMat = new THREE.MeshBasicNodeMaterial({ color: 0xd8281c });
  private markerMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private crossMat = new THREE.MeshBasicNodeMaterial();
  private progMat = new THREE.MeshBasicNodeMaterial({ color: 0x60ff90, transparent: true, opacity: 0.55, depthWrite: false });
  private bubbleGeo: THREE.BufferGeometry; private shoutGeo: THREE.BufferGeometry;
  private ringGeo: THREE.BufferGeometry; private discGeo: THREE.BufferGeometry; private crossGeo: THREE.BufferGeometry;
  private serial = 0;
  private q = new THREE.Quaternion();

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
  }

  clear(): void { this.group.clear(); this.heroes.clear(); }

  private make(id: number, look: number): Hero {
    // A survivor: the player's colour as the main garment (a little faded), the rest from the
    // look the host dealt them.
    const L = readLook(look), A = L.arch;
    const c = new THREE.Color(playerColor(id)).lerp(new THREE.Color(0x6a6658), 0.3).getHex();
    const dark = shade(c, 0.6);
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    const torso = new THREE.Mesh(merge(figure(L, c)), this.mat);
    torso.castShadow = true;
    body.add(torso);
    const limb = (y: number, z: number, parts: THREE.BufferGeometry) => {
      const pivot = new THREE.Group();
      pivot.position.set(0, y, z);
      const m = new THREE.Mesh(parts, this.mat);
      m.castShadow = true;
      pivot.add(m);
      body.add(pivot);
      return pivot;
    };
    const legs = A.pcLegs ? shade(c, 0.85) : A.legs;
    const legGeo = merge([part(box(0.16, 0.56, 0.16), legs, 0, -0.28, 0), part(box(0.24, 0.09, 0.18), A.boots, 0.04, -0.55, 0)]);
    const sleeve = A.overKind === 'open' && A.over !== undefined ? A.over : c;
    const armGeo = merge([part(box(0.14, 0.14, 0.14), A.overKind === 'open' && A.over !== undefined ? shade(A.over, 0.8) : dark, 0, -0.03, 0),
      part(box(0.11, 0.4, 0.11), sleeve, 0, -0.22, 0), part(box(0.1, 0.1, 0.1), L.skin, 0, -0.45, 0)]);
    const legL = limb(0.58, 0.12, legGeo), legR = limb(0.58, -0.12, legGeo);
    const sh = 0.3 * (L.body === Body.Fem ? 0.93 : 1);
    const armL = limb(1.0, sh, armGeo), armR = limb(1.0, -sh, armGeo);
    // The taunt's middle finger: a fist on the gun hand with one chunky finger up out of it,
    // oversized so it still reads at pixel scale.
    const finger = new THREE.Mesh(merge([part(box(0.15, 0.13, 0.15), L.skin, 0, -0.47, 0), part(box(0.07, 0.3, 0.07), L.skin, 0, -0.66, 0)]), this.mat);
    finger.visible = false;
    armR.add(finger);
    const gun = new THREE.Group();
    gun.position.set(0.1, 0.95, -0.18);
    const gm = new THREE.Mesh(merge([
      part(box(0.55, 0.12, 0.1), 0x2b2b2b, 0.28, 0, 0),
      part(box(0.1, 0.18, 0.08), 0x3a2a1a, 0.08, -0.1, 0),
      part(box(0.18, 0.1, 0.12), c, 0.15, 0.08, 0),
    ]), this.mat);
    gm.castShadow = true;
    gun.add(gm);
    const flash = new THREE.Mesh(sphere(0.14, 6, 4), this.flashMat);
    flash.position.x = 0.62;
    flash.scale.set(1.6, 0.8, 0.8);
    gun.add(flash);
    body.add(gun);
    const shout = new THREE.Group();
    shout.add(new THREE.Mesh(this.bubbleGeo, this.bubbleMat), new THREE.Mesh(this.shoutGeo, this.shoutMat));
    shout.visible = false;
    g.add(shout);
    const marker = new THREE.Mesh(this.ringGeo, this.markerMat);
    marker.position.y = 0.03; marker.renderOrder = 4; marker.visible = false;
    const progress = new THREE.Mesh(this.discGeo, this.progMat);
    progress.position.y = 0.025; progress.renderOrder = 4; progress.visible = false;
    const cross = new THREE.Mesh(this.crossGeo, this.crossMat);
    cross.visible = false;
    g.add(marker, progress, cross);
    g.scale.setScalar(1.15);
    this.group.add(g);
    return { group: g, body, legL, legR, armL, armR, gun, flash, finger, shout, marker, cross, progress, look, wd: L.width, ht: L.height,
      phase: 0, seen: 0, down: false, pop: 0, recoil: 0, crouch: 0, downAmt: 0, taunt: 0 };
  }

  setHover(id: number, on: boolean): void {
    const h = this.heroes.get(id);
    if (h) h.group.traverse((c) => { c.userData.hl = on ? 1 : 0; });
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
      if (!h) { h = this.make(p.id, p.look); this.heroes.set(p.id, h); }
      h.seen = serial;
      const alive = (p.flags & PF_ALIVE) !== 0;
      // Standing up again (revived or respawned): a little pop.
      if (h.down && alive) h.pop = 1;
      h.down = !alive;
      h.group.visible = (p.flags & 1) !== 0 || alive;
      h.group.position.set(game.prx[p.id], 0, game.pry[p.id]);
      // Facing the aim, taunting or not: the finger goes wherever the hero is headed.
      h.body.rotation.y = -game.paim[p.id];
      h.downAmt = ease(h.downAmt, alive ? 0 : 1, alive ? 14 : 7, dt);
      const moving = alive && (p.flags & PF_MOVING) !== 0;
      const channel = alive && (p.order === Order.Loot || p.order === Order.Revive) && p.channel > 0;
      const taunting = alive && p.emote === Emote.Taunt && p.emoteLeft > 0;
      h.crouch = ease(h.crouch, channel ? 1 : 0, 10, dt);
      h.taunt = ease(h.taunt, taunting ? 1 : 0, 12, dt);
      h.pop = Math.max(0, h.pop - dt * 2.2);
      if (moving) h.phase += dt * 11; else h.phase *= 0.8;
      const firing = alive && (p.flags & PF_FIRING) !== 0;
      if (firing && Math.floor(now / 45) % 2 === 0) h.recoil = 1;
      h.recoil = Math.max(0, h.recoil - dt * 14);

      // Legs and arms: a walk swing, folded under when crouched.
      const sw = Math.sin(h.phase) * (moving ? 0.6 : 0);
      const cr = h.crouch, tn = h.taunt;
      h.legL.rotation.z = sw * (1 - cr) + cr * 1.25; h.legR.rotation.z = -sw * (1 - cr) + cr * 0.9;
      // The gun arm points forward, the other swings; both reach down to rummage. The taunt
      // throws the gun hand up and out to the side, middle finger raised, jabbing it; the other
      // fist stays clenched low and the body leans into each shout.
      const rummage = Math.sin(t * 13) * 0.25;
      const jab = Math.max(0, Math.sin(t * 7)) * 0.18;
      const fwd = Math.PI / 2 - 0.15;
      h.armR.rotation.z = (fwd - h.recoil * 0.25) * (1 - cr) * (1 - tn) + cr * (0.9 + rummage) + tn * (0.15 + jab * 0.6);
      h.armL.rotation.z = (-sw * 0.6 + 0.6) * (1 - cr) * (1 - tn) + cr * (0.9 - rummage) + tn * 0.35;
      h.armL.rotation.x = tn * 0.25; h.armR.rotation.x = tn * (2.95 - jab * 0.5);
      h.gun.visible = cr < 0.5 && tn < 0.5;
      h.finger.visible = tn >= 0.5;
      // Crouching sinks; the pop springs up with a squash.
      const shoutLean = tn * (0.1 + jab * 0.5);
      const bob = moving ? Math.abs(Math.cos(h.phase)) * 0.05 : 0;
      const popY = h.pop > 0 ? Math.sin((1 - h.pop) * Math.PI) * 0.35 : 0;
      h.body.position.y = bob + popY - cr * 0.3 + h.downAmt * 0.24;
      h.body.rotation.z = -cr * 0.25 - shoutLean + h.downAmt * (Math.PI / 2) + h.recoil * 0.06;
      const sq = h.pop > 0 ? 1 + Math.sin(h.pop * Math.PI * 2) * 0.12 * h.pop : 1;
      const thick = 1 + (h.wd - 1) * 0.6;
      h.body.scale.set(thick / Math.sqrt(sq), sq * h.ht, h.wd / Math.sqrt(sq));
      if (!alive) { h.legL.rotation.z = 0.15; h.legR.rotation.z = -0.1; h.armL.rotation.z = 2.4; h.armR.rotation.z = 0.5; h.gun.visible = false; h.finger.visible = false; }

      h.flash.visible = firing && Math.floor(now / 45) % 2 === 0;
      h.gun.position.x = 0.1 - h.recoil * 0.07;

      // The shout bubble faces the camera.
      h.shout.visible = tn > 0.05;
      if (h.shout.visible) {
        h.shout.position.set(0, 1.95 + Math.sin(t * 6) * 0.04, 0);
        h.shout.quaternion.copy(this.q);
        h.shout.scale.setScalar(0.6 + tn * 0.5 + jab * 0.5);
      }
      // Downed: just a small flat ring on the ground; the HUD label draws the cross, countdown
      // and revive progress above them, so nothing 3D floats up into it.
      const dn = !alive && (p.flags & 1) !== 0;
      h.marker.visible = dn; h.cross.visible = false; h.progress.visible = false;
      if (dn) {
        const s = 1 + 0.06 * Math.sin(t * 5);
        h.marker.scale.set(s, 1, s);
      }
    }
    for (const [id, h] of this.heroes) if (h.seen !== serial) { this.group.remove(h.group); this.heroes.delete(id); }
  }
}

// The figure above the hips, facing +x: torso shaped by body, outfit over it, head, face,
// hair and headgear, and what they carry on their back.
function figure(L: Look, c: number): Part[] {
  const A = L.arch, skin = L.skin, hair = L.hair;
  const fem = L.body === Body.Fem, masc = L.body === Body.Masc;
  const p: Part[] = [];
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

  // What they carry.
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
  add(0.12, 0.08, 0.12, shade(skin, 0.88), 0.01, 1.11);
  add(0.26, 0.26, 0.26, skin, 0.02, 1.22);
  add(0.03, 0.04, 0.05, 0x141010, 0.15, 1.255, 0.06);
  add(0.03, 0.04, 0.05, 0x141010, 0.15, 1.255, -0.06);
  add(0.04, 0.06, 0.05, shade(skin, 0.9), 0.16, 1.21);
  add(0.02, 0.02, 0.08, shade(skin, 0.6), 0.15, 1.15);
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
    case 'ponytail': cap(); add(0.07, 0.26, 0.08, hair, -0.17, 1.2, 0, 0, 0, -0.3); break;
    case 'long': cap(); sides(0.26); add(0.06, 0.4, 0.3, hair, -0.12, 1.13); break;
    case 'locs': cap(); sides(0.22); for (const z of [-0.11, -0.04, 0.04, 0.11]) add(0.05, 0.38, 0.05, hair, -0.13, 1.12, z); break;
    case 'braids': cap(0.05); add(0.04, 0.42, 0.04, hair, -0.14, 1.08, 0.07); add(0.04, 0.42, 0.04, hair, -0.14, 1.08, -0.07); break;
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
  return p;
}
