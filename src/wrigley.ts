import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadStyled } from './facade';
import { makePoly, type Poly } from './citycollider';
import type { Pipe } from './rat';

type P2 = [number, number];

/**
 * Wrigley Field. Anchored on the real field: the OSM dugouts and video boards put home plate near (-50, 61)
 * with centre field pointing north-east, toward Waveland and Sheffield. Everything is built in a local
 * frame (u toward centre field, v toward first base) and carried into the city's world metres.
 */
const HOME: P2 = [-50, 61];
const AX: P2 = [0.66, -0.7513]; // toward centre field
const RV: P2 = [0.7513, 0.66]; // toward first base
const loc = (u: number, v: number): P2 => [HOME[0] + u * AX[0] + v * RV[0], HOME[1] + u * AX[1] + v * RV[1]];
const toLocal = (x: number, z: number): P2 => [(x - HOME[0]) * AX[0] + (z - HOME[1]) * AX[1], (x - HOME[0]) * RV[0] + (z - HOME[1]) * RV[1]];

/** The footprint: stays inside the kerbs of Waveland, Sheffield, Addison and Clark. */
const OUT: P2[] = [[-120, -79], [88.4, -79], [88.4, 76], [76, 100], [4, 127], [-13, 134], [-72, 136], [-94, 128], [-113, 110], [-121, 90], [-123, 20]];
const C: P2 = loc(50, 0); // ray origin for the seating bowl (inside everything, sees every edge)

const N = 180; // angular samples around C
const T = 0.75; // seat row depth
const RISE = 0.22; // seat row height: under the rat's step height, so rows are walkable stairs
const WALL = 3.6; // ivy wall height
const ROOF = 7.2; // roof clearance over the seats
const OUTFIELD_R = (th: number) => 152 - 17 * (th / (Math.PI / 4)) ** 2;

const inPoly = (pts: P2[], x: number, z: number): boolean => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

interface LoopPt {
  p: P2;
  h0: number;
  arc: boolean;
}

/** nearest hit of a ray from C with a closed polyline; t is the distance, k the segment index, f the position along it */
function rayLoop(dx: number, dz: number, pts: P2[]): { t: number; k: number; f: number } {
  let best = { t: Infinity, k: 0, f: 0 };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - C[0]) * ez - (a[1] - C[1]) * ex) / den;
    const f = ((a[0] - C[0]) * dz - (a[1] - C[1]) * dx) / den;
    if (t > 0.01 && f >= -1e-6 && f <= 1 + 1e-6 && t < best.t) best = { t, k: i, f };
  }
  return best;
}

export interface StadiumCtx {
  group: THREE.Group;
  gradient: THREE.DataTexture;
  bulbMat: THREE.Material;
  terrainAt: (x: number, z: number) => number;
  addPoly: (p: Poly) => void;
  addBox: (b: { minX: number; maxX: number; minZ: number; maxZ: number; top: number }) => void;
}
export interface StadiumBuilt {
  pipes: Pipe[];
  cheese: [number, number, number][];
}

export class Stadium {
  readonly out = OUT;
  readonly y0: number;
  private loop: LoopPt[] = [];
  private rin = new Float32Array(N + 1);
  private rout = new Float32Array(N + 1);
  private h0 = new Float32Array(N + 1);
  private rows = new Int32Array(N + 1);
  private bbox: [number, number, number, number];

  constructor(terrainAt: (x: number, z: number) => number) {
    // ---- the line between the playing field and the seats ----
    const L: LoopPt[] = [];
    const R = Math.PI / 4;
    const stand = (u: number, v: number, h0 = 0): LoopPt => ({ p: loc(u, v), h0, arc: false });
    // right-field pole -> along the foul line toward the dugout -> behind home
    const right: LoopPt[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      right.push(stand(94 - 86.5 * t, 96 - 56 * t, Math.max(0, WALL - 0.3 * t * 105)));
    }
    right.push(stand(-6, 35), stand(-17, 26), stand(-22, 12), stand(-22, 0));
    const left = right.map((q) => {
      const [u, v] = toLocal(q.p[0], q.p[1]);
      return stand(u, -v, q.h0);
    });
    // wall arc, left pole -> right pole
    const arc: LoopPt[] = [];
    for (let k = 0; k <= 30; k++) {
      const th = -R + (2 * R * k) / 30;
      const r = OUTFIELD_R(th);
      arc.push({ p: loc(r * Math.cos(th), r * Math.sin(th)), h0: WALL, arc: true });
    }
    // order around the loop: right stand (pole -> home), left stand (home -> pole) reversed, then arc (left -> right)
    L.push(...right, ...left.reverse(), ...arc);
    this.loop = L;
    const pts = L.map((q) => q.p);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of OUT) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    this.bbox = [minX, maxX, minZ, maxZ];

    // field level: just above the highest ground under the footprint
    let hi = -Infinity;
    for (let x = minX; x <= maxX; x += 8) for (let z = minZ; z <= maxZ; z += 8) hi = Math.max(hi, terrainAt(x, z));
    this.y0 = hi + 0.06;

    for (let i = 0; i <= N; i++) {
      const a = ((i % N) / N) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      const hn = rayLoop(dx, dz, pts);
      const ho = rayLoop(dx, dz, OUT);
      this.rin[i] = hn.t;
      this.rout[i] = Math.max(ho.t, hn.t);
      const A = L[hn.k], B = L[(hn.k + 1) % L.length];
      this.h0[i] = A.h0 + (B.h0 - A.h0) * hn.f;
    }
    for (let i = 0; i < N; i++) this.rows[i] = Math.max(1, Math.round((this.rout[i] - this.rin[i] + this.rout[i + 1] - this.rin[i + 1]) / 2 / T));
    this.rows[N] = this.rows[0];
  }

  inside(x: number, z: number): boolean {
    const [a, b, c, d] = this.bbox;
    return x > a && x < b && z > c && z < d && inPoly(OUT, x, z);
  }

  /** Ground height anywhere under the stadium (field, stepped seat rows), or null outside it. */
  y(x: number, z: number): number | null {
    const dx = x - C[0], dz = z - C[1];
    const d = Math.hypot(dx, dz);
    let f = (Math.atan2(dz, dx) / (Math.PI * 2)) * N;
    if (f < 0) f += N;
    const i = Math.min(N - 1, Math.floor(f)), t = f - i;
    const rin = this.rin[i] + (this.rin[i + 1] - this.rin[i]) * t;
    const rout = this.rout[i] + (this.rout[i + 1] - this.rout[i]) * t;
    if (d > rout) return null;
    if (d <= rin) return this.y0;
    const D = rout - rin, K = this.rows[i];
    const k = Math.min(K - 1, Math.floor(((d - rin) * K) / D));
    return this.y0 + this.h0[i] + (this.h0[i + 1] - this.h0[i]) * t + RISE * (k + 1);
  }

  /** world point and unit direction (away from C) of the seat/outer-wall boundary at sample i */
  private at(i: number, which: 'in' | 'out'): P2 {
    const a = ((i % N) / N) * Math.PI * 2;
    const r = which === 'in' ? this.rin[i] : this.rout[i];
    return [C[0] + Math.cos(a) * r, C[1] + Math.sin(a) * r];
  }
  private seat(i: number, k: number): { p: P2; h: number } {
    const a = ((i % N) / N) * Math.PI * 2;
    const K = this.rows[i % N] ;
    const kk = Math.min(k, K);
    const r = this.rin[i] + ((this.rout[i] - this.rin[i]) * kk) / K;
    return { p: [C[0] + Math.cos(a) * r, C[1] + Math.sin(a) * r], h: this.y0 + this.h0[i] + RISE * kk };
  }

  build(ctx: StadiumCtx): StadiumBuilt {
    const { group, gradient, terrainAt } = ctx;
    const toon = (c: number, map?: THREE.Texture, extra: THREE.MeshToonMaterialParameters = {}) => new THREE.MeshToonMaterial({ color: c, gradientMap: gradient, map: map ?? null, side: THREE.DoubleSide, ...extra });
    const y0 = this.y0;
    const pipes: Pipe[] = [];
    const add = (m: THREE.Object3D, shadow = true) => {
      if ((m as THREE.Mesh).isMesh) {
        m.castShadow = shadow;
        m.receiveShadow = true;
      }
      group.add(m);
      return m;
    };

    // ground under the whole footprint, lowest point: where the outer wall starts
    let lo = Infinity;
    for (let i = 0; i < N; i++) {
      const o = this.at(i, 'out');
      lo = Math.min(lo, terrainAt(o[0], o[1]));
    }
    lo -= 0.4;

    // ---------------- field ----------------
    const U0 = -30, U1 = 162, V0 = -100, V1 = 100, S = 10;
    const px = (u: number, v: number): P2 => [(v - V0) * S, (U1 - u) * S];
    const fieldTex = canvas((V1 - V0) * S, (U1 - U0) * S, (c) => {
      c.fillStyle = '#4f9d47';
      c.fillRect(0, 0, (V1 - V0) * S, (U1 - U0) * S);
      // mown stripes across the outfield
      for (let k = 0; k < 40; k++) {
        c.fillStyle = k % 2 ? 'rgba(130,200,90,0.28)' : 'rgba(20,70,30,0.12)';
        const [x0, y0p] = px(U1, V0 + k * 5);
        c.fillRect(x0, y0p, 5 * S, (U1 - U0) * S);
      }
      // warning track along the wall
      c.strokeStyle = '#b88a5a';
      c.lineWidth = 8 * S;
      c.lineJoin = 'round';
      c.beginPath();
      this.loop.filter((q) => q.arc).forEach((q, i) => {
        const [u, v] = toLocal(q.p[0], q.p[1]);
        const [x, y] = px(u, v);
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      });
      c.stroke();
      // infield skin: a circle about the mound, then the grass diamond cut back in
      const dirt = '#c28f5c';
      c.fillStyle = dirt;
      circle(c, px(23, 0), 36 * S);
      c.fillStyle = '#4f9d47';
      c.beginPath();
      [[6, 0], [24.3, 18.3], [42.6, 0], [24.3, -18.3]].forEach(([u, v], i) => {
        const [x, y] = px(u, v);
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      });
      c.closePath();
      c.fill();
      c.fillStyle = '#58a84f';
      c.fill();
      // base paths and the plate circle
      c.strokeStyle = dirt;
      c.lineWidth = 3.2 * S;
      c.beginPath();
      [[0, 0], [24.3, 24.3], [48.6, 0], [24.3, -24.3], [0, 0]].forEach(([u, v], i) => {
        const [x, y] = px(u, v);
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      });
      c.stroke();
      c.fillStyle = dirt;
      circle(c, px(0, 0), 6.2 * S);
      circle(c, px(23, 0), 3.6 * S);
      // chalk: foul lines out to the poles, batter's boxes
      c.strokeStyle = '#f4efe2';
      c.lineWidth = 0.5 * S;
      for (const sv of [-1, 1]) {
        c.beginPath();
        const a = px(0, 0), b = px(120, 120 * sv);
        c.moveTo(a[0], a[1]);
        c.lineTo(b[0], b[1]);
        c.stroke();
        c.strokeRect(px(1.5, sv * 1.5 + (sv > 0 ? 0 : -3.6))[0], px(3, 0)[1], 3.6 * S, 4.6 * S);
      }
      // bases and plate
      c.fillStyle = '#f7f3e6';
      for (const [u, v] of [[24.3, 24.3], [48.6, 0], [24.3, -24.3]]) {
        const [x, y] = px(u, v);
        c.fillRect(x - 0.55 * S, y - 0.55 * S, 1.1 * S, 1.1 * S);
      }
      const [hx, hy] = px(0, 0);
      c.beginPath();
      c.moveTo(hx - 0.6 * S, hy + 0.1 * S);
      c.lineTo(hx + 0.6 * S, hy + 0.1 * S);
      c.lineTo(hx + 0.6 * S, hy - 0.4 * S);
      c.lineTo(hx, hy - 1.0 * S);
      c.lineTo(hx - 0.6 * S, hy - 0.4 * S);
      c.fill();
      c.fillStyle = '#f7f3e6';
      circle(c, px(23, 0), 0.5 * S);
    });
    {
      const pos: number[] = [], uv: number[] = [], idx: number[] = [];
      const push = (p: P2) => {
        const [u, v] = toLocal(p[0], p[1]);
        pos.push(p[0], y0, p[1]);
        uv.push((v - V0) / (V1 - V0), (u - U0) / (U1 - U0));
      };
      push(C);
      for (let i = 0; i < N; i++) push(this.at(i, 'in'));
      for (let i = 0; i < N; i++) idx.push(0, 1 + ((i + 1) % N), 1 + i);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
      g.setIndex(idx);
      add(new THREE.Mesh(g, toon(0xffffff, fieldTex)), false);
    }
    // the mound
    {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.4, 0.16, 20), toon(0xc28f5c));
      const [x, z] = loc(23, 0);
      m.position.set(x, y0 + 0.06, z);
      add(m, false);
    }

    // ---------------- seats ----------------
    {
      const pos: number[] = [], col: number[] = [], idx: number[] = [], nor: number[] = [];
      const seatA = new THREE.Color(0x2f7d4f), seatB = new THREE.Color(0x2a6e46), conc = new THREE.Color(0xc9c2b2), riserC = new THREE.Color(0x9d978a);
      const quad = (a: number[], b: number[], c2: number[], d: number[], color: THREE.Color, n: number[]) => {
        const o = pos.length / 3;
        for (const p of [a, b, c2, d]) {
          pos.push(p[0], p[1], p[2]);
          col.push(color.r, color.g, color.b);
          nor.push(n[0], n[1], n[2]);
        }
        idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
      };
      for (let i = 0; i < N; i++) {
        const K = this.rows[i];
        const aisle = i % 6 === 0;
        for (let k = 0; k < K; k++) {
          const a0 = this.seat(i, k), a1 = this.seat(i + 1, k), b0 = this.seat(i, k + 1), b1 = this.seat(i + 1, k + 1);
          const hA0 = a0.h + RISE, hA1 = a1.h + RISE; // tread heights
          const level = (k * T) / Math.max(1, this.rout[i] - this.rin[i]);
          const concourse = level > 0.3 && level < 0.34;
          const color = aisle || concourse ? conc : (i + k) % 2 ? seatA : seatB;
          // tread (this row's top, from this row's front edge to the next)
          quad([a0.p[0], hA0, a0.p[1]], [a1.p[0], hA1, a1.p[1]], [b1.p[0], hA1, b1.p[1]], [b0.p[0], hA0, b0.p[1]], color, [0, 1, 0]);
          // riser at the front of the row, down to the row below
          const nx = -(a0.p[0] - C[0]), nz = -(a0.p[1] - C[1]);
          const nl = Math.hypot(nx, nz) || 1;
          quad([a0.p[0], a0.h, a0.p[1]], [a1.p[0], a1.h, a1.p[1]], [a1.p[0], hA1, a1.p[1]], [a0.p[0], hA0, a0.p[1]], riserC, [nx / nl, 0, nz / nl]);
          // seat back: a green strip standing on the tread
          if (!aisle && !concourse) quad([b0.p[0], hA0, b0.p[1]], [b1.p[0], hA1, b1.p[1]], [b1.p[0], hA1 + 0.3, b1.p[1]], [b0.p[0], hA0 + 0.3, b0.p[1]], seatB, [nx / nl, 0, nz / nl]);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setIndex(idx);
      add(new THREE.Mesh(g, new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradient, side: THREE.DoubleSide })));
    }

    // ---------------- ivy wall (field side) ----------------
    {
      const ivyTex = canvas(512, 256, (c) => {
        c.fillStyle = '#3d7a38';
        c.fillRect(0, 0, 512, 256);
        for (let k = 0; k < 2600; k++) {
          c.fillStyle = ['#2f6a30', '#4c9040', '#5da34b', '#2a5a2a', '#6a9a3a'][k % 5];
          c.beginPath();
          c.ellipse(Math.random() * 512, Math.random() * 256, 4 + Math.random() * 7, 3 + Math.random() * 5, Math.random() * 3, 0, 7);
          c.fill();
        }
      });
      ivyTex.wrapS = ivyTex.wrapT = THREE.RepeatWrapping;
      const ivy: THREE.BufferGeometry[] = [], brick: THREE.BufferGeometry[] = [];
      const wallPolys: P2[][] = [];
      for (let i = 0; i < this.loop.length; i++) {
        const A = this.loop[i], B = this.loop[(i + 1) % this.loop.length];
        if (A.h0 < 0.3 && B.h0 < 0.3) continue;
        const ha = y0 + A.h0, hb = y0 + B.h0;
        const len = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]);
        // outward (toward the seats) is away from C
        let nx = B.p[1] - A.p[1], nz = -(B.p[0] - A.p[0]);
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl;
        nz /= nl;
        if (nx * (A.p[0] - C[0]) + nz * (A.p[1] - C[1]) < 0) {
          nx = -nx;
          nz = -nz;
        }
        const q = wallQuad(A.p, B.p, y0, y0, ha, hb, len / 3, nx, nz);
        (A.arc ? ivy : brick).push(q);
        // flat cap
        brick.push(capQuad(A.p, B.p, ha + 0.02, hb + 0.02, nx, nz, 0.9));
        const t = 0.9;
        wallPolys.push([A.p, B.p, [B.p[0] + nx * t, B.p[1] + nz * t], [A.p[0] + nx * t, A.p[1] + nz * t]]);
        ctx.addPoly(makePoly(fixWinding(wallPolys[wallPolys.length - 1]), y0 + Math.max(A.h0, B.h0)));
      }
      if (ivy.length) add(new THREE.Mesh(mergeGeometries(ivy, false)!, toon(0xffffff, ivyTex)));
      if (brick.length) add(new THREE.Mesh(mergeGeometries(brick, false)!, toon(0x9a4a3a)));
    }

    // ---------------- outer wall: brick, windows, gates, cornice ----------------
    const brickTex = loadStyled('/textures/brick_wall_09_diff_1k.jpg', { size: 1024, levels: 7, contrast: 1.2 });
    const roofed: boolean[] = [];
    const rim: number[] = [];
    for (let i = 0; i <= N; i++) {
      const stand = this.h0[i] < 0.3 && this.h0[(i + 1) % N] < 0.3 && this.h0[(i + N - 1) % N] < 0.3;
      const D = this.rout[i] - this.rin[i];
      roofed.push(stand && D > 30);
      rim.push(y0 + this.h0[i] + RISE * this.rows[i] + (stand && D > 30 ? ROOF + 0.2 : 1.2));
    }
    {
      const outer: THREE.BufferGeometry[] = [], stone: THREE.BufferGeometry[] = [], inner: THREE.BufferGeometry[] = [];
      for (let i = 0; i < N; i++) {
        const A = this.at(i, 'out'), B = this.at(i + 1, 'out');
        let nx = B[1] - A[1], nz = -(B[0] - A[0]);
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl;
        nz /= nl;
        if (nx * (A[0] - C[0]) + nz * (A[1] - C[1]) < 0) {
          nx = -nx;
          nz = -nz;
        }
        outer.push(wallQuad(A, B, lo, lo, rim[i] - 0.5, rim[i + 1] - 0.5, 12, nx, nz));
        stone.push(wallQuad(A, B, rim[i] - 0.5, rim[i + 1] - 0.5, rim[i], rim[i + 1], 4, nx, nz));
        stone.push(capQuad(A, B, rim[i] + 0.01, rim[i + 1] + 0.01, nx, nz, -0.7)); // cap runs inward
        const sa = this.seat(i, this.rows[i]).h, sb = this.seat(i + 1, this.rows[i]).h;
        const Ai: P2 = [A[0] - nx * 0.2, A[1] - nz * 0.2], Bi: P2 = [B[0] - nx * 0.2, B[1] - nz * 0.2];
        inner.push(wallQuad(Bi, Ai, sb, sa, rim[i + 1], rim[i], 6, -nx, -nz));
        // collision: a thin band just inside the wall
        const t = 0.8;
        const quadP: P2[] = [A, B, [B[0] - nx * t, B[1] - nz * t], [A[0] - nx * t, A[1] - nz * t]];
        ctx.addPoly(makePoly(fixWinding(quadP), Math.max(rim[i], rim[i + 1])));
      }
      add(new THREE.Mesh(mergeGeometries(outer, false)!, toon(0xffffff, brickTex)));
      add(new THREE.Mesh(mergeGeometries(stone, false)!, toon(0xd8ccb0)));
      add(new THREE.Mesh(mergeGeometries(inner, false)!, toon(0xb06a55)));

      // arched gates and window bands, flush on the brick
      const gateGeo = new THREE.PlaneGeometry(2.6, 4.2), winGeo = new THREE.PlaneGeometry(1.5, 2.4);
      const gates: THREE.Matrix4[] = [], wins: THREE.Matrix4[] = [];
      const q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
      let acc = 0;
      for (let i = 0; i < N; i++) {
        const A = this.at(i, 'out'), B = this.at(i + 1, 'out');
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        const nx = (B[1] - A[1]) / (len || 1), nz = -(B[0] - A[0]) / (len || 1);
        const s = nx * (A[0] - C[0]) + nz * (A[1] - C[1]) < 0 ? -1 : 1;
        const ox = nx * s, oz = nz * s;
        q.setFromEuler(new THREE.Euler(0, Math.atan2(ox, oz), 0));
        for (let off = (-acc % 9 + 9) % 9; off < len; off += 9) {
          const t = off / len, x = A[0] + (B[0] - A[0]) * t + ox * 0.06, z = A[1] + (B[1] - A[1]) * t + oz * 0.06;
          const gy = terrainAt(x, z);
          gates.push(new THREE.Matrix4().compose(new THREE.Vector3(x, gy + 2.2, z), q, one));
          const top = Math.min(rim[i], rim[i + 1]);
          for (let w = 0; w < 3; w++) {
            const wy = gy + 7.5 + w * 4.2;
            if (wy + 1.4 < top - 1) wins.push(new THREE.Matrix4().compose(new THREE.Vector3(x, wy, z), q, one));
          }
        }
        acc += len;
      }
      const gm = new THREE.InstancedMesh(gateGeo, toon(0x2a1f26), gates.length);
      gates.forEach((m, i) => gm.setMatrixAt(i, m));
      group.add(gm);
      const wm = new THREE.InstancedMesh(winGeo, toon(0x1d2236), wins.length);
      wins.forEach((m, i) => wm.setMatrixAt(i, m));
      group.add(wm);
    }

    // ---------------- grandstand roof ----------------
    {
      const roofG: THREE.BufferGeometry[] = [], fascia: THREE.BufferGeometry[] = [], cols: THREE.BufferGeometry[] = [];
      const slope = RISE / T;
      for (let i = 0; i < N; i++) {
        if (!roofed[i] || !roofed[i + 1]) continue;
        const f = 0.36;
        const pt = (j: number, frac: number) => {
          const a = this.at(j, 'in'), b = this.at(j, 'out');
          const p: P2 = [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac];
          const s = (this.rout[j] - this.rin[j]) * frac;
          return [p[0], y0 + this.h0[j] + slope * s + ROOF, p[1]];
        };
        const a0 = pt(i, f), a1 = pt(i + 1, f), b0 = pt(i, 1), b1 = pt(i + 1, 1);
        const mb = new THREE.BufferGeometry();
        mb.setAttribute('position', new THREE.Float32BufferAttribute([...a0, ...a1, ...b1, ...b0], 3));
        mb.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
        mb.setIndex([0, 2, 1, 0, 3, 2]);
        roofG.push(mb);
        // fascia: a deep green band on the front edge
        const fb = new THREE.BufferGeometry();
        const d = 1.3;
        fb.setAttribute('position', new THREE.Float32BufferAttribute([...a0, ...a1, a1[0], a1[1] - d, a1[2], a0[0], a0[1] - d, a0[2]], 3));
        const fx = C[0] - a0[0], fz = C[1] - a0[2], fl = Math.hypot(fx, fz) || 1;
        fb.setAttribute('normal', new THREE.Float32BufferAttribute(Array(4).fill([fx / fl, 0, fz / fl]).flat(), 3));
        fb.setIndex([0, 1, 2, 0, 2, 3]);
        fascia.push(fb);
        if (i % 5 === 0) {
          const baseH = a0[1] - ROOF;
          cols.push(new THREE.CylinderGeometry(0.32, 0.32, ROOF, 6).translate(a0[0], baseH + ROOF / 2, a0[2]));
        }
      }
      const green = toon(0x2f6b45, undefined, { side: THREE.DoubleSide });
      if (roofG.length) add(new THREE.Mesh(mergeGeometries(roofG, false)!, green));
      if (fascia.length) add(new THREE.Mesh(mergeGeometries(fascia, false)!, toon(0x24563a, undefined, { side: THREE.DoubleSide })));
      if (cols.length) add(new THREE.Mesh(mergeGeometries(cols, false)!, toon(0x3d4a44)));
    }

    // ---------------- landmarks ----------------
    const yAt = (x: number, z: number) => this.y(x, z) ?? terrainAt(x, z);
    const metal = toon(0x59606c);

    // light towers on the roof
    for (const [u, v] of [[40, 78], [40, -78], [-5, 72], [-5, -72]] as P2[]) {
      const [x, z] = loc(u, v);
      const base = yAt(x, z) + ROOF;
      const tower = new THREE.Group();
      for (const [ox, oz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 16, 5), metal);
        leg.position.set(ox, 8, oz);
        tower.add(leg);
      }
      for (let k = 0; k < 4; k++) {
        const brace = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.1, 2.6), metal);
        brace.position.y = 3 + k * 4;
        tower.add(brace);
      }
      const bank = new THREE.Mesh(new THREE.BoxGeometry(5.4, 3.2, 0.5), ctx.bulbMat);
      bank.position.set(0, 17.4, 0);
      const bankG = new THREE.Group();
      bankG.add(bank);
      bank.position.z = 1.6;
      bankG.rotation.y = Math.atan2(C[0] - x, C[1] - z);
      tower.add(bankG);
      tower.position.set(x, base, z);
      tower.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o.castShadow = true), (o.receiveShadow = true)) : 0));
      group.add(tower);
    }

    // centre-field scoreboard on the back of the bleachers, flags on top
    {
      const dx = AX[0], dz = AX[1];
      const fcf = (Math.atan2(dz, dx) / (Math.PI * 2)) * N;
      const i = ((Math.round(fcf) % N) + N) % N;
      const o = this.at(i, 'out');
      const x = o[0] - dx * 2.2, z = o[1] - dz * 2.2;
      const top = this.y(x, z) ?? rim[i];
      const board = new THREE.Group();
      const tex = canvas(1024, 600, (c) => {
        c.fillStyle = '#1f4a33';
        c.fillRect(0, 0, 1024, 600);
        c.strokeStyle = '#efe9d6';
        c.lineWidth = 5;
        c.strokeRect(10, 10, 1004, 580);
        c.fillStyle = '#efe9d6';
        c.font = 'bold 40px Impact, "Arial Black", sans-serif';
        c.textAlign = 'left';
        for (let r = 0; r < 4; r++) {
          const y = 190 + r * 90;
          c.fillRect(50, y - 3, 920, 3);
          if (r === 1) c.fillText('CUBS', 60, y + 55);
          if (r === 2) c.fillText('VISITORS', 60, y + 55);
          for (let k = 0; k < 11; k++) c.strokeRect(300 + k * 60, y, 54, 80);
        }
        c.font = 'bold 56px Impact, "Arial Black", sans-serif';
        c.textAlign = 'center';
        c.fillText('RUNS · HITS · ERRORS', 512, 110);
      });
      const face = toon(0xffffff, tex);
      const side = toon(0x1f4a33);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(19, 10.6, 1.6), [side, side, side, side, face, side]);
      slab.position.y = 5.3;
      board.add(slab);
      const clock = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 0.5, 20), toon(0xf1ead2));
      clock.rotation.x = Math.PI / 2;
      clock.position.set(0, 12.4, 0.2);
      board.add(clock);
      const roofCap = new THREE.Mesh(new THREE.BoxGeometry(19.8, 0.5, 2.2), toon(0x24563a));
      roofCap.position.y = 10.8;
      board.add(roofCap);
      // flag poles with a blue W
      const flagTex = canvas(256, 160, (c) => {
        c.fillStyle = '#f7f3e6';
        c.fillRect(0, 0, 256, 160);
        c.fillStyle = '#0e3386';
        c.font = 'bold 150px Impact, "Arial Black", sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('W', 128, 86);
      });
      for (const px2 of [-7, 7]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 9, 5), metal);
        pole.position.set(px2, 15.3, 0);
        board.add(pole);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.6), toon(0xffffff, flagTex, { side: THREE.DoubleSide }));
        flag.position.set(px2 + 1.4, 18.2, 0);
        board.add(flag);
      }
      board.position.set(x, top, z);
      board.rotation.y = Math.atan2(-dx, -dz);
      board.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o.castShadow = true), (o.receiveShadow = true)) : 0));
      group.add(board);
    }

    // video boards: right field (real position) and left field
    for (const [bx, bz, w, yaw] of [[86.5, 35, 26, -Math.PI / 2], [-1, -77.5, 34, Math.PI]] as [number, number, number, number][]) {
      const screen = new THREE.Mesh(new THREE.BoxGeometry(w, 6, 0.7), toon(0x1a2a48));
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w - 1, 5), new THREE.MeshBasicMaterial({ map: screenTex() }));
      face.position.z = 0.4;
      screen.add(face);
      screen.position.set(bx, (this.y(bx, bz) ?? y0 + 6) + 3.8, bz);
      screen.rotation.y = yaw;
      screen.castShadow = true;
      group.add(screen);
    }

    // foul poles
    for (const sv of [-1, 1]) {
      const [x, z] = loc(135 * Math.cos(Math.PI / 4), sv * 135 * Math.sin(Math.PI / 4));
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 20, 6), toon(0xf2c230));
      pole.position.set(x, y0 + 10, z);
      add(pole);
    }

    // the two dugouts
    {
      for (const sv of [-1, 1]) {
        const [x, z] = loc(7.5, sv * 38);
        const d = new THREE.Mesh(new THREE.BoxGeometry(14, 0.95, 3.4), toon(sv < 0 ? 0x0e3386 : 0x55606e));
        d.position.set(x, y0 + 0.4, z);
        d.rotation.y = Math.atan2(AX[0], AX[1]) - Math.PI / 2 + 0; // long side along the foul-line axis
        add(d);
        ctx.addBox({ minX: x - 3.6, maxX: x + 3.6, minZ: z - 3.6, maxZ: z + 3.6, top: y0 + 0.9 });
      }
    }

    // the marquee, on the corner at Clark and Addison
    {
      const target = [-108, 117];
      const dx = target[0] - C[0], dz = target[1] - C[1];
      const ang = Math.atan2(dz, dx);
      const i = (((Math.round((ang / (Math.PI * 2)) * N) % N) + N) % N);
      const o = this.at(i, 'out');
      const n = Math.hypot(o[0] - C[0], o[1] - C[1]);
      const ux = (o[0] - C[0]) / n, uz = (o[1] - C[1]) / n;
      const tex = canvas(1024, 400, (c) => {
        c.fillStyle = '#c8321f';
        c.fillRect(0, 0, 1024, 400);
        c.strokeStyle = '#f7f1e0';
        c.lineWidth = 10;
        c.strokeRect(14, 14, 996, 372);
        c.fillStyle = '#f7f1e0';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = '900 168px Impact, Haettenschweiler, "Arial Black", sans-serif';
        c.fillText('WRIGLEY', 512, 130);
        c.fillText('FIELD', 512, 285);
        c.font = '700 40px Impact, "Arial Black", sans-serif';
        c.fillText('HOME OF CHICAGO CUBS', 512, 360);
      });
      const face = toon(0xffffff, tex, { emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.85 });
      const body = toon(0xc8321f);
      const sign = new THREE.Mesh(new THREE.BoxGeometry(11, 4.4, 1.2), [body, body, body, body, face, body]);
      const y = terrainAt(o[0], o[1]);
      sign.position.set(o[0] + ux * 0.7, y + 6.4, o[1] + uz * 0.7);
      sign.rotation.y = Math.atan2(ux, uz);
      add(sign);
      // posts and a stone arch frame at street level
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 6.4, 0.9), toon(0xd8ccb0));
        post.position.set(o[0] + ux * 0.6 - uz * 4.2 * s, y + 3.2, o[1] + uz * 0.6 + ux * 4.2 * s);
        post.rotation.y = Math.atan2(ux, uz);
        add(post);
      }
    }

    // drainpipes up the outside of the bleachers, where the wall is low enough to hop over
    {
      let placed = 0;
      for (let i = 0; i < N && placed < 10; i += 7) {
        if (roofed[i] || roofed[i + 1]) continue;
        const a = this.at(i, 'out'), b = this.at(i + 1, 'out');
        let nx = b[1] - a[1], nz = -(b[0] - a[0]);
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl;
        nz /= nl;
        if (nx * (a[0] - C[0]) + nz * (a[1] - C[1]) < 0) {
          nx = -nx;
          nz = -nz;
        }
        const x = a[0] + nx * 0.1, z = a[1] + nz * 0.1;
        const base = terrainAt(x, z), top = rim[i];
        pipes.push({ x, z, nx, nz, top });
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, top - base, 8), toon(0x5a5f6a));
        pipe.position.set(x + nx * 0.12, (top + base) / 2, z + nz * 0.12);
        add(pipe);
        placed++;
      }
    }

    // cheese: the plate, the mound and a seat or two
    const cheese: [number, number, number][] = [];
    for (const [u, v] of [[4, 0], [23, 0]] as P2[]) {
      const [x, z] = loc(u, v);
      cheese.push([x, y0 + 0.2, z]);
    }
    {
      const [x, z] = loc(8, 52);
      cheese.push([x, yAt(x, z) + 0.2, z]);
    }
    return { pipes, cheese };
  }
}

// ------------------------------------------------------------------------------------------------

function circle(c: CanvasRenderingContext2D, [x, y]: P2, r: number): void {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
}

function canvas(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

let screenCache: THREE.CanvasTexture | null = null;
function screenTex(): THREE.CanvasTexture {
  return (screenCache ??= canvas(512, 128, (c) => {
    c.fillStyle = '#10203a';
    c.fillRect(0, 0, 512, 128);
    for (let k = 0; k < 8; k++) {
      c.fillStyle = k % 2 ? '#2f7de1' : '#e8452e';
      c.fillRect(k * 64, 100, 64, 28);
    }
    c.fillStyle = '#f7f1e0';
    c.font = '900 64px Impact, "Arial Black", sans-serif';
    c.textAlign = 'center';
    c.fillText('GO CUBS GO', 256, 74);
  }));
}

function fixWinding(pts: P2[]): P2[] {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a < 0 ? [...pts].reverse() : pts;
}

/** A vertical wall face from A to B. Bottom and top heights are given per end; UVs in metres / tile. */
function wallQuad(A: P2, B: P2, ba: number, bb: number, ta: number, tb: number, tile: number, nx: number, nz: number, uScale = 1, vScale = 1): THREE.BufferGeometry {
  const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([A[0], ba, A[1], B[0], bb, B[1], B[0], tb, B[1], A[0], ta, A[1]], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([nx, 0, nz, nx, 0, nz, nx, 0, nz, nx, 0, nz], 3));
  const u = (len / tile) * uScale;
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, ba / tile / vScale, u, bb / tile / vScale, u, tb / tile / vScale, 0, ta / tile / vScale], 2));
  // wind so the front faces (nx, nz)
  const cx = (B[0] - A[0]) * nz - (B[1] - A[1]) * nx; // sign of (AB x n) in the xz-plane
  g.setIndex(cx > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
  return g;
}

/** A flat strip on top of a wall, `w` metres wide toward (nx, nz) (negative: the other way). */
function capQuad(A: P2, B: P2, ya: number, yb: number, nx: number, nz: number, w: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([A[0], ya, A[1], B[0], yb, B[1], B[0] + nx * w, yb, B[1] + nz * w, A[0] + nx * w, ya, A[1] + nz * w], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  const cross = (B[0] - A[0]) * nz * Math.sign(w) - (B[1] - A[1]) * nx * Math.sign(w);
  g.setIndex(cross > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]);
  return g;
}
