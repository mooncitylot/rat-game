import * as THREE from 'three';
import type { Collider } from './collider';
import type { Rat } from './rat';

type State = 'patrol' | 'alert' | 'chase' | 'search' | 'rest';

const SCALE = 0.5; // drawn ~2.3 m long; at half size a ~1.1 m cat, about twice the rat
const RADIUS = 0.22;
const STEP = 0.25;

export interface CatEnv {
  sight: number; // metres
  night: number; // 0..1, cats are quicker in the dark
}

/** Alley cat. Patrols a route, notices the rat, chases with limited stamina, gives up if you get above it. */
export class Cat {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  yaw = 0;
  state: State = 'patrol';

  private wp: number;
  private wait = 0;
  private timer = 0;
  private stamina = 0;
  private lostFor = 0;
  private unreach = 0;
  private last = new THREE.Vector3();
  private travel = 0;
  private t = Math.random() * 10;
  private legs: THREE.Mesh[] = [];
  private tail: THREE.Object3D[] = [];
  private mark: THREE.Mesh;
  private body = new THREE.Group();

  constructor(gradient: THREE.DataTexture, color: number, private route: THREE.Vector2[], startAt: number) {
    const toon = (c: number) => new THREE.MeshToonMaterial({ color: c, gradientMap: gradient });
    const fur = toon(color);
    const light = toon(new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.55).getHex());
    const pink = toon(0xe79aa6);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xd8ff5a });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = this.body) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    const torso = add(new THREE.SphereGeometry(1, 16, 12), fur);
    torso.scale.set(0.42, 0.4, 0.95);
    torso.position.set(0, 0.78, 0);
    const chest = add(new THREE.SphereGeometry(1, 12, 8), light);
    chest.scale.set(0.3, 0.3, 0.45);
    chest.position.set(0, 0.62, 0.45);

    const head = add(new THREE.SphereGeometry(1, 14, 10), fur);
    head.scale.set(0.32, 0.29, 0.3);
    head.position.set(0, 1.02, 1.0);
    const muzzle = add(new THREE.SphereGeometry(1, 10, 8), light);
    muzzle.scale.set(0.16, 0.12, 0.14);
    muzzle.position.set(0, 0.94, 1.26);
    const nose = add(new THREE.SphereGeometry(0.04, 6, 6), pink);
    nose.position.set(0, 0.99, 1.38);
    for (const s of [-1, 1]) {
      const ear = add(new THREE.ConeGeometry(0.12, 0.28, 4), fur);
      ear.position.set(s * 0.2, 1.3, 0.95);
      ear.rotation.z = -s * 0.2;
      const eye = add(new THREE.SphereGeometry(0.055, 8, 6), eyeMat);
      eye.scale.set(1, 1.3, 0.6);
      eye.position.set(s * 0.14, 1.07, 1.24);
    }

    for (const [x, z] of [[-0.2, 0.7], [0.2, 0.7], [-0.2, -0.7], [0.2, -0.7]]) {
      const leg = add(new THREE.CylinderGeometry(0.075, 0.07, 0.55, 6), fur);
      leg.position.set(x, 0.3, z);
      this.legs.push(leg);
    }

    let parent: THREE.Object3D = this.body;
    for (let i = 0; i < 5; i++) {
      const seg = new THREE.Group();
      seg.position.set(0, i === 0 ? 0.9 : 0, i === 0 ? -0.9 : -0.22);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06 - i * 0.006, 0.065 - i * 0.006, 0.26, 6), fur);
      m.rotation.x = Math.PI / 2;
      m.position.z = -0.12;
      m.castShadow = true;
      seg.add(m);
      parent.add(seg);
      this.tail.push(seg);
      parent = seg;
    }

    // "!" over the head when it spots you
    this.mark = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.7, 6), new THREE.MeshBasicMaterial({ color: 0xff4a3a }));
    this.mark.rotation.x = Math.PI;
    this.mark.position.set(0, 2.1, 1.0);
    this.mark.visible = false;
    this.group.add(this.body, this.mark);
    this.group.scale.setScalar(SCALE);

    this.wp = startAt % route.length;
    this.pos.set(route[this.wp].x, 0, route[this.wp].y + (Math.random() - 0.5) * 6);
    this.group.position.copy(this.pos);
  }

  /** Returns true on the frame the cat bites. */
  update(dt: number, rat: Rat, world: Collider, env: CatEnv): boolean {
    const dx = rat.pos.x - this.pos.x;
    const dz = rat.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    // a rat up a pipe or on a roof is out of reach
    const reachable = rat.pos.y < 0.9 && !(rat.mode === 'climb' && rat.pos.y > 0.5);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const cosA = (dx * fx + dz * fz) / Math.max(dist, 1e-3);
    const sees = reachable && dist < env.sight && (cosA > 0.2 || dist < 3.5) && !world.blocked(this.pos.x, this.pos.z, rat.pos.x, rat.pos.z, 0.5);
    const aware = dist < env.sight * 1.3 && rat.pos.y < 6; // can still glare up at you

    let speed = 0;
    let bite = false;
    this.mark.visible = false;

    switch (this.state) {
      case 'patrol': {
        const target = this.route[this.wp];
        if (this.wait > 0) {
          this.wait -= dt;
        } else {
          speed = 1.5;
          this.face(target.x - this.pos.x, target.y - this.pos.z, dt, 5);
          if (Math.hypot(target.x - this.pos.x, target.y - this.pos.z) < 0.9) {
            this.wait = 1 + Math.random() * 2.2;
            this.wp = (this.wp + 1) % this.route.length;
          }
        }
        if (sees) {
          this.state = 'alert';
          this.timer = 0.45;
        }
        break;
      }
      case 'alert':
        this.mark.visible = true;
        this.face(dx, dz, dt, 14);
        this.timer -= dt;
        if (this.timer <= 0) {
          this.state = 'chase';
          this.stamina = 5 + Math.random() * 2;
          this.lostFor = 0;
          this.unreach = 0;
        }
        break;
      case 'chase': {
        this.mark.visible = true;
        if (sees) {
          this.last.copy(rat.pos);
          this.lostFor = 0;
        } else {
          this.lostFor += dt;
        }
        if (!reachable && aware) {
          // rat is up a wall: pace underneath and glare, then lose interest
          this.unreach += dt;
          this.face(dx, dz, dt, 10);
          if (this.unreach > 3.5) {
            this.state = 'rest';
            this.timer = 1.5;
          }
          break;
        }
        this.unreach = 0;
        speed = 6.0 + env.night * 0.7;
        this.face(this.last.x - this.pos.x, this.last.z - this.pos.z, dt, 12);
        this.stamina -= dt;
        if (dist < 0.6 && Math.abs(rat.pos.y - this.pos.y) < 0.6 && reachable) {
          bite = true;
          this.state = 'rest';
          this.timer = 1.6;
        } else if (this.stamina <= 0) {
          this.state = 'rest';
          this.timer = 3; // out of breath: your window to escape
        } else if (this.lostFor > 2.5) {
          this.state = 'search';
          this.timer = 4;
        }
        break;
      }
      case 'search':
        speed = 2.6;
        this.face(this.last.x - this.pos.x, this.last.z - this.pos.z, dt, 6);
        this.timer -= dt;
        if (sees) {
          this.state = 'alert';
          this.timer = 0.3;
        } else if (this.timer <= 0 || Math.hypot(this.last.x - this.pos.x, this.last.z - this.pos.z) < 1) {
          this.state = 'patrol';
          this.wait = 1;
        }
        break;
      case 'rest':
        this.timer -= dt;
        if (this.timer <= 0) {
          this.state = 'patrol';
          this.wait = 0.5;
          // resume at the nearest waypoint
          let best = 1e9;
          this.route.forEach((p, i) => {
            const d = Math.hypot(p.x - this.pos.x, p.y - this.pos.z);
            if (d < best) {
              best = d;
              this.wp = i;
            }
          });
        }
        break;
    }

    if (speed > 0) {
      this.pos.x += Math.sin(this.yaw) * speed * dt;
      this.pos.z += Math.cos(this.yaw) * speed * dt;
      world.pushOut(this.pos, RADIUS, STEP);
    }
    const g = world.ground(this.pos.x, this.pos.z, this.pos.y, RADIUS * 0.5, STEP);
    this.pos.y += (g - this.pos.y) * Math.min(1, dt * 16);

    this.travel += speed * dt;
    this.t += dt;
    this.animate(speed);
    return bite;
  }

  private face(dx: number, dz: number, dt: number, rate: number): void {
    if (Math.abs(dx) + Math.abs(dz) < 1e-4) return;
    const target = Math.atan2(dx, dz);
    const d = Math.atan2(Math.sin(target - this.yaw), Math.cos(target - this.yaw));
    this.yaw += d * Math.min(1, dt * rate);
  }

  private animate(speed: number): void {
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    const run = Math.min(1, speed / 3);
    const ph = this.travel * 3.2;
    this.body.position.y = Math.abs(Math.sin(ph)) * 0.06 * run;
    this.body.rotation.x = this.state === 'rest' && speed === 0 ? Math.sin(this.t * 9) * 0.015 : 0; // panting
    this.legs.forEach((leg, i) => {
      const p = ph + (i % 2 ? Math.PI : 0) + (i < 2 ? 0 : Math.PI * 0.5);
      leg.position.z = (i < 2 ? 0.7 : -0.7) + Math.sin(p) * 0.22 * run;
      leg.rotation.x = Math.cos(p) * 0.45 * run;
    });
    const flick = this.state === 'alert' || this.state === 'chase' ? 0.5 : 0.25;
    this.tail.forEach((seg, i) => {
      seg.rotation.y = Math.sin(this.t * (this.state === 'chase' ? 7 : 2.2) - i * 0.6) * flick;
      seg.rotation.x = i === 0 ? -0.9 : 0.14;
    });
  }
}
