import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Street banners: a few painted designs, drawn once on canvas and shared by every lamp. */
function bannerTexture(kind: number): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const W = 128, H = 448;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const art = H - 92; // art area; a white caption strip sits below, like the reference
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);

  const label = (top: string, sub: string) => {
    g.fillStyle = '#e9eaec';
    g.fillRect(0, art, W, H - art);
    g.fillStyle = '#23262d';
    g.textAlign = 'center';
    g.font = '800 20px system-ui, sans-serif';
    g.fillText(top, W / 2, art + 38);
    g.font = '600 13px system-ui, sans-serif';
    g.fillStyle = '#5b6070';
    g.fillText(sub, W / 2, art + 62);
  };

  if (kind === 0) {
    // isometric cube pattern in teal / gold / navy
    const pal = ['#1fb2c9', '#f0b928', '#1c2f6b', '#f6f4ec'];
    g.fillStyle = pal[3];
    g.fillRect(0, 0, W, art);
    const s = 32;
    for (let row = -1; row * s * 0.86 < art + s; row++) {
      for (let col = -1; col * s * 2 < W + s * 2; col++) {
        const cx = col * s * 2 + (row & 1 ? s : 0) + 8, cy = row * s * 1.5 + 14;
        const faces: [number, number][][] = [
          [[0, -s], [s * 0.87, -s / 2], [0, 0], [-s * 0.87, -s / 2]],
          [[-s * 0.87, -s / 2], [0, 0], [0, s], [-s * 0.87, s / 2]],
          [[s * 0.87, -s / 2], [s * 0.87, s / 2], [0, s], [0, 0]],
        ];
        faces.forEach((f, i) => {
          g.fillStyle = pal[(i + ((row + col) & 1 ? 1 : 0)) % 3];
          g.beginPath();
          f.forEach(([px, py], k) => (k ? g.lineTo(cx + px, cy + py) : g.moveTo(cx + px, cy + py)));
          g.closePath();
          g.fill();
        });
      }
    }
    g.fillStyle = '#e9eaec';
    g.fillRect(0, art, W, H - art);
    g.fillStyle = '#23262d';
    g.textAlign = 'center';
    g.font = '800 19px system-ui, sans-serif';
    g.fillText('NORTH SIDE', W / 2, art + 40);
    g.font = '600 13px system-ui, sans-serif';
    g.fillStyle = '#5b6070';
    g.fillText('RAT CITY', W / 2, art + 62);
  } else if (kind === 1) {
    // Chicago flag: two pale-blue stripes, four red stars
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, art);
    g.fillStyle = '#41b6e6';
    g.fillRect(0, art * 0.2, W, art * 0.14);
    g.fillRect(0, art * 0.66, W, art * 0.14);
    g.fillStyle = '#d0202d';
    for (let i = 0; i < 4; i++) {
      const cx = W / 2 + (i - 1.5) * 26, cy = art / 2;
      g.beginPath();
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? 6 : 13, a = (k * Math.PI) / 5 - Math.PI / 2;
        g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      g.closePath();
      g.fill();
    }
    label('CHICAGO', 'CITY OF BIG SHOULDERS');
  } else if (kind === 2) {
    // ballpark blue with a red C
    g.fillStyle = '#0e3386';
    g.fillRect(0, 0, W, art);
    g.strokeStyle = '#fff';
    g.lineWidth = 6;
    g.strokeRect(10, 10, W - 20, art - 20);
    g.fillStyle = '#cc3433';
    g.beginPath();
    g.arc(W / 2, art / 2, 40, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0e3386';
    g.beginPath();
    g.arc(W / 2, art / 2, 27, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0e3386';
    g.fillRect(W / 2 + 4, art / 2 - 14, 40, 28);
    g.fillStyle = '#fff';
    g.font = '800 17px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('FLY THE W', W / 2, art - 24);
    label('WRIGLEYVILLE', 'HOME OF THE CLUB');
  } else {
    // lakefront: sky, sun, waves
    const sky = g.createLinearGradient(0, 0, 0, art);
    sky.addColorStop(0, '#ffb86b');
    sky.addColorStop(0.55, '#ffe2a8');
    sky.addColorStop(1, '#8fd3e8');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, art);
    g.fillStyle = '#fff6d6';
    g.beginPath();
    g.arc(W / 2, art * 0.52, 30, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 6; i++) {
      g.strokeStyle = i % 2 ? '#2a7fa8' : '#1c5f86';
      g.lineWidth = 7;
      g.beginPath();
      const y0 = art * 0.62 + i * 24;
      for (let x = 0; x <= W; x += 4) g.lineTo(x, y0 + Math.sin(x * 0.12 + i) * 5);
      g.stroke();
    }
    label('LAKEFRONT', 'KEEP IT BLUE');
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export interface LampOpts {
  /** pole height in metres (to the arm's rise) */
  h: number;
  /** hang a street banner on the pole */
  banner?: boolean;
}

const BANNER_KINDS = 4;

/**
 * Modernised street lamps: tapered steel pole, a swept arm carrying a flat LED head, and optionally a
 * banner hung from two brackets, as on downtown poles. Everything merges into a few meshes.
 * Local +x points from the pole toward the street.
 */
export class StreetLamps {
  readonly group = new THREE.Group();
  private metal: THREE.MeshToonMaterial;
  private housing: THREE.MeshToonMaterial;
  private banners: THREE.MeshToonMaterial[];
  private batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private count = 0;

  constructor(gradient: THREE.DataTexture, private bulbMat: THREE.Material) {
    this.metal = new THREE.MeshToonMaterial({ color: 0x8a909c, gradientMap: gradient });
    this.housing = new THREE.MeshToonMaterial({ color: 0x4b505b, gradientMap: gradient });
    this.banners = Array.from({ length: BANNER_KINDS }, (_, k) => {
      const map = bannerTexture(k);
      return new THREE.MeshToonMaterial({ color: map ? 0xffffff : [0x1fb2c9, 0x41b6e6, 0x0e3386, 0xffb86b][k], map, gradientMap: gradient, side: THREE.DoubleSide });
    });
  }

  private put(mat: THREE.Material, geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
    geo.applyMatrix4(m);
    let list = this.batches.get(mat);
    if (!list) this.batches.set(mat, (list = []));
    list.push(geo);
  }

  /**
   * Stand a lamp at (x, y, z) with its arm reaching toward the street along local +x, turned by rotY.
   * Returns the world position of the light so the night-time point light can follow it.
   */
  add(x: number, y: number, z: number, rotY: number, o: LampOpts): THREE.Vector3 {
    const { h } = o;
    const base = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0)), new THREE.Vector3(1, 1, 1));
    const L = (px: number, py: number, pz: number, rx = 0, ry = 0, rz = 0) =>
      new THREE.Matrix4().multiplyMatrices(base, new THREE.Matrix4().compose(new THREE.Vector3(px, py, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));

    // pole: stepped base plinth + tapered shaft
    this.put(this.metal, new THREE.CylinderGeometry(0.2, 0.24, 0.35, 10), L(0, 0.175, 0));
    this.put(this.metal, new THREE.CylinderGeometry(0.075, 0.12, h, 10), L(0, h / 2, 0));

    // swept arm: rises out of the pole top and arcs over the street
    const reach = 2.3;
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, h - 0.25, 0), new THREE.Vector3(0.15, h + 0.75, 0), new THREE.Vector3(reach, h + 0.3, 0));
    this.put(this.metal, new THREE.TubeGeometry(curve, 10, 0.05, 6, false), L(0, 0, 0));

    // LED head: slim wedge with a glowing lens underneath
    this.put(this.housing, new THREE.BoxGeometry(1.0, 0.1, 0.34), L(reach + 0.25, h + 0.28, 0, 0, 0, -0.05));
    this.put(this.housing, new THREE.BoxGeometry(0.34, 0.1, 0.22), L(reach - 0.38, h + 0.3, 0, 0, 0, -0.1));
    this.put(this.bulbMat, new THREE.BoxGeometry(0.86, 0.02, 0.26), L(reach + 0.27, h + 0.22, 0));

    if (o.banner) {
      // two brackets and a hanging banner on the street side of the pole, seen face-on by passing traffic
      const top = h - 1.15, hgt = 2.15, w = 0.62;
      const off = 0.1 + w / 2 + 0.06;
      for (const by of [top, top - hgt + 0.2]) {
        this.put(this.metal, new THREE.BoxGeometry(off + 0.05, 0.05, 0.05), L(off / 2 + 0.02, by, 0));
      }
      this.put(this.metal, new THREE.CylinderGeometry(0.018, 0.018, w + 0.08, 6), L(off, top + 0.04, 0, 0, 0, Math.PI / 2));
      const kind = Math.abs(Math.floor(x * 0.37 + z * 0.61)) % BANNER_KINDS;
      const plane = new THREE.PlaneGeometry(w, hgt);
      this.put(this.banners[kind], plane, L(off, top - hgt / 2, 0));
    }

    this.count++;
    return new THREE.Vector3(reach + 0.27, h + 0.2, 0).applyMatrix4(base);
  }

  /** Merge everything into a handful of meshes. Call once, after the last lamp. */
  finish(): void {
    for (const [mat, geos] of this.batches) {
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = mat === this.metal || mat === this.housing;
      mesh.receiveShadow = mesh.castShadow;
      this.group.add(mesh);
      geos.forEach((g) => g.dispose());
    }
    this.batches.clear();
  }

  get lamps(): number {
    return this.count;
  }
}
