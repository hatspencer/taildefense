import * as THREE from 'three/webgpu';
import { output, sRGBTransferOETF, vec4, vertexColor } from 'three/tsl';
import { Emote, Order, PF_ALIVE, PF_CONNECTED, PF_FIRING, PF_HURT, PF_RELOADING, type Player } from '../protocol';
import type { Game } from '../state';
import { build, type Dress, PELVIS, piece, type Use } from './figures';
import { PALETTE, SLOTS, SURVIVOR as SV } from './figures.gen';
import { garment } from './heroes';
import { Body, readLook, shade } from './look';
import { J, Spring } from './rig';
import { survivor } from './survivor';
import { box, merge, part, type Part, playerColor } from './util';

// The HUD's portraits: each survivor's own model from the chest up, lit and alive, rendered
// small by the game's renderer and read back into a 2D canvas the HUD copies from. They
// breathe, blink and look the way their player aims; flinch and grimace when hit, bleed when
// low, wear a plaster while a medkit works, look down to reload or search, shout a taunt and
// slump when down. The pixels get the world's dark outline and dither, so they read as the
// same game.

// One cell's size in pixels. The target is a row of cells, as wide as a multiple of 64 so a
// WebGPU readback has no row padding.
export const CELL = 36;
const CELLS = 8, W = 320;
const FPS = 20;
const WAIST = SV.waist;
const WHITE = new THREE.Color(0xffffff);
const slot = (n: (typeof SLOTS)[number]) => SLOTS.indexOf(n);
const WHITE_CODE = 64 + PALETTE.indexOf(0xe4dccc);
// The joints whose triangles are the bust below the head.
const BUST = new Set<number>([J.X2, J.CHEST, J.UARM_L, J.UARM_R, PELVIS]);

interface Bust {
  id: number; look: number; cell: number; bg: [number, number, number][];
  root: THREE.Group; torso: THREE.Group; head: THREE.Group; tail: THREE.Group | null; eyeY: number; mouthY: number; browY: number;
  eyes: THREE.Mesh; whites: THREE.Mesh; mouth: THREE.Mesh; browL: THREE.Mesh; browR: THREE.Mesh;
  cut: THREE.Mesh; gash: THREE.Mesh; stain: THREE.Mesh; plaster: THREE.Mesh; nv: boolean;
  yaw: Spring; pitch: Spring; flinch: Spring; sway: Spring;
  breath: number; nextBlink: number; blinkTo: number; lastHp: number; hurtFlag: boolean;
  hurt: number; down: number; shout: number; busy: number; fire: number;
}

export class Portraits {
  // What the HUD copies from, one cell per player slot; version counts finished frames.
  readonly atlas: HTMLCanvasElement;
  version = 0;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private rt = new THREE.RenderTarget(W, CELL, { depthBuffer: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(22, 1, 0.1, 10);
  private rim = new THREE.DirectionalLight(0xffffff, 2.2);
  private mat = new THREE.MeshLambertNodeMaterial();
  private busts = new Map<number, Bust>();
  private byCell: (Bust | null)[] = new Array(CELLS).fill(null);
  private last = 0;
  private pending = false;
  private clear = new THREE.Color();

  constructor(private renderer: THREE.WebGPURenderer, private flipY: boolean) {
    this.atlas = document.createElement('canvas');
    this.atlas.width = W; this.atlas.height = CELL;
    this.ctx = this.atlas.getContext('2d')!;
    this.img = this.ctx.createImageData(W, CELL);
    this.mat.colorNode = vertexColor().rgb;
    // A render target gets linear colour; the 2D canvas wants it encoded.
    const o = output as unknown as THREE.Node<'vec4'>;
    this.mat.outputNode = vec4(sRGBTransferOETF(o.rgb) as THREE.Node<'vec3'>, o.a);
    // A warm key light from the front, high on the left; the rim from behind in the player's
    // colour; a dim olive fill.
    const key = new THREE.DirectionalLight(0xffe4c4, 3.4);
    key.position.set(2.4, 2.2, 1.2);
    this.rim.position.set(-2, 1.2, -1.6);
    this.scene.add(key, this.rim, new THREE.HemisphereLight(0xc8d0c0, 0x4a4434, 1.6));
    // A three-quarter view, a touch above the eyes.
    this.camera.position.set(1.6, 1.26, 0.56);
    this.camera.lookAt(0.03, 1.11, 0);
  }

  // The cell a player's portrait is in, or -1.
  cellOf(id: number): number { return this.busts.get(id)?.cell ?? -1; }

  draw(c: CanvasRenderingContext2D, id: number): void {
    c.clearRect(0, 0, CELL, CELL);
    const i = this.cellOf(id);
    if (i >= 0) c.drawImage(this.atlas, i * CELL, 0, CELL, CELL, 0, 0, CELL, CELL);
  }

  // yaw: the camera's azimuth, so a portrait looks the way its player aims on screen.
  update(game: Game, now: number, dt: number, yaw: number): void {
    const f = game.cur, t = now / 1000;
    const seen = new Set<number>();
    for (let i = 0; i < f.nPlayers && i < CELLS; i++) {
      const p = f.players[i];
      let b = this.busts.get(p.id);
      // Night vision goggles, worn at night once bought, change the figure.
      const nv = p.goggles && !!game.welcome?.dark;
      if (b && (b.look !== p.look || b.cell !== i || b.nv !== nv)) { this.drop(b); b = undefined; }
      if (!b) { b = this.make(p, i, t, nv); this.busts.set(p.id, b); this.byCell[i] = b; }
      seen.add(p.id);
      this.animate(b, p, t, dt, yaw);
    }
    for (const b of [...this.busts.values()]) if (!seen.has(b.id)) this.drop(b);
    if (this.pending || now - this.last < 1000 / FPS || seen.size === 0) return;
    this.last = now;
    this.render();
  }

  private drop(b: Bust): void {
    this.scene.remove(b.root);
    b.root.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.busts.delete(b.id);
    if (this.byCell[b.cell] === b) this.byCell[b.cell] = null;
  }

  private mesh(parts: Part[], parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Mesh {
    const geo = merge(parts);
    geo.translate(-x, -y, -z);
    const m = new THREE.Mesh(geo, this.mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  private geo(uses: Use[], dress: Dress, parent: THREE.Object3D, at: THREE.Vector3, mode: Parameters<typeof build>[2]): THREE.Mesh {
    const geo = build(uses, dress, mode);
    geo.translate(-at.x, -at.y, -at.z);
    const m = new THREE.Mesh(geo, this.mat);
    m.position.copy(at);
    parent.add(m);
    return m;
  }

  private make(p: Player, cell: number, t: number, nv: boolean): Bust {
    const L = readLook(p.look), c = garment(p.id);
    const S = survivor(L, c, nv);
    const face = S.uses.filter((u) => u.p === piece(`face_${L.body === Body.Fem ? 'f' : 'm'}`));
    const rest = S.uses.filter((u) => !face.includes(u));
    const root = new THREE.Group();
    // The torso bends at the waist; the head turns at the neck; long hair swings from the
    // back of the head. Each is the figure's own triangles for those joints.
    const torso = new THREE.Group();
    torso.position.y = WAIST;
    torso.rotation.order = 'YXZ';
    root.add(torso);
    const zero = new THREE.Vector3();
    this.geo(rest, S.dress, torso, new THREE.Vector3(0, WAIST, 0), { keep: (j) => BUST.has(j) }).position.copy(zero);
    const neck = new THREE.Vector3(...SV.neck);
    const head = new THREE.Group();
    head.position.set(neck.x, neck.y - WAIST, 0);
    head.rotation.order = 'YXZ';
    torso.add(head);
    this.geo(rest, S.dress, head, neck, { keep: (j) => j === J.HEAD }).position.copy(zero);
    let tail: THREE.Group | null = null;
    if (rest.some((u) => u.p.j0.includes(J.X))) {
      const at = new THREE.Vector3(...SV.tail);
      tail = new THREE.Group();
      tail.position.copy(at).sub(neck);
      head.add(tail);
      this.geo(rest, S.dress, tail, at, { keep: (j) => j === J.X }).position.copy(zero);
    }
    // The face's moving parts, each turning about its own middle: in the head's frame, so
    // animate() sets them relative to the neck.
    const part_ = (only: (k: number, x: number, y: number, z: number) => boolean, x: number, y: number, z: number) => {
      const m = this.geo(face, S.dress, head, new THREE.Vector3(x, y, z), { only });
      m.position.sub(neck);
      return m;
    };
    const [ex, ey] = SV.eye, [bx, by, bz] = SV.brow, [mx, my] = SV.mouth;
    const whites = part_((k) => k === WHITE_CODE, ex, ey, 0);
    const eyes = part_((k) => k === slot('eye'), ex, ey, 0);
    const mouth = part_((k) => k === slot('lip') || k === slot('mouth'), mx, my, 0);
    const browL = part_((k, _x, _y, z) => k === slot('brow') && z > 0, bx, by, bz);
    const browR = part_((k, _x, _y, z) => k === slot('brow') && z < 0, bx, by, -bz);
    // Wounds by how hurt they are, and the plaster a medkit puts on: on the cheek and the
    // brow, in the head's frame.
    const local = (o: THREE.Mesh) => { o.position.sub(neck); return o; };
    const blood = 0x7a1410, fx = ex + 0.004, cy = ey - 0.035;
    const cut = local(this.mesh([part(box(0.012, 0.036, 0.016), blood, fx - 0.012, cy, 0.05), part(box(0.012, 0.012, 0.03), blood, fx - 0.012, cy - 0.018, 0.044)], head, fx, cy));
    const gash = local(this.mesh([part(box(0.012, 0.014, 0.05), blood, fx, by + 0.03, -0.022), part(box(0.012, 0.04, 0.014), blood, fx - 0.004, by + 0.014, -0.04)], head, fx, by + 0.02));
    const stain = this.mesh([part(box(0.02, 0.1, 0.08), 0x5a0e0a, 0.15, 0.86, 0.05), part(box(0.02, 0.05, 0.05), 0x5a0e0a, 0.15, 0.79, 0.08)], torso, 0, WAIST);
    stain.position.set(0, 0, 0);
    const plaster = local(this.mesh([part(box(0.012, 0.022, 0.05), 0xe6dcc4, fx - 0.01, cy, 0.04), part(box(0.014, 0.008, 0.008), 0xb8aa8c, fx - 0.008, cy, 0.04)], head, fx, cy));
    root.scale.setScalar(L.width > 1.05 ? 1 : 1.02);
    this.scene.add(root);

    // The backdrop: the player's colour, dark, lit from above.
    const pc = playerColor(p.id), bg: [number, number, number][] = [];
    for (let y = 0; y < CELL; y++) {
      const h = shade(pc, 0.42 - 0.26 * (y / CELL));
      bg.push([((h >> 16) & 255) * 0.45 + 0x1c * 0.55, ((h >> 8) & 255) * 0.45 + 0x1e * 0.55, (h & 255) * 0.45 + 0x16 * 0.55]);
    }
    return {
      id: p.id, look: p.look, cell, bg, root, torso, head, tail, eyeY: ey - neck.y, mouthY: my - neck.y, browY: by - neck.y, eyes, whites, mouth, browL, browR, cut, gash, stain, plaster, nv,
      yaw: new Spring(2, 0.55, 0), pitch: new Spring(2.2, 0.6, 0), flinch: new Spring(3.2, 0.3, 0), sway: new Spring(1.4, 0.4, 0),
      breath: Math.random() * 6, nextBlink: t + 1 + Math.random() * 3, blinkTo: 0, lastHp: p.hp, hurtFlag: false,
      hurt: 0, down: 0, shout: 0, busy: 0, fire: 0,
    };
  }

  private animate(b: Bust, p: Player, t: number, dt: number, camYaw: number): void {
    const alive = (p.flags & PF_ALIVE) !== 0, here = (p.flags & PF_CONNECTED) !== 0;
    const frac = p.hp / Math.max(1, p.maxHp);
    const low = alive && frac < 0.3;
    const ease = (v: number, goal: number, k: number) => v + (goal - v) * Math.min(1, dt * k);

    // Hit: a flinch, a squeeze of the eyes and a red flash.
    const hurtFlag = (p.flags & PF_HURT) !== 0;
    if (alive && (p.hp < b.lastHp - 0.5 || (hurtFlag && !b.hurtFlag))) {
      b.hurt = 1; b.flinch.kick(b.flinch.v > 0 ? -7 : 7); b.blinkTo = t + 0.2;
    }
    b.lastHp = p.hp; b.hurtFlag = hurtFlag;
    b.hurt = Math.max(0, b.hurt - dt * 3.5);

    const channel = alive && (p.order === Order.Loot || p.order === Order.Revive) && p.channel > 0;
    const reloading = alive && (p.flags & PF_RELOADING) !== 0;
    const taunting = alive && p.emote === Emote.Taunt && p.emoteLeft > 0;
    const firing = alive && (p.flags & PF_FIRING) !== 0;
    b.down = ease(b.down, alive ? 0 : 1, alive ? 10 : 4);
    b.shout = ease(b.shout, taunting ? 1 : 0, 14);
    b.busy = ease(b.busy, channel ? 1 : reloading ? 0.7 : 0, 8);
    b.fire = ease(b.fire, firing ? 1 : 0, 10);

    // Where they look: the aim as seen from the camera, turned towards the viewer so the face
    // stays in the frame. Searching and reloading look down at the work.
    const rel = p.aim + camYaw;
    let yaw = alive ? 0.6 * Math.cos(rel) : 0;
    let pitch = alive ? -0.12 * Math.sin(rel) : 0;
    if (!here) { yaw = 0; pitch = 0.35; }
    yaw = yaw * (1 - b.busy) + 0.25 * b.busy;
    pitch += 0.42 * b.busy - 0.22 * b.shout + (low ? 0.12 : 0) + 0.2 * b.down;
    yaw += b.shout * Math.sin(t * 19) * 0.09;
    const hy = b.yaw.update(dt, yaw), hp = b.pitch.update(dt, pitch), fl = b.flinch.update(dt, 0);
    const sw = b.sway.update(dt, low || !alive ? Math.sin(t * 1.3) * 0.08 : 0);

    // Breath: quicker and deeper when sprinting, winded or hurt; a slow heave when down.
    const rate = !alive ? 1 : p.winded || p.sprinting ? 7 : low ? 4 : 1.9;
    b.breath += dt * rate;
    const br = Math.sin(b.breath) * (p.winded || low ? 0.014 : 0.007);
    const recoil = firing ? -Math.abs(Math.sin(t * 24)) * 0.014 : 0;
    const bob = alive && p.sprinting ? Math.sin(t * 15) * 0.012 : 0;
    b.torso.position.set(recoil - 0.03 * b.down, WAIST + br + bob - 0.1 * b.down, 0);
    b.torso.rotation.set(0.1 * b.down + sw * 0.5 + fl * 0.08, hy * 0.25, -0.12 * b.down - (alive && p.sprinting ? 0.06 : 0) + br * 1.5);
    b.head.rotation.set(fl * 0.35 + sw + 0.35 * b.down, hy * 0.75, -hp + fl * 0.25);
    if (b.tail) b.tail.rotation.set(-hy * 0.4, 0, fl * 0.6 + hp * 0.5);

    // The face.
    if (t > b.nextBlink) { b.blinkTo = t + 0.12; b.nextBlink = t + 1.6 + Math.random() * 3.4; }
    const shut = !alive || !here || t < b.blinkTo;
    const eyeH = shut ? 0.15 : 1.15 * b.shout + (1 - b.shout) * (1 - 0.4 * b.fire - 0.2 * b.busy);
    b.eyes.scale.set(1, Math.max(0.15, eyeH), 1);
    b.whites.scale.set(1, Math.max(0.1, Math.min(1, eyeH)), 1);
    b.eyes.position.z = -0.005 * Math.cos(rel) * (alive ? 1 : 0);
    b.eyes.position.y = b.eyeY - 0.003 * b.busy;
    const open = Math.max(b.shout * 5, b.hurt * 2.5, low ? 1.6 : 0, !alive ? 1.8 : 0, p.winded ? 2 : 0);
    b.mouth.scale.set(1, 1 + open, 1 + 0.3 * b.hurt);
    b.mouth.position.y = b.mouthY - 0.0025 * open;
    // Brows: down at the middle when shooting, up there when hurt or afraid, high when
    // shouting.
    const worry = Math.max(b.hurt, low ? 0.8 : 0, b.down);
    const tilt = 0.4 * b.fire * (1 - worry) - 0.45 * worry;
    b.browL.rotation.x = tilt; b.browR.rotation.x = -tilt;
    const lift = 0.01 * b.shout + 0.005 * worry - 0.004 * b.fire;
    b.browL.position.y = b.browR.position.y = b.browY + lift;

    b.plaster.visible = alive && p.heal > 0;
    b.cut.visible = frac < 0.6 && !b.plaster.visible;
    b.gash.visible = frac < 0.35;
    b.stain.visible = frac < 0.35;
  }

  private render(): void {
    const r = this.renderer;
    const prev = r.getRenderTarget(), auto = r.autoClear, alpha = r.getClearAlpha();
    r.getClearColor(this.clear);
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.rt);
    let first = true;
    for (const b of this.byCell) if (b) b.root.visible = false;
    for (let i = 0; i < CELLS; i++) {
      const b = this.byCell[i];
      if (!b) continue;
      b.root.visible = true;
      this.rim.color.setHex(playerColor(b.id)).lerp(WHITE, 0.35);
      this.rt.viewport.set(i * CELL, 0, CELL, CELL);
      r.autoClear = first;
      r.render(this.scene, this.camera);
      b.root.visible = false;
      first = false;
    }
    r.setRenderTarget(prev);
    r.autoClear = auto;
    r.setClearColor(this.clear, alpha);
    this.pending = true;
    r.readRenderTargetPixelsAsync(this.rt, 0, 0, W, CELL)
      .then((px) => { this.compose(px as Uint8Array); this.version++; })
      .catch(() => { /* a lost frame */ })
      .finally(() => { this.pending = false; });
  }

  // The read-back pixels into the atlas: a backdrop behind, a dark outline around the figure,
  // a red wash when hit, and the world's dusty grade and ordered dither.
  private compose(px: Uint8Array): void {
    const out = this.img.data;
    const at = (x: number, y: number) => ((this.flipY ? CELL - 1 - y : y) * W + x) * 4;
    const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < CELL && px[at(x, y) + 3] > 0;
    for (let i = 0; i < CELLS; i++) {
      const b = this.byCell[i];
      if (!b) continue;
      const hurt = b.hurt;
      const x0 = i * CELL;
      for (let y = 0; y < CELL; y++) {
        const bg = b.bg[y];
        for (let x = x0; x < x0 + CELL; x++) {
          const o = (y * W + x) * 4;
          const bay = ((((x & 1) * 2 + (y & 1) * 3) & 3) + 0.5) / 4 - 0.5;
          let rr: number, gg: number, bb: number;
          if (solid(x, y)) {
            const s = at(x, y);
            rr = px[s]; gg = px[s + 1]; bb = px[s + 2];
            // A touch desaturated and warmed, as the world is graded.
            const l = 0.3 * rr + 0.59 * gg + 0.11 * bb;
            rr = (l * 0.2 + rr * 0.8) * 1.06; gg = l * 0.2 + gg * 0.8; bb = (l * 0.2 + bb * 0.8) * 0.9;
            if (hurt > 0) { rr += (255 - rr) * hurt * 0.55; gg *= 1 - hurt * 0.5; bb *= 1 - hurt * 0.55; }
          } else if (solid(x - 1, y) && x > x0 || solid(x + 1, y) && x < x0 + CELL - 1 || solid(x, y - 1) || solid(x, y + 1)) {
            rr = 14; gg = 12; bb = 10;
          } else {
            [rr, gg, bb] = bg;
            if (hurt > 0) rr += 90 * hurt;
          }
          // Quantize to 32 levels with a 2×2 ordered dither.
          const q = (v: number) => Math.max(0, Math.min(255, Math.round(v / 8 + bay) * 8));
          out[o] = q(rr); out[o + 1] = q(gg); out[o + 2] = q(bb); out[o + 3] = 255;
        }
      }
    }
    this.ctx.putImageData(this.img, 0, 0);
  }
}
