import type * as THREE from 'three';

/** Axis-aligned collision box. `top` is the walkable surface height; boxes always start at y=0. */
export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  top: number;
}

/** Push a circle (centre = pos.xz) out of every box taller than `pos.y + step`. */
export function pushOut(pos: THREE.Vector3, r: number, boxes: Box[], step: number): void {
  for (let iter = 0; iter < 2; iter++) {
    for (const b of boxes) {
      if (b.top <= pos.y + step) continue;
      const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
      let dx = pos.x - cx;
      let dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 < 1e-8) {
        // centre inside the box: shove out along the shallowest axis
        const l = pos.x - b.minX, rr = b.maxX - pos.x, f = pos.z - b.minZ, k = b.maxZ - pos.z;
        const m = Math.min(l, rr, f, k);
        if (m === l) pos.x = b.minX - r;
        else if (m === rr) pos.x = b.maxX + r;
        else if (m === f) pos.z = b.minZ - r;
        else pos.z = b.maxZ + r;
        continue;
      }
      const d = Math.sqrt(d2);
      dx /= d;
      dz /= d;
      pos.x = cx + dx * r;
      pos.z = cz + dz * r;
    }
  }
}

/** Highest reachable surface (top <= y + step) under a point. */
export function groundAt(x: number, z: number, y: number, r: number, boxes: Box[], step: number): number {
  let ground = 0;
  for (const b of boxes) {
    if (x < b.minX - r || x > b.maxX + r) continue;
    if (z < b.minZ - r || z > b.maxZ + r) continue;
    if (b.top <= y + step && b.top > ground) ground = b.top;
  }
  return ground;
}

/** True if any box taller than `minTop` sits on the straight line a -> b (sampled). */
export function blocked(ax: number, az: number, bx: number, bz: number, boxes: Box[], minTop: number): boolean {
  const N = 10;
  for (let i = 1; i < N; i++) {
    const x = ax + ((bx - ax) * i) / N;
    const z = az + ((bz - az) * i) / N;
    for (const b of boxes) {
      if (b.top > minTop && x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return true;
    }
  }
  return false;
}
