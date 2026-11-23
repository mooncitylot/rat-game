import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Box } from './physics';

export interface BridgeSpec {
  x: number; // street centreline (the bridges all run north-south)
  z0: number; // north bank
  z1: number; // south bank
  half: number; // centreline -> parapet
  cut: number; // centreline -> the end of the river basin either side
}

/**
 * The street bridges. The street itself stays on the ground (the river is cut either side of it), so what sells it as
 * a bridge is on the outside: a stone parapet along each sidewalk, a painted steel girder across each face, and a
 * dark arch below it where the water runs under the street.
 */
export function buildBridges(
  bridges: BridgeSpec[],
  river: { bank: number; water: number },
  ctx: { group: THREE.Group; gradient: THREE.DataTexture; addBox: (b: Box) => void },
): void {
  const parts = new Map<number, THREE.BufferGeometry[]>();
  const add = (color: number, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z).toNonIndexed();
    g.deleteAttribute('uv');
    let l = parts.get(color);
    if (!l) parts.set(color, (l = []));
    l.push(g);
  };
  const STONE = 0xcfc6b0, CAP = 0xe2dac6, STEEL = 0x3f6f6a, DARK = 0x16191d;
  const y = river.bank;
  for (const b of bridges) {
    const len = b.z1 - b.z0, mz = (b.z0 + b.z1) / 2;
    for (const s of [-1, 1]) {
      // parapet with a coping, and end piers at both banks
      const px = b.x + s * b.half;
      add(STONE, 0.45, 1.0, len, px, y, mz);
      add(CAP, 0.6, 0.12, len + 0.1, px, y + 1.0, mz);
      for (const ez of [b.z0, b.z1]) add(STONE, 0.9, 1.5, 0.9, px, y, ez);
      ctx.addBox({ minX: px - 0.3, maxX: px + 0.3, minZ: b.z0, maxZ: b.z1, top: y + 1.12 });
      // the face over the water: a girder band, and the arch's shadow beneath it
      const fx = b.x + s * (b.cut + 0.08);
      add(STEEL, 0.16, 1.1, len - 0.4, fx, y - 1.2, mz);
      add(DARK, 0.12, Math.max(0.2, y - 1.2 - river.water + 0.4), len - 3, fx - s * 0.03, river.water - 0.4, mz);
      for (let k = 1; k < 6; k++) add(STEEL, 0.22, 0.22, 0.22, fx + s * 0.05, y - 0.75, b.z0 + (len * k) / 6); // rivet heads
    }
  }
  for (const [color, list] of parts) {
    const g = mergeGeometries(list, false);
    if (!g) continue;
    const mesh = new THREE.Mesh(g, new THREE.MeshToonMaterial({ color, gradientMap: ctx.gradient }));
    mesh.castShadow = color !== DARK;
    mesh.receiveShadow = true;
    ctx.group.add(mesh);
  }
}
