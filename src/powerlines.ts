import * as THREE from 'three';

type P2 = [number, number];

const POLE_H = 8;
const ARM_Y = POLE_H - 0.6;
const ARM_OFFS = [-0.9, 0, 0.9]; // three wires per span, spread along the crossarm
const SAG = 0.9;
const MAX_SPAN = 60;

interface Span {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
}

const spanPoint = (s: Span, u: number, out: THREE.Vector3): THREE.Vector3 =>
  out.set(
    s.ax + (s.bx - s.ax) * u,
    s.ay + (s.by - s.ay) * u - SAG * 4 * u * (1 - u),
    s.az + (s.bz - s.az) * u,
  );

export interface PowerLines {
  group: THREE.Group;
  /** spots on the wires a pigeon can sit */
  perches: { x: number; y: number; z: number; yaw: number }[];
}

/**
 * Utility poles down the named streets and sagging wires between them (pigeons perch on them: see pigeons.ts).
 */
export function buildPowerLines(opts: {
  streets: { pts: P2[]; half: number; name: string }[];
  terrainAt: (x: number, z: number) => number;
  blocked: (x: number, z: number) => boolean;
  addBox: (b: { minX: number; maxX: number; minZ: number; maxZ: number; top: number }) => void;
  gradient: THREE.DataTexture;
  nearEdge: (x: number, z: number, m: number) => boolean;
  rand: () => number;
}): PowerLines {
  const { terrainAt, blocked, gradient, nearEdge, rand } = opts;
  const group = new THREE.Group();
  const toon = (c: number) => new THREE.MeshToonMaterial({ color: c, gradientMap: gradient });

  // ---- poles ----
  const poles: { x: number; z: number; ang: number; y: number }[] = [];
  const spans: Span[] = [];
  const STEP = 38;
  for (const st of opts.streets) {
    if (!st.name) continue;
    const off = st.half + 2.4;
    let prev: { x: number; z: number; y: number; ang: number } | null = null;
    let carry = STEP * 0.5;
    for (let k = 0; k + 1 < st.pts.length; k++) {
      const a = st.pts[k], b = st.pts[k + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-3) continue;
      const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
      while (carry < L) {
        const px = a[0] + tx * carry + -tz * off;
        const pz = a[1] + tz * 0 + tz * carry + tx * off;
        carry += STEP;
        if (blocked(px, pz) || nearEdge(px, pz, 14)) {
          prev = null; // break the line
          continue;
        }
        const cur = { x: px, z: pz, y: terrainAt(px, pz), ang: Math.atan2(tx, tz) };
        poles.push(cur);
        opts.addBox({ minX: px - 0.2, maxX: px + 0.2, minZ: pz - 0.2, maxZ: pz + 0.2, top: cur.y + POLE_H });
        if (prev && Math.hypot(cur.x - prev.x, cur.z - prev.z) < MAX_SPAN) {
          for (const o of ARM_OFFS) {
            // wire attach points slide along each crossarm (perpendicular to the street)
            const pa = { x: prev.x + Math.cos(prev.ang) * o, z: prev.z - Math.sin(prev.ang) * o };
            const pb = { x: cur.x + Math.cos(cur.ang) * o, z: cur.z - Math.sin(cur.ang) * o };
            spans.push({ ax: pa.x, ay: prev.y + ARM_Y + 0.1, az: pa.z, bx: pb.x, by: cur.y + ARM_Y + 0.1, bz: pb.z });
          }
        }
        prev = cur;
      }
      carry -= L;
    }
  }
  if (!poles.length) return { group, perches: [] };

  const poleGeo = new THREE.CylinderGeometry(0.14, 0.2, POLE_H, 6);
  poleGeo.translate(0, POLE_H / 2, 0);
  const armGeo = new THREE.BoxGeometry(2.6, 0.12, 0.12);
  armGeo.translate(0, ARM_Y, 0);
  const poleMesh = new THREE.InstancedMesh(poleGeo, toon(0x5b4636), poles.length);
  const armMesh = new THREE.InstancedMesh(armGeo, toon(0x4a3a2d), poles.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  poles.forEach((p, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.ang);
    m.compose(new THREE.Vector3(p.x, p.y, p.z), q, one);
    poleMesh.setMatrixAt(i, m);
    armMesh.setMatrixAt(i, m);
  });
  poleMesh.castShadow = armMesh.castShadow = true;
  group.add(poleMesh, armMesh);

  // ---- wires ----
  const SEG = 8;
  const pos: number[] = [];
  const v0 = new THREE.Vector3(), v1 = new THREE.Vector3();
  for (const s of spans) {
    for (let i = 0; i < SEG; i++) {
      spanPoint(s, i / SEG, v0);
      spanPoint(s, (i + 1) / SEG, v1);
      pos.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z);
    }
  }
  const wireGeo = new THREE.BufferGeometry();
  wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const wires = new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: 0x1c1c22 }));
  wires.frustumCulled = false;
  group.add(wires);

  // ---- perches: a few spots along every wire ----
  const perches: PowerLines['perches'] = [];
  const v = new THREE.Vector3();
  for (const sp of spans) {
    const yaw = Math.atan2(sp.bx - sp.ax, sp.bz - sp.az);
    for (let k = 0; k < 6; k++) {
      spanPoint(sp, 0.1 + (k + rand()) * 0.13, v);
      perches.push({ x: v.x, y: v.y + 0.02, z: v.z, yaw: yaw + (rand() < 0.5 ? Math.PI : 0) });
    }
  }
  return { group, perches };
}
