import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { inPoly } from './citycollider';
import type { Box } from './physics';

type P2 = [number, number];

export interface LakefrontCtx {
  group: THREE.Group;
  gradient: THREE.DataTexture;
  rand: () => number;
  terrainAt: (x: number, z: number) => number;
  /** true where nothing may be planted or placed: buildings, water, roads, other walkways, the map edge */
  blocked: (x: number, z: number) => boolean;
  inWater: (x: number, z: number) => boolean;
  /** inside the playable area (not at the baked map's edge) */
  inside: (x: number, z: number) => boolean;
  addBox: (b: Box) => void;
  /** every tree already planted (street trees, parks), so new ones keep their distance */
  treeSpots: { x: number; z: number }[];
  /** the Lakefront Trail ways: centreline + half width of the paved ribbon */
  trails: { pts: P2[]; half: number; kind: string }[];
  /** lake and harbour outlines */
  water: P2[][];
  /** a pedestrian-scale lamp that also lights up at night */
  addLamp: (x: number, z: number, nx: number, nz: number) => void;
  /** a Poly Haven prop with a collision box */
  solid: (id: string, x: number, z: number, scale: number, rotY: number) => unknown;
  windUniform: { value: number };
}

// ---- small helpers ----------------------------------------------------------------------------

/** a coloured, flat-shaded box, centred on (x, y, z) */
function cube(w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
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
/** a coloured, flat-shaded cylinder (or cone when radii differ), centred on (x, y, z) */
function tube(rTop: number, rBot: number, h: number, x: number, y: number, z: number, color: number, seg = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg).toNonIndexed();
  g.deleteAttribute('uv');
  g.translate(x, y, z);
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('lakefront geometry merge failed');
  return g;
}
/** paint a whole geometry one colour (for the species that take per-instance tint) */
function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const o = g.index ? g.toNonIndexed() : g;
  o.deleteAttribute('uv');
  return o;
}

/** smooth 0..1 noise for groves and clearings */
const noise = (x: number, z: number) => 0.5 + 0.25 * Math.sin(x * 0.045 + Math.sin(z * 0.03) * 2) + 0.25 * Math.sin(z * 0.05 - x * 0.02 + 1.3);

// ---- furniture models ------------------------------------------------------------------------

const WOOD = 0x9a6b3f, WOOD_D = 0x7d5430, SLAT = 0x2f6044, SLAT_D = 0x264e38, BLACK = 0x1c211e, IRON = 0x2f3d36, STONE = 0x9a9a94, STEEL = 0xaab4bb, WHITE = 0xf1ede0;

/** Chicago Park District style: dark-green slats on black cast-iron ends */
function benchGeo(): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  for (const z of [-0.2, -0.06, 0.08, 0.22]) p.push(cube(1.8, 0.05, 0.11, 0, 0.45, z, SLAT)); // seat slats
  for (const y of [0.68, 0.84]) p.push(cube(1.8, 0.1, 0.04, 0, y, -0.3, SLAT_D)); // back slats
  for (const x of [-0.82, 0.82]) {
    p.push(cube(0.06, 0.45, 0.5, x, 0.225, 0, BLACK)); // cast-iron ends
    p.push(cube(0.06, 0.5, 0.05, x, 0.7, -0.3, BLACK));
    p.push(cube(0.07, 0.05, 0.5, x, 0.62, -0.02, BLACK)); // arm rests
  }
  return merged(p);
}
/** round black perforated-steel litter bin with a domed lid and a green band; `recycle` makes it blue */
function binGeo(recycle: boolean): THREE.BufferGeometry {
  const body = recycle ? 0x2c64a8 : BLACK;
  return merged([
    tube(0.27, 0.25, 0.86, 0, 0.45, 0, body),
    tube(0.285, 0.285, 0.07, 0, 0.62, 0, recycle ? 0xe9eef2 : 0x2f6044), // band
    tube(0.1, 0.3, 0.12, 0, 0.94, 0, recycle ? 0x1f4a80 : 0x2a302d), // lid dome
    cube(0.2, 0.05, 0.03, 0, 0.82, 0.28, 0x0a0c0b), // flap
    tube(0.3, 0.3, 0.03, 0, 0.03, 0, 0x2a302d), // base ring
  ]);
}
/** trail signpost: green board with a white bike and walker, and the trail name strip */
function signGeo(): THREE.BufferGeometry {
  return merged([
    cube(0.1, 2.2, 0.1, 0, 1.1, 0, 0x2a302d),
    cube(0.95, 0.62, 0.05, 0, 1.95, 0.07, 0x1e5a3c),
    cube(0.86, 0.04, 0.06, 0, 2.2, 0.075, WHITE), // frame top
    cube(0.86, 0.04, 0.06, 0, 1.7, 0.075, WHITE),
    cube(0.3, 0.26, 0.06, -0.22, 1.97, 0.08, WHITE), // bike
    cube(0.14, 0.3, 0.06, 0.25, 1.97, 0.08, WHITE), // walker
    cube(0.6, 0.1, 0.05, 0, 1.58, 0.07, 0x3a78b5), // "LAKEFRONT TRAIL" plate
  ]);
}

function pictableGeo(): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [cube(1.9, 0.06, 0.8, 0, 0.76, 0, WOOD)];
  for (const s of [-1, 1]) {
    p.push(cube(1.9, 0.05, 0.28, 0, 0.45, s * 0.7, WOOD_D));
    for (const x of [-0.7, 0.7]) p.push(cube(0.07, 0.75, 0.07, x, 0.38, s * 0.3, IRON), cube(0.07, 0.45, 0.07, x, 0.22, s * 0.7, IRON));
  }
  return merged(p);
}
function fountainGeo(): THREE.BufferGeometry {
  return merged([
    cube(0.34, 0.95, 0.34, 0, 0.475, 0, STONE),
    cube(0.5, 0.1, 0.44, 0, 0.98, 0.04, STEEL),
    cube(0.08, 0.14, 0.08, 0, 1.1, -0.12, STEEL),
    cube(0.7, 0.04, 0.7, 0, 0.02, 0, 0x7d7d78),
  ]);
}
function bikeRackGeo(): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const z = (i - 1.5) * 0.45;
    p.push(cube(0.05, 0.8, 0.05, -0.28, 0.4, z, STEEL), cube(0.05, 0.8, 0.05, 0.28, 0.4, z, STEEL), cube(0.61, 0.05, 0.05, 0, 0.8, z, STEEL));
  }
  return merged(p);
}
function mileMarkerGeo(): THREE.BufferGeometry {
  return merged([cube(0.12, 1.5, 0.12, 0, 0.75, 0, 0x2d5a45), cube(0.6, 0.34, 0.05, 0, 1.3, 0.07, WHITE), cube(0.6, 0.07, 0.06, 0, 1.4, 0.07, 0x3a78b5)]);
}

// ---- plants ----------------------------------------------------------------------------------

/** crossed tapered blades (same idea as the park grass), `h` tall */
function clump(blades: number, h: number, w: number): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + b * 0.7;
    const ox = Math.cos(a) * 0.12, oz = Math.sin(a) * 0.12;
    const dx = Math.cos(a + Math.PI / 2) * w, dz = Math.sin(a + Math.PI / 2) * w;
    const lean = 0.12 * h + (b % 3) * 0.05 * h, bh = h * (0.7 + ((b * 37) % 10) / 25);
    const i0 = pos.length / 3;
    pos.push(ox - dx, 0, oz - dz, ox + dx, 0, oz + dz, ox + Math.cos(a) * lean, bh, oz + Math.sin(a) * lean);
    for (let k = 0; k < 3; k++) nor.push(0, 1, 0);
    idx.push(i0, i0 + 1, i0 + 2, i0 + 2, i0 + 1, i0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

const OAK = [0x4f8a3c, 0x5d9a3f, 0x6a9a3a, 0x4a8a45, 0x86a83c, 0x5a9a48, 0xd98a2b, 0xc8452a];
const PINE = [0x2f6b3a, 0x285f35, 0x3a7a42, 0x2e6e48];
const BIRCH = [0x9cc24a, 0xaed05a, 0x8ab845, 0xe0b13a];
const BLOOM = [0xf4e04d, 0xffffff, 0xf08cb4, 0xb48cf0, 0xff9a3c, 0xe8505a, 0x7aa8f0];
const SHRUB = [0x3f7a35, 0x4f8a3c, 0x5c8f3a, 0x6a9a3a, 0x356b3a];
const PRAIRIE = [0xb6b25a, 0x9bb04e, 0xc9b865, 0x86a84a, 0xa8b856];
const REED = [0x8a9a4a, 0x9aa855, 0xb0a85a, 0x7a9448];

interface Item { x: number; z: number; s: number; c: number; r?: number }

export function buildLakefront(ctx: LakefrontCtx): { benches: number; lamps: number; bins: number; trees: number } {
  const { group, gradient, rand, terrainAt, blocked, inWater, inside, addBox } = ctx;
  const toon = (c: number, extra: Partial<THREE.MeshToonMaterialParameters> = {}) => new THREE.MeshToonMaterial({ color: c, gradientMap: gradient, ...extra });
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);

  // ---- where the trail is: a hash of its segments, so "how far from the path" is cheap ----
  const CELL = 24;
  const segGrid = new Map<number, { ax: number; az: number; bx: number; bz: number; h: number }[]>();
  const ck = (ix: number, iz: number) => ix * 73856093 ^ iz * 19349663;
  let have = false;
  for (const t of ctx.trails) {
    for (let i = 0; i + 1 < t.pts.length; i++) {
      const [ax, az] = t.pts[i], [bx, bz] = t.pts[i + 1];
      const s = { ax, az, bx, bz, h: t.half };
      for (let ix = Math.floor((Math.min(ax, bx) - 30) / CELL); ix <= Math.floor((Math.max(ax, bx) + 30) / CELL); ix++) {
        for (let iz = Math.floor((Math.min(az, bz) - 30) / CELL); iz <= Math.floor((Math.max(az, bz) + 30) / CELL); iz++) {
          const k = ck(ix, iz);
          let l = segGrid.get(k);
          if (!l) segGrid.set(k, (l = []));
          l.push(s);
          have = true;
        }
      }
    }
  }
  if (!have) return { benches: 0, lamps: 0, bins: 0, trees: 0 };
  /** distance from the edge of the paved trail (negative = on it) */
  const trailGap = (x: number, z: number): number => {
    let best = Infinity;
    for (const s of segGrid.get(ck(Math.floor(x / CELL), Math.floor(z / CELL))) ?? []) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(x - s.ax - dx * t, z - s.az - dz * t) - s.h);
    }
    return best;
  };

  // spacing book-keeping
  const placed: Record<string, P2[]> = {};
  const crowded = (kind: string, x: number, z: number, r: number) => (placed[kind] ??= []).some((p) => Math.hypot(p[0] - x, p[1] - z) < r);
  const note = (kind: string, x: number, z: number) => (placed[kind] ??= []).push([x, z]);

  const lakePts: P2[] = ctx.water.flat();
  const nearestWater = (x: number, z: number): P2 => {
    let best = lakePts[0], bd = Infinity;
    for (const p of lakePts) {
      const d = (p[0] - x) ** 2 + (p[1] - z) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };

  const walk = (pts: P2[], step: number, phase: number, fn: (x: number, z: number, tx: number, tz: number, i: number) => void) => {
    let carry = phase, i = 0;
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

  // ---- instanced furniture ----
  const furnMat = toon(0xffffff, { vertexColors: true });
  const furn: Record<string, { geo: THREE.BufferGeometry; list: { x: number; z: number; rot: number }[] }> = {
    bench: { geo: benchGeo(), list: [] },
    table: { geo: pictableGeo(), list: [] },
    fountain: { geo: fountainGeo(), list: [] },
    rack: { geo: bikeRackGeo(), list: [] },
    mile: { geo: mileMarkerGeo(), list: [] },
    bin: { geo: binGeo(false), list: [] },
    recycle: { geo: binGeo(true), list: [] },
    sign: { geo: signGeo(), list: [] },
  };
  /** footprint (w along the local x axis, d along z) and top height of what gets a collision box */
  const FOOT: Record<string, [number, number, number]> = { bench: [1.9, 0.7, 0.5], table: [1.9, 1.8, 0.78], fountain: [0.5, 0.5, 1.0], rack: [0.7, 1.8, 0.8], mile: [0.3, 0.3, 1.5], bin: [0.6, 0.6, 1.0], recycle: [0.6, 0.6, 1.0], sign: [0.3, 0.3, 2.2] };
  const addFurn = (kind: string, x: number, z: number, rot: number): boolean => {
    if (blocked(x, z)) return false;
    furn[kind].list.push({ x, z, rot });
    const [w, d, h] = FOOT[kind];
    const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
    const hx = (w * c + d * s) / 2, hz = (w * s + d * c) / 2;
    addBox({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, top: terrainAt(x, z) + h });
    return true;
  };

  let nLamps = 0, nBins = 0;
  for (const t of ctx.trails) {
    if (t.kind === 'path' && t.half < 1.6) continue; // skip the thin spurs
    const half = t.half;
    walk(t.pts, 4, 1 + rand() * 3, (x, z, tx, tz, i) => {
      const toLake = nearestWater(x, z);
      const lx = toLake[0] - x, lz = toLake[1] - z;
      // outward normals: a is the lake side, b the land side
      const nl: P2 = [-tz, tx];
      const lakeSide = nl[0] * lx + nl[1] * lz > 0 ? 1 : -1;
      const out = (side: number): P2 => [nl[0] * side * lakeSide, nl[1] * side * lakeSide]; // +1 = lake side, -1 = land side
      // lamps: every ~32 m, alternating sides
      if (i % 8 === 0) {
        const s = (i / 8) % 2 ? 1 : -1;
        const n = out(s), off = half + 1.0;
        const px = x + n[0] * off, pz = z + n[1] * off;
        if (!crowded('lamp', px, pz, 24) && !blocked(px, pz)) {
          ctx.addLamp(px, pz, n[0], n[1]);
          note('lamp', px, pz);
          nLamps++;
        }
      }
      // benches every ~20 m: mostly on the land side facing the water, one in four on the lake side facing the path
      if (i % 5 === 2) {
        const n5 = (i / 5) | 0;
        const lakeFacing = n5 % 4 === 3;
        const n = out(lakeFacing ? 1 : -1), off = half + 1.15;
        const px = x + n[0] * off, pz = z + n[1] * off;
        if (!crowded('bench', px, pz, 15) && !blocked(px, pz)) {
          const fx = -n[0], fz = -n[1];
          if (addFurn('bench', px, pz, Math.atan2(fx, fz))) {
            note('bench', px, pz);
            // a litter bin at the end of every bench, with a recycling bin beside it at every third
            const bx = px + tx * 1.6 + n[0] * 0.15, bz = pz + tz * 1.6 + n[1] * 0.15;
            if (addFurn('bin', bx, bz, rand() * 6.28)) {
              nBins++;
              if (n5 % 3 === 0) addFurn('recycle', bx + tx * 0.7, bz + tz * 0.7, rand() * 6.28);
            }
          }
        }
      }
      // a bin on the water side of the path too, every ~48 m, so a rat is never far from a snack
      if (i % 12 === 8) {
        const n = out(1), px = x + n[0] * (half + 0.9), pz = z + n[1] * (half + 0.9);
        if (!crowded('bin', px, pz, 30) && addFurn('bin', px, pz, rand() * 6.28)) {
          note('bin', px, pz);
          nBins++;
        }
      }
      // trail signposts
      if (i % 25 === 7) {
        const n = out(-1), px = x + n[0] * (half + 0.9), pz = z + n[1] * (half + 0.9);
        if (!crowded('sign', px, pz, 80) && addFurn('sign', px, pz, Math.atan2(-n[0], -n[1]))) note('sign', px, pz);
      }
      // bike racks near the benches, now and then
      if (i % 31 === 12) {
        const n = out(-1), px = x + n[0] * (half + 1.4), pz = z + n[1] * (half + 1.4);
        if (!crowded('rack', px, pz, 90) && addFurn('rack', px, pz, Math.atan2(tx, tz))) note('rack', px, pz);
      }
      // drinking fountains
      if (i % 53 === 20) {
        const n = out(-1), px = x + n[0] * (half + 1.0), pz = z + n[1] * (half + 1.0);
        if (!crowded('fountain', px, pz, 140) && addFurn('fountain', px, pz, Math.atan2(-n[0], -n[1]))) note('fountain', px, pz);
      }
      // picnic tables back from the path, in the shade
      if (i % 37 === 9) {
        const n = out(-1), off = half + 5 + rand() * 3, px = x + n[0] * off, pz = z + n[1] * off;
        if (!crowded('table', px, pz, 70) && addFurn('table', px, pz, Math.atan2(tx, tz))) note('table', px, pz);
      }
      // mile markers
      if (i % 40 === 3) {
        const n = out(-1), px = x + n[0] * (half + 0.6), pz = z + n[1] * (half + 0.6);
        if (!crowded('mile', px, pz, 100) && addFurn('mile', px, pz, Math.atan2(-n[0], -n[1]))) note('mile', px, pz);
      }
    });
  }
  for (const f of Object.values(furn)) {
    if (!f.list.length) continue;
    const mesh = new THREE.InstancedMesh(f.geo, furnMat, f.list.length);
    f.list.forEach((p, i) => {
      q.setFromAxisAngle(up, p.rot);
      mesh.setMatrixAt(i, m4.compose(new THREE.Vector3(p.x, terrainAt(p.x, p.z) + 0.04, p.z), q, new THREE.Vector3(1, 1, 1)));
    });
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }


  // ---- pavement paint, Chicago style: bikes get the inland lanes with a dashed yellow centre line, walkers get a
  //      lane on the lake side divided off by a solid white line ----
  {
    const pos: number[] = [], colr: number[] = [];
    const YEL = new THREE.Color(0xe8c84a), WHT = new THREE.Color(0xeeeae0);
    const quad = (a: P2, b: P2, nx: number, nz: number, off: number, w: number, c: THREE.Color) => {
      const v = (p: P2, o: number): number[] => {
        const x = p[0] + nx * o, z = p[1] + nz * o;
        return [x, terrainAt(x, z) + 0.2, z];
      };
      const A = v(a, off - w / 2), B = v(a, off + w / 2), C = v(b, off + w / 2), D = v(b, off - w / 2);
      for (const q4 of [A, B, C, A, C, D]) {
        pos.push(q4[0], q4[1], q4[2]);
        colr.push(c.r, c.g, c.b);
      }
    };
    for (const t of ctx.trails) {
      if (t.kind !== 'cycleway') continue;
      const wide = t.half * 2 >= 12;
      // resample every metre so the lines follow the bends
      const rs: P2[] = [];
      walk(t.pts, 1, 0, (x, z) => rs.push([x, z]));
      if (rs.length < 3) continue;
      // one side decision per trail: which side of the centreline faces the lake
      const mid = rs[rs.length >> 1], mn = rs[(rs.length >> 1) + 1];
      const tl = Math.hypot(mn[0] - mid[0], mn[1] - mid[1]) || 1;
      const lw = nearestWater(mid[0], mid[1]);
      const lakeSign = (-(mn[1] - mid[1]) / tl) * (lw[0] - mid[0]) + ((mn[0] - mid[0]) / tl) * (lw[1] - mid[1]) > 0 ? 1 : -1;
      const pedW = 4.2; // the walkers' lane
      for (let i = 0; i + 1 < rs.length; i++) {
        const a = rs[Math.max(0, i - 1)], b = rs[Math.min(rs.length - 1, i + 2)];
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = (-(b[1] - a[1]) / l) * lakeSign, nz = ((b[0] - a[0]) / l) * lakeSign; // points toward the lake
        if (wide) {
          quad(rs[i], rs[i + 1], nx, nz, t.half - pedW, 0.16, WHT); // walkers' divider
          if (i % 7 < 3) quad(rs[i], rs[i + 1], nx, nz, -pedW / 2, 0.14, YEL); // bikes' centre line
        } // single-lane stretches already get their dashes from city.ts
      }
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(0).flatMap(() => [0, 1, 0]), 3));
      const m = toon(0xffffff, { vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      const mesh = new THREE.Mesh(g, m);
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  // ---- trees: groves with clearings, three kinds ----
  const treeHash = new Map<number, P2[]>();
  const th = (x: number, z: number) => ck(Math.floor(x / 3), Math.floor(z / 3));
  const addToHash = (x: number, z: number) => {
    const k = th(x, z);
    let l = treeHash.get(k);
    if (!l) treeHash.set(k, (l = []));
    l.push([x, z]);
  };
  for (const t of ctx.treeSpots) addToHash(t.x, t.z);
  const tooClose = (x: number, z: number, r: number) => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
      for (const p of treeHash.get(th(x + dx * 3, z + dz * 3)) ?? []) if (Math.hypot(p[0] - x, p[1] - z) < r) return true;
    return false;
  };
  const oaks: Item[] = [], pines: Item[] = [], birches: Item[] = [];
  const shrubs: Item[] = [], blooms: Item[] = [], prairie: Item[] = [], flowerBeds: Item[] = [];
  const pick = (a: number[]) => a[Math.floor(rand() * a.length)];

  for (const t of ctx.trails) {
    if (t.kind === 'path' && t.half < 1.6) continue;
    const half = t.half;
    walk(t.pts, 2.6, rand() * 2, (x, z, tx, tz) => {
      for (const side of [-1, 1]) {
        const nx = -tz * side, nz = tx * side;
        const n = noise(x, z);
        // trees
        const tries = n > 0.62 ? 3 : n > 0.4 ? 1 : 0.25;
        for (let k = 0; k < tries; k += 1) {
          if (k + 1 > tries && rand() > tries - k) continue;
          const off = half + 2.2 + Math.pow(rand(), 1.5) * 17;
          const px = x + nx * off + tx * (rand() - 0.5) * 3, pz = z + nz * off + tz * (rand() - 0.5) * 3;
          if (blocked(px, pz) || trailGap(px, pz) < 2.0 || tooClose(px, pz, 2.7)) continue;
          const sp = noise(px * 1.7 + 40, pz * 1.7);
          const item: Item = { x: px, z: pz, s: 0.85 + rand() * 0.75, c: 0 };
          if (sp > 0.63) { item.c = pick(PINE); pines.push(item); }
          else if (sp < 0.33) { item.c = pick(BIRCH); item.s = 0.8 + rand() * 0.5; birches.push(item); }
          else { item.c = pick(OAK); oaks.push(item); }
          addToHash(px, pz);
        }
        // shrubs hugging the path edge and flowering shrubs
        if (rand() < 0.45) {
          const off = half + 1.4 + rand() * 3.2;
          const px = x + nx * off, pz = z + nz * off;
          if (!blocked(px, pz) && trailGap(px, pz) > 0.9 && !tooClose(px, pz, 0.9)) {
            if (rand() < 0.28) blooms.push({ x: px, z: pz, s: 0.8 + rand() * 0.6, c: pick(BLOOM) });
            else shrubs.push({ x: px, z: pz, s: 0.7 + rand() * 0.8, c: pick(SHRUB) });
          }
        }
        // tall prairie grass in the meadow bands
        for (let k = 0; k < 3; k++) {
          const off = half + 0.9 + rand() * 9;
          const px = x + nx * off + tx * rand() * 2.6, pz = z + nz * off + tz * rand() * 2.6;
          if (blocked(px, pz) || trailGap(px, pz) < 0.7) continue;
          prairie.push({ x: px, z: pz, s: 0.8 + rand() * 0.7, c: pick(PRAIRIE) });
        }
      }
    });
    // flower beds: a bright patch every ~16 m, both sides
    walk(t.pts, 16, rand() * 6, (x, z, tx, tz, i) => {
      const side = i % 2 ? 1 : -1;
      const nx = -tz * side, nz = tx * side;
      const off = half + 1.8 + rand() * 1.5;
      const cx = x + nx * off, cz = z + nz * off;
      if (blocked(cx, cz) || trailGap(cx, cz) < 0.9) return;
      const base = pick(BLOOM), alt = pick(BLOOM);
      for (let k = 0; k < 16; k++) {
        const px = cx + (rand() - 0.5) * 3.4, pz = cz + (rand() - 0.5) * 2.0;
        if (blocked(px, pz) || trailGap(px, pz) < 0.5) continue;
        flowerBeds.push({ x: px, z: pz, s: 0.8 + rand() * 0.5, c: rand() < 0.7 ? base : alt });
      }
    });
  }

  // ---- the shore: reeds and cattails at the waterline, boulders for rip-rap ----
  const reeds: Item[] = [], cattails: Item[] = [], boulders: Item[] = [];
  for (const poly of ctx.water) {
    if (poly.length < 3) continue;
    const ring = [...poly, poly[0]];
    walk(ring, 2.2, rand() * 2, (x, z, tx, tz) => {
      if (!inside(x, z) || (blocked(x, z) && !inWater(x, z))) return;
      // which way is "outside"? probe both sides
      const nx = -tz, nz = tx;
      const sign = inPoly(poly, x + nx * 1.5, z + nz * 1.5) ? -1 : 1; // sign * n points out of the water
      const ox = nx * sign, oz = nz * sign;
      // the shore must be inside the playable area and away from roads
      const edgeOk = (px: number, pz: number) => !blocked(px, pz) && !inWater(px, pz);
      const r = rand();
      if (r < 0.75) {
        for (let k = 0; k < 3; k++) {
          const off = -0.3 + rand() * 1.8; // a little in the water, mostly on the bank
          const px = x + ox * off + tx * (rand() - 0.5) * 2, pz = z + oz * off + tz * (rand() - 0.5) * 2;
          if (!inside(px, pz)) continue;
          if (off > 0 && !edgeOk(px, pz)) continue;
          if (off <= 0 && blocked(px, pz) && !inWater(px, pz)) continue;
          if (trailGap(px, pz) < 0.3) continue;
          (rand() < 0.25 ? cattails : reeds).push({ x: px, z: pz, s: 0.8 + rand() * 0.6, c: pick(REED) });
        }
      }
      if (rand() < 0.4) {
        const off = 0.5 + rand() * 2.4;
        const px = x + ox * off, pz = z + oz * off;
        if (edgeOk(px, pz) && trailGap(px, pz) > 1.2) boulders.push({ x: px, z: pz, s: 0.6 + rand() * 1.1, c: 0, r: rand() * 6.28 });
      }
    });
  }
  // a few rock groups and fallen logs beside the trail
  const logs: Item[] = [];
  for (const t of ctx.trails) {
    if (t.kind === 'path' && t.half < 1.6) continue;
    walk(t.pts, 58, rand() * 40, (x, z, tx, tz, i) => {
      const side = i % 2 ? 1 : -1;
      const off = t.half + 3 + rand() * 5;
      const cx = x - tz * side * off, cz = z + tx * side * off;
      if (blocked(cx, cz) || trailGap(cx, cz) < 1.5) return;
      if (rand() < 0.55) {
        for (let k = 0; k < 3; k++) {
          const px = cx + (rand() - 0.5) * 2.4, pz = cz + (rand() - 0.5) * 2.4;
          if (!blocked(px, pz)) boulders.push({ x: px, z: pz, s: 0.5 + rand() * 0.8, c: 0, r: rand() * 6.28 });
        }
      } else logs.push({ x: cx, z: cz, s: 0.8 + rand() * 0.5, c: 0, r: rand() * 3.14 });
    });
  }

  // ---- build the instanced meshes ----
  const place = (list: Item[], geo: THREE.BufferGeometry, mat: THREE.Material, lift: number, opts: { shadow?: boolean; tilt?: boolean; flat?: boolean } = {}) => {
    if (!list.length) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      q.setFromAxisAngle(up, it.r ?? rand() * 6.28);
      const sy = opts.flat ? it.s : it.s * (0.85 + rand() * 0.35);
      mesh.setMatrixAt(i, m4.compose(new THREE.Vector3(it.x, terrainAt(it.x, it.z) + lift, it.z), q, new THREE.Vector3(it.s, sy, it.s)));
      if (it.c) mesh.setColorAt(i, col.setHex(it.c));
    });
    mesh.castShadow = !!opts.shadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };
  const sway = (m: THREE.Material, amount: number) => {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uWind = ctx.windUniform;
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
  const treeBox = (it: Item, top: number) => addBox({ minX: it.x - 0.3, maxX: it.x + 0.3, minZ: it.z - 0.3, maxZ: it.z + 0.3, top: terrainAt(it.x, it.z) + top * it.s });

  // oaks: a broad crown of three lumps on a stout trunk
  if (oaks.length) {
    const crown = plain(merged([
      new THREE.IcosahedronGeometry(1.7, 1).translate(0, 4.0, 0),
      new THREE.IcosahedronGeometry(1.2, 1).translate(1.1, 3.5, 0.5),
      new THREE.IcosahedronGeometry(1.1, 1).translate(-1.0, 3.7, -0.6),
    ].map((g) => plain(g))));
    place(oaks, crown, toon(0xffffff), 0, { shadow: true });
    place(oaks.map((o) => ({ ...o, c: 0 })), new THREE.CylinderGeometry(0.2, 0.32, 2.7, 6).translate(0, 1.35, 0), toon(0x5a4030), 0, { shadow: true, flat: true });
    oaks.forEach((o) => treeBox(o, 2.6));
  }
  // pines: a trunk and three stacked cones
  if (pines.length) {
    const cones = plain(merged([
      new THREE.ConeGeometry(1.7, 2.2, 7).translate(0, 2.7, 0),
      new THREE.ConeGeometry(1.35, 2.0, 7).translate(0, 4.0, 0),
      new THREE.ConeGeometry(0.95, 1.9, 7).translate(0, 5.2, 0),
    ].map((g) => plain(g))));
    place(pines, cones, toon(0xffffff), 0, { shadow: true });
    place(pines.map((o) => ({ ...o, c: 0 })), new THREE.CylinderGeometry(0.16, 0.26, 2.4, 6).translate(0, 1.2, 0), toon(0x4a3626), 0, { shadow: true, flat: true });
    pines.forEach((o) => treeBox(o, 2.4));
  }
  // birches: slim pale trunks, light oval crowns
  if (birches.length) {
    const crown = plain(new THREE.IcosahedronGeometry(1.2, 1).scale(1, 1.45, 1).translate(0, 4.2, 0));
    place(birches, crown, toon(0xffffff), 0, { shadow: true });
    place(birches.map((o) => ({ ...o, c: 0 })), new THREE.CylinderGeometry(0.1, 0.17, 3.6, 6).translate(0, 1.8, 0), toon(0xe9e4d4), 0, { shadow: true, flat: true });
    birches.forEach((o) => treeBox(o, 3.0));
  }

  // shrubs and flowering shrubs
  const bushGeo = plain(merged([
    new THREE.IcosahedronGeometry(0.7, 1).translate(0, 0.6, 0),
    new THREE.IcosahedronGeometry(0.5, 1).translate(0.55, 0.45, 0.1),
    new THREE.IcosahedronGeometry(0.45, 1).translate(-0.5, 0.4, -0.2),
  ].map((g) => plain(g))));
  place(shrubs, bushGeo, toon(0xffffff), 0, { shadow: true });
  place(blooms, bushGeo, toon(0xffffff), 0, { shadow: true });
  for (const b of [...shrubs, ...blooms]) addBox({ minX: b.x - 0.45 * b.s, maxX: b.x + 0.45 * b.s, minZ: b.z - 0.45 * b.s, maxZ: b.z + 0.45 * b.s, top: terrainAt(b.x, b.z) + 0.9 * b.s });

  // grasses and flowers sway in the wind
  const blade = toon(0xffffff, { side: THREE.DoubleSide, emissive: 0x2e4a1a });
  sway(blade, 0.16);
  place(prairie, clump(7, 0.55, 0.04), blade, 0);
  const reedMat = toon(0xffffff, { side: THREE.DoubleSide, emissive: 0x3a3a18 });
  sway(reedMat, 0.1);
  place(reeds, clump(6, 1.5, 0.05), reedMat, 0);
  const cat = merged([
    plain(clump(1, 1.7, 0.03)),
    plain(new THREE.CylinderGeometry(0.06, 0.06, 0.3, 6).translate(0, 1.5, 0)),
  ].map((g) => (g.index ? g.toNonIndexed() : g)));
  place(cattails, cat, reedMat, 0);
  const bloomMat = toon(0xffffff, { side: THREE.DoubleSide });
  sway(bloomMat, 0.2);
  const flower = merged([
    plain(clump(1, 0.34, 0.02)),
    plain(new THREE.IcosahedronGeometry(0.08, 0).translate(0, 0.36, 0)),
  ].map((g) => (g.index ? g.toNonIndexed() : g)));
  place(flowerBeds, flower, bloomMat, 0);

  // boulders: lumpy grey rocks you can climb
  if (boulders.length) {
    const rock = new THREE.DodecahedronGeometry(0.8, 0);
    const pos = rock.getAttribute('position');
    for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) * (0.85 + Math.sin(i * 12.9) * 0.15), pos.getY(i) * 0.65, pos.getZ(i) * (0.9 + Math.cos(i * 7.1) * 0.15));
    rock.computeVertexNormals();
    const tints = [0x8d8d86, 0x7c7c78, 0x9a968a, 0x6f726f];
    place(boulders.map((b) => ({ ...b, c: pick(tints) })), plain(rock.toNonIndexed()), toon(0xffffff), 0.25, { shadow: true, flat: true });
    for (const b of boulders) addBox({ minX: b.x - 0.55 * b.s, maxX: b.x + 0.55 * b.s, minZ: b.z - 0.55 * b.s, maxZ: b.z + 0.55 * b.s, top: terrainAt(b.x, b.z) + 0.75 * b.s });
  }
  // fallen logs
  if (logs.length) {
    const log = plain(new THREE.CylinderGeometry(0.22, 0.26, 3.2, 7).rotateZ(Math.PI / 2).translate(0, 0.24, 0).toNonIndexed());
    place(logs.map((l) => ({ ...l, c: 0x6a4a32 })), log, toon(0xffffff), 0, { shadow: true, flat: true });
    for (const l of logs) {
      const r = l.r ?? 0, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
      const hx = (3.2 * c + 0.5 * s) * l.s / 2, hz = (3.2 * s + 0.5 * c) * l.s / 2;
      addBox({ minX: l.x - hx, maxX: l.x + hx, minZ: l.z - hz, maxZ: l.z + hz, top: terrainAt(l.x, l.z) + 0.5 * l.s });
    }
  }

  return { benches: furn.bench.list.length, lamps: nLamps, bins: nBins, trees: oaks.length + pines.length + birches.length };
}
