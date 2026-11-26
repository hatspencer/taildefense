import * as THREE from 'three/webgpu';
import {
  atan, float, floor, fract, fwidth, max, min, mix, mrt, output, positionGeometry, step, time, uniform, uv, vec4, vertexColor,
} from 'three/tsl';
import type { Frame } from '../protocol';
import type { Structs } from './structs';
import { writeMatrix } from './util';
import { trapFace } from './traps';
import { dither, tame } from './dither';
import { PAL, lighter } from './palette';

const ROUTE_DOTS = 4096;

type RingName = 'range' | 'area' | 'build' | 'sel' | 'hover' | 'turret' | 'shop';

// The overlays' colours: a call's colour (a team's, a warning's) brought into the palette and
// lifted to read on the dark, mottled ground; and the dark they are underlined with.
const pale = (hex: number) => lighter(tame(hex, 0.62), 0.18);
const OK = 0xd8cca0, BAD = 0xc8402a;
const INK = new THREE.Color(PAL.ink);

type F = THREE.Node<'float'>;

// Whole pixels: a kept pixel is opaque, the rest are not drawn. No glow, no see-through wash.
function solid(m: THREE.MeshBasicNodeMaterial, cov: F): THREE.MeshBasicNodeMaterial {
  m.opacityNode = dither(cov);
  m.alphaTestNode = float(0.5);
  m.transparent = true;
  m.depthWrite = false;
  m.fog = false;
  m.mrtNode = mrt({ output, normal: vec4(0, 0, 0, 0) });
  return m;
}

// A line round the edge of a unit disc or ring lying on the ground, a scene pixel or two wide
// at any size and zoom (its width taken from how fast the radius changes from pixel to pixel),
// broken into dashes `dashes` round, with the pixel inside it dark so it reads on sand and on
// grass alike. 1 on the line, 2 on its dark underline, 0 elsewhere.
function edgeLine(dashes: THREE.UniformNode<'float', number>, crawl: F | number = 0): { line: F; under: F } {
  const rho = positionGeometry.xz.length();
  const edge = float(1).sub(rho), w = fwidth(rho);
  const turn = atan(positionGeometry.z, positionGeometry.x).div(Math.PI * 2);
  // No dashes: a whole line.
  const on = max(step(0.45, fract(turn.mul(dashes).add(crawl))), step(dashes, 0.5));
  const line = step(edge, w.mul(1.4)).mul(on);
  const under = step(w.mul(1.4), edge).mul(step(edge, w.mul(2.6))).mul(on);
  return { line, under };
}

// Ground-level helpers: range and selection rings, the ability area preview, the build
// radius and the build ghost with its footprint. Thin dashed or dotted lines of whole pixels in
// the palette's pale and warning colours, never a glow or a see-through wash.
export class Overlays {
  group = new THREE.Group();
  private rings = new Map<RingName, { mesh: THREE.Mesh; col: THREE.UniformNode<'color', THREE.Color>; dashes: THREE.UniformNode<'float', number> }>();
  private ringGeo: THREE.RingGeometry;
  private discGeo: THREE.CircleGeometry;
  private ghostColor = uniform(new THREE.Color(OK));
  private ghostMat: THREE.MeshLambertNodeMaterial;
  private ghost: THREE.Group | null = null;
  private ghostKind = -1;
  private foot: THREE.Mesh;
  private area: THREE.Mesh;
  private areaCol = uniform(new THREE.Color(BAD));
  private areaDashes = uniform(24);
  // The outlines of structures the creeps destroyed, by structure index, and what they were.
  private ruinMat: THREE.MeshLambertNodeMaterial;
  private ruinsAt = new Map<number, { kind: number; x: number; y: number; g: THREE.Group }>();
  // The creeps' way in through the maze: a dot on each tile of it.
  private dots: THREE.InstancedMesh;
  private dotCol = uniform(new THREE.Color(BAD));
  // The reticle on the ground under the cursor: where a dash or a weapon art goes.
  private reticle = new THREE.Group();
  // This machine's RETICLE and RETICLE_SIZE settings: whether it is drawn, and its size in percent.
  reticleOn = true;
  reticleSize = 100;

  constructor(scene: THREE.Scene, private structs: Structs) {
    scene.add(this.group);
    this.ringGeo = new THREE.RingGeometry(0.8, 1, 96); this.ringGeo.rotateX(-Math.PI / 2);
    this.discGeo = new THREE.CircleGeometry(1, 48); this.discGeo.rotateX(-Math.PI / 2);
    // A ghost is the structure in a dither of whole pixels, tinted pale where it can go and
    // warning red where it cannot.
    this.ghostMat = new THREE.MeshLambertNodeMaterial({ transparent: true, depthWrite: false });
    this.ghostMat.colorNode = mix(vertexColor().rgb, this.ghostColor, 0.45);
    this.ghostMat.emissiveNode = this.ghostColor.mul(0.18);
    this.ghostMat.opacityNode = dither(float(0.62));
    this.ghostMat.alphaTestNode = float(0.5);
    // The footprint: its outline in dashes, and a sparse dither over the ground inside.
    const fe = min(min(uv().x, uv().y), min(float(1).sub(uv().x), float(1).sub(uv().y))), fw = fwidth(fe);
    const fdash = step(0.4, fract(uv().x.add(uv().y).mul(4)));
    const footMat = solid(new THREE.MeshBasicNodeMaterial(), max(step(fe, fw.mul(1.4)).mul(fdash), float(0.16)));
    footMat.colorNode = this.ghostColor;
    const fg = new THREE.PlaneGeometry(1, 1); fg.rotateX(-Math.PI / 2);
    this.foot = new THREE.Mesh(fg, footMat);
    this.foot.visible = false;
    this.foot.renderOrder = 5;
    this.group.add(this.foot);
    // The area an ability will hit: its edge dashed and crawling, the ground inside lightly
    // dithered in the same colour.
    const crawl = floor(time.mul(8)).div(48);
    const ae = edgeLine(this.areaDashes, crawl);
    const am = solid(new THREE.MeshBasicNodeMaterial(), max(max(ae.line, ae.under), float(0.1)));
    am.colorNode = mix(this.areaCol.mul(mix(float(0.55), float(1), ae.line)), INK, ae.under);
    this.area = new THREE.Mesh(this.discGeo, am);
    this.area.visible = false;
    this.area.renderOrder = 5;
    this.group.add(this.area);
    this.ruinMat = new THREE.MeshLambertNodeMaterial({ transparent: true, depthWrite: false });
    this.ruinMat.colorNode = mix(vertexColor().rgb, uniform(new THREE.Color(0xc8c2a0)), 0.7);
    this.ruinMat.opacityNode = dither(float(0.3));
    this.ruinMat.alphaTestNode = float(0.5);
    // The way in: a dot of a couple of pixels on each tile, blinking in steps.
    const dg = new THREE.PlaneGeometry(0.13, 0.13); dg.rotateX(-Math.PI / 2);
    const dm = solid(new THREE.MeshBasicNodeMaterial(), float(1));
    dm.colorNode = this.dotCol.mul(mix(float(0.7), float(1), step(0.5, fract(time.mul(1.5)))));
    this.dots = new THREE.InstancedMesh(dg, dm, ROUTE_DOTS);
    this.dots.count = 0;
    this.dots.renderOrder = 5;
    this.dots.frustumCulled = false;
    this.group.add(this.dots);
    // Drawn over everything, so a creep or a roof never hides the spot aimed at; a dark band
    // under a pale one keeps it plain on sand and snow alike.
    const reticleMat = (hex: number) => {
      const m = new THREE.MeshBasicNodeMaterial({ depthWrite: false, depthTest: false, color: hex });
      m.fog = false;
      m.mrtNode = mrt({ output, normal: vec4(0, 0, 0, 0) });
      return m;
    };
    const shape = (pad: number) => {
      const ring = new THREE.RingGeometry(0.3 - pad, 0.35 + pad, 32);
      const parts: THREE.BufferGeometry[] = [ring];
      for (let i = 0; i < 4; i++) {
        const t = new THREE.PlaneGeometry(0.06 + 2 * pad, 0.18 + 2 * pad);
        t.translate(0, 0.5, 0); t.rotateZ(i * Math.PI / 2);
        parts.push(t);
      }
      parts.push(new THREE.PlaneGeometry(0.07 + 2 * pad, 0.07 + 2 * pad));
      return parts;
    };
    for (const [pad, mat, order] of [[0.035, reticleMat(PAL.ink), 20], [0, reticleMat(0xe8dcb0), 21]] as const) {
      for (const g of shape(pad)) {
        g.rotateX(-Math.PI / 2);
        const m = new THREE.Mesh(g, mat);
        m.renderOrder = order;
        m.frustumCulled = false;
        this.reticle.add(m);
      }
    }
    this.reticle.visible = false;
    this.group.add(this.reticle);
  }

  // The cursor's spot on the ground, about the same size on screen however far the camera is,
  // times the RETICLE_SIZE setting; none at all with RETICLE off.
  cursor(on: boolean, x = 0, z = 0, dist = 22): void {
    on = on && this.reticleOn;
    this.reticle.visible = on;
    if (!on) return;
    this.reticle.position.set(x, 0.12, z);
    this.reticle.scale.setScalar(Math.min(2.5, Math.max(0.6, dist / 22)) * this.reticleSize / 100);
  }

  // Draws the ways in, each a list of tile indices that at(i) turns into tile x, y; none hides them.
  route(paths: Int32Array[] | null, at?: (i: number) => [number, number], hex = 0xff6a3a): void {
    const m = this.dots, a = m.instanceMatrix.array as Float32Array;
    let n = 0;
    // Tiles shared by two ways in are drawn once.
    const done = new Set<number>();
    if (paths && at) for (const p of paths) for (let j = 0; j < p.length - 1 && n < ROUTE_DOTS; j++) {
      if (done.has(p[j])) continue;
      done.add(p[j]);
      const [x, y] = at(p[j]);
      writeMatrix(a, n++ * 16, x + 0.5, 0.07, y + 0.5, 0, 1);
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    this.dotCol.value.setHex(tame(hex, 0.7));
  }

  // A pale outline where each ghost stands, until it is rebuilt or built over.
  ruins(f: Frame): void {
    const at = this.ruinsAt;
    for (const [i, r] of at) {
      if (i < f.nStructs && f.sGhost[i] && f.sKind[i] === r.kind && f.sX[i] === r.x && f.sY[i] === r.y) continue;
      this.group.remove(r.g);
      at.delete(i);
    }
    for (let i = 0; i < f.nStructs; i++) {
      if (!f.sGhost[i] || at.has(i)) continue;
      const g = this.structs.ghost(f.sKind[i], this.ruinMat, f.sFacing[i]);
      g.renderOrder = 4;
      g.position.set(f.sX[i] + f.sW[i] / 2, 0.02, f.sY[i] + f.sH[i] / 2);
      this.group.add(g);
      at.set(i, { kind: f.sKind[i], x: f.sX[i], y: f.sY[i], g });
    }
  }

  private get(name: RingName) {
    let r = this.rings.get(name);
    if (!r) {
      const col = uniform(new THREE.Color(OK)), dashes = uniform(24);
      // A selection is a whole line; a hover, a range or a radius is dashed.
      const e = edgeLine(dashes);
      const mat = solid(new THREE.MeshBasicNodeMaterial(), max(e.line, e.under));
      mat.colorNode = mix(col, INK, e.under);
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.renderOrder = 6;
      mesh.visible = false;
      this.group.add(mesh);
      r = { mesh, col, dashes };
      this.rings.set(name, r);
    }
    return r;
  }

  ring(name: RingName, on: boolean, x = 0, y = 0, r = 1, hex = 0xffffff, opacity = 0.8): void {
    const g = this.get(name), m = g.mesh;
    m.visible = on;
    if (!on) return;
    m.position.set(x, 0.09, y);
    r = Math.max(0.1, r);
    m.scale.setScalar(r);
    // A dash about half a metre long, or none for the selection; a fainter ring is a darker one.
    g.dashes.value = name === 'sel' ? 0 : Math.max(8, Math.round(2 * Math.PI * r / (name === 'hover' ? 0.3 : 0.55)));
    g.col.value.setHex(pale(hex)).multiplyScalar(0.55 + 0.45 * Math.min(1, opacity / 0.8));
  }

  areaPreview(on: boolean, x = 0, y = 0, r = 1, hex = 0xff5040): void {
    this.area.visible = on;
    if (!on) return;
    this.area.position.set(x, 0.1, y);
    this.area.scale.setScalar(r);
    this.areaDashes.value = Math.max(8, Math.round(2 * Math.PI * r / 0.45));
    this.areaCol.value.setHex(pale(hex));
  }

  // The builds sent and not yet shown by a frame: a ghost standing where each was placed, so a
  // click is answered at once, until the structure itself comes in.
  private pendingMat: THREE.MeshLambertNodeMaterial | null = null;
  private pendingAt = new Map<string, THREE.Group>();
  pending(list: readonly { kind: number; tx: number; ty: number; w: number; h: number; facing: number }[]): void {
    const at = this.pendingAt;
    if (!list.length && !at.size) return;
    const want = new Set<string>();
    for (const p of list) {
      const key = `${p.kind}:${p.tx}:${p.ty}:${p.facing}`;
      want.add(key);
      if (at.has(key)) continue;
      if (!this.pendingMat) {
        this.pendingMat = new THREE.MeshLambertNodeMaterial({ transparent: true, depthWrite: false });
        const c = uniform(new THREE.Color(OK));
        this.pendingMat.colorNode = mix(vertexColor().rgb, c, 0.35);
        this.pendingMat.emissiveNode = c.mul(0.12);
        // Filling in as it waits: the dither steps between half and most of the pixels.
        this.pendingMat.opacityNode = dither(mix(float(0.5), float(0.75), step(0.5, fract(time.mul(3)))));
        this.pendingMat.alphaTestNode = float(0.5);
      }
      const g = this.structs.ghost(p.kind, this.pendingMat, p.facing);
      g.renderOrder = 5;
      g.position.set(p.tx + p.w / 2, 0.02, p.ty + p.h / 2);
      this.group.add(g);
      at.set(key, g);
    }
    for (const [key, g] of at) if (!want.has(key)) { this.group.remove(g); at.delete(key); }
  }

  // kind < 0 hides the ghost. A kind placed facing a way is turned to facing, and a catapult
  // pit's shows where it throws to.
  buildGhost(kind: number, tx = 0, ty = 0, w = 1, h = 1, ok = true, facing = 0): void {
    if (kind !== this.ghostKind) {
      if (this.ghost) this.group.remove(this.ghost);
      this.ghost = kind >= 0 ? this.structs.ghost(kind, this.ghostMat, facing, true) : null;
      if (this.ghost) { this.ghost.renderOrder = 5; this.group.add(this.ghost); }
      this.ghostKind = kind;
    }
    this.foot.visible = kind >= 0;
    if (kind < 0 || !this.ghost) return;
    this.ghostColor.value.setHex(ok ? OK : BAD);
    this.ghost.position.set(tx + w / 2, 0.02, ty + h / 2);
    trapFace(this.ghost, facing);
    this.foot.position.set(tx + w / 2, 0.08, ty + h / 2);
    this.foot.scale.set(w, 1, h);
  }
}
