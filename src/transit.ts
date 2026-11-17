import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** a flat-shaded, vertex-coloured box centred on (x, y, z) */
export function cube(w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.deleteAttribute('uv');
  g.translate(x, y, z);
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('transit geometry merge failed');
  return g;
}

// ------------------------------------------------------------------------------------------------
// the bus
// ------------------------------------------------------------------------------------------------

export const BUS_LEN = 11.4;
export const BUS_WID = 2.55;

export interface BusParts {
  body: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  lamps: THREE.BufferGeometry; // headlights, destination sign
  tails: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  bodyMat: THREE.MeshToonMaterial;
}
let busParts: BusParts | null = null;

/** A big city bus, nose toward +z: white with a coloured stripe, dark glass band, roof pod. */
export function getBusParts(gradient: THREE.DataTexture): BusParts {
  if (busParts) return busParts;
  const WHITE = 0xeceef1, GREY = 0xc4c8ce, DARK = 0x23262d;
  busParts = {
    body: merge([
      cube(2.55, 2.55, 11.4, 0, 1.83, 0, WHITE),
      cube(2.57, 0.42, 11.0, 0, 1.0, 0, 0x2b5ea7), // stripe
      cube(2.3, 0.2, 10.8, 0, 3.2, 0, GREY), // roof
      cube(1.5, 0.32, 2.6, 0, 3.4, -2.4, 0x9ea3ab), // air-con pod
      cube(2.5, 0.3, 0.18, 0, 0.5, 5.7, DARK), // bumpers
      cube(2.5, 0.3, 0.18, 0, 0.5, -5.7, DARK),
      cube(2.56, 0.5, 11.0, 0, 0.55, 0, DARK), // skirt
    ]),
    glass: merge([
      cube(2.585, 0.95, 8.8, 0, 2.3, -0.9, 0x1f2a36), // side windows
      cube(2.2, 1.1, 0.07, 0, 2.28, 5.72, 0x1f2a36), // windscreen
      cube(2.2, 0.9, 0.07, 0, 2.28, -5.72, 0x1f2a36), // back window
    ]),
    lamps: merge([
      cube(1.5, 0.3, 0.06, 0, 3.0, 5.72, 0xffb030), // destination sign
      cube(0.34, 0.2, 0.06, -0.9, 0.9, 5.73, 0xfff6cf),
      cube(0.34, 0.2, 0.06, 0.9, 0.9, 5.73, 0xfff6cf),
    ]),
    tails: merge([cube(0.3, 0.2, 0.06, -0.95, 0.95, -5.73, 0xff3a2a), cube(0.3, 0.2, 0.06, 0.95, 0.95, -5.73, 0xff3a2a)]),
    wheel: new THREE.CylinderGeometry(0.5, 0.5, 0.3, 14).rotateZ(Math.PI / 2),
    bodyMat: new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradient, vertexColors: true }),
  };
  return busParts;
}

// ------------------------------------------------------------------------------------------------
// bus stops
// ------------------------------------------------------------------------------------------------

/** A glass shelter with a bench, and a blue stop sign on a pole. Local +z faces the road. */
function shelterGeo(): THREE.BufferGeometry {
  const FRAME = 0x2f3d46;
  const parts: THREE.BufferGeometry[] = [
    cube(5.4, 0.6, 3.0, 0.4, -0.3, 0.05, 0xa8a49c), // concrete pad (instance is raised 8 cm so its top sits above the grass)
    cube(5.4, 0.012, 0.22, 0.4, 0.006, 1.42, 0xd9b43a), // yellow edge strip toward the road
    cube(3.2, 0.12, 1.7, 0, 2.5, 0, 0x3f4f58), // roof
    cube(3.1, 1.9, 0.05, 0, 1.45, -0.78, 0x9cc4d0), // glass back
    cube(0.05, 1.9, 1.5, -1.52, 1.45, 0, 0x9cc4d0), // glass side
    cube(1.8, 0.07, 0.38, 0, 0.55, -0.5, 0x9a6b3f), // bench
    cube(0.07, 0.55, 0.07, -0.75, 0.27, -0.5, FRAME),
    cube(0.07, 0.55, 0.07, 0.75, 0.27, -0.5, FRAME),
    cube(0.45, 1.3, 0.04, 1.35, 1.35, -0.74, 0xd9534f), // route ad panel
    // sign pole
    cube(0.07, 2.7, 0.07, 2.05, 1.35, 0.7, FRAME),
    cube(0.55, 0.45, 0.05, 2.05, 2.6, 0.7, 0x2b5ea7),
    cube(0.3, 0.2, 0.06, 2.05, 2.6, 0.72, 0xf4f1e6),
  ];
  for (const x of [-1.52, 1.52]) for (const z of [0.7, -0.78]) parts.push(cube(0.07, 2.5, 0.07, x, 1.25, z, FRAME));
  return merge(parts);
}

export interface StopSpot { x: number; z: number; /** unit vector pointing from the stop out toward the road */ fx: number; fz: number }

/** Instanced shelters at the given curbside spots. `ground(x, z)` gives the walking surface height. */
export function buildBusStops(spots: StopSpot[], ground: (x: number, z: number) => number, gradient: THREE.DataTexture): THREE.Group {
  const group = new THREE.Group();
  if (!spots.length) return group;
  const mat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradient, vertexColors: true });
  const mesh = new THREE.InstancedMesh(shelterGeo(), mat, spots.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  spots.forEach((s, i) => {
    q.setFromAxisAngle(up, Math.atan2(s.fx, s.fz));
    mesh.setMatrixAt(i, m.compose(new THREE.Vector3(s.x, ground(s.x, s.z) + 0.08, s.z), q, new THREE.Vector3(1, 1, 1)));
  });
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  group.add(mesh);
  return group;
}
