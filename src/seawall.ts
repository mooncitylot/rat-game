import * as THREE from 'three';
import { inPoly, makePoly, type Poly } from './citycollider';

type P2 = [number, number];

/** a closed shoreline: the lake gets Chicago's stepped limestone revetment, harbours get a vertical concrete wall */
export interface ShoreRing {
  pts: P2[];
  kind: 'lake' | 'harbor';
}

export interface SeawallCtx {
  group: THREE.Group;
  gradient: THREE.DataTexture;
  terrainAt: (x: number, z: number) => number;
  floorY: number; // lake bed
  waterY: number; // water surface
  topY: number; // the promenade
  rings: ShoreRing[];
  /** the ring edge is artificial (it runs along the edge of the baked map) */
  isBorder: (a: P2, b: P2) => boolean;
  addPoly: (p: Poly) => void;
  windCCW: (pts: P2[]) => P2[];
  rand: () => number;
}

/** how far the stepped treads reach out into the water, and how wide the concrete apron is behind them */
export const SEAWALL_STEPS = 4; // treads, one metre each
export const SEAWALL_APRON = 4; // metres of concrete behind the top step

const LIME = [0xdad3bd, 0xd0c8af, 0xe1dac6, 0xc9c1a8, 0xd6cdb2];
const CONC = [0xbdbab0, 0xb3b0a5, 0xc4c1b7];

const shade = (hex: number, k: number) => {
  const c = new THREE.Color(hex);
  return c.multiplyScalar(k);
};

/**
 * Distance helpers shared by the terrain carve and the mesh: the polyline edges of each ring that are real shoreline.
 */
export function shoreEdges(rings: ShoreRing[], isBorder: (a: P2, b: P2) => boolean): { ax: number; az: number; bx: number; bz: number; ring: number }[] {
  const out: { ax: number; az: number; bx: number; bz: number; ring: number }[] = [];
  rings.forEach((r, ri) => {
    for (let i = 0; i < r.pts.length; i++) {
      const a = r.pts[i], b = r.pts[(i + 1) % r.pts.length];
      if (!isBorder(a, b)) out.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], ring: ri });
    }
  });
  return out;
}

export function buildSeawall(ctx: SeawallCtx): void {
  const { group, terrainAt, floorY, waterY, topY } = ctx;
  const pos: number[] = [], col: number[] = [];
  const tri = (a: number[], b: number[], c: number[], color: THREE.Color) => {
    for (const p of [a, b, c]) {
      pos.push(p[0], p[1], p[2]);
      col.push(color.r, color.g, color.b);
    }
  };
  const quad = (a: number[], b: number[], c: number[], d: number[], color: THREE.Color) => {
    tri(a, b, c, color);
    tri(a, c, d, color);
  };
  const bollards: THREE.BufferGeometry[] = [];
  const treadBase = floorY + 0.05, treadTop = topY - 0.11;

  ctx.rings.forEach((ring) => {
    const n = ring.pts.length;
    // chains of consecutive real-shore edges
    const keep: boolean[] = [];
    for (let i = 0; i < n; i++) keep.push(!ctx.isBorder(ring.pts[i], ring.pts[(i + 1) % n]));
    let start = keep.indexOf(false);
    if (start < 0) start = 0;
    const chains: P2[][] = [];
    let cur: P2[] = [];
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (keep[i]) {
        if (!cur.length) cur.push(ring.pts[i]);
        cur.push(ring.pts[(i + 1) % n]);
      } else if (cur.length) {
        chains.push(cur);
        cur = [];
      }
    }
    if (cur.length) chains.push(cur);

    for (const chain of chains) {
      // resample every ~2.4 m (a block of limestone), keeping the corners
      const S: { x: number; z: number; tx: number; tz: number }[] = [];
      for (let i = 0; i + 1 < chain.length; i++) {
        const a = chain[i], b = chain[i + 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 0.01) continue;
        const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
        const cnt = Math.max(1, Math.round(L / 2.4));
        for (let k = 0; k < cnt; k++) S.push({ x: a[0] + (b[0] - a[0]) * (k / cnt), z: a[1] + (b[1] - a[1]) * (k / cnt), tx, tz });
      }
      const last = chain[chain.length - 1], prev = chain[chain.length - 2];
      const ll = Math.hypot(last[0] - prev[0], last[1] - prev[1]) || 1;
      S.push({ x: last[0], z: last[1], tx: (last[0] - prev[0]) / ll, tz: (last[1] - prev[1]) / ll });
      if (S.length < 2) continue;
      // inland normal: the side that is not water
      const m = S[S.length >> 1];
      let nSign = 1;
      if (inPoly(ring.pts, m.x - m.tz * 2, m.z + m.tx * 2)) nSign = -1;
      // smooth the normals over the corners so neighbouring blocks meet cleanly
      const N = S.map((_s, i) => {
        const a = S[Math.max(0, i - 1)], b = S[Math.min(S.length - 1, i + 1)];
        const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        return [(-(b.z - a.z) / l) * nSign, ((b.x - a.x) / l) * nSign];
      });
      const at = (i: number, s: number, y: number): number[] => [S[i].x + N[i][0] * s, y, S[i].z + N[i][1] * s];
      const ground = (i: number, s: number) => terrainAt(S[i].x + N[i][0] * s, S[i].z + N[i][1] * s);

      for (let i = 0; i + 1 < S.length; i++) {
        const j = i + 1;
        const tone = LIME[(i * 7 + (ring.kind === 'harbor' ? 3 : 0)) % LIME.length];
        const concrete = CONC[(i * 5) % CONC.length];
        if (ring.kind === 'lake') {
          // stepped limestone: SEAWALL_STEPS treads, each 1 m wide and a little higher than the last
          let prevH = treadBase - 0.45;
          for (let t = 0; t < SEAWALL_STEPS; t++) {
            const s0 = -SEAWALL_STEPS + t, s1 = s0 + 1;
            const planned = treadBase + ((treadTop - treadBase) * t) / (SEAWALL_STEPS - 1);
            const h = Math.max(planned, (ground(i, s0 + 0.5) + ground(j, s0 + 0.5)) / 2 + 0.03);
            const tc = shade(tone, 0.96 + t * 0.02);
            quad(at(i, s0, h), at(i, s1, h), at(j, s1, h), at(j, s0, h), tc); // tread
            quad(at(i, s0, prevH), at(i, s0, h), at(j, s0, h), at(j, s0, prevH), shade(tone, 0.8)); // riser, facing the water
            prevH = h;
          }
          // top riser up to the apron
          const apronY = (a: number, b: number) => Math.max(topY, (ground(a, 1) + ground(b, 1)) / 2) + 0.02;
          const ay = apronY(i, j);
          quad(at(i, 0, prevH), at(i, 0, ay), at(j, 0, ay), at(j, 0, prevH), shade(tone, 0.78));
          quad(at(i, 0, ay), at(i, SEAWALL_APRON, ay), at(j, SEAWALL_APRON, ay), at(j, 0, ay), shade(concrete, 1));
          quad(at(i, SEAWALL_APRON, ay), at(i, SEAWALL_APRON, ay - 0.7), at(j, SEAWALL_APRON, ay - 0.7), at(j, SEAWALL_APRON, ay), shade(concrete, 0.8)); // inland lip
        } else {
          // harbour: a plain vertical concrete face with a coping stone, and an apron behind it
          const ay = Math.max(topY, (ground(i, 1) + ground(j, 1)) / 2) + 0.02;
          quad(at(i, 0, floorY - 0.3), at(i, 0, ay), at(j, 0, ay), at(j, 0, floorY - 0.3), shade(concrete, 0.82));
          quad(at(i, 0, ay), at(i, 0.5, ay + 0.1), at(j, 0.5, ay + 0.1), at(j, 0, ay), shade(tone, 1));
          quad(at(i, 0.5, ay + 0.1), at(i, SEAWALL_APRON * 0.75, ay), at(j, SEAWALL_APRON * 0.75, ay), at(j, 0.5, ay + 0.1), shade(concrete, 1));
          quad(at(i, SEAWALL_APRON * 0.75, ay), at(i, SEAWALL_APRON * 0.75, ay - 0.7), at(j, SEAWALL_APRON * 0.75, ay - 0.7), at(j, SEAWALL_APRON * 0.75, ay), shade(concrete, 0.8));
          // mooring bollards along the quay
          if (i % 4 === 1) {
            const b = new THREE.CylinderGeometry(0.11, 0.14, 0.42, 8).toNonIndexed();
            b.deleteAttribute('uv');
            b.translate(S[i].x + N[i][0] * 0.9, ay + 0.2, S[i].z + N[i][1] * 0.9);
            const c = new THREE.Color(0x2b2f33);
            b.setAttribute('color', new THREE.BufferAttribute(Float32Array.from({ length: b.getAttribute('position').count * 3 }, (_, k) => [c.r, c.g, c.b][k % 3]), 3));
            bollards.push(b);
          }
        }
      }

      // the rat can't wade onto the stones: wall the steps off like the water itself
      const wall = ring.kind === 'lake' ? -SEAWALL_STEPS - 0.2 : -0.3;
      for (let i = 0; i + 1 < S.length; i++) {
        const j = i + 1;
        const pts: P2[] = [[at(i, wall, 0)[0], at(i, wall, 0)[2]], [at(j, wall, 0)[0], at(j, wall, 0)[2]], [at(j, 0.15, 0)[0], at(j, 0.15, 0)[2]], [at(i, 0.15, 0)[0], at(i, 0.15, 0)[2]]];
        ctx.addPoly(makePoly(ctx.windCCW(pts), waterY + 2.2));
      }
    }
  });

  if (pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ctx.gradient, side: THREE.DoubleSide });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (bollards.length) {
    const merged = mergeAll(bollards);
    const mesh = new THREE.Mesh(merged, new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ctx.gradient }));
    mesh.castShadow = true;
    group.add(mesh);
  }
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [];
  for (const p of parts) {
    pos.push(...Array.from(p.getAttribute('position').array));
    col.push(...Array.from(p.getAttribute('color').array));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
