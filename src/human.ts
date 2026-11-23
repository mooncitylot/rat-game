import * as THREE from 'three';
import type { Rat } from './rat';
import { pedestrianGo } from './signals';
import type { Ring } from './world';

const SCALE = 1.2; // a ~1.8 m figure becomes ~2.2 m next to 2.6 m doors
const REACH = 2.0; // how close the rat must be to get noticed
export const SIDEWALK_Y = 0.22;
export const CURB = 1.6; // ring corner -> curb (half the sidewalk)
export const LANE = 0.55; // everyone keeps to the right

// ------------------------------------------------------------------------------------------------
// Sidewalk network: each block has a loop of 4 corners; zebra crossings link facing corners of neighbours.
// ------------------------------------------------------------------------------------------------

export interface Node {
  c: number;
  r: number;
  k: number; // 0 NW, 1 NE, 2 SE, 3 SW (clockwise)
}
export interface Edge {
  a: THREE.Vector2;
  b: THREE.Vector2;
  len: number;
  hx: number;
  hz: number;
  kind: 'side' | 'cross';
  axis: 'x' | 'z';
  to: Node;
  free?: boolean; // crossing with no signal to wait for
}

const SX = [-1, 1, 1, -1];
const SZ = [-1, -1, 1, 1];
// per corner: which neighbour block it faces across each street, and which of its corners it lands on
const CROSS: { dc: number; dr: number; k: number; axis: 'x' | 'z' }[][] = [
  [{ dc: -1, dr: 0, k: 1, axis: 'x' }, { dc: 0, dr: -1, k: 3, axis: 'z' }],
  [{ dc: 1, dr: 0, k: 0, axis: 'x' }, { dc: 0, dr: -1, k: 2, axis: 'z' }],
  [{ dc: 1, dr: 0, k: 3, axis: 'x' }, { dc: 0, dr: 1, k: 1, axis: 'z' }],
  [{ dc: -1, dr: 0, k: 2, axis: 'x' }, { dc: 0, dr: 1, k: 0, axis: 'z' }],
];

/** A pedestrian graph. The grid world is block loops with zebra crossings; the city is the mapped footways. */
export interface Net {
  /** the first edge leaving a start node */
  first(n: Node, dir: 1 | -1): Edge;
  /** the edge to take after arriving at `edge.to` (walker.dir may be changed) */
  next(arrived: Edge, walker: { dir: 1 | -1 }): Edge;
  /** feet height for a walker at (x, z) on an edge `s` metres along it */
  height(x: number, z: number, kind: 'side' | 'cross', s: number, len: number): number;
}

export class SidewalkNet implements Net {
  readonly cols: number;
  readonly rows: number;
  private grid: Ring[][] = [];

  constructor(rings: Ring[]) {
    this.cols = Math.max(...rings.map((r) => r.c)) + 1;
    this.rows = Math.max(...rings.map((r) => r.r)) + 1;
    for (const r of rings) (this.grid[r.c] ??= [])[r.r] = r;
  }

  corner(n: Node): THREE.Vector2 {
    const g = this.grid[n.c][n.r];
    return new THREE.Vector2(g.cx + SX[n.k] * g.half, g.cz + SZ[n.k] * g.half);
  }

  private edge(from: Node, to: Node, kind: 'side' | 'cross', axis: 'x' | 'z'): Edge {
    const a = this.corner(from), b = this.corner(to);
    const len = a.distanceTo(b);
    return { a, b, len, hx: (b.x - a.x) / len, hz: (b.y - a.y) / len, kind, axis, to };
  }

  side(n: Node, dir: 1 | -1): Edge {
    const to = { c: n.c, r: n.r, k: (n.k + dir + 4) % 4 };
    // sides alternate x, z, x, z going round the block
    const axis = (dir === 1 ? n.k : to.k) % 2 === 0 ? 'x' : 'z';
    return this.edge(n, to, 'side', axis);
  }

  first(n: Node, dir: 1 | -1): Edge {
    return this.side(n, dir);
  }

  next(arrived: Edge, walker: { dir: 1 | -1 }): Edge {
    const r = Math.random();
    const here = arrived.to;
    if (arrived.kind === 'cross') {
      walker.dir = Math.random() < 0.5 ? 1 : -1;
      return this.side(here, walker.dir);
    }
    const options = this.crossings(here);
    if (options.length && r < 0.4) return options[Math.floor(Math.random() * options.length)];
    if (r > 0.92) walker.dir = walker.dir === 1 ? -1 : 1;
    return this.side(here, walker.dir);
  }

  height(_x: number, _z: number, kind: 'side' | 'cross', s: number, len: number): number {
    if (kind === 'side') return SIDEWALK_Y;
    const t1 = THREE.MathUtils.clamp((s - (CURB - 0.1)) / 0.3, 0, 1);
    const t2 = THREE.MathUtils.clamp((len - CURB + 0.1 - s) / 0.3, 0, 1);
    return SIDEWALK_Y * (1 - Math.min(t1, t2));
  }

  crossings(n: Node): Edge[] {
    const out: Edge[] = [];
    for (const o of CROSS[n.k]) {
      const c = n.c + o.dc, r = n.r + o.dr;
      if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
      out.push(this.edge(n, { c, r, k: o.k }, 'cross', o.axis));
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------------
// Looks
// ------------------------------------------------------------------------------------------------

export const SKIN = [0xf1c8a5, 0xe3b088, 0xc98d62, 0xa56a43, 0x7a4a2e, 0x55331f];
export const HAIR = [0x16110e, 0x2c1b12, 0x4a3022, 0x7a5232, 0xb98b4d, 0xd6c28a, 0x8a8a8a, 0xc0c0c0, 0x8a3a1c, 0x2fa6a0, 0xd94f8a];
export const JACKET = [0x8a2f3a, 0x2f4a7a, 0x3a6a4a, 0xb08a3a, 0x5a3a7a, 0x3a3f4a, 0x9a5a2a, 0x2a6a6a, 0xd24a2e, 0xe0c24a, 0x4a4a52, 0xe8e2d0, 0x1c1c22];
export const PANTS = [0x2a3550, 0x1c1c22, 0x4a4a52, 0x8a7a5a, 0x3a4a6a, 0x5a3a2a, 0x6a6a72];
const SHOES = [0x17151a, 0xf2eee0, 0x4a2a1a, 0xc8321f, 0x2a3550];

const geos = new Map<string, THREE.BufferGeometry>();
const mats = new Map<string, THREE.MeshToonMaterial>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geos.get(key);
  if (!g) geos.set(key, (g = make()));
  return g;
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

type State = 'walk' | 'cross' | 'pause' | 'notice' | 'windup' | 'recover' | 'startle';
type PauseKind = 'phone' | 'look' | 'stand';

/**
 * A pedestrian: an articulated figure that walks the sidewalks, waits at the curb for the walk signal, crosses
 * on the zebra, now and then stops to check a phone or look in a shop window, and reacts to a rat underfoot.
 */
export class Human {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3(); // where the feet are (includes the stomp lunge)
  active = true;

  // path following
  private edge: Edge;
  private s = 0;
  private base = new THREE.Vector2();
  private prevBase = new THREE.Vector2();
  private yaw = 0;
  private pace: number; // preferred speed
  private speed = 0; // measured speed
  private lastPause = 0;

  // behaviour
  private walker: { dir: 1 | -1 } = { dir: 1 };
  private state: State = 'walk';
  private resume: State = 'walk';
  private pauseKind: PauseKind = 'stand';
  private timer = 0;
  private cooldown = 0;
  private time = Math.random() * 50;
  private phase = 0;
  private timid: boolean;
  private target = new THREE.Vector3();
  private lunge = new THREE.Vector2();
  private ring: THREE.Mesh;

  // look
  private phone: THREE.Mesh;
  private stepLen: number;

  // rig
  private root = new THREE.Group();
  private pelvis = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private thigh: THREE.Group[] = [];
  private knee: THREE.Group[] = [];
  private foot: THREE.Group[] = [];
  private arm: THREE.Group[] = [];
  private elbow: THREE.Group[] = [];

  constructor(gradient: THREE.DataTexture, private net: Net, start: Node, dir: 1 | -1, scene: THREE.Scene, seed: number) {
    const r = rng(seed * 2654435761 + 7);
    const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
    const toon = (c: number) => {
      const key = String(c);
      let m = mats.get(key);
      if (!m) mats.set(key, (m = new THREE.MeshToonMaterial({ color: c, gradientMap: gradient })));
      return m;
    };
    const part = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = true;
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };
    const joint = (parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      parent.add(g);
      return g;
    };

    // ---- who they are ----
    const skin = toon(pick(SKIN));
    const hairColor = pick(HAIR);
    const kind = pick(['coat', 'coat', 'jacket', 'jacket', 'jacket', 'tee', 'dress', 'shorts'] as const);
    const top = pick(JACKET);
    const pantsC = pick(PANTS);
    const cloth = toon(top);
    const pants = toon(kind === 'dress' ? pick([0x1c1c22, 0xd8b4a0, 0x2a3550]) : pantsC);
    const shoe = toon(pick(SHOES));
    const build = 0.92 + r() * 0.2; // height
    const girth = 0.9 + r() * 0.3;
    this.pace = 1.45 + r() * 0.8;
    this.stepLen = 0.8 * build;
    this.timid = r() < 0.35;
    const hairStyle = pick(['short', 'short', 'long', 'bun', 'bald', 'curly'] as const);
    const hat = pick(['none', 'none', 'none', 'beanie', 'cap'] as const);

    // ---- skeleton ----
    this.group.add(this.root);
    this.root.add(this.pelvis);
    this.pelvis.position.y = 0.92; // hip height = leg length, so the feet land on y = 0
    part(geo('hips', () => new THREE.CapsuleGeometry(0.13, 0.08, 4, 10).rotateZ(Math.PI / 2)), kind === 'dress' ? cloth : pants, this.pelvis, 0, 0.02, 0).scale.set(1, 1, 0.85);

    // legs: thigh -> knee -> shin -> foot
    for (const side of [-1, 1]) {
      const th = joint(this.pelvis, side * 0.095, 0, 0);
      const shortsLeg = kind === 'shorts' || kind === 'dress';
      part(geo('thigh', () => new THREE.CapsuleGeometry(0.078, 0.3, 4, 8)), shortsLeg && kind === 'dress' ? skin : pants, th, 0, -0.225, 0);
      const kn = joint(th, 0, -0.46, 0);
      part(geo('shin', () => new THREE.CapsuleGeometry(0.06, 0.31, 4, 8)), shortsLeg ? skin : pants, kn, 0, -0.23, 0);
      const ft = joint(kn, 0, -0.46, 0);
      part(geo('shoe', () => new THREE.BoxGeometry(0.1, 0.08, 0.26)), shoe, ft, 0, -0.03, 0.06);
      this.thigh.push(th);
      this.knee.push(kn);
      this.foot.push(ft);
    }

    // torso, neck, head
    this.pelvis.add(this.torso);
    this.torso.position.y = 0.04;
    const chest = part(geo('chest', () => new THREE.CapsuleGeometry(0.15, 0.3, 4, 10)), cloth, this.torso, 0, 0.3, 0);
    chest.scale.set(1.2 * girth, 1, 0.78 * girth);
    if (kind === 'coat') {
      // long coat: a skirt hanging to the knee
      part(geo('coat', () => new THREE.CylinderGeometry(0.19, 0.27, 0.62, 12, 1, true)), cloth, this.pelvis, 0, -0.26, 0).scale.set(girth, 1, 0.85 * girth);
      this.torso.scale.y = 1;
    } else if (kind === 'dress') {
      part(geo('skirt', () => new THREE.CylinderGeometry(0.17, 0.3, 0.46, 14, 1, true)), cloth, this.pelvis, 0, -0.2, 0).scale.set(girth, 1, girth);
    }
    part(geo('neck', () => new THREE.CylinderGeometry(0.045, 0.05, 0.1, 8)), skin, this.torso, 0, 0.62, 0);
    this.torso.add(this.head);
    this.head.position.y = 0.66;
    const skull = part(geo('skull', () => new THREE.SphereGeometry(0.12, 14, 12)), skin, this.head, 0, 0.09, 0);
    skull.scale.set(0.92, 1.1, 1.0);
    const eyeM = new THREE.MeshBasicMaterial({ color: 0x14121c });
    for (const side of [-1, 1]) {
      part(geo('eye', () => new THREE.SphereGeometry(0.014, 6, 5)), eyeM, this.head, side * 0.045, 0.1, 0.112);
      part(geo('ear', () => new THREE.SphereGeometry(0.03, 6, 5)), skin, this.head, side * 0.108, 0.08, 0).scale.set(0.5, 1, 0.8);
    }
    part(geo('nose', () => new THREE.SphereGeometry(0.02, 6, 5)), skin, this.head, 0, 0.075, 0.118);

    // hair
    const hairM = toon(hairColor);
    if (hairStyle !== 'bald' && hat !== 'beanie') {
      const cap = part(geo('hair', () => new THREE.SphereGeometry(0.128, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.58)), hairM, this.head, 0, 0.1, -0.008);
      cap.scale.set(0.95, 1.1, 1.04);
      if (hairStyle === 'long') part(geo('hairLong', () => new THREE.CapsuleGeometry(0.1, 0.16, 4, 8)), hairM, this.head, 0, -0.02, -0.07).scale.set(1.1, 1, 0.7);
      if (hairStyle === 'bun') part(geo('bun', () => new THREE.SphereGeometry(0.05, 8, 6)), hairM, this.head, 0, 0.23, -0.06);
      if (hairStyle === 'curly') {
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          part(geo('curl', () => new THREE.SphereGeometry(0.05, 6, 5)), hairM, this.head, Math.cos(a) * 0.09, 0.2, Math.sin(a) * 0.09);
        }
      }
    }
    if (hat === 'beanie') {
      part(geo('beanie', () => new THREE.SphereGeometry(0.135, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.6)), toon(pick(JACKET)), this.head, 0, 0.1, -0.005).scale.set(0.97, 1.08, 1.05);
    } else if (hat === 'cap') {
      const capC = toon(pick(JACKET));
      part(geo('capTop', () => new THREE.SphereGeometry(0.13, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5)), capC, this.head, 0, 0.11, 0).scale.set(0.97, 1, 1.05);
      part(geo('capBrim', () => new THREE.BoxGeometry(0.2, 0.012, 0.13)), capC, this.head, 0, 0.115, 0.13);
    }

    // arms: shoulder -> elbow -> hand
    const sleeveUpper = kind === 'tee' ? cloth : cloth;
    const sleeveLower = kind === 'tee' || kind === 'dress' ? skin : cloth;
    for (const side of [-1, 1]) {
      const sh = joint(this.torso, side * 0.235 * girth, 0.52, 0);
      part(geo('shoulder', () => new THREE.SphereGeometry(0.06, 8, 6)), cloth, sh);
      part(geo('upperArm', () => new THREE.CapsuleGeometry(0.05, 0.22, 4, 8)), sleeveUpper, sh, 0, -0.16, 0);
      const el = joint(sh, 0, -0.32, 0);
      part(geo('foreArm', () => new THREE.CapsuleGeometry(0.043, 0.2, 4, 8)), sleeveLower, el, 0, -0.14, 0);
      part(geo('hand', () => new THREE.SphereGeometry(0.05, 8, 6)), skin, el, 0, -0.29, 0);
      this.arm.push(sh);
      this.elbow.push(el);
    }

    // accessories
    const extra = r();
    if (extra < 0.35) {
      part(geo('pack', () => new THREE.BoxGeometry(0.28, 0.36, 0.15)), toon(pick(JACKET)), this.torso, 0, 0.34, -0.17 * girth);
    } else if (extra < 0.6) {
      part(geo('bag', () => new THREE.BoxGeometry(0.06, 0.2, 0.28)), toon(pick(JACKET)), this.torso, 0.3 * girth, 0.02, 0.0);
    }


    // phone
    this.phone = part(geo('phone', () => new THREE.BoxGeometry(0.05, 0.1, 0.01)), new THREE.MeshBasicMaterial({ color: 0xcfe8ff }), this.elbow[1], 0, -0.3, 0.04);
    this.phone.visible = false;

    this.group.scale.setScalar(SCALE * build);

    // stomp telegraph (a red ring where the foot will land)
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.5, 28), new THREE.MeshBasicMaterial({ color: 0xff3a2a, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    scene.add(this.ring);

    // ---- start somewhere along the sidewalk ----
    this.walker.dir = dir;
    this.edge = net.first(start, dir);
    this.s = r() * this.edge.len;
    this.placeOnEdge(true);
    this.yaw = Math.atan2(this.edge.hx, this.edge.hz);
    this.lastPause = -r() * 10;
    this.pos.set(this.base.x, SIDEWALK_Y, this.base.y);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    this.pose(0, 0);
  }

  private home: THREE.Object3D | null = null;
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.group.visible = on;
    // off-screen pedestrians leave the scene graph (53 objects each × 400 adds up)
    if (on) this.home?.add(this.group);
    else {
      this.home = this.group.parent;
      this.group.removeFromParent();
    }
    if (!on) {
      this.ring.visible = false;
      if (this.state === 'windup' || this.state === 'notice' || this.state === 'recover' || this.state === 'startle') this.state = this.resume;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // movement along the current edge
  // ------------------------------------------------------------------------------------------------

  private edgePoint(s: number, out: THREE.Vector2): THREE.Vector2 {
    const e = this.edge;
    // keep right: right-hand side of the heading
    out.set(e.a.x + e.hx * s - e.hz * LANE, e.a.y + e.hz * s + e.hx * LANE);
    return out;
  }

  private tmp = new THREE.Vector2();

  private placeOnEdge(snap: boolean): void {
    this.edgePoint(this.s, this.tmp);
    if (snap) this.base.copy(this.tmp);
  }

  private groundY(): number {
    return this.net.height(this.base.x, this.base.y, this.edge.kind, this.s, this.edge.len);
  }

  private nextEdge(): void {
    this.edge = this.net.next(this.edge, this.walker);
    this.state = this.edge.kind === 'cross' ? 'cross' : 'walk';
    this.s = 0;
  }

  /** Advance along the edge. Returns false if holding at the curb. */
  private advance(dt: number, t: number): boolean {
    let go = this.pace;
    if (this.edge.kind === 'cross') {
      const atCurb = this.s > CURB - 0.6 && this.s < CURB - 0.2;
      if (atCurb && !this.edge.free && !pedestrianGo(t, this.edge.axis)) go = 0; // wait for the walk signal
      if (this.s > CURB && this.s < this.edge.len - CURB) go = this.pace * 1.2; // hurry across the street
    }
    this.s += go * dt;
    if (this.s >= this.edge.len) {
      this.s = this.edge.len;
      this.nextEdge();
    }
    return go > 0;
  }

  // ------------------------------------------------------------------------------------------------
  // per-frame
  // ------------------------------------------------------------------------------------------------

  /** Returns true on the frame a stomp lands on the rat. */
  update(dt: number, rat: Rat, t: number): boolean {
    if (!this.active) return false;
    this.time += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    let stomped = false;

    const dx = rat.pos.x - this.pos.x, dz = rat.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const busy = this.state === 'notice' || this.state === 'windup' || this.state === 'recover' || this.state === 'startle';
    if (!busy && this.cooldown <= 0 && dist < REACH && rat.pos.y < 0.7) {
      this.resume = this.state === 'pause' ? 'walk' : this.state;
      this.state = 'notice';
      this.timer = 0.32;
    }

    this.prevBase.copy(this.base);
    switch (this.state) {
      case 'walk':
      case 'cross': {
        this.advance(dt, t);
        // the occasional stop: check a phone, look in a shop window, just stand
        if (this.state === 'walk' && this.edge.kind === 'side' && this.s > 1.5 && this.edge.len - this.s > 3 && this.time - this.lastPause > 14 && Math.random() < dt * 0.05) {
          this.state = 'pause';
          this.pauseKind = Math.random() < 0.45 ? 'phone' : Math.random() < 0.6 ? 'look' : 'stand';
          this.timer = 3 + Math.random() * 5;
        }
        break;
      }
      case 'pause':
        this.timer -= dt;
        if (this.timer <= 0) {
          this.state = 'walk';
          this.lastPause = this.time;
        }
        break;
      case 'notice': {
        this.timer -= dt;
        if (this.timer <= 0) {
          if (this.timid) {
            this.state = 'startle'; // yelps and hops back; never stomps
            this.timer = 0.9;
            this.cooldown = 5;
          } else {
            this.state = 'windup';
            this.timer = 0.7;
            this.target.set(rat.pos.x, rat.pos.y + 0.04, rat.pos.z); // aimed where you are NOW. Move.
            this.ring.visible = true;
            this.ring.position.set(this.target.x, Math.max(this.target.y, 0.05) + 0.03, this.target.z);
          }
        }
        break;
      }
      case 'windup': {
        this.timer -= dt;
        const k = 1 - this.timer / 0.7;
        this.ring.scale.setScalar(1.3 - 0.3 * k);
        (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.5 * Math.abs(Math.sin(t * 18));
        if (this.timer <= 0) {
          this.ring.visible = false;
          this.state = 'recover';
          this.timer = 1.0;
          if (Math.hypot(rat.pos.x - this.target.x, rat.pos.z - this.target.z) < 0.55 && rat.pos.y < this.target.y + 0.7) stomped = true;
        }
        break;
      }
      case 'startle':
      case 'recover':
        this.timer -= dt;
        if (this.timer <= 0) {
          this.state = this.resume === 'cross' ? 'cross' : 'walk';
          this.cooldown = Math.max(this.cooldown, 1.6);
          this.lastPause = this.time;
        }
        break;
    }

    // ease toward the ideal path point (smooths corners and lane changes)
    this.edgePoint(this.s, this.tmp);
    this.base.lerp(this.tmp, Math.min(1, dt * 9));
    this.speed = this.base.distanceTo(this.prevBase) / Math.max(dt, 1e-4);
    if (this.speed < 0.05) this.speed = 0;

    // facing
    let wantYaw = this.yaw;
    const moving = this.speed > 0.2 && (this.state === 'walk' || this.state === 'cross');
    if (moving) wantYaw = Math.atan2(this.base.x - this.prevBase.x, this.base.y - this.prevBase.y);
    else if (this.state === 'notice' || this.state === 'startle') wantYaw = Math.atan2(dx, dz);
    else if (this.state === 'windup' || this.state === 'recover') wantYaw = Math.atan2(this.target.x - this.pos.x, this.target.z - this.pos.z);
    else if (this.state === 'pause' && this.pauseKind === 'look') {
      const inward = this.walker.dir === 1 ? 1 : -1; // inside of the loop is to the right when walking clockwise
      wantYaw = Math.atan2(-this.edge.hz * inward, this.edge.hx * inward);
    }
    this.yaw += Math.atan2(Math.sin(wantYaw - this.yaw), Math.cos(wantYaw - this.yaw)) * Math.min(1, dt * (moving ? 7 : 9));

    // stomp lunge: step toward where the foot will land, then settle back
    const lungeGoal = this.state === 'windup' || this.state === 'recover' ? THREE.MathUtils.clamp(Math.hypot(this.target.x - this.base.x, this.target.z - this.base.y) - 0.5, 0, 1.0) : 0;
    const gx = lungeGoal > 0 ? ((this.target.x - this.base.x) / Math.max(Math.hypot(this.target.x - this.base.x, this.target.z - this.base.y), 1e-3)) * lungeGoal : 0;
    const gz = lungeGoal > 0 ? ((this.target.z - this.base.y) / Math.max(Math.hypot(this.target.x - this.base.x, this.target.z - this.base.y), 1e-3)) * lungeGoal : 0;
    this.lunge.x += (gx - this.lunge.x) * Math.min(1, dt * 6);
    this.lunge.y += (gz - this.lunge.y) * Math.min(1, dt * 6);

    // startle: hop backward away from the rat
    let hop = 0;
    if (this.state === 'startle') {
      const k = 1 - this.timer / 0.9;
      hop = Math.sin(Math.min(1, k * 2.2) * Math.PI) * 0.22;
      const l = Math.hypot(dx, dz) || 1;
      this.lunge.x -= (dx / l) * dt * 1.3 * (k < 0.5 ? 1 : 0);
      this.lunge.y -= (dz / l) * dt * 1.3 * (k < 0.5 ? 1 : 0);
    }

    this.pos.set(this.base.x + this.lunge.x, this.groundY() + hop, this.base.y + this.lunge.y);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;

    this.phase += dt * Math.PI * (this.speed / this.stepLen);
    this.pose(dt, t);
    return stomped;
  }

  // ------------------------------------------------------------------------------------------------
  // animation
  // ------------------------------------------------------------------------------------------------

  private pose(_dt: number, _t: number): void {
    const a = THREE.MathUtils.clamp(this.speed / 1.9, 0, 1.3); // walk amplitude
    const w = this.phase;
    const tt = this.time;

    // ----- legs -----
    for (let i = 0; i < 2; i++) {
      const th = w + (i ? Math.PI : 0);
      const swing = Math.sin(th) * 0.55 * a; // + is forward
      const bend = a * (0.12 + 0.95 * Math.max(0, Math.cos(th)));
      this.thigh[i].rotation.set(-swing, 0, 0);
      this.knee[i].rotation.set(bend, 0, 0);
      this.foot[i].rotation.set(-(this.thigh[i].rotation.x + this.knee[i].rotation.x) * 0.7, 0, 0);
    }
    this.root.position.y = Math.cos(w * 2) * 0.028 * a;
    this.pelvis.rotation.set(0, Math.sin(w) * 0.13 * a, Math.sin(tt * 0.6) * 0.025 * (1 - Math.min(1, a)));
    this.torso.rotation.set(0.05 * a + Math.sin(tt * 1.7) * 0.008, -Math.sin(w) * 0.2 * a, 0);
    this.torso.scale.y = 1 + Math.sin(tt * 1.8) * 0.006;

    // ----- arms -----
    for (let i = 0; i < 2; i++) {
      const th = w + (i ? 0 : Math.PI); // each arm swings against the same-side leg
      const g = Math.sin(th) * 0.5 * a;
      this.arm[i].rotation.set(-g, 0, (i ? 1 : -1) * 0.06);
      this.elbow[i].rotation.set(-(0.18 + 0.35 * a * Math.max(0, Math.sin(th + 0.4))), 0, 0);
    }

    // ----- head -----
    const glance = Math.sin(tt * 0.55) * 0.45 * (a > 0.2 ? 0.3 : 1) * Math.max(0, Math.sin(tt * 0.23));
    this.head.rotation.set(Math.sin(w * 2) * 0.015 * a, glance, 0);
    this.phone.visible = false;

    // ----- states -----
    switch (this.state) {
      case 'pause':
        if (this.pauseKind === 'phone') {
          this.head.rotation.set(0.5, Math.sin(tt * 0.4) * 0.1, 0);
          this.arm[0].rotation.set(-0.7, 0, 0);
          this.elbow[0].rotation.set(-1.25, 0, 0);
          this.arm[1].rotation.set(-0.7, 0, 0);
          this.elbow[1].rotation.set(-1.25, 0, 0);
          this.phone.visible = true;
          this.torso.rotation.x = 0.1;
        } else if (this.pauseKind === 'look') {
          this.head.rotation.set(0.04, Math.sin(tt * 0.7) * 0.5, 0);
        } else {
          this.pelvis.rotation.z = Math.sin(tt * 0.5) * 0.04; // shifts weight foot to foot
        }
        break;
      case 'notice':
        this.head.rotation.set(0.45, 0, 0); // looks down
        this.torso.rotation.x = -0.12;
        this.arm[0].rotation.set(-0.2, 0, -0.25);
        this.arm[1].rotation.set(-0.2, 0, 0.25);
        break;
      case 'startle': {
        const k = 1 - this.timer / 0.9;
        this.head.rotation.set(0.3, 0, 0);
        this.torso.rotation.x = -0.28 * Math.sin(Math.min(1, k * 2) * Math.PI);
        this.arm[0].rotation.set(-1.1, 0, -0.9);
        this.arm[1].rotation.set(-1.1, 0, 0.9);
        this.elbow[0].rotation.set(-0.8, 0, 0);
        this.elbow[1].rotation.set(-0.8, 0, 0);
        this.thigh[0].rotation.x = -0.5;
        this.knee[0].rotation.x = 0.9;
        break;
      }
      case 'windup': {
        const k = 1 - this.timer / 0.7;
        this.thigh[1].rotation.set(-1.05 - 0.15 * k, 0, 0); // knee up
        this.knee[1].rotation.set(1.0, 0, 0);
        this.foot[1].rotation.set(0.3, 0, 0);
        this.torso.rotation.x = -0.18;
        this.head.rotation.set(0.5, 0, 0);
        this.arm[0].rotation.set(0, 0, -0.7);
        this.arm[1].rotation.set(0, 0, 0.7);
        break;
      }
      case 'recover': {
        const k = 1 - this.timer / 1.0;
        const slam = k < 0.25 ? 1 : Math.max(0, 1 - (k - 0.25) * 2.2);
        this.thigh[1].rotation.set(-0.25 * slam, 0, 0);
        this.knee[1].rotation.set(0.1, 0, 0);
        this.torso.rotation.x = 0.22 * slam;
        this.head.rotation.set(0.35 * slam, 0, 0);
        break;
      }
    }
  }
}
