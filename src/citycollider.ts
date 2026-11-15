import * as THREE from 'three';
import type { Collider } from './collider';
import { blocked as boxBlocked, groundAt, pushOut, type Box } from './physics';

export interface Poly {
  pts: [number, number][]; // positive winding: outward normal of edge a->b is (dz, -dx)
  top: number; // absolute roof height
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function makePoly(pts: [number, number][], top: number): Poly {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { pts, top, minX, maxX, minZ, maxZ };
}

export function inPoly(pts: [number, number][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

const CELL = 16;
const key = (ix: number, iz: number) => ix * 100003 + iz;

/** Heightmap terrain + building polygons + prop boxes, behind a spatial hash. */
export class CityCollider implements Collider {
  private grid = new Map<number, number[]>();
  readonly boxes: Box[] = [];
  private boxGrid = new Map<number, Box[]>();

  private all: Poly[];

  constructor(private terrainFn: (x: number, z: number) => number, readonly polys: Poly[], private limit: { x0: number; x1: number; z0: number; z1: number }) {
    this.all = [];
    polys.forEach((p) => this.addPoly(p));
  }

  /** Register a polygon obstacle (a building, a stadium wall) after construction. */
  addPoly(p: Poly): void {
    const i = this.all.length;
    this.all.push(p);
    for (let ix = Math.floor(p.minX / CELL); ix <= Math.floor(p.maxX / CELL); ix++) {
      for (let iz = Math.floor(p.minZ / CELL); iz <= Math.floor(p.maxZ / CELL); iz++) {
        const k = key(ix, iz);
        let l = this.grid.get(k);
        if (!l) this.grid.set(k, (l = []));
        l.push(i);
      }
    }
  }

  private walkGrid = new Map<number, { ax: number; az: number; bx: number; bz: number; h: number }[]>();
  private walkHalf = 0;
  private walkRise = 0;

  /** Raised sidewalk slabs: anything within `half` of a segment stands `rise` above the terrain. */
  setWalkways(lines: { pts: [number, number][]; half: number }[], rise: number): void {
    this.walkRise = rise;
    for (const ln of lines) {
      const h = ln.half;
      for (let i = 0; i + 1 < ln.pts.length; i++) {
        const [ax, az] = ln.pts[i], [bx, bz] = ln.pts[i + 1];
        const seg = { ax, az, bx, bz, h };
        for (let ix = Math.floor((Math.min(ax, bx) - h) / CELL); ix <= Math.floor((Math.max(ax, bx) + h) / CELL); ix++) {
          for (let iz = Math.floor((Math.min(az, bz) - h) / CELL); iz <= Math.floor((Math.max(az, bz) + h) / CELL); iz++) {
            const k = key(ix, iz);
            let l = this.walkGrid.get(k);
            if (!l) this.walkGrid.set(k, (l = []));
            l.push(seg);
          }
        }
      }
    }
    this.walkHalf = 1;
  }

  /** Height of the sidewalk slab at (x, z) above the terrain, or 0. */
  slab(x: number, z: number): number {
    if (!this.walkHalf) return 0;
    const l = this.walkGrid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!l) return 0;
    for (const s of l) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      if ((x - s.ax - dx * t) ** 2 + (z - s.az - dz * t) ** 2 <= s.h * s.h) return this.walkRise;
    }
    return 0;
  }

  /** Register a prop's box (call after construction). */
  addBox(b: Box): void {
    this.boxes.push(b);
    for (let ix = Math.floor(b.minX / CELL); ix <= Math.floor(b.maxX / CELL); ix++) {
      for (let iz = Math.floor(b.minZ / CELL); iz <= Math.floor(b.maxZ / CELL); iz++) {
        const k = key(ix, iz);
        let l = this.boxGrid.get(k);
        if (!l) this.boxGrid.set(k, (l = []));
        l.push(b);
      }
    }
  }

  private near(x: number, z: number): Poly[] {
    const l = this.grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    return l ? l.map((i) => this.all[i]) : [];
  }
  private nearBoxes(x: number, z: number): Box[] {
    return this.boxGrid.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? [];
  }

  terrain(x: number, z: number): number {
    return this.terrainFn(x, z);
  }

  ground(x: number, z: number, y: number, r: number, step: number): number {
    let g = this.terrainFn(x, z) + this.slab(x, z);
    for (const p of this.near(x, z)) {
      if (p.top <= y + step && p.top > g && x > p.minX - r && x < p.maxX + r && z > p.minZ - r && z < p.maxZ + r && inPoly(p.pts, x, z)) g = p.top;
    }
    const b = groundAt(x, z, y, r, this.nearBoxes(x, z), step);
    return Math.max(g, b);
  }

  pushOut(pos: THREE.Vector3, r: number, step: number): void {
    pos.x = Math.max(this.limit.x0, Math.min(this.limit.x1, pos.x));
    pos.z = Math.max(this.limit.z0, Math.min(this.limit.z1, pos.z));
    for (let iter = 0; iter < 2; iter++) {
      for (const p of this.near(pos.x, pos.z)) {
        if (p.top <= pos.y + step) continue;
        if (pos.x < p.minX - r || pos.x > p.maxX + r || pos.z < p.minZ - r || pos.z > p.maxZ + r) continue;
        const pts = p.pts;
        let best = Infinity, bx = 0, bz = 0, nx = 0, nz = 0;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const dx = b[0] - a[0], dz = b[1] - a[1];
          const l2 = dx * dx + dz * dz;
          let t = l2 > 0 ? ((pos.x - a[0]) * dx + (pos.z - a[1]) * dz) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          const cx = a[0] + dx * t, cz = a[1] + dz * t;
          const d2 = (pos.x - cx) ** 2 + (pos.z - cz) ** 2;
          if (d2 < best) {
            best = d2;
            bx = cx;
            bz = cz;
            const l = Math.sqrt(l2) || 1;
            nx = dz / l;
            nz = -dx / l;
          }
        }
        const d = Math.sqrt(best);
        if (inPoly(pts, pos.x, pos.z)) {
          pos.x = bx + nx * (r + 0.01);
          pos.z = bz + nz * (r + 0.01);
        } else if (d < r) {
          const k = d > 1e-6 ? r / d : 0;
          pos.x = d > 1e-6 ? bx + (pos.x - bx) * k : bx + nx * r;
          pos.z = d > 1e-6 ? bz + (pos.z - bz) * k : bz + nz * r;
        }
      }
      pushOut(pos, r, this.nearBoxes(pos.x, pos.z), step);
    }
  }

  blocked(ax: number, az: number, bx: number, bz: number, minTop: number): boolean {
    const N = 12;
    for (let i = 1; i < N; i++) {
      const x = ax + ((bx - ax) * i) / N, z = az + ((bz - az) * i) / N;
      const g = this.terrainFn(x, z);
      for (const p of this.near(x, z)) if (p.top > g + minTop && inPoly(p.pts, x, z)) return true;
    }
    return boxBlocked(ax, az, bx, bz, this.boxes, minTop);
  }

  solidAt(x: number, y: number, z: number, margin: number): boolean {
    if (y < this.terrainFn(x, z) + this.slab(x, z) + 0.12) return true;
    for (const p of this.near(x, z)) {
      if (y < p.top + margin && x > p.minX - margin && x < p.maxX + margin && z > p.minZ - margin && z < p.maxZ + margin) {
        if (inPoly(p.pts, x, z)) return true;
        // within `margin` of a wall
        for (let i = 0; i < p.pts.length; i++) {
          const a = p.pts[i], b = p.pts[(i + 1) % p.pts.length];
          const dx = b[0] - a[0], dz = b[1] - a[1];
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
          if ((x - a[0] - dx * t) ** 2 + (z - a[1] - dz * t) ** 2 < margin * margin) return true;
        }
      }
    }
    for (const b of this.nearBoxes(x, z)) {
      if (y < b.top + margin && x > b.minX - margin && x < b.maxX + margin && z > b.minZ - margin && z < b.maxZ + margin) return true;
    }
    return false;
  }
}
