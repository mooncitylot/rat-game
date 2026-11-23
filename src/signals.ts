import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Light = 'green' | 'yellow' | 'red';
export interface SignalState {
  ns: Light; // traffic along z
  ew: Light; // traffic along x
}

const CYCLE = 26;

/** One shared cycle for every intersection: north-south goes, then east-west, with all-red gaps. */
export function signalState(t: number): SignalState {
  const p = ((t % CYCLE) + CYCLE) % CYCLE;
  if (p < 9) return { ns: 'green', ew: 'red' };
  if (p < 11) return { ns: 'yellow', ew: 'red' };
  if (p < 13) return { ns: 'red', ew: 'red' };
  if (p < 22) return { ns: 'red', ew: 'green' };
  if (p < 24) return { ns: 'red', ew: 'yellow' };
  return { ns: 'red', ew: 'red' };
}

/** May a pedestrian step off the curb now? Crossing parallel to a green street, and only early in its green so they clear the road. */
export function pedestrianGo(t: number, axis: 'x' | 'z'): boolean {
  const p = ((t % CYCLE) + CYCLE) % CYCLE;
  return axis === 'z' ? p < 5.5 : p >= 13 && p < 18.5;
}

const LIT: Record<Light, number> = { red: 0xff3b2e, yellow: 0xffc926, green: 0x35e06b };
const DIM: Record<Light, number> = { red: 0x3a1512, yellow: 0x3a3010, green: 0x123a1c };
const LIGHTS: Light[] = ['red', 'yellow', 'green'];

/**
 * Traffic signals on the sidewalk corners. Poles and housings are merged into a few meshes; all the
 * lenses share six materials (3 colours x 2 axes), so updating the whole city's lights is six colour sets.
 */
export class TrafficSignals {
  readonly group = new THREE.Group();
  private metal: THREE.MeshToonMaterial;
  private housing: THREE.MeshToonMaterial;
  private lens: Record<'ns' | 'ew', Record<Light, THREE.MeshBasicMaterial>>;
  private batches = new Map<THREE.Material, THREE.BufferGeometry[]>();

  constructor(gradient: THREE.DataTexture) {
    this.metal = new THREE.MeshToonMaterial({ color: 0x4a4f5c, gradientMap: gradient });
    this.housing = new THREE.MeshToonMaterial({ color: 0x1f2128, gradientMap: gradient });
    const mk = () => ({
      red: new THREE.MeshBasicMaterial({ color: DIM.red }),
      yellow: new THREE.MeshBasicMaterial({ color: DIM.yellow }),
      green: new THREE.MeshBasicMaterial({ color: DIM.green }),
    });
    this.lens = { ns: mk(), ew: mk() };
  }

  private add(mat: THREE.Material, geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
    geo.applyMatrix4(m);
    let list = this.batches.get(mat);
    if (!list) this.batches.set(mat, (list = []));
    list.push(geo);
  }

  /**
   * A signal pole at a block corner. (ox, oz) point from the corner toward the two streets it borders;
   * one head faces each street's approaching traffic. `y` is the ground height at the foot of the pole.
   */
  addPole(x: number, z: number, ox: number, oz: number, y = 0): void {
    const T = (px: number, py: number, pz: number, ry = 0) =>
      new THREE.Matrix4().compose(new THREE.Vector3(px, py + y, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(1, 1, 1));

    this.add(this.metal, new THREE.CylinderGeometry(0.09, 0.11, 5.2, 8), T(x, 2.62, z));
    this.add(this.metal, new THREE.CylinderGeometry(0.18, 0.2, 0.3, 8), T(x, 0.37, z)); // base
    this.add(this.metal, new THREE.SphereGeometry(0.11, 8, 6), T(x, 5.25, z)); // cap

    // head A watches the street running along x (its drivers come from the ox side)
    // head B watches the street running along z (its drivers come from the -oz side)
    const heads: { fx: number; fz: number; axis: 'ns' | 'ew' }[] = [
      { fx: ox, fz: 0, axis: 'ew' },
      { fx: 0, fz: -oz, axis: 'ns' },
    ];
    for (const h of heads) {
      const ry = Math.atan2(h.fx, h.fz);
      const cx = x + h.fx * 0.42, cz = z + h.fz * 0.42, cy = 4.55;
      // bracket from the pole to the housing
      this.add(this.metal, new THREE.BoxGeometry(0.1, 0.1, 0.46), T(x + h.fx * 0.22, cy, z + h.fz * 0.22, ry));
      this.head(T, h.axis, cx, cy, cz, h.fx, h.fz, ry);

      // mast arm: sweeps out and up from the pole top, with a second head hanging over the approach
      const reach = 3.4, ay = 5.0;
      const ax = x + h.fx * reach, az = z + h.fz * reach;
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(x, y + ay - 0.5, z),
        new THREE.Vector3(x + h.fx * 0.2, y + ay + 0.35, z + h.fz * 0.2),
        new THREE.Vector3(ax, y + ay + 0.1, az),
      );
      this.add(this.metal, new THREE.TubeGeometry(curve, 10, 0.06, 6, false), new THREE.Matrix4());
      this.add(this.metal, new THREE.BoxGeometry(0.06, 0.4, 0.06), T(ax, ay - 0.1, az)); // hanger
      this.head(T, h.axis, ax, ay - 0.82, az, h.fx, h.fz, ry);
    }
  }

  /** One three-lens signal head at (cx, cy, cz) facing (fx, fz). */
  private head(T: (px: number, py: number, pz: number, ry?: number) => THREE.Matrix4, axis: 'ns' | 'ew', cx: number, cy: number, cz: number, fx: number, fz: number, ry: number): void {
    this.add(this.housing, new THREE.BoxGeometry(0.36, 1.08, 0.3), T(cx, cy, cz, ry));
    this.add(this.housing, new THREE.BoxGeometry(0.5, 1.22, 0.05), T(cx - fx * 0.17, cy, cz - fz * 0.17, ry)); // back plate
    LIGHTS.forEach((l, i) => {
      const ly = cy + 0.33 - i * 0.33;
      const front = new THREE.Vector3(fx, 0, fz).multiplyScalar(0.16);
      this.add(this.lens[axis][l], new THREE.SphereGeometry(0.115, 10, 8), T(cx + front.x, ly, cz + front.z, ry));
      // visor over each lens
      this.add(this.housing, new THREE.BoxGeometry(0.3, 0.035, 0.22), T(cx + fx * 0.22, ly + 0.15, cz + fz * 0.22, ry));
    });
  }

  /** Merge everything into a handful of meshes. Call once, after the last pole. */
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

  update(t: number): void {
    const s = signalState(t);
    for (const axis of ['ns', 'ew'] as const) {
      for (const l of LIGHTS) this.lens[axis][l].color.setHex(s[axis] === l ? LIT[l] : DIM[l]);
    }
  }
}
