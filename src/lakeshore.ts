import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makePoly, type Poly } from './citycollider';
import type { Box } from './physics';

type P2 = [number, number];

/** the bits of city.ts's geometry kit this builder needs (passed in to avoid a circular import) */
export interface MB {
  quad(a: number[], b: number[], c: number[], d: number[], uvs: number[][], want: number[]): void;
  build(): THREE.BufferGeometry;
}
export interface Kit {
  MeshBuilder: new () => MB;
  resample: (pts: P2[], step: number) => P2[];
  sides: (pts: P2[], width: number) => { l: P2; r: P2 }[];
}

export interface LsdCtx {
  group: THREE.Group;
  gradient: THREE.DataTexture;
  roadMat: THREE.Material;
  terrainAt: (x: number, z: number) => number;
  kit: Kit;
  /** the two carriageways, in travel direction, one-way each. `median` ways get the shared centre barrier */
  main: { pts: P2[]; median: boolean }[];
  /** short connector roads already in the map that become exit ramps (first point sits on a carriageway) */
  connectors: P2[][];
  /** synthetic exits: leave the carriageway nearest `from`, land on the ground road at `to` heading `toDir` */
  exits: { name: string; from: P2; to: P2; toDir: P2 }[];
  addBox: (b: Box) => void;
  addPoly: (p: Poly) => void;
  windCCW: (pts: P2[]) => P2[];
  /** a tall lamp on a deck: arm points along (dx, dz) */
  lamp: (x: number, y: number, z: number, dx: number, dz: number, h: number) => void;
}

export interface LsdResult {
  /** absolute road-surface height where the deck or a ramp carries traffic, else null */
  surfaceAt: (x: number, z: number) => number | null;
  /** every lane cars drive: mainline pieces (split where ramps leave) and ramps */
  lanes: { pts: P2[]; w: number; oneway: boolean }[];
}

const DECK_H = 6.5; // road surface above the ground
const DECK_T = 1.4; // girder depth
const MAIN_W = 21; // each carriageway
const RAMP_W = 7;
const PARAPET = 1.05;

const CONCRETE = 0xa9a79f;

function signTexture(lines: string[]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1b6b45';
  g.fillRect(0, 0, 512, 160);
  g.strokeStyle = '#f4f1e4';
  g.lineWidth = 8;
  g.strokeRect(8, 8, 496, 144);
  g.fillStyle = '#f4f1e4';
  g.textAlign = 'center';
  g.font = 'bold 54px sans-serif';
  g.fillText(lines[0], 256, 70);
  g.font = 'bold 40px sans-serif';
  g.fillText(lines[1] ?? '', 256, 125);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildLakeShoreDrive(ctx: LsdCtx): LsdResult {
  const { kit, terrainAt } = ctx;
  const up = [0, 1, 0];
  const concreteB = new kit.MeshBuilder();
  const roadB = new kit.MeshBuilder();
  const paint: { yel: number[]; wht: number[] } = { yel: [], wht: [] };
  const pierGeos: THREE.BufferGeometry[] = [];
  const signs: { x: number; y: number; z: number; bx: number; bz: number; yaw: number; text: string[] }[] = [];
  const flat = [[0.3, 0.3], [0.32, 0.3], [0.32, 0.32], [0.3, 0.32]];

  // ---- the lookup the cars use (and the main-line distance test the ramps use) ----
  interface Samp { x: number; z: number; y: number; half: number }
  const CELL = 16;
  const grid = new Map<number, Samp[]>();
  const gk = (ix: number, iz: number) => ix * 100003 + iz;
  const addSamp = (s: Samp) => {
    const r = s.half + 4;
    for (let ix = Math.floor((s.x - r) / CELL); ix <= Math.floor((s.x + r) / CELL); ix++) {
      for (let iz = Math.floor((s.z - r) / CELL); iz <= Math.floor((s.z + r) / CELL); iz++) {
        const k = gk(ix, iz);
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(s);
      }
    }
  };
  const surfaceAt = (x: number, z: number): number | null => {
    const l = grid.get(gk(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!l) return null;
    let best = Infinity, y: number | null = null;
    for (const s of l) {
      const d = Math.hypot(x - s.x, z - s.z) / (s.half + 3);
      if (d < 1 && d < best) {
        best = d;
        y = s.y;
      }
    }
    return y;
  };

  // the mainline centreline samples, for "is this inside the mainline?" and "what height is the deck here?"
  const mainSamps: Samp[] = [];
  const mainNear = (x: number, z: number): { d: number; y: number } => {
    let d = Infinity, y = 0;
    for (const s of mainSamps) {
      if (Math.abs(s.x - x) > 40 || Math.abs(s.z - z) > 40) continue;
      const dd = Math.hypot(s.x - x, s.z - z);
      if (dd < d) {
        d = dd;
        y = s.y;
      }
    }
    return { d, y };
  };

  const pt = (q: P2, y: number): number[] => [q[0], y, q[1]];
  const lanesOut: LsdResult['lanes'] = [];

  /** a deck along `pts` with per-sample surface heights `Y` */
  const deck = (pts: P2[], width: number, Y: (i: number, n: number) => number, o: { main: boolean; leftBarrier: 'parapet' | 'median' | 'none'; ramp?: boolean }): { p: P2[]; ys: number[] } => {
    const p = kit.resample(pts, 6);
    const n = p.length;
    const S = kit.sides(p, width);
    const ys = p.map((_q, i) => Y(i, n));
    const half = width / 2;
    const T = o.ramp ? 0.9 : DECK_T;
    let dist = 0;
    for (let i = 0; i + 1 < n; i++) {
      const j = i + 1;
      const seg = Math.hypot(p[j][0] - p[i][0], p[j][1] - p[i][1]);
      const L0 = pt(S[i].l, ys[i]), R0 = pt(S[i].r, ys[i]), L1 = pt(S[j].l, ys[j]), R1 = pt(S[j].r, ys[j]);
      const u0 = dist / 8, u1 = (dist + seg) / 8, v1 = width / 8;
      roadB.quad(L0, R0, R1, L1, [[u0, 0], [u0, v1], [u1, v1], [u1, 0]], up);
      // underside and the two fascias
      const D = (q: P2, y: number) => pt(q, y - T);
      concreteB.quad(D(S[i].l, ys[i]), D(S[i].r, ys[i]), D(S[j].r, ys[j]), D(S[j].l, ys[j]), [[0, 0], [1, 0], [1, 1], [0, 1]], [0, -1, 0]);
      const cx = p[i][0], cz = p[i][1];
      for (const side of ['l', 'r'] as const) {
        const e0 = S[i][side], e1 = S[j][side];
        const ox = e0[0] - cx, oz = e0[1] - cz, on = Math.hypot(ox, oz) || 1;
        const out = [ox / on, 0, oz / on];
        const left = side === 'r'; // the carriageway's left (median side) is the 'r' edge
        // ramp edges inside the mainline are left open (the mainline deck covers them)
        const hidden = o.ramp && (mainNear(e0[0], e0[1]).d < 11.2 || mainNear(e1[0], e1[1]).d < 11.2);
        if (hidden) continue;
        let kind: 'parapet' | 'median' | 'none' = 'parapet';
        if (left) kind = o.leftBarrier;
        const top = kind === 'none' ? 0 : kind === 'median' ? 1.0 : PARAPET;
        const ext = kind === 'median' ? 0.9 : 0; // the median barrier spans the gap to the other carriageway
        const wdt = kind === 'median' ? 0.7 : 0.5;
        const inw = (e: P2): P2 => [e[0] - (out[0] * (wdt)), e[1] - out[2] * wdt];
        const E0 = pt([e0[0] + out[0] * ext, e0[1] + out[2] * ext], ys[i] + top), E1 = pt([e1[0] + out[0] * ext, e1[1] + out[2] * ext], ys[j] + top);
        const I0 = pt(inw(e0), ys[i] + top), I1 = pt(inw(e1), ys[j] + top);
        const B0 = pt([e0[0] + out[0] * ext, e0[1] + out[2] * ext], ys[i] - T), B1 = pt([e1[0] + out[0] * ext, e1[1] + out[2] * ext], ys[j] - T);
        // outer face (all the way down the girder), top cap, inner face
        concreteB.quad(E0, E1, B1, B0, flat, out);
        if (top > 0) {
          concreteB.quad(E0, E1, I1, I0, flat, up);
          const I0b = pt(inw(e0), ys[i]), I1b = pt(inw(e1), ys[j]);
          concreteB.quad(I0, I1, I1b, I0b, flat, [-out[0], 0, -out[2]]);
        }
      }
      // lane paint: dashed white dividers, solid yellow at the median edge, solid white at the right edge
      const lane = (off: number, w: number, bucket: number[], dash: boolean) => {
        const t0 = dash ? 0.15 : 0, t1 = dash ? 0.65 : 1;
        const at = (k: number, t: number): number[] => {
          const x = p[i][0] + (p[j][0] - p[i][0]) * t, z = p[i][1] + (p[j][1] - p[i][1]) * t;
          const nx = S[i].l[0] - p[i][0], nz = S[i].l[1] - p[i][1];
          const nl = Math.hypot(nx, nz) || 1;
          const mx = S[j].l[0] - p[j][0], mz = S[j].l[1] - p[j][1];
          const ml = Math.hypot(mx, mz) || 1;
          const ux = (nx / nl) * (1 - t) + (mx / ml) * t, uz = (nz / nl) * (1 - t) + (mz / ml) * t;
          const y = ys[i] + (ys[j] - ys[i]) * t + 0.03;
          return [x + ux * (off + k * w / 2), y, z + uz * (off + k * w / 2)];
        };
        const a = at(-1, t0), b = at(1, t0), c = at(1, t1), d = at(-1, t1);
        bucket.push(...a, ...b, ...c, ...a, ...c, ...d);
      };
      const edgeOff = half - 0.7;
      lane(-edgeOff, 0.22, paint.yel, false); // left edge: the 'r' side is -n
      lane(edgeOff, 0.22, paint.wht, false);
      if (!o.ramp) for (const f of [-0.5, 0, 0.5]) lane(f * (width - 3), 0.18, paint.wht, true);
      dist += seg;
    }
    // end caps so a deck that starts or stops in view isn't hollow
    for (const [i, dir] of [[0, -1], [n - 1, 1]] as const) {
      const a = pt(S[i].l, ys[i]), b = pt(S[i].r, ys[i]);
      const c = pt(S[i].r, ys[i] - T), d = pt(S[i].l, ys[i] - T);
      const t = i === 0 ? [p[1][0] - p[0][0], p[1][1] - p[0][1]] : [p[n - 1][0] - p[n - 2][0], p[n - 1][1] - p[n - 2][1]];
      const tl = Math.hypot(t[0], t[1]) || 1;
      concreteB.quad(a, b, c, d, flat, [(t[0] / tl) * dir, 0, (t[1] / tl) * dir]);
    }
    return { p, ys };
  };

  // ---- mainline carriageways ----
  const mainDecks: { p: P2[]; ys: number[]; src: number }[] = [];
  ctx.main.forEach((m, mi) => {
    const rs = kit.resample(m.pts, 6);
    const g = rs.map((q) => terrainAt(q[0], q[1]));
    const sm = g.map((_v, i) => {
      let a = 0, c = 0;
      for (let k = -4; k <= 4; k++) {
        const v = g[Math.max(0, Math.min(g.length - 1, i + k))];
        a += v;
        c++;
      }
      return a / c;
    });
    const d = deck(m.pts, MAIN_W, (i) => sm[Math.min(i, sm.length - 1)] + DECK_H, { main: true, leftBarrier: m.median ? 'median' : 'none' });
    mainDecks.push({ ...d, src: mi });
    d.p.forEach((q, i) => {
      const s = { x: q[0], z: q[1], y: d.ys[i], half: MAIN_W / 2 };
      mainSamps.push(s);
      addSamp(s);
    });
  });

  // ---- piers, lights, signs on the mainline ----
  const addPier = (x: number, z: number, tx: number, tz: number, y: number, width: number, cap: boolean) => {
    const g0 = terrainAt(x, z);
    const colH = y - DECK_T - (cap ? 1.3 : 0.3) - g0;
    if (colH < 0.5) return;
    const col = new THREE.CylinderGeometry(0.95, 1.1, colH + 0.4, 10);
    col.translate(x, g0 + (colH - 0.4) / 2 + 0.2, z);
    pierGeos.push(col);
    void cap;
    void tx;
    void tz;
    void width;
    ctx.addBox({ minX: x - 1.0, maxX: x + 1.0, minZ: z - 1.0, maxZ: z + 1.0, top: y - DECK_T - 0.4 });
  };
  mainDecks.forEach((d) => {
    const m = ctx.main[d.src];
    for (let i = 2; i < d.p.length - 1; i += 4) {
      const a = d.p[i - 1], b = d.p[i + 1];
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const tx = (b[0] - a[0]) / tl, tz = (b[1] - a[1]) / tl;
      // a hammerhead bent: one column on the carriageway's centreline, a cap beam across it
      addPier(d.p[i][0], d.p[i][1], tx, tz, d.ys[i], MAIN_W - 3, false);
      // the cap beam, built oriented across the road
      const beam = new THREE.BoxGeometry(2.4, 1.3, MAIN_W - 3);
      beam.rotateY(Math.atan2(tx, tz));
      beam.translate(d.p[i][0], d.ys[i] - DECK_T - 0.65, d.p[i][1]);
      pierGeos.push(beam);
    }
    // lights: on the median barrier (back to back, one arm over each carriageway) and along the outer parapet
    if (m.median) {
      for (let i = 3; i < d.p.length - 2; i += 6) {
        const a = d.p[i - 1], b = d.p[i + 1];
        const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const tx = (b[0] - a[0]) / tl, tz = (b[1] - a[1]) / tl;
        const nx = -tz, nz = tx; // right of travel
        const lx = d.p[i][0] - nx * (MAIN_W / 2 + 0.45), lz = d.p[i][1] - nz * (MAIN_W / 2 + 0.45);
        const y = d.ys[i] + 1.0;
        ctx.lamp(lx, y, lz, nx, nz, 8.5); // over this carriageway
        ctx.lamp(lx, y, lz, -nx, -nz, 8.5); // over the other
      }
    }
  });

  // ---- ramps ----
  type Ramp = { pts: P2[]; name: string };
  const ramps: Ramp[] = [];
  const nearestOn = (pts: P2[], x: number, z: number): { i: number; t: number; x: number; z: number } => {
    let best = Infinity, r = { i: 0, t: 0, x: pts[0][0], z: pts[0][1] };
    for (let i = 0; i + 1 < pts.length; i++) {
      const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
      const t = Math.max(0, Math.min(1, ((x - pts[i][0]) * dx + (z - pts[i][1]) * dz) / (dx * dx + dz * dz || 1)));
      const cx = pts[i][0] + dx * t, cz = pts[i][1] + dz * t;
      const d = Math.hypot(x - cx, z - cz);
      if (d < best) {
        best = d;
        r = { i, t, x: cx, z: cz };
      }
    }
    return r;
  };

  // lanes: each mainline is one lane unless a synthetic exit splits it
  const splits = new Map<number, { at: P2; i: number }[]>(); // per main way
  for (const ex of ctx.exits) {
    // find the mainline the exit leaves
    let wi = 0, best = Infinity, hit = { i: 0, t: 0, x: 0, z: 0 };
    ctx.main.forEach((m, k) => {
      const h = nearestOn(m.pts, ex.from[0], ex.from[1]);
      const d = Math.hypot(h.x - ex.from[0], h.z - ex.from[1]);
      if (d < best) {
        best = d;
        wi = k;
        hit = h;
      }
    });
    const m = ctx.main[wi];
    const J: P2 = [hit.x, hit.z];
    const a = m.pts[hit.i], b = m.pts[hit.i + 1];
    const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const T0: P2 = [(b[0] - a[0]) / tl, (b[1] - a[1]) / tl];
    const R0: P2 = [-T0[1], T0[0]]; // right of travel
    const P0: P2 = [J[0], J[1]];
    const P1: P2 = [P0[0] + T0[0] * 45 + R0[0] * 6, P0[1] + T0[1] * 45 + R0[1] * 6];
    const P3: P2 = [ex.to[0], ex.to[1]];
    const P2c: P2 = [P3[0] - ex.toDir[0] * 45, P3[1] - ex.toDir[1] * 45];
    const curve = new THREE.CubicBezierCurve(new THREE.Vector2(...P0), new THREE.Vector2(...P1), new THREE.Vector2(...P2c), new THREE.Vector2(...P3));
    const pts = curve.getSpacedPoints(24).map((v) => [v.x, v.y] as P2);
    ramps.push({ pts, name: ex.name });
    const l = splits.get(wi) ?? [];
    l.push({ at: J, i: hit.i });
    splits.set(wi, l);
  }
  for (const c of ctx.connectors) ramps.push({ pts: c, name: 'connector' });

  // mainline lanes, split where a synthetic exit leaves
  ctx.main.forEach((m, wi) => {
    const cuts = (splits.get(wi) ?? []).sort((a, b) => a.i - b.i);
    if (!cuts.length) {
      lanesOut.push({ pts: m.pts, w: MAIN_W, oneway: true });
      return;
    }
    let from: P2[] = [m.pts[0]];
    let idx = 0;
    for (const c of cuts) {
      for (; idx < c.i; idx++) from.push(m.pts[idx + 1]);
      from.push(c.at);
      lanesOut.push({ pts: from, w: MAIN_W, oneway: true });
      from = [c.at];
    }
    for (; idx + 1 < m.pts.length; idx++) from.push(m.pts[idx + 1]);
    lanesOut.push({ pts: from, w: MAIN_W, oneway: true });
  });

  for (const r of ramps) {
    // push the centreline clear of the mainline beyond the first 40 m so the ramp can separate from the deck
    const cum: number[] = [0];
    for (let i = 1; i < r.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]));
    const pts: P2[] = r.pts.map((q, i) => {
      const w = Math.max(0, Math.min(1, (cum[i] - 30) / 45));
      if (w <= 0) return q;
      let best = Infinity, bx = 0, bz = 0;
      for (const s of mainSamps) {
        if (Math.abs(s.x - q[0]) > 30 || Math.abs(s.z - q[1]) > 30) continue;
        const d = Math.hypot(q[0] - s.x, q[1] - s.z);
        if (d < best) {
          best = d;
          bx = s.x;
          bz = s.z;
        }
      }
      const want = MAIN_W / 2 + 0.5 + RAMP_W / 2 + 1.0;
      if (best >= want) return q;
      const k = ((want - best) * w) / (best || 1);
      return [q[0] + (q[0] - bx) * k, q[1] + (q[1] - bz) * k] as P2;
    });
    const rs = kit.resample(pts, 6);
    const start = mainNear(pts[0][0], pts[0][1]);
    const yStart = start.y - 0.04;
    const yEnd = terrainAt(pts[pts.length - 1][0], pts[pts.length - 1][1]) + 0.06;
    const d = deck(pts, RAMP_W, (i, n) => {
      const t = n > 1 ? i / (n - 1) : 0;
      const g = terrainAt(rs[Math.min(i, rs.length - 1)][0], rs[Math.min(i, rs.length - 1)][1]) + 0.06;
      return Math.max(g, yStart + (yEnd - yStart) * t);
    }, { main: false, leftBarrier: 'parapet', ramp: true });
    d.p.forEach((q, i) => addSamp({ x: q[0], z: q[1], y: d.ys[i], half: RAMP_W / 2 }));
    lanesOut.push({ pts, w: RAMP_W, oneway: true });
    // supports every 18 m while the ramp is more than 2.5 m up
    for (let i = 2; i < d.p.length - 1; i += 3) {
      const a = d.p[i - 1], b = d.p[i + 1];
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      if (mainNear(d.p[i][0], d.p[i][1]).d < 14) continue;
      if (d.ys[i] - terrainAt(d.p[i][0], d.p[i][1]) < 2.5) continue;
      addPier(d.p[i][0], d.p[i][1], (b[0] - a[0]) / tl, (b[1] - a[1]) / tl, d.ys[i], RAMP_W, false);
      const beam = new THREE.BoxGeometry(2.2, 1.0, RAMP_W - 1.5);
      beam.rotateY(Math.atan2((b[0] - a[0]) / tl, (b[1] - a[1]) / tl));
      beam.translate(d.p[i][0], d.ys[i] - 0.9 - 0.5, d.p[i][1]);
      pierGeos.push(beam);
    }
    // while the ramp is low, it is a wall the rat can't wade through (it can climb onto the last stretch)
    for (let i = 0; i + 1 < d.p.length; i++) {
      const top = Math.max(d.ys[i], d.ys[i + 1]);
      const g = terrainAt(d.p[i][0], d.p[i][1]);
      if (top - g > 3.2 || mainNear(d.p[i][0], d.p[i][1]).d < 13) continue;
      const S2 = kit.sides([d.p[i], d.p[i + 1]], RAMP_W);
      ctx.addPoly(makePoly(ctx.windCCW([S2[0].l, S2[1].l, S2[1].r, S2[0].r]), top));
    }
  }

  // ---- exit signs: green boards over the mainline ahead of each ramp ----
  const signFor = (ex: { name: string; from: P2 }, text: string[]) => {
    let wi = 0, best = Infinity, hit = { i: 0, t: 0, x: 0, z: 0 };
    ctx.main.forEach((m, k) => {
      const h = nearestOn(m.pts, ex.from[0], ex.from[1]);
      const d = Math.hypot(h.x - ex.from[0], h.z - ex.from[1]);
      if (d < best) {
        best = d;
        wi = k;
        hit = h;
      }
    });
    const dk = mainDecks.find((q) => q.src === wi)!;
    // walk back ~140 m from the junction along the deck
    let bi = 0, bd = Infinity;
    dk.p.forEach((q, i) => {
      const d = Math.hypot(q[0] - hit.x, q[1] - hit.z);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    const si = Math.max(1, bi - 23);
    const a = dk.p[si - 1], b = dk.p[Math.min(dk.p.length - 1, si + 1)];
    const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tx = (b[0] - a[0]) / tl, tz = (b[1] - a[1]) / tl;
    const nx = -tz, nz = tx;
    const x = dk.p[si][0] + nx * (MAIN_W / 2 - 0.9), z = dk.p[si][1] + nz * (MAIN_W / 2 - 0.9);
    signs.push({ x, y: dk.ys[si], z, bx: x - nx * 2.8, bz: z - nz * 2.8, yaw: Math.atan2(-tx, -tz), text });
  };
  const fromList: { name: string; from: P2 }[] = [];
  for (const c of ctx.connectors) fromList.push({ name: 'BELMONT', from: c[0] });
  for (const ex of ctx.exits) fromList.push({ name: ex.name.toUpperCase(), from: ex.from });
  for (const f of fromList) signFor(f, [f.name, 'EXIT  1/4 MILE']);

  // ---- build the meshes ----
  const concreteMat = new THREE.MeshToonMaterial({ color: CONCRETE, gradientMap: ctx.gradient });
  concreteMat.side = THREE.DoubleSide;
  const deckMesh = new THREE.Mesh(roadB.build(), ctx.roadMat);
  deckMesh.receiveShadow = true;
  const concMesh = new THREE.Mesh(concreteB.build(), concreteMat);
  concMesh.castShadow = concMesh.receiveShadow = true;
  ctx.group.add(deckMesh, concMesh);
  if (pierGeos.length) {
    for (const g of pierGeos) {
      g.deleteAttribute('uv');
    }
    const pm = new THREE.Mesh(mergeGeometries(pierGeos, false)!, concreteMat);
    pm.castShadow = pm.receiveShadow = true;
    ctx.group.add(pm);
  }
  for (const [bucket, color] of [[paint.yel, 0xe8c24a], [paint.wht, 0xf2efe6]] as const) {
    if (!bucket.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bucket, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(bucket.length).fill(0).map((_v, i) => (i % 3 === 1 ? 1 : 0)), 3));
    const m = new THREE.MeshToonMaterial({ color, gradientMap: ctx.gradient, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    ctx.group.add(mesh);
  }
  for (const s of signs) {
    const tex = signTexture(s.text);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(7, 2.2), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    board.position.set(s.bx, s.y + 6.2, s.bz);
    board.rotation.y = s.yaw;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 6.4, 0.3), new THREE.MeshToonMaterial({ color: 0x4a4e52, gradientMap: ctx.gradient }));
    post.position.set(s.x, s.y + 3.1, s.z);
    ctx.group.add(board, post);
  }

  return { surfaceAt, lanes: lanesOut };
}
