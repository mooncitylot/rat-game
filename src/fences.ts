import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Backyard fences. Chicago lots run from the house back to the alley; the yard between is fenced: a tall board
 * privacy fence or galvanised chain-link along the alley (with a gate) and down both lot lines to the house.
 * Lots are found from each building's rear wall: march straight back from it until the alley (or the next
 * building, or a garage) turns up, and fence the strip the house is as wide as.
 */

type P2 = [number, number];

export interface FenceLot {
  pts: P2[]; // footprint, CCW (outward normal of edge a->b is (dz, -dx))
  street: boolean[]; // per edge: faces a street
  party: boolean[]; // per edge: shared wall
}

export interface FenceEnv {
  ground(x: number, z: number): number;
  inBuilding(x: number, z: number): boolean;
  /** on a street, sidewalk or any other paved walk (fences stay off them) */
  paved(x: number, z: number): boolean;
  /** distance to the nearest alley kerb (negative inside the alley), or null if none nearby */
  alley(x: number, z: number): number | null;
  /** register a thin wall the rat bumps into */
  solid(pts: P2[], top: number): void;
}

const WOOD_H = 1.8;
const LINK_H = 1.25;
const STEP = 0.25; // sampling step along a fence line
const GATE = 1.1;

/** greyscale vertical boards with dark gaps; tinted by the material colour */
function boardTexture(): THREE.Texture {
  const W = 256, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const boards = 8;
  for (let i = 0; i < boards; i++) {
    const v = 205 + Math.floor(Math.sin(i * 12.9898) * 43758.5453 % 1 * 40);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect((i * W) / boards, 0, W / boards, H);
    // a little grain
    g.fillStyle = 'rgba(0,0,0,0.06)';
    for (let k = 0; k < 3; k++) g.fillRect((i * W) / boards + 4 + ((i * 7 + k * 9) % 22), 0, 1, H);
    g.fillStyle = 'rgba(40,30,20,0.85)';
    g.fillRect((i * W) / boards, 0, 2, H); // gap between boards
  }
  // the back rails show through as faint horizontal bands
  g.fillStyle = 'rgba(0,0,0,0.08)';
  g.fillRect(0, H * 0.12, W, 6);
  g.fillRect(0, H * 0.82, W, 6);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** chain-link: a diamond lattice of wire on transparent */
function linkTexture(): THREE.Texture {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, S, S);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 5;
  g.beginPath();
  for (const o of [-S, 0, S]) {
    g.moveTo(o, 0);
    g.lineTo(o + S, S);
    g.moveTo(o + S, 0);
    g.lineTo(o, S);
  }
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

export function buildBackyardFences(lots: FenceLot[], env: FenceEnv, gradient: THREE.DataTexture, rand: () => number): THREE.Group {
  const group = new THREE.Group();
  const toon = (c: number, map?: THREE.Texture) => new THREE.MeshToonMaterial({ color: c, gradientMap: gradient, map: map ?? null });
  const boards = boardTexture();
  const woodMats = [0x9a7350, 0xb07a48, 0x8c8478, 0x74563c, 0xa89a86].map((c) => toon(c, boards));
  const woodTrim = [0x6f513a, 0x7d5636, 0x6a645c, 0x543e2c, 0x7a6f60].map((c) => toon(c));
  const steel = toon(0x8e959c);
  const linkMat = new THREE.MeshToonMaterial({ color: 0xaab0b6, gradientMap: gradient, map: linkTexture(), alphaTest: 0.45, side: THREE.DoubleSide });
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const push = (m: THREE.Material, g: THREE.BufferGeometry) => {
    let l = batches.get(m);
    if (!l) batches.set(m, (l = []));
    l.push(g);
  };
  const up = new THREE.Vector3(0, 1, 0);
  /** a box of size (len along the fence, h, d) centred at (x, y, z), turned to the fence direction */
  const box = (m: THREE.Material, len: number, h: number, d: number, x: number, y: number, z: number, ang: number, uTile = 0): void => {
    const g = new THREE.BoxGeometry(len, h, d);
    if (uTile) {
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (len / uTile));
    }
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(up, ang), new THREE.Vector3(1, 1, 1)));
    push(m, g);
  };
  const plane = (m: THREE.Material, len: number, h: number, x: number, y: number, z: number, ang: number, tile: number): void => {
    const g = new THREE.PlaneGeometry(len, h);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (len / tile), uv.getY(i) * (h / tile));
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(up, ang), new THREE.Vector3(1, 1, 1)));
    push(m, g);
  };

  // ---- fences already placed, so neighbouring lots share a line instead of doubling it ----
  const CELL = 6;
  const placed = new Map<number, { ax: number; az: number; bx: number; bz: number; ux: number; uz: number }[]>();
  const covered = (x: number, z: number, ux: number, uz: number): boolean => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const s of placed.get((cx + i) * 100003 + (cz + j)) ?? []) {
        const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
        const d = Math.hypot(x - s.ax - dx * t, z - s.az - dz * t);
        if (d < 1.1 && Math.abs(s.ux * ux + s.uz * uz) > 0.85) return true; // running alongside one
      }
    }
    return false;
  };
  const register = (ax: number, az: number, bx: number, bz: number): void => {
    const L = Math.hypot(bx - ax, bz - az) || 1;
    const s = { ax, az, bx, bz, ux: (bx - ax) / L, uz: (bz - az) / L };
    const pad = 1.2;
    for (let ix = Math.floor((Math.min(ax, bx) - pad) / CELL); ix <= Math.floor((Math.max(ax, bx) + pad) / CELL); ix++) {
      for (let iz = Math.floor((Math.min(az, bz) - pad) / CELL); iz <= Math.floor((Math.max(az, bz) + pad) / CELL); iz++) {
        const k = ix * 100003 + iz;
        let l = placed.get(k);
        if (!l) placed.set(k, (l = []));
        l.push(s);
      }
    }
  };

  const blocked = (x: number, z: number): boolean => {
    if (env.inBuilding(x, z) || env.paved(x, z)) return true;
    const a = env.alley(x, z);
    return a !== null && a < 0.3;
  };

  /** one straight run of fence between posts; the panel sits on the ground at its middle */
  const panel = (style: number, tint: number, ax: number, az: number, bx: number, bz: number): void => {
    const len = Math.hypot(bx - ax, bz - az);
    const ang = -Math.atan2(bz - az, bx - ax);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const y = env.ground(mx, mz) - 0.05;
    if (style === 0) {
      box(woodMats[tint], len, WOOD_H - 0.1, 0.035, mx, y + 0.05 + (WOOD_H - 0.1) / 2, mz, ang, 1.2);
      box(woodTrim[tint], len, 0.05, 0.1, mx, y + WOOD_H + 0.02, mz, ang); // cap rail
      env.solid(slab(ax, az, bx, bz, 0.08), y + WOOD_H + 0.05);
    } else {
      plane(linkMat, len, LINK_H - 0.08, mx, y + 0.04 + (LINK_H - 0.08) / 2, mz, ang, 0.22);
      box(steel, len, 0.045, 0.045, mx, y + LINK_H, mz, ang); // top rail
      env.solid(slab(ax, az, bx, bz, 0.06), y + LINK_H + 0.03);
    }
  };
  const post = (style: number, tint: number, x: number, z: number, ang: number, big = false): void => {
    const y = env.ground(x, z) - 0.05;
    if (style === 0) {
      const h = WOOD_H + 0.12;
      box(woodTrim[tint], big ? 0.14 : 0.1, h, big ? 0.14 : 0.1, x, y + h / 2, z, ang);
    } else {
      const h = LINK_H + (big ? 0.12 : 0.06);
      box(steel, big ? 0.09 : 0.06, h, big ? 0.09 : 0.06, x, y + h / 2, z, ang);
      box(steel, big ? 0.13 : 0.09, 0.05, big ? 0.13 : 0.09, x, y + h + 0.02, z, ang); // cap
    }
  };
  /** a thin collision wall along a->b */
  const slab = (ax: number, az: number, bx: number, bz: number, w: number): P2[] => {
    const L = Math.hypot(bx - ax, bz - az) || 1;
    const nx = ((bz - az) / L) * w, nz = (-(bx - ax) / L) * w;
    // CCW in the collider's sense (outward normal (dz, -dx))
    return [[ax - nx, az - nz], [bx - nx, bz - nz], [bx + nx, bz + nz], [ax + nx, az + nz]];
  };

  /**
   * Fence a -> b where it can stand: not in a building, on pavement or in the alley, and not alongside a fence
   * that's already there. `gate` (0..1 along the line) leaves a gap with heavier posts either side.
   */
  let runs = 0;
  const fence = (style: number, tint: number, ax: number, az: number, bx: number, bz: number, gate = -1): void => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.8) return;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    const n = Math.floor(L / STEP);
    const ok: boolean[] = [];
    const g0 = gate >= 0 ? gate * L - GATE / 2 : Infinity, g1 = gate >= 0 ? gate * L + GATE / 2 : -Infinity;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * L;
      const x = ax + ux * t, z = az + uz * t;
      ok.push(!(t > g0 && t < g1) && !blocked(x, z) && !covered(x, z, ux, uz));
    }
    const ang = -Math.atan2(uz, ux);
    let i = 0;
    while (i <= n) {
      if (!ok[i]) { i++; continue; }
      let j = i;
      while (j + 1 <= n && ok[j + 1]) j++;
      const t0 = (i / n) * L, t1 = (j / n) * L;
      if (t1 - t0 >= 0.75) {
        const span = style === 0 ? 2.4 : 3.0;
        const k = Math.max(1, Math.round((t1 - t0) / span));
        for (let p = 0; p < k; p++) {
          const s0 = t0 + ((t1 - t0) * p) / k, s1 = t0 + ((t1 - t0) * (p + 1)) / k;
          panel(style, tint, ax + ux * s0, az + uz * s0, ax + ux * s1, az + uz * s1);
        }
        for (let p = 0; p <= k; p++) {
          const s = t0 + ((t1 - t0) * p) / k;
          const atGate = Math.abs(s - g0) < 0.3 || Math.abs(s - g1) < 0.3;
          post(style, tint, ax + ux * s, az + uz * s, ang, p === 0 || p === k || atGate);
        }
        register(ax + ux * t0, az + uz * t0, ax + ux * t1, az + uz * t1);
        runs++;
      }
      i = j + 1;
    }
  };

  // ---- find each house's backyard ----
  const MAX_DEPTH = 45;
  for (const lot of lots) {
    const pts = lot.pts, n = pts.length;
    if (n < 3 || !lot.street.some(Boolean)) continue; // only houses that front a street have a backyard
    // the main street face: the longest one
    let fnx = 0, fnz = 0, fl = 0;
    for (let i = 0; i < n; i++) {
      if (!lot.street[i]) continue;
      const a = pts[i], b = pts[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > fl) { fl = L; fnx = (b[1] - a[1]) / L; fnz = -(b[0] - a[0]) / L; }
    }
    // the rear wall: faces away from the street, and a straight walk back from it ends at an alley or another building
    let best: { i: number; L: number; nx: number; nz: number; t: number; kind: 'alley' | 'bld' } | null = null;
    for (let i = 0; i < n; i++) {
      if (lot.street[i] || lot.party[i]) continue;
      const a = pts[i], b = pts[(i + 1) % n];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 3) continue;
      const nx = (b[1] - a[1]) / L, nz = -(b[0] - a[0]) / L;
      if (nx * fnx + nz * fnz > -0.8) continue;
      const mx = (a[0] + b[0]) / 2 + nx * 0.3, mz = (a[1] + b[1]) / 2 + nz * 0.3;
      // a garage on the alley doesn't end the walk: keep going (a little way) to find the alley behind it
      let hit: { t: number; kind: 'alley' | 'bld' } | null = null;
      let tb = -1;
      for (let t = 0.5; t < MAX_DEPTH; t += 0.5) {
        const x = mx + nx * t, z = mz + nz * t;
        if (env.paved(x, z)) break; // a street or sidewalk behind: a through lot or a corner, leave it open
        const al = env.alley(x, z);
        if (al !== null && al < 0.3) { hit = { t, kind: 'alley' }; break; }
        if (tb < 0 && env.inBuilding(x, z)) {
          tb = t;
          if (t > 12) break; // the next street's house, back to back with this one
        }
        if (tb >= 0 && t > tb + 12) break;
      }
      if (!hit && tb >= 0) hit = { t: tb, kind: 'bld' };
      if (!hit) continue;
      const better = !best || (hit.kind === 'alley' && best.kind !== 'alley') || (hit.kind === best.kind && L > best.L);
      if (better) best = { i, L, nx, nz, t: hit.t, kind: hit.kind };
    }
    if (!best) continue;
    const a = pts[best.i], b = pts[(best.i + 1) % n];
    const ux = (b[0] - a[0]) / best.L, uz = (b[1] - a[1]) / best.L;
    const ox = (a[0] + b[0]) / 2 + best.nx * 0.3, oz = (a[1] + b[1]) / 2 + best.nz * 0.3;
    // the lot is as wide as the house (plus a little for the gangway)
    let u0 = Infinity, u1 = -Infinity;
    for (const p of pts) {
      const u = (p[0] - ox) * ux + (p[1] - oz) * uz;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
    }
    if (u1 - u0 > 40) continue; // a big block of flats: a courtyard, not a backyard
    u0 -= 0.5;
    u1 += 0.5;
    let back: number, backFence: boolean;
    if (best.kind === 'alley') { back = best.t - 1.0; backFence = true; }
    else if (best.t > 12) { back = best.t / 2; backFence = true; } // the next street's house: the lot line is halfway
    else { back = best.t - 0.4; backFence = false; } // a garage on the alley closes the yard
    if (back < 3) continue;
    const P = (u: number, v: number): P2 => [ox + ux * u + best!.nx * v, oz + uz * u + best!.nz * v];
    const style = rand() < 0.62 ? 0 : 1;
    const tint = Math.floor(rand() * woodMats.length);
    if (backFence) {
      const [x0, z0] = P(u0 - 1.5, back), [x1, z1] = P(u1 + 1.5, back); // reach over the gangway to the neighbour's
      fence(style, tint, x0, z0, x1, z1, 0.25 + rand() * 0.5);
    }
    // the lot lines: from the back fence forward to where the house's side wall begins
    for (const [u, inward] of [[u0, 1], [u1, -1]] as const) {
      let v = back;
      while (v > -6) {
        const [x, z] = P(u + inward * 0.9, v);
        if (env.inBuilding(x, z)) break;
        v -= 0.25;
      }
      const [x0, z0] = P(u, back), [x1, z1] = P(u, Math.max(v, -6));
      fence(style, tint, x0, z0, x1, z1);
    }
  }

  for (const [mat, geos] of batches) {
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = mat !== linkMat;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.runs = runs;
  return group;
}
