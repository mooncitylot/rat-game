import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type P2 = [number, number];

const POLE_H = 8;
const ARM_Y = POLE_H - 0.6;
const ARM_OFFS = [-0.9, 0, 0.9]; // three wires per span, spread along the crossarm
const SAG = 0.9;
const MAX_SPAN = 60;
const PIGEON_VIS = 90; // only pigeons this close to the rat are drawn / simulated
const SCARE = 5.5;

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

type State = 'perched' | 'flying' | 'away';

class Pigeon {
  readonly group = new THREE.Group();
  readonly wings: THREE.Mesh[];
  state: State = 'perched';
  span: Span;
  u: number;
  timer = 0;
  private from = new THREE.Vector3();
  private to = new THREE.Vector3();
  private t = 0;
  private dur = 1;
  private arc = 3;
  private phase = Math.random() * 6;

  constructor(body: THREE.Object3D, wingGeo: THREE.BufferGeometry, wingMat: THREE.Material, span: Span, u: number) {
    this.span = span;
    this.u = u;
    this.group.add(body.clone());
    this.wings = [-1, 1].map((s) => {
      const w = new THREE.Mesh(wingGeo, wingMat);
      w.position.set(s * 0.05, 0.1, 0);
      w.scale.x = s;
      w.visible = false;
      this.group.add(w);
      return w;
    });
    this.group.scale.setScalar(1.5);
    this.perch(span, u);
  }

  private perch(span: Span, u: number): void {
    this.span = span;
    this.u = u;
    this.state = 'perched';
    spanPoint(span, u, this.group.position);
    this.group.position.y += 0.02;
    // face along the wire, either way
    this.group.rotation.set(0, Math.atan2(span.bx - span.ax, span.bz - span.az) + (this.phase > 3 ? Math.PI : 0), 0);
    this.wings.forEach((w) => (w.visible = false));
  }

  private launch(to: THREE.Vector3, dur: number, arc: number): void {
    this.from.copy(this.group.position);
    this.to.copy(to);
    this.t = 0;
    this.dur = dur;
    this.arc = arc;
    this.wings.forEach((w) => (w.visible = true));
  }

  /** `home` = a free wire spot to come back to */
  update(dt: number, time: number, rat: THREE.Vector3, pickSpot: () => { span: Span; u: number }): void {
    const g = this.group;
    if (this.state === 'perched') {
      // idle bob
      g.rotation.x = Math.sin(time * 3 + this.phase) * 0.04;
      const dx = rat.x - g.position.x, dz = rat.z - g.position.z;
      if (dx * dx + dz * dz < SCARE * SCARE && rat.y < g.position.y + 2) {
        // scatter away from the rat, up and out
        const d = Math.hypot(dx, dz) || 1;
        const dist = 35 + Math.random() * 25;
        this.state = 'away';
        this.timer = 4 + Math.random() * 6;
        this.launch(new THREE.Vector3(g.position.x - (dx / d) * dist + (Math.random() - 0.5) * 16, g.position.y + 10 + Math.random() * 8, g.position.z - (dz / d) * dist + (Math.random() - 0.5) * 16), 1.8 + Math.random() * 0.6, 2);
      }
    } else if (this.state === 'away') {
      if (this.t < this.dur) this.fly(dt, time);
      else {
        // circle in place until it is time to come home
        g.position.y += Math.sin(time * 2 + this.phase) * dt * 0.8;
        this.flap(time, 0.5);
        this.timer -= dt;
        if (this.timer <= 0) {
          const spot = pickSpot();
          spanPoint(spot.span, spot.u, this.to);
          this.to.y += 0.02;
          this.span = spot.span;
          this.u = spot.u;
          this.state = 'flying';
          this.launch(this.to, 2.4 + Math.random(), 1.5);
        }
      }
    } else {
      if (this.t < this.dur) this.fly(dt, time);
      else this.perch(this.span, this.u);
    }
  }

  private fly(dt: number, time: number): void {
    const g = this.group;
    this.t += dt;
    const k = Math.min(1, this.t / this.dur);
    const e = k * k * (3 - 2 * k);
    const prev = g.position.clone();
    g.position.lerpVectors(this.from, this.to, e);
    g.position.y += Math.sin(k * Math.PI) * this.arc;
    const vx = g.position.x - prev.x, vz = g.position.z - prev.z;
    if (vx * vx + vz * vz > 1e-8) g.rotation.set(0, Math.atan2(vx, vz), 0);
    this.flap(time, 1);
  }

  private flap(time: number, amp: number): void {
    const a = Math.sin(time * 28 + this.phase) * 0.9 * amp;
    this.wings[0].rotation.z = a;
    this.wings[1].rotation.z = -a;
  }
}

export interface PowerLines {
  group: THREE.Group;
  update: (dt: number, time: number, rat: THREE.Vector3) => void;
}

/**
 * Utility poles down the named streets, sagging wires between them, and pigeons sitting on the wires.
 * Pigeons scatter when the rat comes close and drift back to a free wire a few seconds later.
 */
export function buildPowerLines(opts: {
  streets: { pts: P2[]; half: number; name: string }[];
  terrainAt: (x: number, z: number) => number;
  blocked: (x: number, z: number) => boolean;
  addBox: (b: { minX: number; maxX: number; minZ: number; maxZ: number; top: number }) => void;
  gradient: THREE.DataTexture;
  nearEdge: (x: number, z: number, m: number) => boolean;
  rand: () => number;
  pigeons?: number;
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
  if (!poles.length) return { group, update: () => {} };

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

  // ---- pigeons ----
  const grey = toon(0x8a8d99), dark = toon(0x4d5160), neck = toon(0x3f8f7a);
  const part = (g: THREE.BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z);
  const bodyG = part(new THREE.SphereGeometry(0.09, 7, 5).scale(1, 0.85, 1.5), 0, 0.12, 0);
  const headG = part(new THREE.SphereGeometry(0.045, 6, 5), 0, 0.2, 0.12);
  const tailG = part(new THREE.BoxGeometry(0.07, 0.015, 0.12), 0, 0.12, -0.17);
  const beakG = part(new THREE.ConeGeometry(0.012, 0.04, 4).rotateX(Math.PI / 2), 0, 0.2, 0.18);
  const body = new THREE.Mesh(mergeGeometries([bodyG, tailG])!, grey);
  const head = new THREE.Mesh(mergeGeometries([headG])!, neck);
  const beak = new THREE.Mesh(beakG, dark);
  const bodyGroup = new THREE.Group();
  bodyGroup.add(body, head, beak);
  const wingGeo = new THREE.BoxGeometry(0.18, 0.012, 0.14).translate(0.09, 0, 0);

  const pickSpot = () => {
    const s = spans[Math.floor(rand() * spans.length)];
    return { span: s, u: 0.12 + rand() * 0.76 };
  };
  const pigeons: Pigeon[] = [];
  const count = Math.min(opts.pigeons ?? 120, spans.length * 2);
  for (let i = 0; i < count; i++) {
    const spot = pickSpot();
    const p = new Pigeon(bodyGroup, wingGeo, dark, spot.span, spot.u);
    group.add(p.group);
    pigeons.push(p);
  }

  return {
    group,
    update(dt, time, rat) {
      for (const p of pigeons) {
        const dx = p.group.position.x - rat.x, dz = p.group.position.z - rat.z;
        const near = dx * dx + dz * dz < PIGEON_VIS * PIGEON_VIS;
        p.group.visible = near;
        if (near || p.state !== 'perched') p.update(dt, time, rat, pickSpot);
      }
    },
  };
}
