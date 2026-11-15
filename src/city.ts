import * as THREE from 'three';
import { buildPowerLines } from './powerlines';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Stadium } from './wrigley';
import { CityCollider, inPoly, makePoly, type Poly } from './citycollider';
import { FacadeKit, loadStyled } from './facade';
import { SHOP_NAMES } from './paint';
import type { Box } from './physics';
import { PolyNet } from './polynet';
import { Props, propBox, PROP_SIZE } from './props';
import { TrafficSignals } from './signals';
import { TOTAL_CHEESE, type Cheese, type Pipe, type World } from './world';

// ------------------------------------------------------------------------------------------------
// data (baked by scripts/bake.mjs)
// ------------------------------------------------------------------------------------------------

type P2 = [number, number];
export interface CityData {
  name: string;
  center: [number, number];
  scale: number;
  extent: number;
  bounds: { x0: number; x1: number; z0: number; z1: number };
  lakeIdx: number; // index into `water` of the open lake (-1 = none)
  osmCopyright: string;
  heights: { nx: number; nz: number; step: number; min: number; data: number[] };
  roads: { k: string; n: string; w: number; o: number; br: number; tu: number; sw: string; f: string; p: P2[] }[];
  buildings: { t: string; l: number; h: number; n: string; a: number; p: P2[] }[];
  rails: { k: string; el: number; p: P2[] }[];
  parks: { k: string; p: P2[] }[];
  water: P2[][];
  signals: P2[];
  crossings: P2[];
  lamps: P2[];
  trees: P2[];
  hydrants: P2[];
  benches: P2[];
  bins: P2[];
  shops: { p: P2; name: string; kind: string }[];
}

export async function loadCity(name: string): Promise<CityData> {
  const res = await fetch(`/city/${name}.json`);
  if (!res.ok) throw new Error(`no baked city ${name}`);
  return res.json();
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------------
// terrain
// ------------------------------------------------------------------------------------------------

class Terrain {
  private h: Float32Array;
  readonly nx: number;
  readonly nz: number;
  readonly step: number;
  readonly x0: number;
  readonly z0: number;
  constructor(d: CityData, exag: number) {
    this.nx = d.heights.nx;
    this.nz = d.heights.nz;
    this.step = d.heights.step;
    this.x0 = d.bounds.x0;
    this.z0 = d.bounds.z0;
    this.h = Float32Array.from(d.heights.data, (v) => (v / 100) * exag);
  }
  at(x: number, z: number): number {
    const fx = Math.max(0, Math.min(this.nx - 1.001, (x - this.x0) / this.step));
    const fz = Math.max(0, Math.min(this.nz - 1.001, (z - this.z0) / this.step));
    const i = Math.floor(fx), j = Math.floor(fz);
    const ax = fx - i, az = fz - j;
    const n = this.nx;
    const a = this.h[j * n + i], b = this.h[j * n + i + 1], c = this.h[(j + 1) * n + i], d = this.h[(j + 1) * n + i + 1];
    return (a * (1 - ax) + b * ax) * (1 - az) + (c * (1 - ax) + d * ax) * az;
  }
}

// ------------------------------------------------------------------------------------------------
// geometry helpers
// ------------------------------------------------------------------------------------------------

class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  /** A quad a,b,c,d (loop order); wound to face `want`. */
  quad(a: number[], b: number[], c: number[], d: number[], uvs: number[][], want: number[]): void {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const flip = n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0;
    const v = flip ? [a, d, c, b] : [a, b, c, d];
    const u = flip ? [uvs[0], uvs[3], uvs[2], uvs[1]] : uvs;
    const base = this.pos.length / 3;
    v.forEach((p, i) => {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(want[0], want[1], want[2]);
      this.uv.push(u[i][0], u[i][1]);
    });
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    return g;
  }
}

function resample(pts: P2[], step: number): P2[] {
  const out: P2[] = [pts[0]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** left/right offset points for a polyline with mitred joins */
function sides(pts: P2[], width: number): { l: P2; r: P2 }[] {
  const out: { l: P2; r: P2 }[] = [];
  const h = width / 2;
  const seg = (i: number): P2 => {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]; // left normal
  };
  for (let i = 0; i < pts.length; i++) {
    const n0 = seg(Math.max(0, i - 1)), n1 = seg(Math.min(pts.length - 2, i));
    let nx = n0[0] + n1[0], nz = n0[1] + n1[1];
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    const miter = Math.min(1.8, 1 / Math.max(0.5, nx * n1[0] + nz * n1[1]));
    out.push({ l: [pts[i][0] + nx * h * miter, pts[i][1] + nz * h * miter], r: [pts[i][0] - nx * h * miter, pts[i][1] - nz * h * miter] });
  }
  return out;
}

/** A flat ribbon along a polyline, hugging the terrain. With `rise` it becomes a curbed slab with side skirts. */
function ribbon(pts: P2[], width: number, terrain: Terrain, lift: number, tile: number, rise = 0): THREE.BufferGeometry {
  const p = resample(pts, 6);
  const s = sides(p, width);
  const mb = new MeshBuilder();
  let dist = 0;
  const up = [0, 1, 0];
  for (let i = 0; i + 1 < p.length; i++) {
    const seg = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
    const y = (q: P2) => terrain.at(q[0], q[1]) + lift + rise;
    const L0 = [s[i].l[0], y(s[i].l), s[i].l[1]], R0 = [s[i].r[0], y(s[i].r), s[i].r[1]];
    const L1 = [s[i + 1].l[0], y(s[i + 1].l), s[i + 1].l[1]], R1 = [s[i + 1].r[0], y(s[i + 1].r), s[i + 1].r[1]];
    const u0 = dist / tile, u1 = (dist + seg) / tile, v1 = width / tile;
    mb.quad(L0, R0, R1, L1, [[u0, 0], [u0, v1], [u1, v1], [u1, 0]], up);
    if (rise > 0) {
      const bot = (q: P2) => terrain.at(q[0], q[1]) + lift - 0.02;
      const lb0 = [L0[0], bot(s[i].l), L0[2]], lb1 = [L1[0], bot(s[i + 1].l), L1[2]];
      const rb0 = [R0[0], bot(s[i].r), R0[2]], rb1 = [R1[0], bot(s[i + 1].r), R1[2]];
      const nl = [-(p[i + 1][1] - p[i][1]), 0, p[i + 1][0] - p[i][0]];
      const nn = Math.hypot(nl[0], nl[2]) || 1;
      const left = [nl[0] / nn, 0, nl[2] / nn], right = [-left[0], 0, -left[2]];
      mb.quad(L0, L1, lb1, lb0, [[0, 0], [1, 0], [1, 1], [0, 1]], left);
      mb.quad(R0, R1, rb1, rb0, [[0, 0], [1, 0], [1, 1], [0, 1]], right);
    }
    dist += seg;
  }
  return mb.build();
}

/**
 * Hide texture repetition: blend the map with a rotated, larger-scale copy of itself through a slow
 * noise, and push the brightness around in broad patches.
 */
function breakTiling(m: THREE.MeshToonMaterial): void {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <map_fragment>',
      `
      vec2 tuv = vMapUv;
      float lo = 0.5 + 0.5 * sin(tuv.x * 0.11 + sin(tuv.y * 0.09) * 2.0) * sin(tuv.y * 0.13 + sin(tuv.x * 0.07) * 1.7);
      float lo2 = 0.5 + 0.5 * sin(tuv.x * 0.31 + 1.7) * sin(tuv.y * 0.27 - 0.6);
      vec2 ruv = mat2(0.8, 0.6, -0.6, 0.8) * tuv * 0.41 + vec2(0.37, 0.19);
      vec4 sa = texture2D(map, tuv);
      vec4 sb = texture2D(map, ruv);
      vec4 sampledDiffuseColor = mix(sa, sb, smoothstep(0.25, 0.75, lo));
      sampledDiffuseColor.rgb *= 0.88 + 0.24 * lo2;
      diffuseColor *= sampledDiffuseColor;
      `,
    );
  };
  m.customProgramCacheKey = () => 'breakTiling';
}

const windCCW = (pts: P2[]): P2[] => (polyArea(pts) < 0 ? [...pts].reverse() : pts);

function polyArea(pts: P2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function flatPoly(pts: P2[], terrain: Terrain, lift: number, uvTile = 5): THREE.BufferGeometry {
  const tris = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p[0], p[1])), []);
  const pos: number[] = [];
  for (const p of pts) pos.push(p[0], terrain.at(p[0], p[1]) + lift, p[1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pts.flatMap(() => [0, 1, 0]), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p[0] / uvTile, p[1] / uvTile]), 2));
  g.setIndex(tris.flatMap((t) => [t[0], t[2], t[1]]));
  return g;
}

// ------------------------------------------------------------------------------------------------
// segment index (nearest road queries)
// ------------------------------------------------------------------------------------------------

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  half: number;
  alley: boolean;
}
class SegIndex {
  private cell = 24;
  private grid = new Map<number, Seg[]>();
  add(s: Seg): void {
    const x0 = Math.min(s.ax, s.bx) - s.half - 14, x1 = Math.max(s.ax, s.bx) + s.half + 14;
    const z0 = Math.min(s.az, s.bz) - s.half - 14, z1 = Math.max(s.az, s.bz) + s.half + 14;
    for (let ix = Math.floor(x0 / this.cell); ix <= Math.floor(x1 / this.cell); ix++) {
      for (let iz = Math.floor(z0 / this.cell); iz <= Math.floor(z1 / this.cell); iz++) {
        const k = ix * 100003 + iz;
        let l = this.grid.get(k);
        if (!l) this.grid.set(k, (l = []));
        l.push(s);
      }
    }
  }
  /** nearest road surface edge to (x, z): distance from the kerb and the direction toward it */
  nearest(x: number, z: number, alley: boolean): { d: number; dx: number; dz: number } | null {
    const l = this.grid.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell));
    if (!l) return null;
    let best: { d: number; dx: number; dz: number } | null = null;
    for (const s of l) {
      if (s.alley !== alley) continue;
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      const cx = s.ax + dx * t, cz = s.az + dz * t;
      const d = Math.hypot(x - cx, z - cz);
      const kerb = d - s.half;
      if (!best || kerb < best.d) best = { d: kerb, dx: (cx - x) / (d || 1), dz: (cz - z) / (d || 1) };
    }
    return best;
  }
}

// ------------------------------------------------------------------------------------------------
// the city
// ------------------------------------------------------------------------------------------------

const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'busway', 'alley']);
const WALKABLE = new Set(['footway', 'pedestrian', 'path', 'cycleway']);
const STYLES = [0, 0, 0, 1, 1, 2, 3, 3, 4, 5, 5];
const LEAVES = [0x4f8a3c, 0x6a9a3a, 0x86a83c, 0xd98a2b, 0xc8452a, 0xe0b13a];
const GRASSY = new Set(['park', 'garden', 'grass', 'village_green', 'recreation_ground', 'dog_park', 'scrub', 'cemetery', 'wood', 'forest']);
const PARK_COLOR: Record<string, number> = {
  park: 0x78a85c, garden: 0x78a85c, grass: 0x78a85c, village_green: 0x78a85c, recreation_ground: 0x84ad62, dog_park: 0x8cae5e,
  pitch: 0xc9a46a, track: 0xb07a5a, playground: 0xcf9a5a, stadium: 0x9aa39a, sports_centre: 0x9aa39a, cemetery: 0x7aa068,
  wood: 0x4f8a4a, forest: 0x4f8a4a, scrub: 0x6a9a4a, beach: 0xe3d3a2,
};

export function buildCity(data: CityData, gradient: THREE.DataTexture, opts: { exag: number }): World {
  const rand = rng(20240607);
  const terrain = new Terrain(data, opts.exag);
  // Wrigley Field is built by hand: drop the stray OSM pieces (dugouts, screens, the grandstand roof outline) inside it
  const stadium = new Stadium((x, z) => terrain.at(x, z));
  data.buildings = data.buildings.filter((b) => {
    const cx = b.p.reduce((a, q) => a + q[0], 0) / b.p.length, cz = b.p.reduce((a, q) => a + q[1], 0) / b.p.length;
    return !stadium.inside(cx, cz);
  });
  const group = new THREE.Group();
  const ext = data.extent;
  const B = data.bounds;
  /** true if (x, z) is within `m` of the edge of the baked area */
  const nearEdge = (x: number, z: number, m: number) => x < B.x0 + m || x > B.x1 - m || z < B.z0 + m || z > B.z1 - m;
  const toon = (c: number, map?: THREE.Texture) => new THREE.MeshToonMaterial({ color: c, gradientMap: gradient, map: map ?? null });
  const shadowed = <T extends THREE.Mesh>(m: T, cast = false): T => {
    m.castShadow = cast;
    m.receiveShadow = true;
    return m;
  };

  const grass = loadStyled('/textures/aerial_grass_rock_diff_1k.jpg', { size: 1024, levels: 7, contrast: 1.1, sat: 0.8, blur: 0.9, recolor: 0x93c765, gain: 1.35 });

  // ---- terrain ----
  {
    const nx = terrain.nx, nz = terrain.nz, step = terrain.step;
    const pos: number[] = [], col: number[] = [], idx: number[] = [], nor: number[] = [];
    const base = new THREE.Color(0xffffff), alt = new THREE.Color(0xd6e0c2), c = new THREE.Color();
    const uvs: number[] = [];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = B.x0 + i * step, z = B.z0 + j * step;
        pos.push(x, terrain.at(x, z), z);
        const t = (Math.sin(i * 0.9) * Math.cos(j * 1.3) + Math.sin(i * 0.31 + j * 0.47)) * 0.25 + 0.5;
        c.copy(base).lerp(alt, t);
        col.push(c.r, c.g, c.b);
        nor.push(0, 1, 0);
        uvs.push(x / 5, z / 5);
      }
    }
    for (let j = 0; j + 1 < nz; j++) for (let i = 0; i + 1 < nx; i++) {
      const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const terrainMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradient, map: grass });
    breakTiling(terrainMat);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    group.add(shadowed(new THREE.Mesh(g, terrainMat)));
  }

  // ---- water: Lake Michigan and the harbours ----
  // the baked terrain is flat under the lake, so a plane just above that level fills every basin and the shore shows where land climbs through it
  const waterPolys: { pts: P2[]; minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  const lake = { y: 0, shoreX: null as number | null };
  {
    lake.y = terrain.at(B.x1 - 20, 0) + 0.12;
    const waterMat = new THREE.MeshToonMaterial({ color: 0x4d86b6, gradientMap: gradient, side: THREE.DoubleSide });
    data.water.forEach((pts, wi) => {
      if (pts.length < 3) return;
      const xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]);
      waterPolys.push({ pts, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) });
      const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map((q) => new THREE.Vector2(q[0], q[1]))));
      g.rotateX(Math.PI / 2); // (x, y, 0) -> (x, 0, y)
      const mesh = new THREE.Mesh(g, waterMat);
      mesh.position.y = wi === data.lakeIdx ? lake.y : terrain.at(pts[0][0], pts[0][1]) + 0.12;
      mesh.receiveShadow = true;
      group.add(mesh);
      if (wi === data.lakeIdx) lake.shoreX = Math.min(...pts.filter((q) => q[0] < B.x1).map((q) => q[0]));
    });
  }
  const inWater = (x: number, z: number): boolean => {
    for (const w of waterPolys) if (x > w.minX && x < w.maxX && z > w.minZ && z < w.maxZ && inPoly(w.pts, x, z)) return true;
    return false;
  };

  // ---- materials ----
  const asphalt = loadStyled('/textures/asphalt_02_diff_1k.jpg', { levels: 9, contrast: 0.25, sat: 0, blur: 4, recolor: 0x7e7e9a, gain: 1.25 });
  const pavement = loadStyled('/textures/concrete_tiles_02_diff_1k.jpg', { size: 1024, levels: 7, contrast: 1.4, sat: 0.5, blur: 0.5, recolor: 0xd9d2c6, gain: 1.3 });
  const grassMat = toon(0xffffff, grass);
  breakTiling(grassMat);
  const roadMat = toon(0xffffff, asphalt);
  const walkMat = toon(0xffffff, pavement);
  for (const m of [roadMat, walkMat]) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -1;
  }

  // ---- roads, sidewalks, alleys ----
  const segs = new SegIndex();
  const roadGeos: THREE.BufferGeometry[] = [];
  const walkGeos: THREE.BufferGeometry[] = [];
  const dashes: THREE.Matrix4[] = [];
  const catRoutes: THREE.Vector2[][] = [];
  const footways: { pts: P2[]; crossing: boolean }[] = [];
  const slabs: { pts: P2[]; half: number }[] = [];
  const streetLines: { pts: P2[]; half: number; name: string }[] = [];
  const alleyLines: { pts: P2[]; half: number }[] = [];
  const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  const zebras: THREE.Matrix4[] = [];

  for (const r of data.roads) {
    if (r.tu) continue;
    const alley = r.k === 'alley';
    if (DRIVABLE.has(r.k)) {
      roadGeos.push(ribbon(r.p, r.w, terrain, 0.06, 8));
      for (let i = 0; i + 1 < r.p.length; i++) segs.add({ ax: r.p[i][0], az: r.p[i][1], bx: r.p[i + 1][0], bz: r.p[i + 1][1], half: r.w / 2, alley });
      if (alley) alleyLines.push({ pts: r.p, half: r.w / 2 });
      else streetLines.push({ pts: r.p, half: r.w / 2, name: r.n });
      // dashed centre line on two-way streets
      if (!alley && r.w >= 11 && !r.o && r.k !== 'service') {
        const rs = resample(r.p, 1);
        let acc = 0;
        for (let i = 1; i < rs.length; i++) {
          const dx = rs[i][0] - rs[i - 1][0], dz = rs[i][1] - rs[i - 1][1];
          acc += 1;
          if (acc % 8 < 3) {
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, -Math.atan2(dz, dx)));
            dashes.push(new THREE.Matrix4().compose(new THREE.Vector3(rs[i][0], terrain.at(rs[i][0], rs[i][1]) + 0.1, rs[i][1]), q, new THREE.Vector3(1, 1, 1)));
          }
        }
      }
    } else if (WALKABLE.has(r.k)) {
      if (r.f === 'crossing') {
        footways.push({ pts: r.p, crossing: true });
        // zebra bars across the street, long axis along the street
        const a = r.p[0], b = r.p[r.p.length - 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L > 4) {
          const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, -Math.atan2(dz, dx)));
          for (let s = 1.2; s < L - 1.0; s += 1.15) {
            const x = a[0] + dx * s, z = a[1] + dz * s;
            zebras.push(new THREE.Matrix4().compose(new THREE.Vector3(x, terrain.at(x, z) + 0.1, z), q, new THREE.Vector3(1, 1, 1)));
          }
        }
      } else {
        footways.push({ pts: r.p, crossing: false });
        walkGeos.push(ribbon(r.p, Math.max(r.w, 3.0), terrain, 0.0, 4, 0.16));
        slabs.push({ pts: r.p, half: Math.max(r.w, 3.0) / 2 });
      }
    }
  }
  if (roadGeos.length) group.add(shadowed(new THREE.Mesh(mergeGeometries(roadGeos, false)!, roadMat)));
  if (walkGeos.length) group.add(shadowed(new THREE.Mesh(mergeGeometries(walkGeos, false)!, walkMat)));
  {
    const mk = (geo: THREE.BufferGeometry, color: number, xf: THREE.Matrix4[]) => {
      if (!xf.length) return;
      const m = toon(color);
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      m.polygonOffsetUnits = -2;
      const im = new THREE.InstancedMesh(geo, m, xf.length);
      xf.forEach((x, i) => im.setMatrixAt(i, x));
      im.receiveShadow = true;
      group.add(im);
    };
    mk(new THREE.PlaneGeometry(2.4, 0.2), 0xe6d9a8, dashes);
    mk(new THREE.PlaneGeometry(0.55, 3.2), 0xf2eee0, zebras);
  }
  void flat;

  // ---- parks and pitches ----
  for (const p of data.parks) {
    if (p.p.length < 3 || !PARK_COLOR[p.k]) continue;
    const pts = polyArea(p.p) < 0 ? [...p.p].reverse() : p.p;
    group.add(shadowed(new THREE.Mesh(flatPoly(pts, terrain, 0.04), GRASSY.has(p.k) ? grassMat : toon(PARK_COLOR[p.k]))));
  }

  // ---- buildings ----
  const kit = new FacadeKit(gradient, rand);
  group.add(kit.group);
  const polys: Poly[] = [];
  const pipes: Pipe[] = [];
  const edgeIndex = new Map<number, { a: P2; b: P2; owner: number }[]>();
  const ek = (x: number, z: number) => Math.floor(x / 8) * 100003 + Math.floor(z / 8);
  const rings: P2[][] = data.buildings.map((b) => (polyArea(b.p) < 0 ? [...b.p].reverse() : b.p));
  rings.forEach((p, bi) => {
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const k = ek(mx, mz);
      let l = edgeIndex.get(k);
      if (!l) edgeIndex.set(k, (l = []));
      l.push({ a, b, owner: bi });
    }
  });
  const usedShops = new Set<number>();
  const buildingFootprints: P2[][] = [];

  data.buildings.forEach((b, bi) => {
    const pts = rings[bi];
    if (pts.length < 3) return;
    const n = pts.length;
    let baseY = Infinity;
    for (const p of pts) baseY = Math.min(baseY, terrain.at(p[0], p[1]));
    const street: boolean[] = [], alley: boolean[] = [], party: boolean[] = [], shopName: (string | null)[] = [];
    let shopHere = false;
    for (let i = 0; i < n; i++) {
      const a = pts[i], c = pts[(i + 1) % n];
      const dx = c[0] - a[0], dz = c[1] - a[1], L = Math.hypot(dx, dz) || 1;
      const nx = dz / L, nz = -dx / L, mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
      const s = L >= 4.5 ? segs.nearest(mx + nx * 0.3, mz + nz * 0.3, false) : null;
      const al = L >= 4.5 ? segs.nearest(mx + nx * 0.3, mz + nz * 0.3, true) : null;
      const isAlley = !!al && al.d < 7 && al.dx * nx + al.dz * nz > 0.3;
      const isStreet = !isAlley && !!s && s.d < 16 && s.dx * nx + s.dz * nz > 0.3;
      alley.push(isAlley);
      street.push(isStreet);
      // shared wall with a neighbour?
      let shared = false;
      for (let ox = -1; ox <= 1 && !shared; ox++) {
        for (let oz = -1; oz <= 1 && !shared; oz++) {
          const l = edgeIndex.get(ek(mx + ox * 8, mz + oz * 8));
          if (!l) continue;
          for (const e of l) {
            if (e.owner === bi) continue;
            const ex = e.b[0] - e.a[0], ez = e.b[1] - e.a[1], el = Math.hypot(ex, ez) || 1;
            if ((ez / el) * nx + (-ex / el) * nz > -0.8) continue; // not facing us
            const t = Math.max(0, Math.min(1, ((mx - e.a[0]) * ex + (mz - e.a[1]) * ez) / (el * el)));
            if (Math.hypot(mx - (e.a[0] + ex * t), mz - (e.a[1] + ez * t)) < 0.9) shared = true;
          }
        }
      }
      party.push(shared);
      // a named shop whose pin is near this street face gives the sign its name
      let name: string | null = null;
      if (isStreet) {
        let bestD = 18;
        data.shops.forEach((sh, si) => {
          const d = Math.hypot(sh.p[0] - mx, sh.p[1] - mz);
          if (d < bestD && sh.name && !usedShops.has(si)) {
            bestD = d;
            name = sh.name;
            usedShops.add(si);
          }
        });
        if (name) shopHere = true;
      }
      shopName.push(name);
    }

    // storeys: mapped level count, else a guess by type and size (Chicago: lots of two- and three-flats)
    let floors = b.l > 0 ? Math.round(b.l) : b.h > 0 ? Math.max(1, Math.round((b.h - 2) / 4)) : 0;
    const low = /^(garage|garages|shed|carport|roof|hut|service|kiosk)$/.test(b.t);
    if (!floors) floors = low ? 1 : /^(apartments|residential)$/.test(b.t) ? 3 : /^(retail|commercial|office)$/.test(b.t) ? 2 : b.a > 300 ? 3 : 2;
    floors = Math.min(floors, 14);
    const commercial = /^(retail|commercial|office|supermarket)$/.test(b.t) || shopHere;
    const ground: 'shop' | 'res' = commercial && floors >= 1 && !low ? 'shop' : 'res';
    const r = kit.addPoly({
      pts,
      baseY,
      floors: low ? 0 : floors,
      ground,
      style: STYLES[Math.floor(rand() * STYLES.length)],
      plinth: Math.floor(rand() * 4),
      street,
      alley,
      party,
      shopName,
      seed: bi * 7919 + 13,
    });
    polys.push(makePoly(pts, r.roofY));
    buildingFootprints.push(pts);
    pipes.push(...r.pipes);
    for (const pp of r.pipes) {
      const pipe = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, r.roofY - baseY, 8), toon(0x5a5f6a)), true);
      pipe.position.set(pp.x, (r.roofY + baseY) / 2, pp.z);
      group.add(pipe);
    }
  });
  const windows = kit.finish();
  // pipes were recorded with absolute roof heights already

  const inBuilding = (x: number, z: number): boolean => {
    if (stadium.inside(x, z) || inWater(x, z)) return true; // water counts as solid for placing things
    for (const p of polys) if (x > p.minX && x < p.maxX && z > p.minZ && z < p.maxZ && inPoly(p.pts, x, z)) return true;
    return false;
  };

  // ---- the collider ----
  const collider = new CityCollider((x, z) => stadium.y(x, z) ?? terrain.at(x, z), polys, { x0: B.x0 + 8, x1: B.x1 - 8, z0: B.z0 + 8, z1: B.z1 - 8 });
  collider.setWalkways(slabs, 0.16);
  for (const w of waterPolys) collider.addPoly(makePoly(windCCW(w.pts), lake.y + 2.2)); // too tall to climb: the rat can't swim
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfff1b0 });
  const wrig = stadium.build({ group, gradient, bulbMat, terrainAt: (x, z) => terrain.at(x, z), addPoly: (p) => collider.addPoly(p), addBox: (b) => collider.addBox(b) });
  pipes.push(...wrig.pipes);
  const props = new Props(gradient, bulbMat);
  const solid = (id: string, x: number, z: number, scale: number, rotY: number): Box | null => {
    if (inBuilding(x, z)) return null;
    const y0 = terrain.at(x, z) + 0.05;
    props.place(group, id, { x, y: y0, z, rotY, scale });
    // axis-aligned bounds of the rotated footprint
    const [sx, sy, sz] = PROP_SIZE[id];
    const c = Math.abs(Math.cos(rotY)), s = Math.abs(Math.sin(rotY));
    const hx = ((sx * c + sz * s) * scale) / 2, hz = ((sx * s + sz * c) * scale) / 2;
    const b: Box = { minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, top: y0 + sy * scale };
    collider.addBox(b);
    return b;
  };
  void propBox;

  // ---- alley clutter + cat patrols ----
  const dumpMat = toon(0x2f6b4a);
  const cheeseSpots: [number, number, number][] = [];
  const along = (pts: P2[], step: number, fn: (x: number, z: number, tx: number, tz: number, i: number) => void) => {
    let carry = step * 0.5, i = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const tx = (b[0] - a[0]) / (L || 1), tz = (b[1] - a[1]) / (L || 1);
      while (carry < L) {
        fn(a[0] + tx * carry, a[1] + tz * carry, tx, tz, i++);
        carry += step;
      }
      carry -= L;
    }
  };
  for (const al of alleyLines) {
    const len = al.pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - al.pts[i - 1][0], p[1] - al.pts[i - 1][1]) : 0), 0);
    if (len > 25) {
      const r = al.pts.map((p) => new THREE.Vector2(p[0], p[1]));
      catRoutes.push([...r, ...r.slice(1, -1).reverse()]);
    }
    along(al.pts, 13, (x, z, tx, tz, i) => {
      const side = i % 2 ? 1 : -1;
      const off = Math.max(0.9, al.half - 1.0);
      const px = x - tz * off * side, pz = z + tx * off * side;
      const ang = Math.atan2(tx, tz);
      const kind = i % 4;
      if (kind === 0) {
        // dumpster (primitive)
        if (inBuilding(px, pz)) return;
        const y0 = terrain.at(px, pz) + 0.05;
        const d = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.1, 2.2), dumpMat), true);
        d.position.set(px, y0 + 0.55, pz);
        d.rotation.y = ang;
        group.add(d);
        const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang));
        const hx = (1.4 * c + 2.2 * s) / 2, hz = (1.4 * s + 2.2 * c) / 2;
        collider.addBox({ minX: px - hx, maxX: px + hx, minZ: pz - hz, maxZ: pz + hz, top: y0 + 1.1 });
        cheeseSpots.push([px, y0 + 1.1, pz]);
      } else if (kind === 1) {
        const lower = solid('wooden_crate_01', px, pz, 1.3, ang);
        if (lower) {
          const top = solid('plastic_crate_01', px, pz, 1.5, ang);
          void top;
          cheeseSpots.push([px, lower.top + 0.4, pz]);
        }
      } else if (kind === 2) solid('Barrel_01', px, pz, 1.3, 0);
      else solid(i % 8 === 3 ? 'cardboard_box_01' : 'metal_trash_can', px, pz, 1.2, ang);
    });
  }

  // ---- street furniture: lamps, hydrants, trees (in the grass strip between kerb and sidewalk) ----
  const lamps: THREE.Vector3[] = [];
  const treeSpots: { x: number; z: number; s: number; c: number }[] = [];
  const forests: P2[][] = [];
  for (const st of streetLines) {
    if (!st.name) continue;
    const half = st.half + 1.3;
    let lampSide = 1;
    along(st.pts, 44, (x, z, tx, tz, i) => {
      const side = i % 2 ? 1 : -1;
      const nx = -tz * side, nz = tx * side;
      const lx = x + nx * half, lz = z + nz * half;
      if (inBuilding(lx, lz) || nearEdge(lx, lz, 12)) return;
      lampSide = -lampSide;
      const lamp = new THREE.Vector3(lx, terrain.at(lx, lz) + 5.3, lz);
      lamps.push(lamp);
      props.place(group, 'street_lamp_01', {
        x: lx, y: terrain.at(lx, lz), z: lz, rotY: Math.atan2(nz, -nx), scale: 1.4,
        onLoad: (root) => {
          root.updateWorldMatrix(true, true);
          root.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh && m.material === bulbMat) lamp.copy(new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()));
          });
        },
      });
    });
    along(st.pts, 55, (x, z, tx, tz, i) => {
      const nx = -tz * (i % 2 ? 1 : -1), nz = tx * (i % 2 ? 1 : -1);
      solid('fire_hydrant', x + nx * (half + 0.4), z + nz * (half + 0.4), 1.3, 0);
    });
    along(st.pts, 11, (x, z, tx, tz, i) => {
      if (rand() < 0.3) return;
      const side = i % 2 ? 1 : -1;
      const nx = -tz * side, nz = tx * side;
      const px = x + nx * (half + 0.2), pz = z + nz * (half + 0.2);
      if (inBuilding(px, pz) || nearEdge(px, pz, 12)) return;
      treeSpots.push({ x: px, z: pz, s: 0.8 + rand() * 0.6, c: LEAVES[Math.floor(rand() * LEAVES.length)] });
    });
  }
  const powerLines = buildPowerLines({ streets: streetLines, terrainAt: (x, z) => terrain.at(x, z), blocked: inBuilding, addBox: (b) => collider.addBox(b), gradient, nearEdge, rand });
  group.add(powerLines.group);
  for (const p of data.parks) {
    if (!/^(park|garden|grass|village_green|recreation_ground|dog_park|wood|forest|scrub)$/.test(p.k) || p.p.length < 3) continue;
    const pts = p.p;
    const xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const area = Math.abs(polyArea(pts));
    if (area < 1000 && !/^(wood|forest)$/.test(p.k)) {
      // small green: a few trees
      const count = Math.min(40, Math.floor(area / 160));
      for (let k = 0; k < count * 3 && treeSpots.length < 6000; k++) {
        const x = minX + rand() * (maxX - minX), z = minZ + rand() * (maxZ - minZ);
        if (inPoly(pts, x, z) && !inBuilding(x, z)) treeSpots.push({ x, z, s: 0.8 + rand() * 0.7, c: LEAVES[Math.floor(rand() * LEAVES.length)] });
      }
      continue;
    }
    // big green space: a forest. Jittered grid keeps trees spaced but irregular; paths stay clear.
    forests.push(pts);
    const step = 4.2;
    for (let gx = minX; gx < maxX; gx += step) {
      for (let gz = minZ; gz < maxZ; gz += step) {
        const x = gx + (rand() - 0.5) * step * 0.9, z = gz + (rand() - 0.5) * step * 0.9;
        if (treeSpots.length >= 6000 || !inPoly(pts, x, z) || inBuilding(x, z) || collider.slab(x, z) > 0) continue;
        treeSpots.push({ x, z, s: 0.9 + rand() * 0.9, c: LEAVES[Math.floor(rand() * LEAVES.length)] });
      }
    }
  }
  if (treeSpots.length) {
    const crownGeo = new THREE.IcosahedronGeometry(1.7, 1);
    const trunkGeo = new THREE.CylinderGeometry(0.2, 0.3, 2.6, 6);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradient }), treeSpots.length);
    const trunks = new THREE.InstancedMesh(trunkGeo, toon(0x5a4030), treeSpots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), color = new THREE.Color();
    treeSpots.forEach((t, i) => {
      const y = terrain.at(t.x, t.z);
      q.setFromEuler(new THREE.Euler(0, rand() * 6, 0));
      m.compose(new THREE.Vector3(t.x, y + 1.3 * t.s, t.z), q, new THREE.Vector3(t.s, t.s, t.s));
      trunks.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(t.x, y + 4.0 * t.s, t.z), q, new THREE.Vector3(t.s * 1.05, t.s * (0.9 + rand() * 0.3), t.s * 1.05));
      crowns.setMatrixAt(i, m);
      crowns.setColorAt(i, color.setHex(t.c));
      collider.addBox({ minX: t.x - 0.3, maxX: t.x + 0.3, minZ: t.z - 0.3, maxZ: t.z + 0.3, top: y + 2.6 * t.s });
    });
    crowns.castShadow = trunks.castShadow = true;
    crowns.receiveShadow = true;
    group.add(crowns, trunks);
  }

  // ---- ground cover: grass tufts, flowers and bushes in the green spaces ----
  const windUniform = { value: 0 };
  {
    const tufts: { x: number; z: number; s: number; c: number }[] = [];
    const flowers: { x: number; z: number; s: number; c: number }[] = [];
    const bushes: { x: number; z: number; s: number; c: number }[] = [];
    const TUFT_CAP = 220000, FLOWER_CAP = 6000, BUSH_CAP = 1500;
    const GRASS_TINTS = [0x6fa045, 0x7fb04c, 0x8cbc55, 0x5e9340, 0x9ac45e];
    const FLOWER_COLS = [0xf4e04d, 0xffffff, 0xf08cb4, 0xb48cf0, 0xff9a3c];
    const BUSH_COLS = [0x3f7a35, 0x4f8a3c, 0x5c8f3a, 0x6a9a3a];
    const tint = () => GRASS_TINTS[Math.floor(rand() * GRASS_TINTS.length)];
    // the strip of grass between the kerb and the sidewalk, both sides of every street
    for (const st of streetLines) {
      const edge = resample(st.pts, 0.9);
      for (let i = 0; i + 1 < edge.length; i++) {
        const tx = edge[i + 1][0] - edge[i][0], tz = edge[i + 1][1] - edge[i][1], tl = Math.hypot(tx, tz) || 1;
        for (const side of [1, -1]) {
          const nx = (-tz / tl) * side, nz = (tx / tl) * side;
          for (let k = 0; k < 3 && tufts.length < TUFT_CAP * 0.35; k++) {
            const off = st.half + 0.15 + rand() * 2.6;
            const x = edge[i][0] + nx * off + (tx / tl) * rand() * 0.9, z = edge[i][1] + nz * off + (tz / tl) * rand() * 0.9;
            if (inBuilding(x, z) || nearEdge(x, z, 3) || collider.slab(x, z) > 0) continue;
            const near = segs.nearest(x, z, false);
            if (near && near.d < 0.25) continue; // still on asphalt
            const al = segs.nearest(x, z, true);
            if (al && al.d < 0.25) continue;
            tufts.push({ x, z, s: 0.8 + rand() * 0.45, c: tint() });
          }
        }
      }
    }
    const grassParks = data.parks.filter((p) => GRASSY.has(p.k) && p.p.length >= 3);
    const totalArea = grassParks.reduce((a, p) => a + Math.abs(polyArea(p.p)), 0);
    const step = Math.max(0.7, Math.sqrt(totalArea / Math.max(1, TUFT_CAP - tufts.length)) * 1.1); // thin out evenly if the parks are huge
    for (const p of grassParks) {
      const pts = p.p;
      const xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const wooded = /^(wood|forest|scrub)$/.test(p.k);
      for (let gx = minX; gx < maxX; gx += step) {
        for (let gz = minZ; gz < maxZ; gz += step) {
          const x = gx + rand() * step, z = gz + rand() * step;
          if (!inPoly(pts, x, z) || inBuilding(x, z) || nearEdge(x, z, 3) || collider.slab(x, z) > 0) continue;
          if (tufts.length < TUFT_CAP) tufts.push({ x, z, s: 0.8 + rand() * 0.5, c: tint() });
          const r = rand();
          if (r < 0.03 && flowers.length < FLOWER_CAP && !wooded) {
            const col = FLOWER_COLS[Math.floor(rand() * FLOWER_COLS.length)];
            for (let k = 0; k < 4 && flowers.length < FLOWER_CAP; k++) flowers.push({ x: x + (rand() - 0.5) * 1.4, z: z + (rand() - 0.5) * 1.4, s: 0.7 + rand() * 0.4, c: col });
          } else if (r > (wooded ? 0.99 : 0.997) && bushes.length < BUSH_CAP) {
            bushes.push({ x, z, s: 0.8 + rand() * 0.9, c: BUSH_COLS[Math.floor(rand() * BUSH_COLS.length)] });
          }
        }
      }
    }
    // a clump: crossed, tapered blades, bending more toward the tip
    const clump = (blades: number, h: number, w: number): THREE.BufferGeometry => {
      const pos: number[] = [], nor: number[] = [], idx: number[] = [];
      for (let b = 0; b < blades; b++) {
        const a = (b / blades) * Math.PI * 2 + b * 0.7;
        const ox = Math.cos(a) * 0.12, oz = Math.sin(a) * 0.12;
        const dx = Math.cos(a + Math.PI / 2) * w, dz = Math.sin(a + Math.PI / 2) * w;
        const lean = 0.18 + (b % 3) * 0.08, bh = h * (0.7 + ((b * 37) % 10) / 25);
        const i0 = pos.length / 3;
        pos.push(ox - dx, 0, oz - dz, ox + dx, 0, oz + dz, ox + Math.cos(a) * lean, bh, oz + Math.sin(a) * lean);
        for (let k = 0; k < 3; k++) nor.push(0, 1, 0);
        idx.push(i0, i0 + 1, i0 + 2, i0 + 2, i0 + 1, i0); // double-sided
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setIndex(idx);
      return g;
    };
    const sway = (m: THREE.Material, amount: number) => {
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uWind = windUniform;
        sh.vertexShader = 'uniform float uWind;\n' + sh.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 iw = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
          #else
            vec3 iw = vec3(0.0);
          #endif
          float ph = iw.x * 0.35 + iw.z * 0.27 + uWind * 1.6;
          transformed.x += (sin(ph) + 0.4 * sin(ph * 2.3 + 1.7)) * ${amount.toFixed(3)} * position.y;
          transformed.z += cos(ph * 0.8 + 0.6) * ${(amount * 0.6).toFixed(3)} * position.y;`,
        );
      };
    };
    const place = (list: { x: number; z: number; s: number; c: number }[], geo: THREE.BufferGeometry, mat: THREE.Material, lift: number, shadow: boolean) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
      list.forEach((t, i) => {
        q.setFromEuler(new THREE.Euler(0, rand() * 6.28, 0));
        m.compose(new THREE.Vector3(t.x, terrain.at(t.x, t.z) + lift, t.z), q, new THREE.Vector3(t.s, t.s * (0.85 + rand() * 0.4), t.s));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, col.setHex(t.c));
      });
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = shadow;
      group.add(mesh);
    };
    const grassBlade = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradient, side: THREE.DoubleSide, emissive: 0x2e4a1a });
    sway(grassBlade, 0.12);
    place(tufts, clump(6, 0.2, 0.06), grassBlade, 0, true);

    // flowers: a thin stem with a bright head
    const stem = clump(1, 0.32, 0.02);
    const head = new THREE.IcosahedronGeometry(0.07, 0).translate(0, 0.34, 0).toNonIndexed();
    head.deleteAttribute('uv'); // must match the stem's attributes or mergeGeometries returns null
    const bloom = mergeGeometries([stem.toNonIndexed(), head], false);
    if (!bloom) throw new Error('flower geometry merge failed');
    const bloomMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradient, side: THREE.DoubleSide });
    sway(bloomMat, 0.2);
    place(flowers, bloom, bloomMat, 0, false);

    // bushes: a lumpy dome that blocks a rat's way a little
    const bushGeo = mergeGeometries([
      new THREE.IcosahedronGeometry(0.7, 1).translate(0, 0.6, 0),
      new THREE.IcosahedronGeometry(0.5, 1).translate(0.55, 0.45, 0.1),
      new THREE.IcosahedronGeometry(0.45, 1).translate(-0.5, 0.4, -0.2),
    ].map((g) => g.toNonIndexed()), false)!;
    const bushMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradient });
    place(bushes, bushGeo, bushMat, 0, true);
    for (const b of bushes) collider.addBox({ minX: b.x - 0.45 * b.s, maxX: b.x + 0.45 * b.s, minZ: b.z - 0.45 * b.s, maxZ: b.z + 0.45 * b.s, top: terrain.at(b.x, b.z) + 0.9 * b.s });
  }

  // ---- the elevated L: a deck on columns ----
  {
    const deckMat = toon(0x4a4f5c), colMat = toon(0x3a3d46);
    const decks: THREE.BufferGeometry[] = [], cols: THREE.BufferGeometry[] = [];
    for (const r of data.rails) {
      if (!r.el) continue;
      const p = resample(r.p, 6);
      const top = (q: P2) => terrain.at(q[0], q[1]) + 10;
      const s = sides(p, 6.5);
      const mb = new MeshBuilder();
      for (let i = 0; i + 1 < p.length; i++) {
        const L0 = [s[i].l[0], top(p[i]), s[i].l[1]], R0 = [s[i].r[0], top(p[i]), s[i].r[1]], L1 = [s[i + 1].l[0], top(p[i + 1]), s[i + 1].l[1]], R1 = [s[i + 1].r[0], top(p[i + 1]), s[i + 1].r[1]];
        mb.quad(L0, R0, R1, L1, [[0, 0], [1, 0], [1, 1], [0, 1]], [0, 1, 0]);
        const d = (a: number[]) => [a[0], a[1] - 1.1, a[2]];
        mb.quad(d(L0), d(R0), d(R1), d(L1), [[0, 0], [1, 0], [1, 1], [0, 1]], [0, -1, 0]);
        const nl = [-(p[i + 1][1] - p[i][1]), 0, p[i + 1][0] - p[i][0]], nn = Math.hypot(nl[0], nl[2]) || 1;
        mb.quad(L0, L1, d(L1), d(L0), [[0, 0], [1, 0], [1, 1], [0, 1]], [nl[0] / nn, 0, nl[2] / nn]);
        mb.quad(R0, R1, d(R1), d(R0), [[0, 0], [1, 0], [1, 1], [0, 1]], [-nl[0] / nn, 0, -nl[2] / nn]);
      }
      decks.push(mb.build());
      along(p, 14, (x, z) => {
        const y = terrain.at(x, z);
        cols.push(new THREE.CylinderGeometry(0.55, 0.7, 10, 8).translate(x, y + 4.5, z));
        collider.addBox({ minX: x - 0.6, maxX: x + 0.6, minZ: z - 0.6, maxZ: z + 0.6, top: y + 9 });
      });
    }
    if (decks.length) group.add(shadowed(new THREE.Mesh(mergeGeometries(decks, false)!, deckMat), true));
    if (cols.length) group.add(shadowed(new THREE.Mesh(mergeGeometries(cols, false)!, colMat), true));
  }

  // ---- traffic signals at the mapped intersections ----
  const signals = new TrafficSignals(gradient);
  for (const [sx0, sz0] of data.signals) {
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = sx0 + sx * 9, z = sz0 + sz * 9;
      if (inBuilding(x, z)) continue;
      signals.addPole(x, z, -sx, -sz);
    }
  }
  signals.finish();
  group.add(signals.group);

  // ---- pedestrians: the mapped footways ----
  const net = new PolyNet(footways, (x, z) => terrain.at(x, z));

  // ---- nest: nearest street vertex to the middle of the map ----
  let spawnPt: P2 = [0, 0];
  let bestD = Infinity;
  for (const st of streetLines) {
    if (st.half < 4) continue;
    for (const p of st.pts) {
      const d = Math.hypot(p[0], p[1]);
      if (d < bestD && !inBuilding(p[0], p[1])) {
        bestD = d;
        spawnPt = p;
      }
    }
  }
  const spawn = new THREE.Vector3(spawnPt[0], terrain.at(spawnPt[0], spawnPt[1]) + 0.06, spawnPt[1]);
  const nest = spawn.clone();
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.05, 20), toon(0x2b2b33));
  lid.position.set(nest.x, nest.y + 0.02, nest.z);
  lid.receiveShadow = true;
  group.add(lid);
  const ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.58, 0.72, 28), new THREE.MeshBasicMaterial({ color: 0x8fe39a }));
  ringMesh.rotation.x = -Math.PI / 2;
  ringMesh.position.set(nest.x, nest.y + 0.05, nest.z);
  group.add(ringMesh);
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.45, 60, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x8fe39a, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
  );
  beacon.position.set(nest.x, nest.y + 30, nest.z);
  group.add(beacon);

  // ---- cheese: a few on the big roofs, the rest in alleys and on sidewalks ----
  const spots: [number, number, number][] = [...wrig.cheese];
  const bigRoofs = polys.filter((p, i) => data.buildings[i] && Math.abs(polyArea(p.pts)) > 160).sort(() => rand() - 0.5).slice(0, 4);
  for (const p of bigRoofs) {
    // a point well inside the roof
    const cx = p.pts.reduce((s, q) => s + q[0], 0) / p.pts.length, cz = p.pts.reduce((s, q) => s + q[1], 0) / p.pts.length;
    if (inPoly(p.pts, cx, cz)) spots.push([cx, p.top, cz]);
  }
  const pool = [...cheeseSpots];
  for (const f of footways) if (!f.crossing) for (let i = 0; i < f.pts.length; i += 3) pool.push([f.pts[i][0], terrain.at(f.pts[i][0], f.pts[i][1]) + 0.16, f.pts[i][1]]);
  pool.sort(() => rand() - 0.5);
  for (const sp of pool) {
    if (spots.length >= TOTAL_CHEESE) break;
    if (!nearEdge(sp[0], sp[2], 15) && !inBuilding(sp[0], sp[2])) spots.push(sp);
  }
  const cheese: Cheese[] = [];
  const placeholderGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.12, 3);
  const placeholderMat = new THREE.MeshToonMaterial({ color: 0xffd23a, gradientMap: gradient, emissive: 0x6a4a00 });
  for (const [x, surface, z] of spots) {
    const holder = new THREE.Group();
    const y = surface + 0.12;
    holder.position.set(x, y, z);
    const ph = new THREE.Mesh(placeholderGeo, placeholderMat);
    ph.castShadow = true;
    holder.add(ph);
    group.add(holder);
    props.place(holder, 'CheeseBox_01', { x: 0, y: -0.04, z: 0, scale: 2.2, emissive: 0xa07a10, replace: ph });
    cheese.push({ mesh: holder, baseY: y, state: 'free' });
  }

  // a catch-all cat route if the data had no usable alleys
  if (!catRoutes.length) catRoutes.push([new THREE.Vector2(spawn.x + 20, spawn.z), new THREE.Vector2(spawn.x + 60, spawn.z)]);
  while (catRoutes.length < 3) catRoutes.push(catRoutes[catRoutes.length % Math.max(1, catRoutes.length)]);
  void SHOP_NAMES;
  void buildingFootprints;

  return {
    group,
    boxes: collider.boxes,
    collider,
    pipes,
    cheese,
    spawn,
    nest,
    lamps,
    bulbMat,
    windows,
    propsReady: props.ready(),
    rings: [],
    walkNet: net,
    walkStarts: net.starts,
    carRoads: data.roads.filter((r) => !r.tu && !r.br && DRIVABLE.has(r.k) && r.k !== 'alley' && r.k !== 'service' && r.w >= 7).map((r) => ({ pts: r.p, w: r.w, oneway: !!r.o })),
    terrainAt: (x, z) => terrain.at(x, z),
    catRoutes: catRoutes.sort(() => rand() - 0.5).slice(0, 4),
    beacon,
    signals,
    powerLines,
    plants: { update: (t: number) => { windUniform.value = t; } },
    size: { w: B.x1 - B.x0, d: B.z1 - B.z0 },
    osmCredit: data.osmCopyright,
    map: {
      bounds: B,
      water: data.water.filter((w) => w.length >= 3).map((w, i) => ({ pts: w, lake: i === data.lakeIdx })),
      roads: data.roads.filter((r) => !r.tu && DRIVABLE.has(r.k)).map((r) => ({ pts: r.p, w: r.w, alley: r.k === 'alley' })),
      buildings: [...rings, stadium.out],
      green: data.parks.filter((p) => PARK_COLOR[p.k] && p.p.length >= 3).map((p) => ({ pts: p.p, forest: forests.includes(p.p) })),
      rails: data.rails.map((r) => r.p),
      places: [
        { name: 'Wrigley Field', x: 0, z: 0 },
        { name: 'The nest', x: nest.x, z: nest.z },
        ...forests.map((f, i) => {
          const cx = f.reduce((a, q) => a + q[0], 0) / f.length, cz = f.reduce((a, q) => a + q[1], 0) / f.length;
          return { name: forests.length > 1 ? `Forest ${i + 1}` : 'Forest', x: cx, z: cz };
        }),
        ...(lake.shoreX !== null ? [{ name: 'Lake Michigan', x: lake.shoreX - 14, z: 0 }] : []),
        { name: 'North end', x: 0, z: -ext * 0.8 },
        { name: 'South end', x: 0, z: ext * 0.8 },
        { name: 'West end', x: -ext * 0.8, z: 0 },
      ],
    },
  };
}
