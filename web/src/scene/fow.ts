import * as THREE from 'three/webgpu';
import { Fn, clamp, float, floor, luminance, mix, output, positionWorld, rangeFogFactor, reference, smoothstep, step, texture, uniform, vec3, vec4 } from 'three/tsl';
import { bayerAt, noise } from './dither';
import { uFogAmt, uFogDrift } from './weather';
import { DAY_SIGHT, PF_ALIVE, RIFLE, RIFLE_SIGHT, sightMul } from '../protocol';
import type { Game } from '../state';

// Fog of war on screen, and the weather's haze: the scene's fog node, which every lit material runs, darkens what
// the team cannot see by a per-tile texture (red: in sight now, green: seen before), eased
// so the edge of sight drifts rather than snaps. It also does the distance fog the scene's
// Fog would, since a fog node replaces it. With fog of war off the texture is never read.
export class FogOfWar {
  private tex: THREE.DataTexture;
  private node = texture(blank());
  private uSize = uniform(new THREE.Vector2(1, 1));
  private uOn = uniform(0);
  // How bright ground seen before stays: dimmer at night, black in brutal's.
  private uMem = uniform(0.4);
  // How bright ground never seen is: pitch black at night.
  private uNever = uniform(0.07);
  private shown = new Float32Array(0);
  private seen = new Float32Array(0);
  private vision: Game['vision'] = null;
  // Textures swapped out, disposed once they have gone unused for a few frames.
  private retired: { tex: THREE.DataTexture; frames: number }[] = [];
  // Fog and rain close in round your survivor: past about their sight the world fades into
  // the fog colour, by uHaze at most. Every difficulty, fog of war or not.
  private uHaze = uniform(0);
  private uEye = uniform(new THREE.Vector2());
  private uNear = uniform(8);
  private uFar = uniform(14);

  constructor(scene: THREE.Scene) {
    this.tex = this.node.value as THREE.DataTexture;
    const f = scene.fog as THREE.Fog;
    const color = reference('color', 'color', f), near = reference('near', 'float', f), far = reference('far', 'float', f);
    const t = this.node.sample(positionWorld.xz.div(this.uSize));
    scene.fogNode = Fn(() => {
      // The edge of sight is a band of dithered pixels, not a blur: the eased, filtered tile
      // values are narrowed to half a tile and cut against a dither laid on the ground in
      // cells of about two scene pixels, so it stays put as the view moves. (The fog node
      // cannot read the screen coordinate; a pattern on the screen would swim anyway.)
      const b = bayerAt(floor(positionWorld.xz.mul(11)));
      const lit = step(b, smoothstep(0.2, 0.8, t.r)), mem = step(b, smoothstep(0.2, 0.8, t.g));
      // Never seen: near black. Seen before: dim and drained of colour, the way a map
      // remembers ground but not what walks on it; at night, never seen is black and seen nearly so. In sight: as it is.
      const shade = mix(mix(this.uNever, this.uMem, mem), float(1), lit);
      const sat = mix(float(0.3), float(1), lit);
      // The haze is the picture's dust and damp, warm grey, not the cold sky's grey.
      const haze = mix(color, vec3(luminance(color)).mul(vec3(1.05, 1.0, 0.84)), 0.5);
      // Distance first, so far ground the team has never seen is dark, not haze.
      const d = mix(output.rgb, haze, rangeFogFactor(near, far));
      // The weather's haze gathers with distance from your survivor (or the view), heavier
      // in banks that drift with the wind, so it lies over the land in patches rather than as
      // an even wash over the whole view.
      const bank = noise(positionWorld.xz.mul(0.09).add(uFogDrift));
      const far0 = smoothstep(this.uNear, this.uFar, positionWorld.xz.sub(this.uEye).length());
      const k = smoothstep(0.3, 0.72, bank);
      const amt = clamp(far0.mul(this.uHaze).mul(k.mul(0.8).add(0.3)).add(k.mul(uFogAmt).mul(0.35)), 0, 0.92);
      const c = mix(d, haze, amt);
      // Out of sight, the ground goes to a dark olive, not grey.
      const dark = mix(vec3(luminance(c)), c, sat).mul(shade).mul(mix(vec3(0.96, 0.92, 0.66), vec3(1), lit))
        .add(vec3(0.02, 0.021, 0.008).mul(float(1).sub(lit)).mul(step(0.01, this.uNever)));
      return vec4(mix(c, dark, this.uOn), output.a);
    })();
  }

  // Eases the texture towards the team's sight, and the haze towards the weather's; call once
  // a rendered frame. tx, tz: the view target, where the haze centres with no survivor of yours up.
  update(game: Game, dt: number, tx: number, tz: number): void {
    this.haze(game, dt, tx, tz);
    for (let i = this.retired.length - 1; i >= 0; i--) {
      if (--this.retired[i].frames > 0) continue;
      this.retired[i].tex.dispose();
      this.retired.splice(i, 1);
    }
    const v = game.vision;
    if (v !== this.vision) {
      this.vision = v;
      this.uOn.value = v ? 1 : 0;
      this.uMem.value = game.lightOnly() ? 0 : game.welcome?.dark ? 0.16 : 0.4;
      this.uNever.value = game.welcome?.dark ? 0 : 0.07;
      if (v) {
        // A new sight (the host changed the difficulty) on the same map keeps the texture and
        // rewrites it. One of another size takes a new one, and the old is disposed only once
        // frames have been drawn without it: the fog node still has it bound until the next
        // render, and WebGPU fails every submit that uses a destroyed texture.
        const img = this.tex.image as { width: number; height: number };
        if (img.width !== v.w || img.height !== v.h) {
          this.retired.push({ tex: this.tex, frames: 30 });
          this.tex = new THREE.DataTexture(new Uint8Array(v.w * v.h * 4), v.w, v.h, THREE.RGBAFormat);
          this.tex.magFilter = THREE.LinearFilter; this.tex.minFilter = THREE.LinearFilter;
          this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
          this.node.value = this.tex;
          this.uSize.value.set(v.w, v.h);
        }
        this.shown = new Float32Array(v.w * v.h);
        this.seen = new Float32Array(v.w * v.h);
        // The first look is instant: no fade in from black on joining.
        const px = this.tex.image.data as Uint8Array;
        for (let i = 0; i < v.now.length; i++) {
          this.shown[i] = v.now[i]; this.seen[i] = v.seen[i];
          px[i * 4] = v.now[i] * 255; px[i * 4 + 1] = v.seen[i] * 255; px[i * 4 + 3] = 255;
        }
        this.tex.needsUpdate = true;
      }
    }
    if (!v) return;
    const k = Math.min(1, dt * 6), now = v.now, seen = v.seen, sh = this.shown, se = this.seen;
    const px = this.tex.image.data as Uint8Array;
    let moved = false;
    for (let i = 0; i < now.length; i++) {
      const a = sh[i], b = se[i];
      const na = Math.abs(now[i] - a) < 0.004 ? now[i] : a + (now[i] - a) * k;
      const nb = Math.abs(seen[i] - b) < 0.004 ? seen[i] : b + (seen[i] - b) * k;
      if (na === a && nb === b) continue;
      sh[i] = na; se[i] = nb;
      px[i * 4] = na * 255; px[i * 4 + 1] = nb * 255;
      moved = true;
    }
    if (moved) this.tex.needsUpdate = true;
  }

  // How clearly x, z shows through the haze right now, 1 clear .. 0 lost in it, as the fog
  // node fades it: for what is drawn over the scene, the labels, to fade with it.
  clarity(x: number, z: number): number {
    const d = Math.hypot(x - this.uEye.value.x, z - this.uEye.value.y);
    const n = this.uNear.value, f = this.uFar.value, t = Math.min(1, Math.max(0, (d - n) / Math.max(1e-3, f - n)));
    return 1 - t * t * (3 - 2 * t) * this.uHaze.value;
  }

  // The haze follows your survivor, or the view with none up, and reaches as far as you see.
  private haze(game: Game, dt: number, tx: number, tz: number): void {
    const f = game.cur, me = game.me(), k = Math.min(1, dt * 1.5);
    const see = game.welcome ? sightMul(f.weather, f.weatherAmt) : 1;
    const up = me && me.flags & PF_ALIVE;
    if (up) this.uEye.value.set(game.prx[me.id], game.pry[me.id]);
    else this.uEye.value.set(tx, tz);
    // With a flashlight the haze sits out at the end of its beam; goggles see as by day.
    const r = (up && me.goggles ? DAY_SIGHT : game.welcome?.cone || game.welcome?.dark || DAY_SIGHT) * (up && me.cur === RIFLE ? RIFLE_SIGHT : 1) * see;
    this.uNear.value += (r * 0.55 - this.uNear.value) * k;
    this.uFar.value += (r * 1.15 - this.uFar.value) * k;
    this.uHaze.value += (Math.min(1, (1 - see) / 0.6) * 0.9 - this.uHaze.value) * k;
  }
}

function blank(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 0, 255]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}
