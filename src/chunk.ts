import * as THREE from 'three';

/**
 * Big InstancedMeshes (every window frame in the city, every grass tuft) are culled as ONE object by three,
 * so they're drawn whole in the colour, normal and shadow passes no matter where you look.
 * Splitting them into spatial cells gives each cell a tight bounding sphere: off-screen cells are frustum-culled,
 * the shadow camera only draws the cells near the rat, and cells beyond the fog can be skipped outright.
 */

const CELL = 64; // m
const PAD = 2; // m of slack on each cell's bounds (wind-sway shaders move vertices a little)

interface Chunk {
  mesh: THREE.InstancedMesh;
  /** chunk-local index → original instance index */
  src: number[];
}

/** A split InstancedMesh that still answers to the original instance indices for colour updates. */
export class ChunkedInstances {
  readonly group = new THREE.Group();
  readonly chunks: Chunk[] = [];
  /** cells further than this from the camera are hidden (small props vanish long before the fog does) */
  maxDist = Infinity;
  private where: Int32Array; // original index → chunk number
  private local: Int32Array; // original index → index inside its chunk

  constructor(im: THREE.InstancedMesh, cell = CELL) {
    const n = im.count;
    this.where = new Int32Array(n);
    this.local = new Int32Array(n);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const cells = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      im.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`;
      let list = cells.get(key);
      if (!list) cells.set(key, (list = []));
      list.push(i);
    }
    const c = new THREE.Color();
    for (const src of cells.values()) {
      const mesh = new THREE.InstancedMesh(im.geometry, im.material, src.length);
      mesh.name = im.name ? `${im.name}·chunk` : 'chunk';
      mesh.castShadow = im.castShadow;
      mesh.receiveShadow = im.receiveShadow;
      mesh.renderOrder = im.renderOrder;
      mesh.layers.mask = im.layers.mask;
      const ci = this.chunks.length;
      src.forEach((s, k) => {
        im.getMatrixAt(s, m);
        mesh.setMatrixAt(k, m);
        if (im.instanceColor) {
          im.getColorAt(s, c);
          mesh.setColorAt(k, c);
        }
        this.where[s] = ci;
        this.local[s] = k;
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.boundingSphere!.radius += PAD;
      mesh.frustumCulled = true;
      this.chunks.push({ mesh, src });
      this.group.add(mesh);
    }
    this.group.position.copy(im.position);
    this.group.quaternion.copy(im.quaternion);
    this.group.scale.copy(im.scale);
  }

  setColorAt(i: number, color: THREE.Color): void {
    this.chunks[this.where[i]].mesh.setColorAt(this.local[i], color);
  }

  colorsChanged(): void {
    for (const ch of this.chunks) if (ch.mesh.instanceColor) ch.mesh.instanceColor.needsUpdate = true;
  }
}

const all: ChunkedInstances[] = [];

/**
 * Replace every InstancedMesh under `root` with at least `min` instances by a chunked copy.
 * `keep` maps meshes the caller holds a reference to → receives their replacement.
 */
export function chunkInstances(root: THREE.Object3D, min = 1500, keep = new Map<THREE.InstancedMesh, (c: ChunkedInstances) => void>()): number {
  const found: THREE.InstancedMesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).count >= min) found.push(o as THREE.InstancedMesh);
  });
  let made = 0;
  for (const im of found) {
    const parent = im.parent;
    if (!parent) continue;
    const ch = new ChunkedInstances(im);
    parent.add(ch.group);
    parent.remove(im);
    im.dispose(); // frees the old instance buffers; geometry + material are shared with the chunks
    keep.get(im)?.(ch);
    all.push(ch);
    made += ch.chunks.length;
  }
  return made;
}

/** Hide chunks entirely past `far` m from the camera (they'd be pure fog colour anyway). */
const cells: THREE.Mesh[] = [];

/**
 * Merged city-wide meshes (all the facade trim of one material, the roofs, the terrain) are a single object
 * a kilometre across: never culled. Re-cut each into spatial cells. The cells share the original vertex
 * buffers (only the index differs), so GPU memory doesn't grow.
 */
export function splitMeshes(root: THREE.Object3D, cell = 96, minRadius = 150, minTris = 4000): number {
  root.updateMatrixWorld(true);
  const found: THREE.Mesh[] = [];
  const visit = (o: THREE.Object3D) => {
    if (o.userData.prop) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && !Array.isArray(m.material) && !m.geometry.groups.length) {
      const g = m.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
      if (g.boundingSphere!.radius >= minRadius && tris >= minTris) found.push(m);
    }
    for (const c of o.children) visit(c);
  };
  visit(root);

  let made = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const mesh of found) {
    const g = mesh.geometry;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const idx = g.index;
    const triCount = (idx ? idx.count : pos.count) / 3;
    const vi = (k: number) => (idx ? idx.getX(k) : k);
    const buckets = new Map<string, number[]>();
    for (let t = 0; t < triCount; t++) {
      const i0 = vi(t * 3), i1 = vi(t * 3 + 1), i2 = vi(t * 3 + 2);
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      const cx = (a.x + b.x + c.x) / 3, cz = (a.z + b.z + c.z) / 3;
      const key = `${Math.floor(cx / cell)},${Math.floor(cz / cell)}`;
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push(i0, i1, i2);
    }
    if (buckets.size < 2) continue;
    const parent = mesh.parent!;
    const box = new THREE.Box3();
    for (const list of buckets.values()) {
      const sub = new THREE.BufferGeometry();
      for (const name in g.attributes) sub.setAttribute(name, g.attributes[name]); // shared, not copied
      sub.setIndex(pos.count > 65535 ? new THREE.Uint32BufferAttribute(list, 1) : new THREE.Uint16BufferAttribute(list, 1));
      // bounds from this cell's triangles only (computeBoundingSphere would scan the whole shared buffer)
      box.makeEmpty();
      for (const i of list) box.expandByPoint(a.fromBufferAttribute(pos, i));
      sub.boundingBox = box.clone();
      sub.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const part = new THREE.Mesh(sub, mesh.material);
      part.name = mesh.name ? `${mesh.name}·cell` : 'cell';
      part.castShadow = mesh.castShadow;
      part.receiveShadow = mesh.receiveShadow;
      part.renderOrder = mesh.renderOrder;
      part.position.copy(mesh.position);
      part.quaternion.copy(mesh.quaternion);
      part.scale.copy(mesh.scale);
      parent.add(part);
      cells.push(part);
      made++;
    }
    parent.remove(mesh); // (not disposed: the cells share its vertex attributes)
  }
  return made;
}

const s = new THREE.Sphere();
export function cullChunks(camPos: THREE.Vector3, far: number): void {
  for (const m of cells) {
    s.copy(m.geometry.boundingSphere!).applyMatrix4(m.matrixWorld);
    m.visible = s.center.distanceTo(camPos) - s.radius < far;
  }
  for (const ch of all) {
    const lim = Math.min(far, ch.maxDist);
    for (const c of ch.chunks) {
      s.copy(c.mesh.boundingSphere!).applyMatrix4(c.mesh.matrixWorld);
      c.mesh.visible = s.center.distanceTo(camPos) - s.radius < lim;
    }
  }
}

/**
 * Every placed Poly Haven prop is its own little scene graph (hundreds of street lamps, hydrants, crates…).
 * Gather the meshes that share a geometry + material into one InstancedMesh each, then chunk those.
 * Only touches objects under a holder marked `userData.prop` and not `userData.noBatch`.
 */
export function instancify(root: THREE.Object3D, min = 6): { merged: number; sets: number } {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map<string, THREE.Mesh[]>();
  const collect = (o: THREE.Object3D) => {
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || Array.isArray(m.material)) return;
      const key = `${m.geometry.uuid}|${(m.material as THREE.Material).uuid}`;
      let list = groups.get(key);
      if (!list) groups.set(key, (list = []));
      list.push(m);
    });
  };
  const holders: THREE.Object3D[] = [];
  const visit = (o: THREE.Object3D) => {
    if (o.userData.prop) {
      if (!o.userData.noBatch) {
        collect(o);
        holders.push(o);
      }
      return;
    }
    for (const c of o.children) visit(c);
  };
  visit(root);

  let merged = 0, sets = 0;
  const m4 = new THREE.Matrix4();
  const scl = new THREE.Vector3();
  for (const list of groups.values()) {
    if (list.length < min) continue;
    const first = list[0];
    const im = new THREE.InstancedMesh(first.geometry, first.material as THREE.Material, list.length);
    im.castShadow = first.castShadow;
    im.receiveShadow = first.receiveShadow;
    let size = 0;
    if (!first.geometry.boundingSphere) first.geometry.computeBoundingSphere();
    list.forEach((mesh, i) => {
      m4.multiplyMatrices(inv, mesh.matrixWorld);
      im.setMatrixAt(i, m4);
      scl.setFromMatrixScale(m4);
      size = Math.max(size, first.geometry.boundingSphere!.radius * Math.max(scl.x, scl.y, scl.z));
      mesh.parent?.remove(mesh);
    });
    im.instanceMatrix.needsUpdate = true;
    const ch = new ChunkedInstances(im, 48);
    ch.maxDist = size < 1 ? 70 : size < 2.5 ? 110 : Infinity; // crates & hydrants < bins & barrels < lamps
    im.dispose();
    root.add(ch.group);
    all.push(ch);
    merged += list.length;
    sets++;
  }
  // drop the prop holders that are now empty shells (thousands of Groups three would otherwise walk every render)
  for (const h of holders) {
    let hasMesh = false;
    h.traverse((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.Light).isLight) hasMesh = true;
    });
    if (!hasMesh) h.removeFromParent();
  }
  return { merged, sets };
}
