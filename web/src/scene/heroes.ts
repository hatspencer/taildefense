import * as THREE from 'three/webgpu';
import { color, sin, time } from 'three/tsl';
import { Emote, Order, PF_ALIVE, PF_FIRING, PF_MOVING } from '../protocol';
import type { Game } from '../state';
import { litMaterial } from './structs';
import { box, merge, part, playerColor, sphere } from './util';

interface Hero {
  group: THREE.Group; body: THREE.Group; legL: THREE.Object3D; legR: THREE.Object3D;
  armL: THREE.Object3D; armR: THREE.Object3D; gun: THREE.Object3D; flash: THREE.Object3D;
  shout: THREE.Object3D; marker: THREE.Object3D; cross: THREE.Object3D; progress: THREE.Object3D;
  phase: number; seen: number; down: boolean; pop: number; recoil: number; crouch: number; downAmt: number; taunt: number;
}

// A pose blend towards a goal at rate k per second.
const ease = (v: number, goal: number, k: number, dt: number) => v + (goal - v) * Math.min(1, dt * k);

// One low-poly figure per player in the player's colour, the gun along `aim`. Poses: walk,
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

  private make(id: number): Hero {
    // A survivor: a jacket in the player's colour (a little faded), jeans, a backpack.
    const c = new THREE.Color(playerColor(id)).lerp(new THREE.Color(0x6a6658), 0.3).getHex();
    const dark = new THREE.Color(c).multiplyScalar(0.6).getHex();
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    const torso = new THREE.Mesh(merge([
      part(box(0.34, 0.5, 0.46), c, 0, 0.82, 0),
      part(box(0.2, 0.4, 0.36), 0x5a4630, -0.26, 0.86, 0),
      part(box(0.14, 0.1, 0.38), 0x3e3022, -0.3, 1.08, 0),
      part(box(0.26, 0.26, 0.26), 0xd2a884, 0.02, 1.22, 0),
      part(box(0.04, 0.05, 0.2), 0x2a2018, 0.15, 1.24, 0),
      part(box(0.28, 0.1, 0.28), 0x3a2c22, -0.01, 1.37, 0),
    ]), this.mat);
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
    const legGeo = merge([part(box(0.16, 0.56, 0.16), 0x3b3f4a, 0, -0.28, 0), part(box(0.24, 0.08, 0.18), 0x222222, 0.04, -0.55, 0)]);
    const legL = limb(0.58, 0.12, legGeo), legR = limb(0.58, -0.12, legGeo);
    const armGeo = merge([part(box(0.14, 0.14, 0.14), dark, 0, -0.03, 0), part(box(0.11, 0.4, 0.11), c, 0, -0.22, 0), part(box(0.1, 0.1, 0.1), 0xd2a884, 0, -0.45, 0)]);
    const armL = limb(1.0, 0.3, armGeo), armR = limb(1.0, -0.3, armGeo);
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
    return { group: g, body, legL, legR, armL, armR, gun, flash, shout, marker, cross, progress,
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
      if (!h) { h = this.make(p.id); this.heroes.set(p.id, h); }
      h.seen = serial;
      const alive = (p.flags & PF_ALIVE) !== 0;
      // Standing up again (revived or respawned): a little pop.
      if (h.down && alive) h.pop = 1;
      h.down = !alive;
      h.group.visible = (p.flags & 1) !== 0 || alive;
      h.group.position.set(game.prx[p.id], 0, game.pry[p.id]);
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
      // The gun arm points forward, the other swings; both reach down to rummage, or go up
      // and pump for a taunt.
      const pump = Math.sin(t * 16) * 0.35;
      const rummage = Math.sin(t * 13) * 0.25;
      const fwd = Math.PI / 2 - 0.15;
      h.armR.rotation.z = (fwd - h.recoil * 0.25) * (1 - cr) * (1 - tn) + cr * (0.9 + rummage) + tn * (Math.PI - 0.3 + pump);
      h.armL.rotation.z = (-sw * 0.6 + 0.6) * (1 - cr) * (1 - tn) + cr * (0.9 - rummage) + tn * (Math.PI - 0.3 - pump);
      h.armL.rotation.x = tn * 0.35; h.armR.rotation.x = -tn * 0.35;
      h.gun.visible = cr < 0.5 && tn < 0.5;
      // The taunt hops; crouching sinks; the pop springs up with a squash.
      const hop = tn * Math.abs(Math.sin(t * 9)) * 0.28;
      const bob = moving ? Math.abs(Math.cos(h.phase)) * 0.05 : 0;
      const popY = h.pop > 0 ? Math.sin((1 - h.pop) * Math.PI) * 0.35 : 0;
      h.body.position.y = bob + hop + popY - cr * 0.3 + h.downAmt * 0.24;
      h.body.rotation.z = -cr * 0.25 + h.downAmt * (Math.PI / 2) + h.recoil * 0.06;
      const sq = h.pop > 0 ? 1 + Math.sin(h.pop * Math.PI * 2) * 0.12 * h.pop : 1;
      h.body.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
      if (!alive) { h.legL.rotation.z = 0.15; h.legR.rotation.z = -0.1; h.armL.rotation.z = 2.4; h.armR.rotation.z = 0.5; h.gun.visible = false; }

      h.flash.visible = firing && Math.floor(now / 45) % 2 === 0;
      h.gun.position.x = 0.1 - h.recoil * 0.07;

      // The shout bubble faces the camera.
      h.shout.visible = tn > 0.05;
      if (h.shout.visible) {
        h.shout.position.set(0, 1.95 + hop + Math.sin(t * 6) * 0.04, 0);
        h.shout.quaternion.copy(this.q);
        h.shout.scale.setScalar(0.6 + tn * 0.5 + Math.abs(Math.sin(t * 9)) * 0.08);
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
