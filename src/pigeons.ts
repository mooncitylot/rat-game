import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * City pigeons. They sit in little groups on the wires, along roof cornices, on rooftop gear and down on the
 * sidewalks; when the rat comes close the whole group bursts up and away, circles a while, then settles on a
 * spot near where it took off. Drawn as a handful of InstancedMeshes; only the birds near the rat are
 * simulated and drawn.
 */

export interface Spot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  ground?: boolean; // on the pavement: pecks instead of bobbing
}

const VIS = 90; // drawn / simulated within this of the rat
const SCARE = 5.5;
const MAX_DRAWN = 1400; // under chunk.ts's 1500 cut-off: these move every frame, never chunk them
const CELL = 24;

type State = 'perched' | 'flying' | 'away';

interface Bird {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  state: State;
  spot: Spot;
  timer: number;
  fx: number; fy: number; fz: number;
  tx: number; ty: number; tz: number;
  t: number; dur: number; arc: number;
  phase: number;
  wing: number; // flap angle, 0 when folded
  col: THREE.Color;
}

export interface Flock {
  group: THREE.Group;
  count: number;
  update(dt: number, time: number, rat: THREE.Vector3): void;
}

export function buildFlock(spots: Spot[], count: number, gradient: THREE.DataTexture, rand: () => number): Flock {
  const group = new THREE.Group();
  if (!spots.length) return { group, count: 0, update: () => {} };
  const toon = (c: number, side: THREE.Side = THREE.FrontSide) => new THREE.MeshToonMaterial({ color: c, gradientMap: gradient, side });

  // ---- spots, bucketed so a bird coming home can pick one nearby ----
  const grid = new Map<number, Spot[]>();
  const key = (x: number, z: number) => Math.floor(x / CELL) * 100003 + Math.floor(z / CELL);
  for (const s of spots) {
    const k = key(s.x, s.z);
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(s);
  }
  const taken = new Set<Spot>();
  const near = (x: number, z: number, r: number): Spot => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), R = Math.ceil(r / CELL);
    for (let tries = 0; tries < 12; tries++) {
      const l = grid.get((cx + Math.floor(rand() * (2 * R + 1)) - R) * 100003 + cz + Math.floor(rand() * (2 * R + 1)) - R);
      if (!l) continue;
      const s = l[Math.floor(rand() * l.length)];
      if (!taken.has(s)) return s;
    }
    return spots[Math.floor(rand() * spots.length)];
  };

  // ---- birds: seeded in groups of 2-7 around a spot ----
  const PLUMAGE = [0x8a8d99, 0x8a8d99, 0x8a8d99, 0x7d808c, 0x9a9caa, 0x6f6a66, 0xb7a58f, 0xe8e6e0, 0x55545c];
  const birds: Bird[] = [];
  const makeBird = (s: Spot): Bird => {
    taken.add(s);
    return {
      x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: 0, state: 'perched', spot: s, timer: 0,
      fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, t: 0, dur: 1, arc: 0, phase: rand() * 6.28, wing: 0,
      col: new THREE.Color(PLUMAGE[Math.floor(rand() * PLUMAGE.length)]),
    };
  };
  count = Math.min(count, Math.floor(spots.length * 0.6));
  while (birds.length < count) {
    const seed = spots[Math.floor(rand() * spots.length)];
    if (taken.has(seed)) continue;
    birds.push(makeBird(seed));
    const n = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < n && birds.length < count; i++) {
      const s = near(seed.x, seed.z, 6);
      if (!taken.has(s) && Math.hypot(s.x - seed.x, s.z - seed.z) < 14) birds.push(makeBird(s));
    }
  }

  // ---- meshes ----
  const part = (g: THREE.BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z);
  const bodyGeo = mergeGeometries([
    part(new THREE.SphereGeometry(0.09, 7, 5).scale(1, 0.85, 1.5), 0, 0.12, 0),
    part(new THREE.BoxGeometry(0.07, 0.015, 0.12), 0, 0.12, -0.17),
  ])!;
  const headGeo = part(new THREE.SphereGeometry(0.045, 6, 5), 0, 0.2, 0.12);
  const beakGeo = part(new THREE.ConeGeometry(0.012, 0.04, 4).rotateX(Math.PI / 2), 0, 0.2, 0.18);
  const legGeo = part(new THREE.BoxGeometry(0.06, 0.06, 0.015), 0, 0.03, 0.01);
  const wingGeo = new THREE.BoxGeometry(0.18, 0.012, 0.14).translate(0.09, 0, 0);
  const mk = (g: THREE.BufferGeometry, m: THREE.Material) => {
    const im = new THREE.InstancedMesh(g, m, MAX_DRAWN);
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = true;
    group.add(im);
    return im;
  };
  const body = mk(bodyGeo, toon(0xffffff));
  const head = mk(headGeo, toon(0x3f8f7a));
  const beak = mk(beakGeo, toon(0x4d5160));
  const legs = mk(legGeo, toon(0xc0605a));
  const wingL = mk(wingGeo, toon(0x4d5160, THREE.DoubleSide));
  const wingR = mk(wingGeo, toon(0x4d5160, THREE.DoubleSide));
  body.setColorAt(0, new THREE.Color(1, 1, 1)); // allocate instanceColor

  const m = new THREE.Matrix4(), w = new THREE.Matrix4(), e = new THREE.Euler(), qq = new THREE.Quaternion(), pos = new THREE.Vector3();
  const SC = new THREE.Vector3(1.5, 1.5, 1.5);
  const wingOff = new THREE.Vector3(), wingQ = new THREE.Quaternion(), wingS = new THREE.Vector3();

  const launch = (b: Bird, tx: number, ty: number, tz: number, dur: number, arc: number) => {
    b.fx = b.x; b.fy = b.y; b.fz = b.z;
    b.tx = tx; b.ty = ty; b.tz = tz;
    b.t = 0; b.dur = dur; b.arc = arc;
  };
  const scare = (b: Bird, rx: number, rz: number) => {
    const dx = rx - b.x, dz = rz - b.z, d = Math.hypot(dx, dz) || 1;
    const dist = 25 + rand() * 25;
    taken.delete(b.spot);
    b.state = 'away';
    b.timer = 4 + rand() * 6;
    launch(b, b.x - (dx / d) * dist + (rand() - 0.5) * 16, b.y + 9 + rand() * 8, b.z - (dz / d) * dist + (rand() - 0.5) * 16, 1.6 + rand() * 0.6, 2);
  };
  const fly = (b: Bird, dt: number) => {
    b.t += dt;
    const k = Math.min(1, b.t / b.dur);
    const s = k * k * (3 - 2 * k);
    const px = b.x, pz = b.z;
    b.x = b.fx + (b.tx - b.fx) * s;
    b.y = b.fy + (b.ty - b.fy) * s + Math.sin(k * Math.PI) * b.arc;
    b.z = b.fz + (b.tz - b.fz) * s;
    const vx = b.x - px, vz = b.z - pz;
    if (vx * vx + vz * vz > 1e-8) b.yaw = Math.atan2(vx, vz);
    b.pitch = 0;
  };

  return {
    group,
    count: birds.length,
    update(dt, time, rat) {
      let n = 0;
      const vis2 = VIS * VIS;
      for (const b of birds) {
        const dx = b.x - rat.x, dz = b.z - rat.z;
        const close = dx * dx + dz * dz < vis2;
        if (!close && b.state === 'perched') continue;
        if (b.state === 'perched') {
          if (b.spot.ground) {
            // peck: dip the head now and then, shuffle round
            const c = Math.sin(time * 2.3 + b.phase);
            b.pitch = c > 0.6 ? 0.5 : 0;
            if (Math.sin(time * 0.3 + b.phase * 3) > 0.995) b.yaw += dt * 3;
          } else b.pitch = Math.sin(time * 3 + b.phase) * 0.04;
          b.wing = 0;
          if (dx * dx + dz * dz < SCARE * SCARE && rat.y < b.y + 2) {
            scare(b, rat.x, rat.z);
            // the rest of the group goes too
            for (const o of birds) {
              if (o.state !== 'perched' || o === b) continue;
              const ox = o.x - b.x, oz = o.z - b.z;
              if (ox * ox + oz * oz < 64 && Math.abs(o.y - b.y) < 4) {
                o.timer = 0;
                scare(o, rat.x, rat.z);
                o.dur += rand() * 0.4;
              }
            }
          }
        } else if (b.state === 'away') {
          if (b.t < b.dur) fly(b, dt);
          else {
            b.y += Math.sin(time * 2 + b.phase) * dt * 0.8;
            b.timer -= dt;
            if (b.timer <= 0) {
              // settle somewhere near, never right back beside the rat
              let s = near(b.x, b.z, 40);
              for (let k = 0; k < 6 && Math.hypot(s.x - rat.x, s.z - rat.z) < 12; k++) s = near(b.x, b.z, 40);
              taken.add(s);
              b.spot = s;
              b.state = 'flying';
              launch(b, s.x, s.y, s.z, 2.4 + rand(), 1.5);
            }
          }
          b.wing = Math.sin(time * 28 + b.phase) * 0.9 * (b.t < b.dur ? 1 : 0.5);
        } else {
          if (b.t < b.dur) {
            fly(b, dt);
            b.wing = Math.sin(time * 28 + b.phase) * 0.9;
          } else {
            b.state = 'perched';
            b.x = b.spot.x; b.y = b.spot.y; b.z = b.spot.z; b.yaw = b.spot.yaw;
            b.wing = 0;
          }
        }
        if (!close || n >= MAX_DRAWN) continue;
        // ---- draw ----
        e.set(b.pitch, b.yaw, 0, 'YXZ');
        qq.setFromEuler(e);
        m.compose(pos.set(b.x, b.y + 0.02, b.z), qq, SC);
        body.setMatrixAt(n, m);
        body.setColorAt(n, b.col);
        head.setMatrixAt(n, m);
        beak.setMatrixAt(n, m);
        legs.setMatrixAt(n, m);
        const flapping = b.wing !== 0 || b.state !== 'perched';
        for (const [im, sx] of [[wingL, 1], [wingR, -1]] as const) {
          if (flapping) {
            wingOff.set(sx * 0.05, 0.1, 0);
            wingQ.setFromEuler(e.set(0, 0, sx * b.wing));
            wingS.set(sx, 1, 1);
          } else {
            // folded along the back
            wingOff.set(sx * 0.065, 0.165, 0.07);
            wingQ.setFromEuler(e.set(0, sx * 1.45, sx * -0.25));
            wingS.set(sx, 1, 0.75);
          }
          w.compose(wingOff, wingQ, wingS);
          im.setMatrixAt(n, w.premultiply(m));
        }
        n++;
      }
      for (const im of [body, head, beak, legs, wingL, wingR]) {
        im.count = n;
        im.instanceMatrix.needsUpdate = true;
      }
      if (body.instanceColor) body.instanceColor.needsUpdate = true;
    },
  };
}
