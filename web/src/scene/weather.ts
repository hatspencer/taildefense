import * as THREE from 'three/webgpu';
import {
  float, fract, instancedBufferAttribute, mrt, normalize, output, vec4, positionGeometry, sin, cos, smoothstep, time, uniform, vec3,
} from 'three/tsl';
import { BlastKind, Weather as W } from '../protocol';
import type { Game } from '../state';

// Shared with the terrain's materials: how wet (puddles, darker ground) and how snowy (white
// on the ground and the tops of things) the world is, 0..1.
export const uWet = uniform(0);
export const uSnow = uniform(0);

const RAIN = 9000, SNOW = 7000;

// How much fog, rain, storm and snow each weather kind shows at full strength.
const LOOKS: Record<number, { fog: number; rain: number; storm: number; snow: number; flakes?: number; gust?: number }> = {
  [W.Clear]: { fog: 0, rain: 0, storm: 0, snow: 0 },
  [W.Fog]: { fog: 1, rain: 0, storm: 0, snow: 0 },
  [W.Rain]: { fog: 0.2, rain: 1, storm: 0, snow: 0 },
  [W.Storm]: { fog: 0.35, rain: 1, storm: 1, snow: 0 },
  [W.Snow]: { fog: 0.12, rain: 0, storm: 0, snow: 0.55, flakes: 0.25 },
  [W.Drizzle]: { fog: 0.1, rain: 0.3, storm: 0, snow: 0 },
  [W.Thunder]: { fog: 0.15, rain: 0.5, storm: 0.2, snow: 0 },
  [W.HeavySnow]: { fog: 0.4, rain: 0, storm: 0, snow: 1, flakes: 1, gust: 1 },
};

// How the weather looks right now, eased: World reads it for fog, light and tint.
// snow is how white the ground and sky go; flakes how thick the snowfall is; gust how hard the
// wind drives it.
export interface WeatherLook { fog: number; rain: number; storm: number; snow: number; flakes: number; gust: number; flash: number; dark: number }

// Rain, storm and snow particles. Every drop has a fixed random spot in a box; the shader moves
// it with the clock and wraps it into the box around the view target, so the CPU does nothing
// per drop and the particles stay anchored in the world while the camera pans.
export class Weather {
  group = new THREE.Group();
  look: WeatherLook = { fog: 0, rain: 0, storm: 0, snow: 0, flakes: 0, gust: 0, flash: 0, dark: 0 };
  private uCorner = uniform(new THREE.Vector3());
  private uSize = uniform(new THREE.Vector3(60, 30, 60));
  private uRight = uniform(new THREE.Vector3(1, 0, 0));
  private uUp = uniform(new THREE.Vector3(0, 1, 0));
  private uWind = uniform(new THREE.Vector2(2, 1));
  private uFall = uniform(22);
  private uLen = uniform(0.9);
  private uAlpha = uniform(0.4);
  private uSnowAlpha = uniform(0.9);
  private rain: THREE.InstancedMesh;
  private snow: THREE.InstancedMesh;
  private lastTick = -1;
  // Lightning flicker: seconds since the last strike.
  private sinceBolt = 9;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.rain = this.make(RAIN, true);
    this.snow = this.make(SNOW, false);
  }

  private make(cap: number, rain: boolean): THREE.InstancedMesh {
    const seeds = new Float32Array(cap * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const s = instancedBufferAttribute<'vec4'>(new THREE.InstancedBufferAttribute(seeds, 4), 'vec4');
    const t = time;
    const size = this.uSize, corner = this.uCorner, g = positionGeometry;
    const speed = s.w.mul(0.4).add(0.8);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    if (rain) {
      const motion = vec3(this.uWind.x.mul(t), this.uFall.mul(t).mul(speed).negate(), this.uWind.y.mul(t));
      const p = corner.add(fract(s.xyz.mul(size).add(motion).sub(corner).div(size)).mul(size));
      const dir = normalize(vec3(this.uWind.x, this.uFall.negate(), this.uWind.y));
      // Spanned by right and the fall direction, which points down: flip y so the face looks at the camera.
      mat.positionNode = p.add(this.uRight.mul(g.x.mul(0.035))).sub(dir.mul(g.y.mul(this.uLen)));
      mat.colorNode = vec3(0.78, 0.84, 0.92);
      // Fade near the top of the box so drops do not pop in.
      mat.opacityNode = this.uAlpha.mul(float(1).sub(smoothstep(0.75, 1, p.y.div(size.y))));
    } else {
      const fall = t.mul(1.6).mul(speed);
      const drift = vec3(sin(t.mul(0.9).add(s.w.mul(20))).mul(0.6).add(this.uWind.x.mul(t).mul(0.3)), fall.negate(), cos(t.mul(0.7).add(s.w.mul(13))).mul(0.6).add(this.uWind.y.mul(t).mul(0.3)));
      const p = corner.add(fract(s.xyz.mul(size).add(drift).sub(corner).div(size)).mul(size));
      const r = s.w.mul(0.05).add(0.06);
      mat.positionNode = p.add(this.uRight.mul(g.x).add(this.uUp.mul(g.y)).mul(r));
      mat.colorNode = vec3(0.95, 0.97, 1.0);
      mat.opacityNode = this.uSnowAlpha.mul(float(1).sub(smoothstep(0.8, 1, p.y.div(size.y))));
    }
    // Keep the outline pass's normals: a flake is not a crease.
    mat.mrtNode = mrt({ output, normal: vec4(0, 0, 0, 0) });
    const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, cap);
    m.frustumCulled = false;
    m.count = 0;
    m.renderOrder = 7;
    this.group.add(m);
    return m;
  }

  // Per render frame, before World applies the look. tx, tz: the view target; dist: the camera distance.
  update(game: Game, dt: number, cam: THREE.Camera, tx: number, tz: number, dist: number): void {
    const f = game.cur, l = this.look;
    const k = f.weather, amt = game.welcome ? f.weatherAmt : 0;
    const e = Math.min(1, dt * 1.5);
    const to = (v: number, goal: number) => v + (goal - v) * e;
    // Heavy rain, storms and heavy snow are the full effect; a drizzle, a thunder shower and a
    // light snowfall are a fraction of it, so the everyday weather stays easy on the eyes.
    const g = LOOKS[k] ?? LOOKS[W.Clear];
    l.fog = to(l.fog, g.fog * amt);
    l.rain = to(l.rain, g.rain * amt);
    l.storm = to(l.storm, g.storm * amt);
    l.snow = to(l.snow, g.snow * amt);
    l.flakes = to(l.flakes, (g.flakes ?? 0) * amt);
    l.gust = to(l.gust, (g.gust ?? 0) * amt);
    l.dark = Math.max(l.storm * 0.6, l.rain * 0.35, l.fog * 0.3);

    // Lightning: a strike flashes twice, quickly.
    if (f.tick !== this.lastTick) {
      this.lastTick = f.tick;
      for (let i = 0; i < f.nBlasts; i++) if (f.bKind[i] === BlastKind.Lightning) this.sinceBolt = 0;
    }
    this.sinceBolt += dt;
    const s = this.sinceBolt;
    l.flash = s < 0.06 ? 1 : s < 0.12 ? 0.25 : s < 0.2 ? 0.8 : Math.max(0, 0.8 - (s - 0.2) * 3);

    uWet.value = l.rain > uWet.value ? Math.min(l.rain, uWet.value + dt * 0.3) : Math.max(l.rain, uWet.value - dt * 0.03);
    uSnow.value = l.snow > uSnow.value ? Math.min(l.snow, uSnow.value + dt * 0.2) : Math.max(l.snow, uSnow.value - dt * 0.05);

    // The box follows the view; bigger when zoomed out, so the density per screen stays put.
    const span = Math.max(36, dist * 1.5), hgt = Math.min(22, Math.max(10, dist * 0.45));
    this.uSize.value.set(span, hgt, span);
    this.uCorner.value.set(tx - span / 2, 0, tz - span / 2 + dist * 0.15);
    const m = cam.matrixWorld.elements;
    this.uRight.value.set(m[0], m[1], m[2]);
    this.uUp.value.set(m[4], m[5], m[6]);
    const zoomFill = Math.min(1, (span * span) / (60 * 60));
    this.rain.count = Math.floor(RAIN * Math.min(1, l.rain * (0.45 + 0.55 * l.storm)) * zoomFill);
    this.uFall.value = 22 + 10 * l.storm;
    this.uLen.value = 0.7 + 0.4 * l.storm;
    this.uWind.value.set(1.5 + 5 * l.storm + 9 * l.gust, 0.8 + 2 * l.storm + 3 * l.gust);
    this.uAlpha.value = 0.22 + 0.1 * l.storm;
    this.rain.visible = this.rain.count > 0;
    this.snow.count = Math.floor(SNOW * l.flakes * zoomFill);
    this.snow.visible = this.snow.count > 0;
  }
}
