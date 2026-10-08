import * as THREE from 'three/webgpu';
import { PF_ALIVE, PF_FIRING, PF_MOVING } from '../protocol';
import type { Game } from '../state';
import { litMaterial } from './structs';
import { box, merge, part, playerColor, sphere } from './util';

interface Hero {
  group: THREE.Group; body: THREE.Group; legL: THREE.Object3D; legR: THREE.Object3D; gun: THREE.Object3D;
  flash: THREE.Object3D; phase: number;
}

// One low-poly figure per player in the player's colour, the gun along `aim`.
export class Heroes {
  group = new THREE.Group();
  private heroes = new Map<number, Hero>();
  private mat = litMaterial();
  private flashMat = new THREE.MeshBasicNodeMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });

  constructor(scene: THREE.Scene) { scene.add(this.group); }

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
      part(box(0.28, 0.1, 0.28), 0x3a2c22, -0.01, 1.37, 0),
      part(box(0.14, 0.14, 0.14), dark, 0, 1.0, 0.3),
      part(box(0.14, 0.14, 0.14), dark, 0, 1.0, -0.3),
    ]), this.mat);
    torso.castShadow = true;
    body.add(torso);
    const leg = () => {
      const pivot = new THREE.Group();
      pivot.position.y = 0.58;
      const m = new THREE.Mesh(merge([part(box(0.16, 0.56, 0.16), 0x3b3f4a, 0, -0.28, 0), part(box(0.24, 0.08, 0.18), 0x222222, 0.04, -0.55, 0)]), this.mat);
      m.castShadow = true;
      pivot.add(m);
      return pivot;
    };
    const legL = leg(), legR = leg();
    legL.position.z = 0.12; legR.position.z = -0.12;
    body.add(legL, legR);
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
    g.scale.setScalar(1.15);
    this.group.add(g);
    return { group: g, body, legL, legR, gun, flash, phase: 0 };
  }

  setHover(id: number, on: boolean): void {
    const h = this.heroes.get(id);
    if (h) h.group.traverse((c) => { c.userData.hl = on ? 1 : 0; });
  }

  update(game: Game, now: number, dt: number): void {
    const f = game.cur;
    const seen = new Set<number>();
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      seen.add(p.id);
      let h = this.heroes.get(p.id);
      if (!h) { h = this.make(p.id); this.heroes.set(p.id, h); }
      const alive = (p.flags & PF_ALIVE) !== 0;
      h.group.visible = alive;
      if (!alive) continue;
      h.group.position.set(game.prx[p.id], 0, game.pry[p.id]);
      h.body.rotation.y = -game.paim[p.id];
      const moving = (p.flags & PF_MOVING) !== 0;
      if (moving) h.phase += dt * 11; else h.phase *= 0.8;
      const sw = Math.sin(h.phase) * (moving ? 0.6 : 0);
      h.legL.rotation.z = sw; h.legR.rotation.z = -sw;
      h.body.position.y = moving ? Math.abs(Math.cos(h.phase)) * 0.05 : 0;
      const firing = (p.flags & PF_FIRING) !== 0;
      h.flash.visible = firing && Math.floor(now / 45) % 2 === 0;
      h.gun.position.x = 0.1 - (h.flash.visible ? 0.04 : 0);
    }
    for (const [id, h] of this.heroes) if (!seen.has(id)) { this.group.remove(h.group); this.heroes.delete(id); }
  }
}
