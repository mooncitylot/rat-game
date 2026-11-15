import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Box } from './physics';

/** Real-world bounding sizes (x, y, z in metres) of the Poly Haven props, used for collision boxes. */
export const PROP_SIZE: Record<string, [number, number, number]> = {
  fire_hydrant: [0.3, 0.8, 0.3],
  metal_trash_can: [0.61, 0.98, 0.56],
  utility_box_01: [0.52, 1.12, 0.43],
  wooden_crate_01: [0.83, 0.35, 0.41],
  plastic_crate_01: [0.3, 0.26, 0.41],
  cardboard_box_01: [0.39, 0.34, 0.52],
  trashbag: [0.53, 0.57, 0.46],
  street_lamp_01: [0.7, 3.87, 0.39],
  old_tyre: [0.6, 0.6, 0.16],
  Barrel_01: [0.56, 0.88, 0.56],
  CheeseBox_01: [0.24, 0.06, 0.11],
};

export interface PlaceOpts {
  x: number;
  y?: number;
  z: number;
  rotY?: number;
  scale?: number;
  emissive?: number;
  replace?: THREE.Object3D; // placeholder to remove once the model arrives
  onLoad?: (root: THREE.Object3D) => void;
}

/** Loads Poly Haven glTFs, turns their PBR materials into toon ones, and places clones. */
export class Props {
  private loader = new GLTFLoader();
  private cache = new Map<string, Promise<THREE.Object3D | null>>();

  constructor(private gradient: THREE.DataTexture, private bulbMat?: THREE.Material) {}

  private load(id: string): Promise<THREE.Object3D | null> {
    let p = this.cache.get(id);
    if (!p) {
      p = typeof document === 'undefined'
        ? Promise.resolve(null)
        : this.loader
            .loadAsync(`/models/${id}/${id}.gltf`)
            .then((gltf) => this.prepare(gltf.scene))
            .catch((e) => {
              console.warn('prop failed', id, e);
              return null;
            });
      this.cache.set(id, p);
    }
    return p;
  }

  private prepare(scene: THREE.Object3D): THREE.Object3D {
    const swapped = new Map<THREE.Material, THREE.Material>();
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const old = mesh.material as THREE.MeshStandardMaterial;
      let m = swapped.get(old);
      if (!m) {
        if (this.bulbMat && /bulb/i.test(old.name)) m = this.bulbMat;
        else m = new THREE.MeshToonMaterial({ color: 0xffffff, map: old.map ?? null, gradientMap: this.gradient, transparent: old.transparent, opacity: old.opacity });
        swapped.set(old, m);
      }
      mesh.material = m;
    });
    // some Poly Haven files ship two variants side by side (fire_hydrant + fire_hydrant_aged, 0.6 m apart):
    // stack them on the same spot; place() keeps just one per copy
    if (scene.children.some((c) => /_aged$/.test(c.name))) for (const c of scene.children) c.position.x = 0;
    // recentre: origin at the middle of the footprint, resting on y = 0
    const box = new THREE.Box3().setFromObject(scene);
    const wrap = new THREE.Group();
    scene.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    wrap.add(scene);
    return wrap;
  }

  /** Resolves once every model requested so far has loaded and been placed. */
  ready(): Promise<void> {
    return Promise.all([...this.cache.values()]).then(() => undefined);
  }

  /** Place a model; returns the (initially empty) holder. */
  place(parent: THREE.Object3D, id: string, o: PlaceOpts): THREE.Group {
    const holder = new THREE.Group();
    holder.position.set(o.x, o.y ?? 0, o.z);
    holder.rotation.y = o.rotY ?? 0;
    holder.scale.setScalar(o.scale ?? 1);
    // plain props get merged into instanced meshes once everything has loaded (see chunk.ts instancify);
    // ones with their own material or a placeholder to swap (the cheese) stay separate objects
    holder.userData.prop = true;
    holder.userData.noBatch = o.emissive !== undefined || !!o.replace;
    parent.add(holder);
    void this.load(id).then((tpl) => {
      if (!tpl) return;
      const inst = tpl.clone(true);
      // two-variant models: keep the pristine or the aged one, picked by position so it's stable
      const variants = inst.children[0];
      if (variants?.children.some((c) => /_aged$/.test(c.name))) {
        const aged = Math.abs(Math.sin(o.x * 12.9898 + o.z * 78.233) * 43758.5453) % 1 < 0.5;
        for (const c of [...variants.children]) if (/_aged$/.test(c.name) !== aged) variants.remove(c);
      }
      if (o.emissive !== undefined) {
        inst.traverse((c) => {
          const mesh = c as THREE.Mesh;
          if (mesh.isMesh) {
            const m = (mesh.material as THREE.MeshToonMaterial).clone();
            if (m.emissive) m.emissive.setHex(o.emissive!);
            mesh.material = m;
          }
        });
      }
      holder.add(inst);
      if (o.replace) o.replace.parent?.remove(o.replace);
      o.onLoad?.(inst);
    });
    return holder;
  }
}

/** Axis-aligned collision box for a prop of real size `PROP_SIZE[id]`, scaled and turned in 90 degree steps. */
export function propBox(id: string, x: number, z: number, y0: number, scale: number, rotY = 0): Box {
  const [sx, sy, sz] = PROP_SIZE[id];
  const swap = Math.abs(Math.sin(rotY)) > 0.7;
  const hx = ((swap ? sz : sx) * scale) / 2;
  const hz = ((swap ? sx : sz) * scale) / 2;
  return { minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, top: y0 + sy * scale };
}
