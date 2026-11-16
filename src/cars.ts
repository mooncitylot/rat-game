import * as THREE from 'three';
import type { Rat } from './rat';
import { BUS_LEN, BUS_WID, getBusParts, type StopSpot } from './transit';

export interface CarRoad {
  pts: [number, number][];
  w: number;
  oneway: boolean;
}

interface Lane {
  p: THREE.Vector2[]; // resampled polyline (centre line)
  cum: number[]; // cumulative length
  len: number;
  w: number;
  oneway: boolean;
  stops: number[]; // bus stop positions along the centre line (metres from the start)
  startLinks: { lane: number; dir: 1 | -1 }[]; // roads that continue from the start / end
  endLinks: { lane: number; dir: 1 | -1 }[];
}

const COLORS = [0xc0392b, 0x2f5fa8, 0xe8e2d0, 0x1c1c22, 0x4a4a52, 0xd9a21f, 0x2f7a4a, 0x8a8f99, 0x7a2f6a, 0xe86a2a];
const LEN = 4.4, WID = 1.8;

interface Shared {
  lower: THREE.BufferGeometry;
  glassG: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  hub: THREE.BufferGeometry;
  bumper: THREE.BufferGeometry;
  lamp: THREE.BufferGeometry;
  mirror: THREE.BufferGeometry;
  beamG: THREE.BufferGeometry;
  glass: THREE.MeshToonMaterial;
  tire: THREE.MeshToonMaterial;
  hubM: THREE.MeshToonMaterial;
  trim: THREE.MeshToonMaterial;
  head: THREE.MeshBasicMaterial;
  tail: THREE.MeshBasicMaterial;
  brake: THREE.MeshBasicMaterial;
  beam: THREE.MeshBasicMaterial;
  halo: THREE.SpriteMaterial;
  haloRed: THREE.SpriteMaterial;
}
let shared: Shared | null = null;

function profile(pts: [number, number][], width: number, bevel: number): THREE.BufferGeometry {
  const sh = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
  const g = new THREE.ExtrudeGeometry(sh, { depth: width - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  g.rotateY(-Math.PI / 2); // shape x -> world z (forward), extrusion -> world x
  g.computeVertexNormals();
  return g;
}

function glowTexture(kind: 'dot' | 'beam'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = kind === 'beam' ? 128 : 64;
  const x = c.getContext('2d')!;
  const g = kind === 'beam' ? x.createRadialGradient(32, 122, 2, 32, 122, 118) : x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(kind === 'beam' ? 0.35 : 0.3, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, c.height);
  if (kind === 'beam') {
    // squeeze into a cone: fade the sides
    x.globalCompositeOperation = 'destination-in';
    const m = x.createLinearGradient(0, 0, 64, 0);
    m.addColorStop(0, 'rgba(0,0,0,0)');
    m.addColorStop(0.5, 'rgba(0,0,0,1)');
    m.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = m;
    x.fillRect(0, 0, 64, 128);
  }
  return new THREE.CanvasTexture(c);
}

function makeShared(gradient: THREE.DataTexture): Shared {
  const dot = glowTexture('dot');
  const beamTex = glowTexture('beam');
  const beamG = new THREE.PlaneGeometry(WID * 1.5, 9);
  beamG.rotateX(Math.PI / 2);
  beamG.translate(0, 0.1, LEN / 2 + 4.2);
  return {
    // lower body: tapered hood and boot
    lower: profile([[-2.2, 0.32], [2.2, 0.32], [2.22, 0.7], [1.6, 0.93], [0.9, 0.98], [-1.7, 0.98], [-2.2, 0.86]], WID, 0.06),
    // greenhouse: raked windscreen and rear glass
    glassG: profile([[-1.25, 0.96], [-0.85, 1.55], [0.55, 1.55], [1.1, 0.96]], WID * 0.9, 0.03),
    roof: new THREE.BoxGeometry(WID * 0.88, 0.07, 1.5).translate(0, 1.57, -0.15),
    wheel: new THREE.CylinderGeometry(0.34, 0.34, 0.26, 14).rotateZ(Math.PI / 2),
    hub: new THREE.CylinderGeometry(0.19, 0.19, 0.28, 10).rotateZ(Math.PI / 2),
    bumper: new THREE.BoxGeometry(WID + 0.08, 0.2, 0.18),
    lamp: new THREE.BoxGeometry(0.4, 0.15, 0.06),
    mirror: new THREE.BoxGeometry(0.14, 0.1, 0.1),
    beamG,
    glass: new THREE.MeshToonMaterial({ color: 0x1d2733, gradientMap: gradient }),
    tire: new THREE.MeshToonMaterial({ color: 0x141318, gradientMap: gradient }),
    hubM: new THREE.MeshToonMaterial({ color: 0xaab0ba, gradientMap: gradient }),
    trim: new THREE.MeshToonMaterial({ color: 0x24232b, gradientMap: gradient }),
    head: new THREE.MeshBasicMaterial({ color: 0xfff6cf }),
    tail: new THREE.MeshBasicMaterial({ color: 0xc01818 }),
    brake: new THREE.MeshBasicMaterial({ color: 0xff4a3a }),
    beam: new THREE.MeshBasicMaterial({ map: beamTex, color: 0xffeebb, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    halo: new THREE.SpriteMaterial({ map: dot, color: 0xfff0c0, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
    haloRed: new THREE.SpriteMaterial({ map: dot, color: 0xff3020, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
  };
}

/** Headlights and taillights glow harder as night falls. */
export function setCarNight(night: number): void {
  if (!shared) return;
  shared.beam.opacity = 0.1 + 0.5 * night;
  shared.halo.opacity = 0.35 + 0.65 * night;
  shared.haloRed.opacity = 0.3 + 0.6 * night;
  shared.head.color.setScalar(1).multiplyScalar(0.85 + 0.15 * night).lerp(HEAD_TINT, 0.3);
}
const HEAD_TINT = new THREE.Color(0xfff6cf);

export class Car {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  active = true;
  speed = 0;
  private lane: number;
  private dir: 1 | -1;
  private s: number;
  private off: number;
  private top: number;
  private yaw = 0;
  private tails: THREE.Mesh[] = [];
  private braking = false;
  readonly kind: 'car' | 'bus';
  readonly len: number;
  readonly wid: number;
  private dwell = 0;
  private served = '';

  constructor(gradient: THREE.DataTexture, private fleet: Fleet, lane: number, s: number, dir: 1 | -1, seed: number, kind: 'car' | 'bus' = 'car') {
    if (!shared) shared = makeShared(gradient);
    const k = shared;
    this.kind = kind;
    this.len = kind === 'bus' ? BUS_LEN : LEN;
    this.wid = kind === 'bus' ? BUS_WID : WID;
    const paint = new THREE.MeshToonMaterial({ color: COLORS[seed % COLORS.length], gradientMap: gradient });
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, shadow = true) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = shadow;
      mesh.position.set(x, y, z);
      this.group.add(mesh);
      return mesh;
    };
    if (kind === 'bus') {
      const b = getBusParts(gradient);
      add(b.body, b.bodyMat);
      add(b.glass, k.glass, 0, 0, 0, false);
      add(b.lamps, k.head, 0, 0, 0, false);
      this.tails.push(add(b.tails, k.tail, 0, 0, 0, false));
      for (const sx of [-1, 1]) for (const z of [3.5, -3.3]) add(b.wheel, k.tire, sx * 1.2, 0.5, z, false);
      for (const sx of [-1, 1]) {
        for (const hz of [5.85, -5.85]) {
          const sp = new THREE.Sprite(hz > 0 ? k.halo : k.haloRed);
          sp.scale.setScalar(hz > 0 ? 1.4 : 1.0);
          sp.position.set(sx * (hz > 0 ? 0.9 : 0.95), 0.92, hz);
          this.group.add(sp);
        }
      }
      add(k.beamG, k.beam, 0, 0, 1.6, false).renderOrder = 2;
      this.lane = lane;
      this.dir = dir;
      this.s = s;
      this.top = 6 + (seed % 3) * 1.2;
      this.off = 0;
      this.place();
      return;
    }
    add(k.lower, paint);
    add(k.glassG, k.glass);
    add(k.roof, paint);
    add(k.bumper, k.trim, 0, 0.42, LEN / 2 + 0.02);
    add(k.bumper, k.trim, 0, 0.42, -LEN / 2 - 0.02);
    for (const sx of [-1, 1]) {
      for (const z of [1.4, -1.35]) {
        add(k.wheel, k.tire, sx * (WID / 2 - 0.02), 0.34, z);
        add(k.hub, k.hubM, sx * (WID / 2 + 0.01), 0.34, z, false);
      }
      add(k.lamp, k.head, sx * 0.58, 0.76, LEN / 2 + 0.07, false);
      this.tails.push(add(k.lamp, k.tail, sx * 0.62, 0.8, -LEN / 2 - 0.07, false));
      add(k.mirror, paint, sx * (WID / 2 + 0.1), 1.0, 0.75, false);
      for (const hz of [LEN / 2 + 0.12, -LEN / 2 - 0.12]) {
        const sp = new THREE.Sprite(hz > 0 ? k.halo : k.haloRed);
        sp.scale.setScalar(hz > 0 ? 1.1 : 0.8);
        sp.position.set(sx * (hz > 0 ? 0.58 : 0.62), hz > 0 ? 0.76 : 0.8, hz);
        this.group.add(sp);
      }
    }
    add(k.beamG, k.beam, 0, 0, 0, false).renderOrder = 2;
    this.lane = lane;
    this.dir = dir;
    this.s = s;
    this.top = 7 + (seed % 5) * 1.2; // cruising speed, m/s
    this.off = 0; // set in place()
    this.place();
  }

  private place(): void {
    const L = this.fleet.lanes[this.lane];
    const { x, z, tx, tz } = this.fleet.sample(L, this.s);
    // keep right of the centre line, in the direction of travel
    this.off = L.oneway ? 0 : (L.w / 2 - 2.0 + 0.25) / 2; // middle of the travel lane: between the double yellow and the parking-lane line
    const rx = -tz * this.dir, rz = tx * this.dir; // right-hand side of travel
    this.pos.set(x + rx * this.off, this.fleet.terrainAt(x + rx * this.off, z + rz * this.off) + 0.06, z + rz * this.off);
    this.yaw = Math.atan2(tx * this.dir, tz * this.dir);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
  }

  /** distance to the nearest car ahead in my lane (Infinity if clear) */
  private gap(): number {
    let best = Infinity;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    for (const o of this.fleet.cars) {
      if (o === this || !o.active) continue;
      if (Math.abs(o.pos.x - this.pos.x) > 26 || Math.abs(o.pos.z - this.pos.z) > 26) continue;
      const dx = o.pos.x - this.pos.x, dz = o.pos.z - this.pos.z;
      const ahead = dx * fx + dz * fz;
      if (ahead < 0 || ahead > 14 + this.len) continue;
      const side = Math.abs(dx * fz - dz * fx);
      if (side < Math.max(2.2, (this.wid + o.wid) / 2 + 0.4)) best = Math.min(best, ahead - (this.len + o.len) / 2);
    }
    return best;
  }

  update(dt: number, rat: Rat): boolean {
    // slow for traffic ahead and for a rat in the road
    let want = this.top;
    const g = this.gap();
    if (g < 12) want = Math.min(want, Math.max(0, (g - 1.5) * 1.2));
    if (this.kind === 'bus') {
      if (this.dwell > 0) {
        this.dwell -= dt;
        want = 0;
      } else {
        const L0 = this.fleet.lanes[this.lane];
        L0.stops.forEach((st, i) => {
          const at = this.dir === 1 ? st : Math.min(L0.len - 4, st + 14);
          const ahead = (at - this.s) * this.dir;
          const key = `${this.lane}:${i}:${this.dir}`;
          if (ahead > 0 && ahead < 45 && this.served !== key) {
            want = Math.min(want, Math.sqrt(2 * 1.6 * Math.max(ahead - 1, 0)));
            if (ahead < 2 && this.speed < 0.7) {
              this.dwell = 4 + Math.random() * 3;
              this.served = key;
            }
          }
        });
      }
    }
    const brk = want < this.speed - 0.4;
    if (brk !== this.braking) {
      this.braking = brk;
      for (const t of this.tails) t.material = brk ? shared!.brake : shared!.tail;
    }
    this.speed += (want - this.speed) * Math.min(1, dt * (want < this.speed ? 3 : this.kind === 'bus' ? 0.6 : 1));
    this.s += this.dir * this.speed * dt;
    const L = this.fleet.lanes[this.lane];
    if (this.s > L.len || this.s < 0) {
      const links = this.s > L.len ? L.endLinks : L.startLinks;
      const pick = links.length ? links[Math.floor(Math.random() * links.length)] : null;
      if (pick) {
        const n = this.fleet.lanes[pick.lane];
        if (n.oneway && pick.dir !== this.fleet.onewayDir(pick.lane)) {
          this.turnAround(L);
        } else {
          this.lane = pick.lane;
          this.dir = pick.dir;
          this.s = pick.dir === 1 ? 0.01 : n.len - 0.01;
        }
      } else this.turnAround(L);
    }
    this.place();
    // run the rat over
    const dx = rat.pos.x - this.pos.x, dz = rat.pos.z - this.pos.z;
    if (this.speed > 1.5 && rat.pos.y - this.pos.y < (this.kind === 'bus' ? 3.4 : 1.4)) {
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const lx = dx * fz - dz * fx, ly = dx * fx + dz * fz;
      if (Math.abs(lx) < this.wid / 2 + 0.2 && Math.abs(ly) < this.len / 2 + 0.2) return true;
    }
    return false;
  }

  private turnAround(L: Lane): void {
    // one-way streets can't be reversed: wrap to the other end instead
    if (L.oneway) this.s = this.s > L.len ? 0.01 : L.len - 0.01;
    else {
      this.dir = (this.dir * -1) as 1 | -1;
      this.s = THREE.MathUtils.clamp(this.s, 0.01, L.len - 0.01);
    }
  }

  private home: THREE.Object3D | null = null;
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.group.visible = on;
    // parked cars leave the scene graph entirely, so three doesn't walk their matrices every render
    if (on) this.home?.add(this.group);
    else {
      this.home = this.group.parent;
      this.group.removeFromParent();
    }
  }
}

/** All the traffic. Builds a lane graph from the mapped roads and spawns cars on it. */
export class Fleet {
  readonly lanes: Lane[] = [];
  readonly cars: Car[] = [];
  private onewayDirs: (1 | -1)[] = [];

  constructor(roads: CarRoad[], readonly terrainAt: (x: number, z: number) => number) {
    for (const r of roads) {
      const p = r.pts.map((q) => new THREE.Vector2(q[0], q[1]));
      const cum = [0];
      for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + p[i].distanceTo(p[i - 1]));
      const len = cum[cum.length - 1];
      if (len < 12) continue;
      const stops: number[] = [];
      if (r.w >= 11 && len > 90) for (let st = 45 + ((this.lanes.length * 37) % 40); st < len - 40; st += 170) stops.push(st);
      this.lanes.push({ p, cum, len, w: r.w, oneway: r.oneway, stops, startLinks: [], endLinks: [] });
      this.onewayDirs.push(1);
    }
    // link road ends to any road whose end is within a few metres
    const near = (a: THREE.Vector2, b: THREE.Vector2) => a.distanceTo(b) < 4;
    this.lanes.forEach((L, i) => {
      this.lanes.forEach((M, j) => {
        if (i === j) return;
        const mStart = M.p[0], mEnd = M.p[M.p.length - 1];
        if (near(L.p[0], mStart)) L.startLinks.push({ lane: j, dir: 1 });
        if (near(L.p[0], mEnd)) L.startLinks.push({ lane: j, dir: -1 });
        if (near(L.p[L.p.length - 1], mStart)) L.endLinks.push({ lane: j, dir: 1 });
        if (near(L.p[L.p.length - 1], mEnd)) L.endLinks.push({ lane: j, dir: -1 });
      });
    });
  }

  onewayDir(_lane: number): 1 | -1 {
    return 1; // mapped one-way streets run along their drawn direction
  }

  sample(L: Lane, s: number): { x: number; z: number; tx: number; tz: number } {
    let i = 1;
    while (i < L.cum.length - 1 && L.cum[i] < s) i++;
    const a = L.p[i - 1], b = L.p[i];
    const seg = L.cum[i] - L.cum[i - 1] || 1;
    const t = THREE.MathUtils.clamp((s - L.cum[i - 1]) / seg, 0, 1);
    const tx = (b.x - a.x) / seg, tz = (b.y - a.y) / seg;
    return { x: a.x + (b.x - a.x) * t, z: a.y + (b.y - a.y) * t, tx, tz };
  }

  spawn(gradient: THREE.DataTexture, scene: THREE.Scene, count: number): void {
    if (!this.lanes.length) return;
    // weight lanes by length so long streets get more cars
    const total = this.lanes.reduce((a, l) => a + l.len, 0);
    for (let i = 0; i < count; i++) {
      let r = Math.random() * total, li = 0;
      while (li < this.lanes.length - 1 && r > this.lanes[li].len) r -= this.lanes[li++].len;
      const L = this.lanes[li];
      const dir: 1 | -1 = L.oneway ? 1 : Math.random() < 0.5 ? 1 : -1;
      const car = new Car(gradient, this, li, Math.random() * L.len, dir, i);
      scene.add(car.group);
      this.cars.push(car);
    }
  }

  /** buses run the wide through-streets and pause at the stops */
  spawnBuses(gradient: THREE.DataTexture, scene: THREE.Scene, count: number): void {
    const lanes = this.lanes.map((l, i) => ({ l, i })).filter((x) => x.l.stops.length);
    if (!lanes.length) return;
    const total = lanes.reduce((a, x) => a + x.l.len, 0);
    for (let n = 0; n < count; n++) {
      let r = Math.random() * total, k = 0;
      while (k < lanes.length - 1 && r > lanes[k].l.len) r -= lanes[k++].l.len;
      const { l: L, i: li } = lanes[k];
      const dir: 1 | -1 = L.oneway ? 1 : Math.random() < 0.5 ? 1 : -1;
      const bus = new Car(gradient, this, li, Math.random() * L.len, dir, n, 'bus');
      scene.add(bus.group);
      this.cars.push(bus);
    }
  }

  /** curbside spots for the bus-stop shelters (right-hand side of travel) */
  stopSpots(): StopSpot[] {
    const out: StopSpot[] = [];
    this.lanes.forEach((L) => {
      for (const st of L.stops) {
        for (const dir of L.oneway ? [1] : [1, -1]) {
          const s = dir === 1 ? st : Math.min(L.len - 4, st + 14);
          const { x, z, tx, tz } = this.sample(L, s);
          const rx = -tz * dir, rz = tx * dir; // right of travel
          const off = L.w / 2 + 1.7;
          out.push({ x: x + rx * off, z: z + rz * off, fx: -rx, fz: -rz });
        }
      }
    });
    return out;
  }
}
