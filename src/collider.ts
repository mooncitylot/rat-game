import type * as THREE from 'three';
import { blocked, groundAt, pushOut, type Box } from './physics';

/**
 * What the characters stand on and bump into. The flat grid world answers with axis-aligned boxes;
 * the generated city answers with a heightmap and building polygons.
 */
export interface Collider {
  /** Bare ground height at (x, z). */
  terrain(x: number, z: number): number;
  /** Highest surface under (x, z) that a character at height y can reach (top <= y + step). */
  ground(x: number, z: number, y: number, r: number, step: number): number;
  /** Push a circle out of anything taller than pos.y + step. */
  pushOut(pos: THREE.Vector3, r: number, step: number): void;
  /** Is something taller than minTop between a and b (line of sight)? */
  blocked(ax: number, az: number, bx: number, bz: number, minTop: number): boolean;
  /** Is the point (with margin) inside geometry or underground? Used to keep the camera out of walls. */
  solidAt(x: number, y: number, z: number, margin: number): boolean;
}

export class BoxCollider implements Collider {
  constructor(readonly boxes: Box[]) {}
  terrain(): number {
    return 0;
  }
  ground(x: number, z: number, y: number, r: number, step: number): number {
    return groundAt(x, z, y, r, this.boxes, step);
  }
  pushOut(pos: THREE.Vector3, r: number, step: number): void {
    pushOut(pos, r, this.boxes, step);
  }
  blocked(ax: number, az: number, bx: number, bz: number, minTop: number): boolean {
    return blocked(ax, az, bx, bz, this.boxes, minTop);
  }
  solidAt(x: number, y: number, z: number, margin: number): boolean {
    if (y < 0.12) return true;
    for (const b of this.boxes) {
      if (b.bottom !== undefined && y < b.bottom - margin) continue;
      if (y < b.top + margin && x > b.minX - margin && x < b.maxX + margin && z > b.minZ - margin && z < b.maxZ + margin) return true;
    }
    return false;
  }
}
