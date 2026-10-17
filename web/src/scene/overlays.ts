import * as THREE from 'three/webgpu';
import { float, mix, sin, time, uniform, vertexColor } from 'three/tsl';
import type { Frame } from '../protocol';
import type { Structs } from './structs';
import { setEmissive } from './util';

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
