import * as THREE from 'three';
import type { Collider } from './collider';

export const RAT_SCALE = 0.45; // the model is drawn ~1.4 m long; at this scale it is a ~0.65 m rat next to 2.6 m doors
export const RAT_RADIUS = 0.12;
const STEP = 0.25; // max ledge the rat scrambles up without jumping (a curb is 0.22)
const GRAVITY = 26;
const JUMP = 8.2;
export const MAX_FUEL = 100; // seconds of thrust
const THRUST = 52; // upward accel while flying (gravity is 26)
const MAX_RISE = 6.5;
const REFUEL = 25; // fuel/sec regained on the ground

export interface Pipe {
  x: number;
  z: number;
  nx: number;
  nz: number;
  top: number;
}
export interface Level {
  collider: Collider;
  pipes: Pipe[];
}

export interface MoveInput {
  x: number; // strafe  (-1 left .. 1 right)
  z: number; // forward (-1 back .. 1 forward)
  sprint: boolean;
  jump: boolean;
}

export class Rat {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  vy = 0;
  yaw = 0;
  grounded = true;
  speed = 0;
  mode: 'walk' | 'climb' = 'walk';
  hurt = 0; // invulnerability timer after a hit
  fuel = MAX_FUEL;
  flying = false;
  jumped = false; // set for one frame when a jump starts (for sound)

  private pipe: Pipe | null = null;
  private cd = 0; // can't re-attach to a pipe for a moment after leaving one
  private prevJump = false;
  private knock = new THREE.Vector2();
  private climbPhase = 0;

  private body: THREE.Group = new THREE.Group();
  private legs: THREE.Mesh[] = [];
  private tail: THREE.Object3D[] = [];
  private t = 0;
  private flame: THREE.Mesh;
  private glow: THREE.PointLight;
  private smoke: { m: THREE.Mesh; age: number; vy: number }[] = [];
  private smokeGeo = new THREE.SphereGeometry(1, 6, 5);
  private smokeT = 0;
  private tiara = new THREE.Group();

  /** America's Next Top Rat */
  crown(): void {
    this.tiara.visible = true;
  }

  constructor(gradient: THREE.DataTexture) {
    const toon = (color: number) => new THREE.MeshToonMaterial({ color, gradientMap: gradient });
    const fur = toon(0x7d746c);
    const belly = toon(0xb9aea0);
    const pink = toon(0xe79aa6);
    const black = new THREE.MeshBasicMaterial({ color: 0x14121c });

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = this.body) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    // torso: a long egg
    const torso = add(new THREE.SphereGeometry(1, 16, 12), fur);
    torso.scale.set(0.27, 0.25, 0.55);
    torso.position.set(0, 0.28, -0.05);
    const under = add(new THREE.SphereGeometry(1, 12, 8), belly);
    under.scale.set(0.2, 0.16, 0.42);
    under.position.set(0, 0.2, -0.02);

    // head + snout
    const head = add(new THREE.SphereGeometry(1, 14, 10), fur);
    head.scale.set(0.17, 0.16, 0.2);
    head.position.set(0, 0.32, 0.5);
    const snout = add(new THREE.ConeGeometry(0.12, 0.28, 10), fur);
    snout.rotation.x = Math.PI / 2;
    snout.position.set(0, 0.29, 0.72);
    const nose = add(new THREE.SphereGeometry(0.045, 8, 6), pink);
    nose.position.set(0, 0.29, 0.87);

    // ears + eyes
    for (const s of [-1, 1]) {
      const ear = add(new THREE.SphereGeometry(1, 10, 8), pink);
      ear.scale.set(0.12, 0.13, 0.03);
      ear.position.set(s * 0.12, 0.47, 0.4);
      ear.rotation.y = s * 0.5;
      const eye = add(new THREE.SphereGeometry(0.035, 6, 6), black);
      eye.position.set(s * 0.1, 0.36, 0.62);
    }

    // contestant sash: a red band slung round the shoulders
    const sash = add(new THREE.TorusGeometry(1, 0.07, 5, 28), toon(0xd8243c));
    sash.scale.set(0.285, 0.272, 0.7);
    sash.position.set(0, 0.29, 0.12);
    sash.rotation.set(0.35, 0, 0.5);

    // the crown: hidden until the rat wins
    const gold = toon(0xffcf40);
    this.tiara.position.set(0, 0.46, 0.48);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.014, 5, 18), gold);
    band.rotation.x = Math.PI / 2;
    this.tiara.add(band);
    for (let i = -2; i <= 2; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.018, i === 0 ? 0.11 : 0.07, 5), gold);
      const a = i * 0.45 - Math.PI / 2;
      spike.position.set(Math.cos(a) * -0.09, 0.04, Math.sin(a) * -0.09);
      this.tiara.add(spike);
    }
    const jewel = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 5), toon(0x3ad0ff));
    jewel.position.set(0, 0.015, 0.095);
    this.tiara.add(jewel);
    this.tiara.visible = false;
    this.body.add(this.tiara);

    // paws
    const pawGeo = new THREE.SphereGeometry(0.075, 8, 6);
    for (const [x, z] of [[-0.14, 0.3], [0.14, 0.3], [-0.14, -0.3], [0.14, -0.3]]) {
      const paw = add(pawGeo, pink);
      paw.scale.set(1, 0.7, 1.5);
      paw.position.set(x, 0.07, z);
      this.legs.push(paw);
    }

    // rocket pack
    const metal = toon(0x555a66);
    for (const sx of [-0.09, 0.09]) {
      const can = add(new THREE.CylinderGeometry(0.06, 0.07, 0.3, 8), metal);
      can.position.set(sx, 0.6, -0.12);
      can.rotation.x = Math.PI / 2;
    }
    this.flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.09, 0.45, 8),
      new THREE.MeshBasicMaterial({ color: 0xffb030 }),
    );
    this.flame.rotation.x = -Math.PI / 2; // tip points back (-z)
    this.flame.position.set(0, 0.6, -0.5);
    this.glow = new THREE.PointLight(0xffa040, 0, 7, 1.6);
    this.glow.position.set(0, 0.6, -0.6);
    this.body.add(this.glow);
    this.flame.visible = false;
    this.body.add(this.flame);

    // tail: chain of segments that whip as we move
    let parent: THREE.Object3D = this.body;
    for (let i = 0; i < 6; i++) {
      const seg = new THREE.Group();
      seg.position.set(0, i === 0 ? 0.24 : 0, i === 0 ? -0.55 : -0.2);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.035 - i * 0.004, 0.04 - i * 0.004, 0.22, 6), pink);
      m.rotation.x = Math.PI / 2;
      m.position.z = -0.1;
      m.castShadow = true;
      seg.add(m);
      parent.add(seg);
      this.tail.push(seg);
      parent = seg;
    }

    this.group.rotation.order = 'YXZ';
    this.group.scale.setScalar(RAT_SCALE);
    this.group.add(this.body);
  }

  spawn(p: THREE.Vector3): void {
    this.pos.copy(p);
    this.vy = 0;
    this.fuel = MAX_FUEL;
    this.grounded = true;
    this.mode = 'walk';
    this.pipe = null;
    this.knock.set(0, 0);
    this.speed = 0;
  }

  /** Grab a pipe (optionally at a given height). */
  attach(p: Pipe, y = this.pos.y): void {
    this.mode = 'climb';
    this.pipe = p;
    this.pos.set(p.x + p.nx * 0.11, y, p.z + p.nz * 0.11);
    this.vy = 0;
    this.speed = 0;
    this.knock.set(0, 0);
    this.yaw = Math.atan2(-p.nx, -p.nz);
  }

  /** Returns false while invulnerable. */
  hit(fromX: number, fromZ: number): boolean {
    if (this.hurt > 0) return false;
    this.hurt = 1.8;
    if (this.mode === 'climb') {
      this.mode = 'walk';
      this.pipe = null;
      this.cd = 0.8;
    }
    const dx = this.pos.x - fromX, dz = this.pos.z - fromZ;
    const l = Math.hypot(dx, dz) || 1;
    this.knock.set((dx / l) * 6, (dz / l) * 6);
    this.vy = 5;
    this.grounded = false;
    return true;
  }

  update(dt: number, input: MoveInput, camYaw: number, level: Level): void {
    this.hurt = Math.max(0, this.hurt - dt);
    this.cd = Math.max(0, this.cd - dt);
    const jumpEdge = input.jump && !this.prevJump;
    this.prevJump = input.jump;

    if (this.mode === 'climb') {
      this.climb(dt, input, jumpEdge, level);
      this.animate(dt);
      return;
    }

    // camera-relative wish direction (camera looks down -z at yaw 0)
    const sin = Math.sin(camYaw), cos = Math.cos(camYaw);
    let wx = input.x * cos - input.z * sin;
    let wz = -input.x * sin - input.z * cos;
    const len = Math.hypot(wx, wz);
    if (len > 1) {
      wx /= len;
      wz /= len;
    }
    const top = input.sprint ? 7.5 : 4.4;
    const want = Math.min(1, len) * top;
    this.speed += (want - this.speed) * Math.min(1, dt * 14); // snappy accel, rat-like
    if (len > 0.05) {
      const target = Math.atan2(wx, wz);
      let d = target - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * 14);
    }
    // keep gliding along the facing direction while speed decays, so stops aren't instant
    const mag = Math.hypot(wx, wz);
    const dirX = mag > 0.05 ? wx / mag : Math.sin(this.yaw);
    const dirZ = mag > 0.05 ? wz / mag : Math.cos(this.yaw);
    this.pos.x += dirX * this.speed * dt + this.knock.x * dt;
    this.pos.z += dirZ * this.speed * dt + this.knock.y * dt;
    this.knock.multiplyScalar(Math.exp(-dt * (this.grounded ? 8 : 1.2)));

    level.collider.pushOut(this.pos, RAT_RADIUS, STEP);

    // run at a drainpipe to start climbing
    if (this.cd <= 0 && this.speed > 1.5 && mag > 0.05) {
      for (const p of level.pipes) {
        if (this.pos.y > p.top - 0.6) continue;
        const ax = p.x + p.nx * 0.32, az = p.z + p.nz * 0.32;
        if (Math.hypot(this.pos.x - ax, this.pos.z - az) < 0.34 && dirX * -p.nx + dirZ * -p.nz > 0.5) {
          this.attach(p);
          return;
        }
      }
    }

    const ground = level.collider.ground(this.pos.x, this.pos.z, this.pos.y, RAT_RADIUS * 0.6, STEP);

    if (input.jump && this.grounded) {
      this.vy = JUMP;
      this.grounded = false;
      this.jumped = true;
    }
    // rocket pack: hold space in the air
    this.flying = input.jump && !this.grounded && this.fuel > 0;
    if (this.flying) {
      this.fuel = Math.max(0, this.fuel - dt);
      this.vy = Math.min(MAX_RISE, this.vy + THRUST * dt);
    } else if (this.grounded) {
      this.fuel = Math.min(MAX_FUEL, this.fuel + REFUEL * dt);
    }
    this.vy -= GRAVITY * dt;
    this.pos.y += this.vy * dt;
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this.vy = 0;
      this.grounded = true;
    } else if (this.pos.y > ground + 0.05) {
      this.grounded = false;
    }

    this.animate(dt);
  }

  private climb(dt: number, input: MoveInput, jumpEdge: boolean, level: Level): void {
    const p = this.pipe!;
    const ax = p.x + p.nx * 0.11, az = p.z + p.nz * 0.11;
    const k = Math.min(1, dt * 20);
    this.pos.x += (ax - this.pos.x) * k;
    this.pos.z += (az - this.pos.z) * k;

    const v = input.z * (input.sprint ? 4.2 : 2.6);
    this.pos.y += v * dt;
    this.climbPhase += v * dt * 5;

    if (jumpEdge) {
      // kick off the wall into the alley
      this.mode = 'walk';
      this.pipe = null;
      this.cd = 0.5;
      this.knock.set(p.nx * 4.2, p.nz * 4.2);
      this.vy = 6;
      this.grounded = false;
      this.yaw = Math.atan2(p.nx, p.nz);
      this.jumped = true;
      return;
    }
    if (v > 0 && this.pos.y >= p.top - 0.1) {
      // scramble over the parapet onto the roof
      this.pos.set(p.x - p.nx * 0.7, p.top, p.z - p.nz * 0.7);
      this.mode = 'walk';
      this.pipe = null;
      this.cd = 0.6;
      this.vy = 0;
      this.grounded = true;
      return;
    }
    const g = level.collider.ground(ax, az, this.pos.y, 0.2, STEP);
    if (v < 0 && this.pos.y <= g) {
      // back down at the bottom
      this.pos.set(p.x + p.nx * 0.35, g, p.z + p.nz * 0.35);
      this.mode = 'walk';
      this.pipe = null;
      this.cd = 0.5;
      this.vy = 0;
      this.grounded = true;
      this.yaw = Math.atan2(p.nx, p.nz);
    }
  }

  private updateSmoke(dt: number): void {
    const scene = this.group.parent;
    if (!scene) return;
    this.glow.intensity = this.flying ? 3 + Math.random() * 1.5 : 0;
    this.smokeT -= dt;
    if (this.flying && this.mode === 'walk' && this.smokeT <= 0) {
      this.smokeT = 0.03;
      this.group.updateMatrixWorld(true);
      const p = new THREE.Vector3(0, 0.6, -0.65);
      this.body.localToWorld(p);
      let e = this.smoke.find((x) => !x.m.visible);
      if (!e) {
        const m = new THREE.Mesh(this.smokeGeo, new THREE.MeshBasicMaterial({ color: 0xb8b8c0, transparent: true, depthWrite: false }));
        scene.add(m);
        e = { m, age: 0, vy: 0 };
        this.smoke.push(e);
      }
      e.m.visible = true;
      e.m.position.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 0.06, 0, (Math.random() - 0.5) * 0.06));
      e.age = 0;
      e.vy = -0.3 - Math.random() * 0.3;
    }
    for (const e of this.smoke) {
      if (!e.m.visible) continue;
      e.age += dt;
      const k = e.age / 1.1;
      if (k >= 1) { e.m.visible = false; continue; }
      e.m.position.y += (e.vy + k * 0.9) * dt; // sinks briefly, then drifts up
      e.m.scale.setScalar(0.05 + k * 0.22);
      (e.m.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - k);
    }
  }

  private animate(dt: number): void {
    this.updateSmoke(dt);
    const climbing = this.mode === 'climb';
    this.t += dt * (2 + this.speed * 1.6);
    const run = Math.min(1, this.speed / 5);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    this.flame.visible = this.flying && !climbing;
    this.flame.scale.set(1, 0.7 + Math.random() * 0.6, 1);
    this.group.visible = this.hurt <= 0 || Math.floor(this.hurt * 14) % 2 === 0; // blink while invulnerable

    if (climbing) {
      // nose to the sky, belly on the pipe
      this.group.rotation.x = -Math.PI / 2;
      this.group.position.y += 0.55 * RAT_SCALE;
      this.body.position.y = 0;
      this.body.rotation.x = 0;
      this.legs.forEach((leg, i) => {
        const ph = this.climbPhase + (i % 2) * Math.PI;
        leg.position.z = (i < 2 ? 0.3 : -0.3) + Math.sin(ph) * 0.14;
        leg.position.y = 0.07;
      });
      this.tail.forEach((seg, i) => {
        seg.rotation.y = Math.sin(this.t * 1.5 - i * 0.7) * 0.15;
        seg.rotation.x = -0.05;
      });
      return;
    }

    this.group.rotation.x = 0;
    // bounding gait
    const air = this.grounded ? 0 : 1;
    this.body.position.y = Math.abs(Math.sin(this.t * 2)) * 0.07 * run * (1 - air);
    this.body.rotation.x = air ? THREE.MathUtils.clamp(-this.vy * 0.04, -0.5, 0.4) : Math.sin(this.t * 2) * 0.05 * run;
    this.legs.forEach((leg, i) => {
      const ph = this.t * 2 + (i < 2 ? 0 : Math.PI) + (i % 2) * 0.4;
      leg.position.z = (i < 2 ? 0.3 : -0.3) + Math.sin(ph) * 0.12 * run;
      leg.position.y = 0.07 + Math.max(0, Math.cos(ph)) * 0.07 * run;
    });
    this.tail.forEach((seg, i) => {
      seg.rotation.y = Math.sin(this.t * 2 - i * 0.7) * (0.12 + run * 0.25);
      seg.rotation.x = i === 0 ? -0.35 : -0.04 - air * 0.08;
    });
  }
}
