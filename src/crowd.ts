import * as THREE from 'three';
import type { Rat } from './rat';
import { pedestrianGo } from './signals';
import { CURB, LANE, SIDEWALK_Y, SKIN, HAIR, JACKET, PANTS, type Edge, type Net, type Node } from './human';

/**
 * Background pedestrians. Thousands of them, drawn with a handful of InstancedMeshes (torso, head, hair, legs,
 * arms) and simulated with just enough logic to follow the sidewalk graph and obey the walk signals.
 * The full-detail `Human` rigs stay for the people close enough to stomp the rat; these fill the street behind them.
 */

const SCALE = 1.2;
const MAX_VISIBLE = 900;

interface Walker {
  edge: Edge;
  s: number;
  dir: { dir: 1 | -1 };
  pace: number;
  x: number;
  z: number;
  y: number;
  px: number;
  pz: number;
  yaw: number;
  phase: number;
  stride: number;
  speed: number;
  scale: number;
  active: boolean;
  cloth: THREE.Color;
  armC: THREE.Color;
  skin: THREE.Color;
  hair: THREE.Color;
  legC: THREE.Color;
  hipX: number;
  shX: number;
  wait: number;
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export class Crowd {
  readonly group = new THREE.Group();
  private walkers: Walker[] = [];
  private torso: THREE.InstancedMesh;
  private head: THREE.InstancedMesh;
  private hair: THREE.InstancedMesh;
  private legs: THREE.InstancedMesh;
  private arms: THREE.InstancedMesh;

  constructor(gradient: THREE.DataTexture, private net: Net, starts: Node[], count: number, private radius: number) {
    const mat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradient });
    const body = new THREE.CapsuleGeometry(0.15, 0.3, 2, 7).scale(1.2, 1, 0.78).translate(0, 1.26, 0);
    const skull = new THREE.SphereGeometry(0.12, 8, 6).scale(0.92, 1.1, 1.0).translate(0, 1.71, 0);
    const hairG = new THREE.SphereGeometry(0.128, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.58).scale(0.95, 1.1, 1.04).translate(0, 1.72, -0.008);
    const leg = new THREE.CapsuleGeometry(0.07, 0.78, 2, 6).translate(0, -0.46, 0);
    const arm = new THREE.CapsuleGeometry(0.047, 0.46, 2, 6).translate(0, -0.3, 0);

    const make = (g: THREE.BufferGeometry, n: number, shadow: boolean) => {
      const m = new THREE.InstancedMesh(g, mat, n);
      m.count = 0;
      m.castShadow = shadow;
      m.frustumCulled = false; // instances span the whole city; the bounding sphere is just the origin
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
      return m;
    };
    this.torso = make(body, MAX_VISIBLE, true);
    this.head = make(skull, MAX_VISIBLE, false);
    this.hair = make(hairG, MAX_VISIBLE, false);
    this.legs = make(leg, MAX_VISIBLE * 2, true);
    this.arms = make(arm, MAX_VISIBLE * 2, false);
    // torso, head and hair all hang off the figure's own transform: share one matrix buffer
    this.head.instanceMatrix = this.torso.instanceMatrix;
    this.hair.instanceMatrix = this.torso.instanceMatrix;

    const r = rng(0x9e3779b1);
    const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
    for (let i = 0; i < count && starts.length; i++) {
      const start = starts[Math.floor(r() * starts.length)];
      const dir: 1 | -1 = r() < 0.5 ? 1 : -1;
      const edge = net.first(start, dir);
      const kind = pick(['coat', 'coat', 'jacket', 'jacket', 'jacket', 'tee', 'dress', 'shorts']);
      const skin = new THREE.Color(pick(SKIN));
      const cloth = new THREE.Color(pick(JACKET));
      const bald = r() < 0.12;
      const w: Walker = {
        edge,
        s: r() * edge.len,
        dir: { dir },
        pace: 1.45 + r() * 0.8,
        x: 0, z: 0, y: SIDEWALK_Y, px: 0, pz: 0,
        yaw: Math.atan2(edge.hx, edge.hz),
        phase: r() * 6.28,
        stride: 0.8 * (0.92 + r() * 0.2),
        speed: 0,
        scale: SCALE * (0.92 + r() * 0.2),
        active: false,
        cloth,
        armC: kind === 'tee' || kind === 'dress' ? skin : cloth,
        skin,
        hair: bald ? skin : new THREE.Color(pick(HAIR)),
        legC: kind === 'shorts' || kind === 'dress' ? skin : new THREE.Color(kind === 'coat' ? cloth.getHex() : pick(PANTS)),
        hipX: 0.095,
        shX: 0.235 * (0.9 + r() * 0.3),
        wait: 0,
      };
      this.edgePoint(w, w.s);
      w.x = w.px = this.tx;
      w.z = w.pz = this.tz;
      this.walkers.push(w);
    }
  }

  get size(): number {
    return this.walkers.length;
  }

  private tx = 0;
  private tz = 0;
  private edgePoint(w: Walker, s: number): void {
    const e = w.edge;
    this.tx = e.a.x + e.hx * s - e.hz * LANE;
    this.tz = e.a.y + e.hz * s + e.hx * LANE;
  }

  private sim(w: Walker, dt: number, t: number, rat: Rat, d2: number): void {
    let go = w.pace;
    const e = w.edge;
    if (e.kind === 'cross') {
      const atCurb = w.s > CURB - 0.6 && w.s < CURB - 0.2;
      if (atCurb && !e.free && !pedestrianGo(t, e.axis)) go = 0; // wait for the walk signal
      if (w.s > CURB && w.s < e.len - CURB) go = w.pace * 1.2;
    }
    if (d2 < 1.4 * 1.4 && rat.pos.y < 0.7) go = 0; // a rat underfoot: stop and stare
    w.s += go * dt;
    if (w.s >= e.len) {
      w.s = e.len;
      w.edge = this.net.next(e, w.dir);
      w.s = 0;
    }
    this.edgePoint(w, w.s);
    w.px = w.x;
    w.pz = w.z;
    const k = Math.min(1, dt * 9);
    w.x += (this.tx - w.x) * k;
    w.z += (this.tz - w.z) * k;
    const mx = w.x - w.px, mz = w.z - w.pz;
    w.speed = Math.hypot(mx, mz) / Math.max(dt, 1e-4);
    if (w.speed < 0.05) w.speed = 0;
    else if (w.speed > 0.2) {
      const want = Math.atan2(mx, mz);
      w.yaw += Math.atan2(Math.sin(want - w.yaw), Math.cos(want - w.yaw)) * Math.min(1, dt * 7);
    }
    w.y = this.net.height(w.x, w.z, w.edge.kind, w.s, w.edge.len);
    w.phase += dt * Math.PI * (w.speed / w.stride);
  }

  private B = new THREE.Matrix4();
  private L = new THREE.Matrix4();
  private M = new THREE.Matrix4();
  private pos = new THREE.Vector3();
  private sc = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private q = new THREE.Quaternion();
  private qx = new THREE.Quaternion();
  private ax = new THREE.Vector3(1, 0, 0);

  update(dt: number, t: number, rat: Rat): void {
    const R2 = this.radius * this.radius, R2h = R2 * 1.32;
    let n = 0;
    const { torso, head, hair, legs, arms } = this;
    for (const w of this.walkers) {
      const dx = w.x - rat.pos.x, dz = w.z - rat.pos.z;
      const d2 = dx * dx + dz * dz;
      const on = d2 < (w.active ? R2h : R2);
      w.active = on;
      if (!on) continue;
      this.sim(w, dt, t, rat, d2);
      if (n >= MAX_VISIBLE) continue;

      // figure transform
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, w.yaw);
      this.pos.set(w.x, w.y, w.z);
      this.sc.setScalar(w.scale);
      this.B.compose(this.pos, this.q, this.sc);
      torso.setMatrixAt(n, this.B);
      torso.setColorAt(n, w.cloth);
      head.setColorAt(n, w.skin);
      hair.setColorAt(n, w.hair);

      // limbs swing about the hips and shoulders
      const a = THREE.MathUtils.clamp(w.speed / 1.9, 0, 1.3);
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1;
        const th = w.phase + (i ? Math.PI : 0);
        this.qx.setFromAxisAngle(this.ax, -Math.sin(th) * 0.55 * a);
        this.L.compose(this.pos.set(side * w.hipX, 0.92, 0), this.qx, this.one);
        this.M.multiplyMatrices(this.B, this.L);
        legs.setMatrixAt(n * 2 + i, this.M);
        legs.setColorAt(n * 2 + i, w.legC);

        const ta = w.phase + (i ? 0 : Math.PI);
        this.qx.setFromAxisAngle(this.ax, -Math.sin(ta) * 0.5 * a);
        this.L.compose(this.pos.set(side * w.shX, 1.48, 0), this.qx, this.one);
        this.M.multiplyMatrices(this.B, this.L);
        arms.setMatrixAt(n * 2 + i, this.M);
        arms.setColorAt(n * 2 + i, w.armC);
      }
      n++;
    }
    torso.count = head.count = hair.count = n;
    legs.count = arms.count = n * 2;
    for (const m of [torso, head, hair, legs, arms]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    // (head and hair share the torso's matrix buffer, so they only need their own colours)
    this.visible = n;
  }

  /** how many are drawn this frame (for the stats overlay) */
  visible = 0;
}
