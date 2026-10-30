import * as THREE from 'three/webgpu';
import { float, mix, sin, time, uniform, vertexColor } from 'three/tsl';
import type { Frame } from '../protocol';
import type { Structs } from './structs';
import { setEmissive, writeMatrix } from './util';

const ROUTE_DOTS = 4096;

type RingName = 'range' | 'area' | 'build' | 'sel' | 'hover' | 'turret' | 'shop';

// Ground-level helpers: range and selection rings, the ability area preview, the build
// radius and the translucent build ghost with its footprint.
export class Overlays {
  group = new THREE.Group();
  private rings = new Map<RingName, THREE.Mesh>();
  private ringGeo: THREE.RingGeometry;
  private thinGeo: THREE.RingGeometry;
  private discGeo: THREE.CircleGeometry;
  private ghostColor = uniform(new THREE.Color(0x40ff70));
  private ghostMat: THREE.MeshLambertNodeMaterial;
  private ghost: THREE.Group | null = null;
  private ghostKind = -1;
  private foot: THREE.Mesh;
  private area: THREE.Mesh;
  // The outlines of structures the creeps destroyed, by structure index, and what they were.
  private ruinMat: THREE.MeshLambertNodeMaterial;
  private ruinsAt = new Map<number, { kind: number; x: number; y: number; g: THREE.Group }>();
  // The creeps' way in through the maze: a dot on each tile of it.
  private dots: THREE.InstancedMesh;

  constructor(scene: THREE.Scene, private structs: Structs) {
    scene.add(this.group);
    this.ringGeo = new THREE.RingGeometry(0.93, 1, 96); this.ringGeo.rotateX(-Math.PI / 2);
    this.thinGeo = new THREE.RingGeometry(0.975, 1, 128); this.thinGeo.rotateX(-Math.PI / 2);
    this.discGeo = new THREE.CircleGeometry(1, 48); this.discGeo.rotateX(-Math.PI / 2);
    this.ghostMat = new THREE.MeshLambertNodeMaterial({ transparent: true, depthWrite: false });
    this.ghostMat.colorNode = mix(vertexColor().rgb, this.ghostColor, 0.5);
    setEmissive(this.ghostMat, this.ghostColor.mul(0.3));
    this.ghostMat.opacityNode = sin(time.mul(6)).mul(0.08).add(0.68);
    const footMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    footMat.colorNode = this.ghostColor;
    footMat.opacityNode = float(0.45);
    const fg = new THREE.PlaneGeometry(1, 1); fg.rotateX(-Math.PI / 2);
    this.foot = new THREE.Mesh(fg, footMat);
    this.foot.visible = false;
    this.foot.renderOrder = 5;
    this.group.add(this.foot);
    const am = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, color: 0xff5040 });
    am.opacityNode = sin(time.mul(8)).mul(0.05).add(0.2);
    this.area = new THREE.Mesh(this.discGeo, am);
    this.area.visible = false;
    this.area.renderOrder = 5;
    this.group.add(this.area);
    this.ruinMat = new THREE.MeshLambertNodeMaterial({ transparent: true, depthWrite: false });
    this.ruinMat.colorNode = mix(vertexColor().rgb, uniform(new THREE.Color(0x8fb4d8)), 0.7);
    this.ruinMat.opacityNode = sin(time.mul(2)).mul(0.05).add(0.22);
    const dg = new THREE.PlaneGeometry(0.26, 0.26); dg.rotateX(-Math.PI / 2); dg.rotateY(Math.PI / 4);
    const dm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, color: 0xff6a3a });
    dm.opacityNode = sin(time.mul(4)).mul(0.1).add(0.75);
    this.dots = new THREE.InstancedMesh(dg, dm, ROUTE_DOTS);
    this.dots.count = 0;
    this.dots.renderOrder = 5;
    this.dots.frustumCulled = false;
    this.group.add(this.dots);
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
    (m.material as THREE.MeshBasicNodeMaterial).color.setHex(hex);
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
      const g = this.structs.ghost(f.sKind[i], this.ruinMat);
      g.renderOrder = 4;
      g.position.set(f.sX[i] + f.sW[i] / 2, 0.02, f.sY[i] + f.sH[i] / 2);
      this.group.add(g);
      at.set(i, { kind: f.sKind[i], x: f.sX[i], y: f.sY[i], g });
    }
  }

  private get(name: RingName): THREE.Mesh {
    let m = this.rings.get(name);
    if (!m) {
      const thin = name === 'build' || name === 'range' || name === 'turret' || name === 'shop';
      const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
      m = new THREE.Mesh(thin ? this.thinGeo : this.ringGeo, mat);
      m.renderOrder = 6;
      m.visible = false;
      this.group.add(m);
      this.rings.set(name, m);
    }
    return m;
  }

  ring(name: RingName, on: boolean, x = 0, y = 0, r = 1, hex = 0xffffff, opacity = 0.8): void {
    const m = this.get(name);
    m.visible = on;
    if (!on) return;
    m.position.set(x, 0.09, y);
    m.scale.setScalar(Math.max(0.1, r));
    const mat = m.material as THREE.MeshBasicNodeMaterial;
    mat.color.setHex(hex);
    mat.opacity = opacity;
  }

  areaPreview(on: boolean, x = 0, y = 0, r = 1, hex = 0xff5040): void {
    this.area.visible = on;
    if (!on) return;
    this.area.position.set(x, 0.1, y);
    this.area.scale.setScalar(r);
    (this.area.material as THREE.MeshBasicNodeMaterial).color.setHex(hex);
  }

  // The builds sent and not yet shown by a frame: a ghost standing where each was placed, so a
  // click is answered at once, until the structure itself comes in.
  private pendingMat: THREE.MeshLambertNodeMaterial | null = null;
  private pendingAt = new Map<string, THREE.Group>();
  pending(list: readonly { kind: number; tx: number; ty: number; w: number; h: number }[]): void {
    const at = this.pendingAt;
    if (!list.length && !at.size) return;
    const want = new Set<string>();
    for (const p of list) {
      const key = `${p.kind}:${p.tx}:${p.ty}`;
      want.add(key);
      if (at.has(key)) continue;
      if (!this.pendingMat) {
        this.pendingMat = new THREE.MeshLambertNodeMaterial({ transparent: true, depthWrite: false });
        const c = uniform(new THREE.Color(0x40ff70));
        this.pendingMat.colorNode = mix(vertexColor().rgb, c, 0.35);
        setEmissive(this.pendingMat, c.mul(0.2));
        this.pendingMat.opacityNode = sin(time.mul(14)).mul(0.1).add(0.55);
      }
      const g = this.structs.ghost(p.kind, this.pendingMat);
      g.renderOrder = 5;
      g.position.set(p.tx + p.w / 2, 0.02, p.ty + p.h / 2);
      this.group.add(g);
      at.set(key, g);
    }
    for (const [key, g] of at) if (!want.has(key)) { this.group.remove(g); at.delete(key); }
  }

  // kind < 0 hides the ghost.
  buildGhost(kind: number, tx = 0, ty = 0, w = 1, h = 1, ok = true): void {
    if (kind !== this.ghostKind) {
      if (this.ghost) this.group.remove(this.ghost);
      this.ghost = kind >= 0 ? this.structs.ghost(kind, this.ghostMat) : null;
      if (this.ghost) { this.ghost.renderOrder = 5; this.group.add(this.ghost); }
      this.ghostKind = kind;
    }
    this.foot.visible = kind >= 0;
    if (kind < 0 || !this.ghost) return;
    this.ghostColor.value.setHex(ok ? 0x40ff70 : 0xff4030);
    this.ghost.position.set(tx + w / 2, 0.02, ty + h / 2);
    this.foot.position.set(tx + w / 2, 0.08, ty + h / 2);
    this.foot.scale.set(w, 1, h);
  }
}
