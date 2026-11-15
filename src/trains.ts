import * as THREE from 'three';
import { cube, merge } from './transit';

type P2 = [number, number];

const CAR_LEN = 15, CAR_GAP = 0.7, CARS = 6;
const TRAIN_LEN = CARS * (CAR_LEN + CAR_GAP);
const DECK = 10.15; // the elevated deck's top sits 10 m over the terrain; wheels rest on it
const CRUISE = 17, ACCEL = 1.5, BRAKE = 1.7, DWELL = 11;

/** one stretch of elevated track, resampled, with straight run-outs past both ends so trains can slide off-map */
class Track {
  readonly p: THREE.Vector2[] = [];
  readonly cum: number[] = [0];
  readonly len: number;
  stopS = 0; // where the head of a stopping train halts
  platformSide = 1;

  constructor(pts: P2[]) {
    const pad = 220;
    const first = pts[0], second = pts[1], last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const norm = (a: P2, b: P2): P2 => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    };
    const d0 = norm(second, first), d1 = norm(prev, last);
    const ext: P2[] = [[first[0] + d0[0] * pad, first[1] + d0[1] * pad], ...pts, [last[0] + d1[0] * pad, last[1] + d1[1] * pad]];
    // resample every 2 m
    for (let i = 0; i + 1 < ext.length; i++) {
      const a = ext[i], b = ext[i + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(L / 2));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) this.p.push(new THREE.Vector2(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n));
    }
    for (let i = 1; i < this.p.length; i++) this.cum.push(this.cum[i - 1] + this.p[i].distanceTo(this.p[i - 1]));
    this.len = this.cum[this.cum.length - 1];
  }

  /** position and unit tangent at arc length s (clamped) */
  at(s: number, out: { x: number; z: number; tx: number; tz: number }): void {
    s = THREE.MathUtils.clamp(s, 0, this.len - 1e-3);
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = this.p[lo], b = this.p[hi];
    const seg = this.cum[hi] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / seg;
    out.x = a.x + (b.x - a.x) * t;
    out.z = a.y + (b.y - a.y) * t;
    out.tx = (b.x - a.x) / seg;
    out.tz = (b.y - a.y) / seg;
  }

  /** arc length of the track point nearest (x, z) */
  nearest(x: number, z: number): number {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.p.length; i++) {
      const d = (this.p[i].x - x) ** 2 + (this.p[i].y - z) ** 2;
      if (d < bd) { bd = d; best = this.cum[i]; }
    }
    return best;
  }
}

/** Stitch the mapped rail pieces into long runs, always continuing in the direction of travel. */
function chain(seed: number, polys: P2[][], used: Set<number>): P2[] {
  let run = polys[seed].slice();
  used.add(seed);
  const near = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 4;
  const dir = (a: P2, b: P2): P2 => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (let i = 0; i < polys.length && !grew; i++) {
      if (used.has(i)) continue;
      const p = polys[i];
      const end = run[run.length - 1], tail = dir(run[run.length - 2], end);
      const head = run[0], headDir = dir(run[1], head); // heading out of the start
      for (const cand of [p, [...p].reverse()]) {
        // append: cand starts where the run ends and keeps going the same way
        if (near(cand[0], end)) {
          const d = dir(cand[0], cand[1]);
          if (d[0] * tail[0] + d[1] * tail[1] > 0.5) { run = [...run, ...cand.slice(1)]; used.add(i); grew = true; break; }
        }
        // prepend: cand ends where the run starts
        if (near(cand[cand.length - 1], head)) {
          const d = dir(cand[cand.length - 2], cand[cand.length - 1]);
          if (d[0] * headDir[0] + d[1] * headDir[1] > 0.5) { run = [...cand.slice(0, -1), ...run]; used.add(i); grew = true; break; }
        }
      }
    }
  }
  return run;
}

// ---- the cars ----

interface Parts { body: THREE.BufferGeometry; glass: THREE.BufferGeometry; lamps: THREE.BufferGeometry; tails: THREE.BufferGeometry; trucks: THREE.BufferGeometry }
function carParts(stripe: number): Parts {
  const SILVER = 0xc3c7cd, ROOF = 0x9a9ea6;
  const H = 3.6;
  return {
    body: merge([
      cube(3.2, H - 0.9, CAR_LEN, 0, 0.9 + (H - 0.9) / 2, 0, SILVER),
      cube(3.22, 0.5, CAR_LEN - 0.4, 0, 1.45, 0, stripe), // line-colour band
      cube(2.8, 0.3, CAR_LEN - 0.6, 0, H + 0.1, 0, ROOF),
      cube(1.8, 0.25, 4, 0, H + 0.35, -2, 0x888c94), // roof equipment
    ]),
    glass: merge([
      cube(3.24, 0.95, CAR_LEN - 1.6, 0, 2.55, 0, 0x1d2a36),
      cube(2.6, 1.3, 0.06, 0, 2.6, CAR_LEN / 2 + 0.02, 0x1d2a36), // end windows
      cube(2.6, 1.3, 0.06, 0, 2.6, -CAR_LEN / 2 - 0.02, 0x1d2a36),
    ]),
    lamps: merge([cube(0.4, 0.22, 0.06, -0.9, 1.2, CAR_LEN / 2 + 0.04, 0xfff3c8), cube(0.4, 0.22, 0.06, 0.9, 1.2, CAR_LEN / 2 + 0.04, 0xfff3c8)]),
    tails: merge([cube(0.3, 0.2, 0.06, -0.9, 1.2, -CAR_LEN / 2 - 0.04, 0xff3a2a), cube(0.3, 0.2, 0.06, 0.9, 1.2, -CAR_LEN / 2 - 0.04, 0xff3a2a)]),
    trucks: merge([
      cube(2.6, 0.7, 3.4, 0, 0.55, 4.6, 0x2a2b31),
      cube(2.6, 0.7, 3.4, 0, 0.55, -4.6, 0x2a2b31),
      cube(3.0, 0.12, CAR_LEN - 0.5, 0, 0.88, 0, 0x34353c), // underframe
    ]),
  };
}

class Train {
  s: number;
  speed = 0;
  dwell = 0;
  served = false;
  readonly group = new THREE.Group();
  private cars: THREE.Group[] = [];
  private tmp = { x: 0, z: 0, tx: 0, tz: 0 };
  private a = { x: 0, z: 0, tx: 0, tz: 0 };
  private b = { x: 0, z: 0, tx: 0, tz: 0 };

  constructor(readonly track: Track, s: number, parts: Parts, mats: { body: THREE.Material; glass: THREE.Material; lamps: THREE.Material; tails: THREE.Material; trucks: THREE.Material }) {
    this.s = s;
    for (let i = 0; i < CARS; i++) {
      const g = new THREE.Group();
      const add = (geo: THREE.BufferGeometry, m: THREE.Material, shadow = false) => {
        const mesh = new THREE.Mesh(geo, m);
        mesh.castShadow = shadow;
        mesh.frustumCulled = false;
        g.add(mesh);
      };
      add(parts.body, mats.body, true);
      add(parts.glass, mats.glass);
      add(parts.trucks, mats.trucks);
      if (i === 0) add(parts.lamps, mats.lamps);
      if (i === CARS - 1) add(parts.tails, mats.tails);
      this.cars.push(g);
      this.group.add(g);
    }
  }

  /** pose every car along the track under the head position */
  place(terrainAt: (x: number, z: number) => number): void {
    for (let i = 0; i < CARS; i++) {
      const centre = this.s - (i + 0.5) * (CAR_LEN + CAR_GAP) + CAR_GAP / 2;
      const t = this.track;
      t.at(centre, this.tmp);
      t.at(centre + CAR_LEN * 0.4, this.a);
      t.at(centre - CAR_LEN * 0.4, this.b);
      const g = this.cars[i];
      const ya = terrainAt(this.a.x, this.a.z) + DECK, yb = terrainAt(this.b.x, this.b.z) + DECK;
      g.position.set(this.tmp.x, (ya + yb) / 2, this.tmp.z);
      const dx = this.a.x - this.b.x, dz = this.a.z - this.b.z;
      g.rotation.set(0, Math.atan2(dx, dz), 0);
      g.rotateX(-Math.atan2(ya - yb, Math.hypot(dx, dz)));
    }
  }
}

/** The L: red and brown trains on the elevated tracks, stopping at a station. */
export class Trains {
  readonly group = new THREE.Group();
  readonly trains: Train[] = [];
  private winMat = new THREE.MeshBasicMaterial({ color: 0x1d2a36 });
  private day = new THREE.Color(0x1d2a36);
  private night = new THREE.Color(0xffe39a);
  /** station platform spot, for the toast / map */
  readonly station: { x: number; z: number } | null = null;

  constructor(rails: P2[][], private terrainAt: (x: number, z: number) => number, gradient: THREE.DataTexture) {
    const polys = rails.filter((r) => r.length >= 2);
    if (!polys.length) return;
    const order = polys.map((_, i) => i).sort((a, b) => polys[b].length - polys[a].length);
    const used = new Set<number>();
    const runs: P2[][] = [];
    for (const i of order) {
      if (used.has(i) || runs.length >= 2) continue;
      runs.push(chain(i, polys, used));
    }
    const tracks = runs.map((r) => new Track(r));
    // run the second track the opposite way
    if (tracks[1]) {
      const rev = new Track([...runs[1]].reverse());
      tracks[1] = rev;
    }

    const bodyMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradient, vertexColors: true });
    const trucks = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradient, vertexColors: true });
    const lamps = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
    const tails = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
    const glass = this.winMat;
    glass.vertexColors = true;
    const lines = [0xc8102e, 0x62361b]; // Red Line, Brown Line

    // the station: the point of each track nearest the middle of the map
    const stationAt: P2 = [0, 0];
    tracks.forEach((t, ti) => {
      t.stopS = t.nearest(stationAt[0], stationAt[1]) + TRAIN_LEN / 2;
      // platform goes on the side away from the other track
      const other = tracks[1 - ti];
      if (other) {
        const o = { x: 0, z: 0, tx: 0, tz: 0 }, c = { x: 0, z: 0, tx: 0, tz: 0 };
        t.at(t.stopS - TRAIN_LEN / 2, c);
        other.at(other.nearest(c.x, c.z), o);
        const nx = -c.tz, nz = c.tx;
        t.platformSide = (o.x - c.x) * nx + (o.z - c.z) * nz > 0 ? 1 : -1; // local +x is the right-hand normal
      }
      const parts = carParts(lines[ti % 2]);
      const per = 2;
      for (let k = 0; k < per; k++) {
        const tr = new Train(t, (t.len * (k + 0.3)) / per, parts, { body: bodyMat, glass, lamps, tails, trucks });
        this.trains.push(tr);
        this.group.add(tr.group);
      }
      this.group.add(this.buildStation(t, ti));
    });
    const t0 = tracks[0];
    if (t0) {
      const c = { x: 0, z: 0, tx: 0, tz: 0 };
      t0.at(t0.stopS - TRAIN_LEN / 2, c);
      (this as { station: { x: number; z: number } | null }).station = { x: c.x, z: c.z };
    }
    this.trains.forEach((tr) => tr.place(this.terrainAt));
  }

  private buildStation(t: Track, ti: number): THREE.Object3D {
    const g = new THREE.Group();
    const centre = { x: 0, z: 0, tx: 0, tz: 0 };
    t.at(t.stopS - TRAIN_LEN / 2, centre);
    const yaw = Math.atan2(centre.tx, centre.tz);
    const y = this.terrainAt(centre.x, centre.z) + DECK;
    const side = t.platformSide;
    const L = TRAIN_LEN + 6;
    const parts = [
      cube(4.0, 2.4, L, 0, -0.3 + 0.0, 0, 0x8d8a84), // platform block, sunk below deck level
      cube(4.0, 0.12, L, 0, 0.9, 0, 0xb9b4a8), // platform surface
      cube(0.25, 0.1, L, 1.9 * -side, 0.97, 0, 0xe8c84a), // tactile edge strip
    ];
    // canopy: roof on posts, with a sign on the street side
    const canopy: THREE.BufferGeometry[] = [cube(4.6, 0.22, L - 10, 0.2 * side, 5.0, 0, 0x4a5058)];
    for (let z = -L / 2 + 8; z <= L / 2 - 8; z += 11) canopy.push(cube(0.18, 4.0, 0.18, 1.5 * side, 3.0, z, 0x3a3f46));
    for (let z = -L / 2 + 8; z <= L / 2 - 8; z += 22) canopy.push(cube(1.6, 0.06, 0.6, 0, 4.85, z, 0xfff1b0)); // light strips
    const mat = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true });
    const body = new THREE.Mesh(merge([...parts, ...canopy]), mat);
    body.castShadow = body.receiveShadow = true;
    // platform sits beside the track, away from the other one
    const wrap = new THREE.Group();
    body.position.x = side * 4.2;
    wrap.add(body);
    // name sign
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 96;
    const x = c.getContext('2d')!;
    x.fillStyle = '#1f2a36';
    x.fillRect(0, 0, 512, 96);
    x.fillStyle = ti % 2 ? '#62361b' : '#c8102e';
    x.fillRect(0, 0, 512, 12);
    x.fillStyle = '#f4f1e6';
    x.font = 'bold 54px ui-monospace, Menlo, monospace';
    x.textAlign = 'center';
    x.fillText('ADDISON', 256, 72);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    for (const end of [-1, 1]) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(5, 0.95), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      sign.position.set(side * 4.2, 4.3, end * (L / 2 - 9));
      wrap.add(sign);
    }
    g.add(wrap);
    g.position.set(centre.x, y, centre.z);
    g.rotation.y = yaw;
    return g;
  }

  /** Move every train. Returns 0..1: how close the nearest one is to `focus` (for the rumble). */
  update(dt: number, focus: THREE.Vector3, night: number): number {
    this.winMat.color.copy(this.day).lerp(this.night, night * 0.9);
    let loud = 0;
    for (const tr of this.trains) {
      const t = tr.track;
      let want = CRUISE;
      // hold back behind a train on the same track
      for (const o of this.trains) {
        if (o === tr || o.track !== t) continue;
        const gap = o.s - TRAIN_LEN - tr.s;
        if (gap > -TRAIN_LEN && gap < 200) want = Math.min(want, Math.max(0, (gap - 25) * 0.25));
      }
      if (tr.dwell > 0) {
        tr.dwell -= dt;
        want = 0;
        if (tr.dwell <= 0) tr.served = true;
      } else if (!tr.served) {
        const dist = t.stopS - tr.s;
        if (dist > -2 && dist < 400) want = Math.min(want, Math.sqrt(2 * BRAKE * 0.9 * Math.max(dist, 0)) + (dist < 1.2 ? 0 : 0.6));
        if (dist < 1.5 && tr.speed < 0.4) {
          tr.dwell = DWELL;
          tr.speed = 0;
        }
      }
      tr.speed += Math.sign(want - tr.speed) * Math.min(Math.abs(want - tr.speed), (want > tr.speed ? ACCEL : BRAKE * 1.2) * dt);
      tr.s += tr.speed * dt;
      if (tr.s - TRAIN_LEN > t.len - 60) {
        tr.s = 0;
        tr.served = false;
        tr.speed = CRUISE * 0.6;
      }
      tr.place(this.terrainAt);
      // loudness: nearest car centre, scaled by speed
      for (let i = 0; i < CARS; i += 2) {
        const c = (tr as unknown as { cars: THREE.Group[] }).cars[i].position;
        const d = Math.hypot(c.x - focus.x, c.z - focus.z);
        loud = Math.max(loud, Math.max(0, 1 - d / 200) * (0.25 + 0.75 * Math.min(1, tr.speed / 12)));
      }
    }
    return loud;
  }
}
