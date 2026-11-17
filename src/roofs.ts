import * as THREE from 'three';
import { inPoly } from './citycollider';

/**
 * Rooftop clutter: the mechanical stuff that lives on a flat city roof. Package HVAC units and their ducts,
 * little AC condensers, mushroom exhaust fans, plumbing stacks and gooseneck vents, electrical and transformer
 * cabinets, roof hatches, skylights, the odd satellite dish, brick chimneys on the two- and three-flats, and on
 * the tall ones a stair penthouse and maybe a wooden water tank on legs.
 *
 * Everything is stamped from a few template geometries into one big buffer per material (no per-piece objects),
 * every solid piece gets a collision box the rat can stand on, and the flat tops become pigeon perches.
 */

type P2 = [number, number];

export interface RoofSpec {
  pts: P2[]; // footprint, CCW
  roofY: number;
  floors: number;
  shop: boolean; // commercial ground floor
}

export interface Perch {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface RoofEnv {
  addBox(b: { minX: number; maxX: number; minZ: number; maxZ: number; top: number }): void;
}

/** Accumulates transformed copies of template geometries into one indexed buffer. */
class Batch {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  private v = new THREE.Vector3();
  private nm = new THREE.Matrix3();
  add(g: THREE.BufferGeometry, m: THREE.Matrix4): void {
    const p = g.attributes.position as THREE.BufferAttribute, n = g.attributes.normal as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
    const base = this.pos.length / 3;
    this.nm.getNormalMatrix(m);
    for (let i = 0; i < p.count; i++) {
      this.v.fromBufferAttribute(p, i).applyMatrix4(m);
      this.pos.push(this.v.x, this.v.y, this.v.z);
      this.v.fromBufferAttribute(n, i).applyMatrix3(this.nm).normalize();
      this.nor.push(this.v.x, this.v.y, this.v.z);
      this.uv.push(uv.getX(i), uv.getY(i));
    }
    const ix = g.index!;
    for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
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

export function buildRoofs(roofs: RoofSpec[], env: RoofEnv, gradient: THREE.DataTexture, rand: () => number): { group: THREE.Group; perches: Perch[] } {
  const group = new THREE.Group();
  const perches: Perch[] = [];
  const toon = (c: number) => new THREE.MeshToonMaterial({ color: c, gradientMap: gradient });
  const M = {
    unit: toon(0xbdb9ae), // galvanised / beige sheet metal
    unitDark: toon(0x8f8b82),
    grille: toon(0x2a2c30),
    metal: toon(0x9aa0a6),
    pipe: toon(0x3d4046),
    green: toon(0x5e7461), // utility cabinet green
    grey: toon(0x7d8187),
    brick: toon(0x8a4a3a),
    brick2: toon(0x9a6a4e),
    stone: toon(0xd6c9b2),
    glass: toon(0x8fb8d0),
    wood: toon(0x7a5a40),
    roofing: toon(0x3a3532),
    white: toon(0xe6e4dc),
  };
  const batches = new Map<THREE.Material, Batch>();
  const BOX = new THREE.BoxGeometry(1, 1, 1);
  const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  const CONE = new THREE.CylinderGeometry(0, 0.5, 1, 10);
  const DOME = new THREE.SphereGeometry(0.5, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  const tmp = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);

  // a placement frame: origin on the roof, rotated by yaw. Pieces are given in local coordinates (y up from the roof).
  let fx = 0, fy = 0, fz = 0, fc = 1, fs = 0, fyaw = 0;
  const frame = (x: number, y: number, z: number, yaw: number) => {
    fx = x; fy = y; fz = z; fyaw = yaw; fc = Math.cos(yaw); fs = Math.sin(yaw);
  };
  const world = (lx: number, lz: number): P2 => [fx + lx * fc + lz * fs, fz - lx * fs + lz * fc];
  const put = (geo: THREE.BufferGeometry, mat: THREE.Material, w: number, h: number, d: number, lx: number, ly: number, lz: number, extra?: THREE.Quaternion) => {
    const [x, z] = world(lx, lz);
    q.setFromAxisAngle(Y, fyaw);
    if (extra) q.multiply(extra);
    tmp.compose(p.set(x, fy + ly, z), q, s.set(w, h, d));
    let b = batches.get(mat);
    if (!b) batches.set(mat, (b = new Batch()));
    b.add(geo, tmp);
  };
  /** box sitting on local y0 */
  const box = (mat: THREE.Material, w: number, h: number, d: number, lx: number, y0: number, lz: number) => put(BOX, mat, w, h, d, lx, y0 + h / 2, lz);
  const cyl = (mat: THREE.Material, r: number, h: number, lx: number, y0: number, lz: number) => put(CYL, mat, r * 2, h, r * 2, lx, y0 + h / 2, lz);
  /** collision for a local-space rectangle, as its world AABB (a touch smaller, so rotated corners don't snag) */
  const solid = (w: number, d: number, lx: number, lz: number, top: number, perch = true) => {
    const hx = (Math.abs(fc) * w + Math.abs(fs) * d) / 2 * 0.92, hz = (Math.abs(fs) * w + Math.abs(fc) * d) / 2 * 0.92;
    const [x, z] = world(lx, lz);
    env.addBox({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, top: fy + top });
    if (perch && w * d > 0.3) {
      const k = w * d > 3 ? 2 : 1;
      for (let i = 0; i < k; i++) {
        const [px, pz] = world(lx + (rand() - 0.5) * w * 0.6, lz + (rand() - 0.5) * d * 0.6);
        perches.push({ x: px, y: fy + top, z: pz, yaw: rand() * Math.PI * 2 });
      }
    }
  };

  // ---- the pieces (each in its own frame; returns nothing, footprint radius is decided by the caller) ----
  const hvac = () => {
    const w = 2.2 + rand() * 1.0, d = 1.3 + rand() * 0.4, h = 1.1 + rand() * 0.3;
    box(M.unitDark, w + 0.2, 0.25, d + 0.2, 0, 0, 0); // curb
    box(M.unit, w, h, d, 0, 0.25, 0);
    const top = 0.25 + h;
    for (const sx of [-1, 1]) {
      cyl(M.grille, 0.36, 0.04, sx * w * 0.24, top, 0); // fan grilles
      cyl(M.metal, 0.06, 0.06, sx * w * 0.24, top + 0.02, 0);
    }
    for (let k = 0; k < 5; k++) box(M.grille, 0.06, h * 0.55, 0.02, -w / 2 + 0.25 + k * 0.12, 0.25 + h * 0.2, d / 2 + 0.005); // louvres
    box(M.grille, 0.02, h * 0.5, d * 0.6, w / 2 + 0.005, 0.25 + h * 0.25, 0); // access panel seam
    // a duct dropping into the roof
    box(M.unitDark, 0.6, 0.5, 0.9, -w / 2 + 0.5, 0.0, -d / 2 - 0.45);
    solid(w + 0.2, d + 0.2, 0, 0, top);
  };
  const condenser = () => {
    const w = 0.75 + rand() * 0.25, h = 0.7 + rand() * 0.25;
    box(M.pipe, w + 0.1, 0.12, w + 0.1, 0, 0, 0); // pad
    box(M.white, w, h, w, 0, 0.12, 0);
    cyl(M.grille, w * 0.4, 0.03, 0, 0.12 + h, 0);
    for (let k = 0; k < 4; k++) box(M.grille, w * 0.8, 0.02, 0.01, 0, 0.2 + k * (h / 4.5), w / 2 + 0.005);
    box(M.pipe, 0.05, 0.05, 0.8, w / 2 - 0.1, 0.18, -w / 2 - 0.4); // refrigerant line
    solid(w + 0.1, w + 0.1, 0, 0, 0.12 + h);
  };
  const exhaustFan = () => {
    const r = 0.32 + rand() * 0.12;
    box(M.unitDark, r * 2.4, 0.3, r * 2.4, 0, 0, 0); // curb
    cyl(M.metal, r, 0.3, 0, 0.3, 0);
    put(DOME, M.metal, r * 3, r * 1.4, r * 3, 0, 0.62, 0); // mushroom hood
    solid(r * 2.4, r * 2.4, 0, 0, 0.62 + r * 0.7);
  };
  const ventStack = () => {
    const n = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < n; k++) {
      const lx = (k - (n - 1) / 2) * 0.45;
      if (rand() < 0.5) {
        cyl(M.pipe, 0.055, 0.55 + rand() * 0.4, lx, 0, 0); // plumbing stack
      } else {
        cyl(M.metal, 0.12, 0.7, lx, 0, 0); // gooseneck / capped vent
        cyl(M.metal, 0.22, 0.08, lx, 0.72, 0);
        put(CONE, M.metal, 0.44, 0.16, 0.44, lx, 0.88, 0);
      }
    }
  };
  const cabinet = () => {
    // electrical / transformer cabinet, conduit running down into the roof
    const w = 0.9 + rand() * 0.8, h = 1.2 + rand() * 0.5, d = 0.55 + rand() * 0.3;
    const mat = rand() < 0.6 ? M.green : M.grey;
    box(M.pipe, w + 0.2, 0.12, d + 0.2, 0, 0, 0);
    box(mat, w, h, d, 0, 0.12, 0);
    box(mat, w + 0.08, 0.06, d + 0.12, 0, 0.12 + h, 0); // drip cap
    box(M.grille, 0.02, h * 0.8, 0.01, 0, 0.2, d / 2 + 0.005); // door split
    for (const sx of [-1, 1]) box(M.grille, 0.04, 0.12, 0.03, sx * 0.1, 0.12 + h * 0.5, d / 2 + 0.01); // handles
    for (let k = 0; k < 3; k++) box(M.grille, w * 0.3, 0.02, 0.01, -w * 0.25, 0.12 + h * 0.75 + k * 0.06, d / 2 + 0.006); // vent slots
    cyl(M.pipe, 0.04, 0.4, w * 0.3, 0, -d / 2 - 0.08); // conduit
    if (rand() < 0.4) {
      // pad-mount transformer beside it: ribbed tank
      box(M.green, 1.0, 1.0, 0.8, w / 2 + 0.75, 0, 0);
      for (let k = 0; k < 5; k++) box(M.green, 0.04, 0.8, 0.95, w / 2 + 0.35 + k * 0.2, 0.1, 0);
      solid(1.0, 0.95, w / 2 + 0.75, 0, 1.0);
    }
    solid(w + 0.2, d + 0.2, 0, 0, 0.18 + h);
  };
  const chimney = (style: THREE.Material) => {
    const w = 0.6 + rand() * 0.4, d = 0.45 + rand() * 0.2, h = 1.0 + rand() * 1.0;
    box(style, w, h, d, 0, 0, 0);
    box(M.stone, w + 0.12, 0.1, d + 0.12, 0, h, 0);
    const flues = 1 + Math.floor(rand() * 2);
    for (let k = 0; k < flues; k++) cyl(M.brick2, 0.09, 0.22, (k - (flues - 1) / 2) * 0.24, h + 0.1, 0);
    solid(w + 0.12, d + 0.12, 0, 0, h + 0.1);
  };
  const hatch = () => {
    box(M.unitDark, 0.9, 0.4, 0.9, 0, 0, 0);
    box(M.metal, 1.0, 0.06, 1.0, 0, 0.4, 0);
    box(M.grille, 0.2, 0.03, 0.05, 0, 0.44, 0.45);
    solid(1.0, 1.0, 0, 0, 0.46);
  };
  const skylight = () => {
    const w = 0.9 + rand() * 0.8, d = 0.8 + rand() * 0.5;
    box(M.unitDark, w, 0.3, d, 0, 0, 0);
    put(BOX, M.glass, w - 0.12, 0.3, d - 0.12, 0, 0.36, 0, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.25)); // pitched glass
    solid(w, d, 0, 0, 0.45, false);
  };
  const dish = () => {
    box(M.pipe, 0.5, 0.08, 0.5, 0, 0, 0);
    cyl(M.pipe, 0.03, 0.7, 0, 0.08, 0);
    put(DOME, M.white, 0.75, 0.16, 0.75, 0, 0.82, 0.05, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2 + 0.6));
    cyl(M.pipe, 0.02, 0.35, 0, 0.75, 0.25);
  };
  const penthouse = (w: number, d: number) => {
    // stair / elevator bulkhead: brick box with a door, a cap, a vent on top
    const h = 2.6 + rand() * 0.8;
    box(M.brick, w, h, d, 0, 0, 0);
    box(M.stone, w + 0.2, 0.2, d + 0.2, 0, h, 0);
    box(M.grille, 0.9, 2.0, 0.04, w * 0.2, 0, d / 2 + 0.01); // door
    cyl(M.metal, 0.25, 0.5, -w * 0.25, h + 0.2, 0);
    solid(w + 0.2, d + 0.2, 0, 0, h + 0.2);
  };
  const waterTower = () => {
    // a cedar tank on a steel frame
    const r = 1.6 + rand() * 0.5, legH = 2.6, tankH = 2.8 + rand() * 0.6;
    box(M.pipe, r * 2.1, 0.2, r * 2.1, 0, 0, 0);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) box(M.pipe, 0.18, legH, 0.18, sx * r * 0.7, 0.2, sz * r * 0.7);
    for (const sx of [-1, 1]) {
      box(M.pipe, r * 1.5, 0.1, 0.1, 0, 0.2 + legH * 0.55, sx * r * 0.7);
      box(M.pipe, 0.1, 0.1, r * 1.5, sx * r * 0.7, 0.2 + legH * 0.55, 0);
    }
    box(M.pipe, r * 1.8, 0.15, r * 1.8, 0, 0.2 + legH, 0); // deck
    const y0 = 0.35 + legH;
    cyl(M.wood, r, tankH, 0, y0, 0);
    for (let k = 0; k < 3; k++) cyl(M.pipe, r + 0.03, 0.06, 0, y0 + 0.3 + k * (tankH - 0.5) / 2, 0); // hoops
    put(CONE, M.roofing, r * 2.25, 1.2, r * 2.25, 0, y0 + tankH + 0.6, 0);
    put(CONE, M.metal, 0.2, 0.3, 0.2, 0, y0 + tankH + 1.3, 0); // finial
    cyl(M.pipe, 0.1, legH + 0.3, r * 0.3, 0, r * 0.3); // down pipe
    // collision: the tank as a block up top, legs as posts (the rat can scurry underneath)
    const [tx, tz] = world(0, 0);
    env.addBox({ minX: tx - r * 0.8, maxX: tx + r * 0.8, minZ: tz - r * 0.8, maxZ: tz + r * 0.8, top: fy + y0 + tankH });
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const [lx, lz] = world(sx * r * 0.7, sz * r * 0.7);
      env.addBox({ minX: lx - 0.12, maxX: lx + 0.12, minZ: lz - 0.12, maxZ: lz + 0.12, top: fy + y0 });
    }
    for (let k = 0; k < 4; k++) {
      const a = rand() * Math.PI * 2;
      const [px, pz] = world(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
      perches.push({ x: px, y: fy + y0 + tankH + 0.05, z: pz, yaw: rand() * 6.28 }); // on the roof's lower rim, roughly
    }
  };

  // ---- place them roof by roof ----
  const edgeDist = (pts: P2[], x: number, z: number): number => {
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
      best = Math.min(best, Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t));
    }
    return best;
  };
  for (const r of roofs) {
    const pts = r.pts, n = pts.length;
    if (n < 3) continue;
    let area = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, yaw = 0, longest = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      area += a[0] * b[1] - b[0] * a[1];
      minX = Math.min(minX, a[0]); maxX = Math.max(maxX, a[0]); minZ = Math.min(minZ, a[1]); maxZ = Math.max(maxZ, a[1]);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > longest) { longest = L; yaw = -Math.atan2(b[1] - a[1], b[0] - a[0]); }
      // pigeons line the cornice
      if (L > 3) {
        const nx = (b[1] - a[1]) / L, nz = -(b[0] - a[0]) / L;
        for (let k = 0; k < Math.min(4, Math.floor(L / 4)); k++) {
          const t = (k + 0.5 + (rand() - 0.5) * 0.6) / Math.min(4, Math.floor(L / 4));
          perches.push({ x: a[0] + (b[0] - a[0]) * t + nx * 0.2, y: r.roofY, z: a[1] + (b[1] - a[1]) * t + nz * 0.2, yaw: Math.atan2(nx, nz) + (rand() - 0.5) * 0.6 });
        }
      }
    }
    area = Math.abs(area) / 2;
    if (area < 30) continue;
    const big = area > 450 || r.floors >= 5 || r.shop;
    const placed: { x: number; z: number; r: number }[] = [];
    /** find a free spot `rad` m across, clear of the edges and of everything placed; then build `fn` there */
    const place = (rad: number, fn: () => void, tries = 18, alignYaw = yaw): boolean => {
      for (let t = 0; t < tries; t++) {
        const x = minX + rand() * (maxX - minX), z = minZ + rand() * (maxZ - minZ);
        if (!inPoly(pts, x, z) || edgeDist(pts, x, z) < rad + 0.7) continue;
        if (placed.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + rad + 0.4)) continue;
        placed.push({ x, z, r: rad });
        frame(x, r.roofY - 0.02, z, alignYaw + (rand() < 0.5 ? 0 : Math.PI));
        fn();
        return true;
      }
      return false;
    };
    const budget = Math.min(16, Math.max(2, Math.round(area / (big ? 55 : 35))));
    let made = 0;
    if (r.floors >= 5 && area > 200) {
      if (place(3.2, () => penthouse(3.5 + rand() * 1.5, 3 + rand())) ) made += 2;
      if (r.floors >= 6 && rand() < 0.35 && place(3.0, waterTower)) made += 2;
    }
    if (big) {
      const units = Math.max(1, Math.round(area / 250));
      for (let k = 0; k < units && made < budget; k++) if (place(1.9, hvac)) made++;
      if (rand() < 0.7 && place(1.3, cabinet)) made++;
      if (rand() < 0.5 && place(0.8, hatch)) made++;
    } else {
      // two- and three-flats: chimneys near the party walls, a hatch, a condenser or two
      const chimMat = rand() < 0.5 ? M.brick : M.brick2;
      const chims = rand() < 0.75 ? 1 + Math.floor(rand() * 2) : 0;
      for (let k = 0; k < chims; k++) if (place(0.6, () => chimney(chimMat))) made++;
      if (rand() < 0.6 && place(0.8, hatch)) made++;
      if (rand() < 0.3 && place(1.0, skylight)) made++;
      if (rand() < 0.15 && place(1.3, cabinet)) made++;
    }
    while (made < budget) {
      const k = rand();
      const ok = k < 0.3 ? place(0.7, condenser) : k < 0.55 ? place(0.7, exhaustFan) : k < 0.85 ? place(0.6, ventStack) : k < 0.93 ? place(0.5, dish, 8, rand() * 6.28) : place(1.0, skylight);
      made++;
      void ok;
    }
  }

  for (const [mat, b] of batches) {
    if (!b.idx.length) continue;
    const mesh = new THREE.Mesh(b.build(), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, perches };
}
