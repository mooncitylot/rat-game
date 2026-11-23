import * as THREE from 'three';
import type { World } from './world';

const UP = new THREE.Vector3(0, 1, 0);

export interface Env {
  hour: number;
  night: number; // 0 day .. 1 full night
}

// hour, sky/fog colour, hemisphere sky, hemisphere ground, hemisphere intensity, key colour, key intensity
type Key = [number, number, number, number, number, number, number];
const KEYS: Key[] = [
  [0, 0x1a1c30, 0x8a90b8, 0x3a3436, 1.3, 0xd0d4f0, 1.9],
  [5, 0x1a1c30, 0x8a90b8, 0x3a3436, 1.3, 0xd0d4f0, 1.9],
  [6.5, 0xf0a58a, 0xffd0c0, 0x6a4a52, 1.0, 0xffb98a, 2.0],
  [8.5, 0x9fd0ee, 0xcfe6ff, 0x7a6a62, 1.35, 0xfff2dc, 3.0],
  [15.5, 0x9fd0ee, 0xcfe6ff, 0x7a6a62, 1.35, 0xfff2dc, 3.0],
  [18, 0xe9a37a, 0xb9c8ff, 0x6a4a52, 1.1, 0xffc48a, 2.6],
  [19.5, 0x5a3a62, 0x9a8ab0, 0x383036, 1.15, 0xff9a6a, 1.4],
  [21, 0x1a1c30, 0x8a90b8, 0x3a3436, 1.3, 0xd0d4f0, 1.9],
  [24, 0x1a1c30, 0x8a90b8, 0x3a3436, 1.3, 0xd0d4f0, 1.9],
];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
  gl_Position.z = gl_Position.w; // always at the far plane
}
`;
const skyFrag = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uHorizon;
uniform vec3 uTop;
uniform vec3 uSun;
uniform float uNight;
uniform float uTime;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { return 0.5 * vn(p) + 0.25 * vn(p * 2.03) + 0.125 * vn(p * 4.1) + 0.0625 * vn(p * 8.3); }
void main() {
  vec3 d = normalize(vDir);
  float y = max(d.y, 0.0);
  // painted sky: the gradient is stepped into flat bands
  float t = floor(pow(y, 0.7) * 7.0) / 7.0;
  vec3 col = mix(uHorizon, uTop, t);

  // flat-shaded clouds: a lit edge toward the sun, a shaded body
  vec2 uv = d.xz / (y + 0.28) * 1.15 + vec2(uTime * 0.012, 0.0);
  float n = fbm(uv);
  float cover = 0.5;
  float body = smoothstep(cover, cover + 0.015, n) * smoothstep(0.02, 0.2, y);
  float edge = smoothstep(cover, cover + 0.015, fbm(uv + normalize(uSun.xz + 1e-3) * 0.07));
  vec3 lit = mix(uHorizon, vec3(1.0), 0.75);
  vec3 shade = mix(uTop, vec3(0.35, 0.38, 0.5), 0.35);
  vec3 cloud = mix(shade, lit, 1.0 - step(0.5, edge)); // rim toward the sun is lit
  cloud *= mix(1.0, 0.45, uNight);
  col = mix(col, cloud, body);

  // stars: dots and the odd four-point sparkle, twinkling in steps
  if (uNight > 0.05 && d.y > 0.02) {
    vec2 sp = d.xz / (d.y + 0.6) * 38.0;
    vec2 id = floor(sp), f = fract(sp) - 0.5;
    float r = h21(id);
    float on = step(0.93, r) * (1.0 - body);
    float tw = step(0.35, fract(r * 91.0 + floor(uTime * 2.0) * 0.37));
    float dot_ = 1.0 - smoothstep(0.05, 0.1, length(f));
    float spark = (1.0 - smoothstep(0.0, 0.06, min(abs(f.x), abs(f.y)))) * (1.0 - smoothstep(0.1, 0.32, length(f))) * step(0.985, r);
    col = mix(col, vec3(1.0, 0.97, 0.8), clamp(dot_ + spark, 0.0, 1.0) * on * tw * uNight);
  }

  // the sun (two flat rings) by day, the moon (one ring) by night
  float s = dot(d, normalize(uSun));
  vec3 disc = mix(vec3(1.0, 0.93, 0.62), vec3(0.95, 0.96, 1.0), uNight);
  float core = step(mix(0.9985, 0.9992, uNight), s);
  float halo = step(0.9955, s) * (1.0 - uNight);
  col = mix(col, disc, core);
  col = mix(col, mix(col, disc, 0.35), halo * (1.0 - core));
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Atmosphere {
  readonly env: Env = { hour: 17.4, night: 0 };
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  readonly key = new THREE.DirectionalLight(0xffffff, 1);
  readonly dome: THREE.Mesh;
  private domeMat: THREE.ShaderMaterial;
  /** seconds per full 24h day */
  dayLength = 300;

  private lamps: THREE.PointLight[] = [];
  private winLights: THREE.PointLight[] = []; // fixed pool, moved onto the nearest lit windows
  private winLightTimer = 0;
  private winLightLevel = 0;
  private winTimer = 0;
  private lastNight = -1;
  private bg = new THREE.Color();
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();
  private lampColor = new THREE.Color();
  private warm = new THREE.Color(0xfff1b0);
  private cold = new THREE.Color(0x6a6458);
  private winLit = [new THREE.Color(0xffd27a), new THREE.Color(0xffc15e), new THREE.Color(0xfff0b8)];
  private winDark = new THREE.Color();
  private tmp = new THREE.Color();
  readonly keyDir = new THREE.Vector3();
  private lsRight = new THREE.Vector3();
  private lsUp = new THREE.Vector3();
  private snapped = new THREE.Vector3();
  readonly lampOrder: number[];

  constructor(private scene: THREE.Scene, private world: World) {
    scene.add(this.hemi, this.key, this.key.target);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const S = 38;
    Object.assign(this.key.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 160 });
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.04;
    scene.background = new THREE.Color();
    scene.fog = new THREE.Fog(0xffffff, 60, 170);

    // a fixed pool of lights follows the nearest street lamps (fixed count = no shader recompiles)
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffd9a0, 0, 26, 2);
      scene.add(l);
      this.lamps.push(l);
    }
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffc873, 0, 16, 2);
      scene.add(l);
      this.winLights.push(l);
    }
    this.lampOrder = world.lamps.map((_, i) => i);

    this.domeMat = new THREE.ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uHorizon: { value: new THREE.Color() },
        uTop: { value: new THREE.Color() },
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uNight: { value: 0 },
        uTime: { value: 0 },
      },
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(200, 32, 16), this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);
  }

  skipHours(h: number): void {
    this.env.hour = (this.env.hour + h) % 24;
  }

  /** debug: jump to an hour */
  setHour(hour: number): void {
    this.env.hour = hour;
  }

  update(dt: number, focus: THREE.Vector3, time: number): void {
    const e = this.env;
    e.hour = (e.hour + (dt * 24) / this.dayLength) % 24;
    e.night = e.hour >= 12 ? smooth(17.5, 20, e.hour) : 1 - smooth(5, 7.5, e.hour);

    // ---- sample the keyframes ----
    let i = 0;
    while (i < KEYS.length - 2 && e.hour >= KEYS[i + 1][0]) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const f = (e.hour - a[0]) / (b[0] - a[0]);
    const mixCol = (ia: number, ib: number, out: THREE.Color) => out.set(ia).lerp(this.tmp.set(ib), f);
    mixCol(a[1], b[1], this.bg);
    mixCol(a[2], b[2], this.c1);
    mixCol(a[3], b[3], this.c2);
    const hemiI = a[4] + (b[4] - a[4]) * f;
    mixCol(a[5], b[5], this.key.color);
    const keyI = a[6] + (b[6] - a[6]) * f;


    this.hemi.color.copy(this.c1);
    this.hemi.groundColor.copy(this.c2);
    this.hemi.intensity = hemiI;
    this.key.intensity = keyI;
    (this.scene.background as THREE.Color).copy(this.bg);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.bg);
    fog.near = 60;
    fog.far = 170;

    // ---- key light: sun by day, moon by night, same arc so it never pops ----
    const day = e.hour >= 6 && e.hour < 18;
    const ang = (((day ? e.hour - 6 : e.hour >= 18 ? e.hour - 18 : e.hour + 6) % 12) / 12) * Math.PI;
    const elev = Math.sin(ang);
    this.keyDir.set(day ? Math.cos(ang) : -Math.cos(ang), 0.25 + 0.75 * elev, 0.4).normalize();
    this.key.intensity *= 0.35 + 0.65 * Math.min(1, elev * 4);
    // snap the shadow frustum to whole shadow-map texels (in light space) so edges don't shimmer as the rat moves
    const sc = this.key.shadow.camera;
    const texel = (sc.right - sc.left) / this.key.shadow.mapSize.x;
    this.lsRight.crossVectors(UP, this.keyDir).normalize();
    this.lsUp.crossVectors(this.keyDir, this.lsRight);
    const lr = focus.dot(this.lsRight), lu = focus.dot(this.lsUp);
    this.snapped.copy(focus)
      .addScaledVector(this.lsRight, Math.round(lr / texel) * texel - lr)
      .addScaledVector(this.lsUp, Math.round(lu / texel) * texel - lu);
    this.key.target.position.copy(this.snapped);
    this.key.position.copy(this.snapped).addScaledVector(this.keyDir, 70);

    // ---- street lamps: glow at night, lit by the 4 nearest ----
    const glow = smooth(0.15, 0.7, e.night);
    this.lampColor.copy(this.cold).lerp(this.warm, glow);
    this.world.bulbMat.color.copy(this.lampColor);
    const lamps = this.world.lamps;
    this.lampOrder.sort((p, q) => lamps[p].distanceToSquared(focus) - lamps[q].distanceToSquared(focus));
    this.lamps.forEach((l, k) => {
      l.position.copy(lamps[this.lampOrder[k]]);
      l.intensity = 90 * glow;
    });

    // ---- windows: lights come on as the night deepens (refresh a couple of times a second) ----
    this.winTimer -= dt;
    if (this.winTimer <= 0 && Math.abs(e.night - this.lastNight) > 0.004) {
      this.winTimer = 0.4;
      this.lastNight = e.night;
      this.winDark.copy(this.bg).multiplyScalar(0.45).add(this.tmp.set(0x0a0c18));
      const { mesh, thr } = this.world.windows;
      const level = e.night;
      for (let w = 0; w < thr.length; w++) {
        if (level + 0.02 > thr[w]) mesh.setColorAt(w, this.winLit[w % 3]);
        else mesh.setColorAt(w, this.winDark);
      }
      if (mesh instanceof THREE.InstancedMesh) { if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; } else mesh.colorsChanged();
    }

    // ---- lit windows throw light: the pool hops onto the nearest lit panes (rescanned a few times a second) ----
    const level = e.night;
    this.winLightLevel = smooth(0.15, 0.6, e.night);
    this.winLightTimer -= dt;
    if (this.winLightTimer <= 0) {
      this.winLightTimer = 0.25;
      const { thr, pos } = this.world.windows;
      const R2 = 45 * 45;
      const picks: { d: number; i: number }[] = [];
      if (this.winLightLevel > 0.01) {
        for (let w = 0; w < thr.length; w++) {
          if (level + 0.02 <= thr[w]) continue;
          const dx = pos[w * 5] - focus.x, dy = pos[w * 5 + 1] - focus.y, dz = pos[w * 5 + 2] - focus.z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < R2) picks.push({ d, i: w });
        }
        picks.sort((a, b) => a.d - b.d);
      }
      const chosen: number[] = [];
      for (const p of picks) {
        if (chosen.length >= this.winLights.length) break;
        const x = pos[p.i * 5], y = pos[p.i * 5 + 1], z = pos[p.i * 5 + 2];
        // spread out: skip panes right beside one already lit
        if (chosen.some((c) => Math.hypot(pos[c * 5] - x, pos[c * 5 + 1] - y, pos[c * 5 + 2] - z) < 6)) continue;
        chosen.push(p.i);
      }
      this.winLights.forEach((l, k) => {
        const w = chosen[k];
        if (w === undefined) { l.userData.on = 0; return; }
        l.userData.on = 1;
        l.position.set(pos[w * 5] + pos[w * 5 + 3] * 1.2, pos[w * 5 + 1], pos[w * 5 + 2] + pos[w * 5 + 4] * 1.2);
        l.color.copy(this.winLit[w % 3]);
      });
    }
    // ease intensity so lights fade between windows instead of popping
    for (const l of this.winLights) {
      const target = (l.userData.on ? 22 : 0) * this.winLightLevel;
      l.intensity += (target - l.intensity) * Math.min(1, dt * 8);
    }

    // ---- painted sky dome ----
    const u = this.domeMat.uniforms;
    (u.uHorizon.value as THREE.Color).copy(this.bg);
    (u.uTop.value as THREE.Color).copy(this.c1).lerp(this.bg, 0.25);
    (u.uSun.value as THREE.Vector3).copy(this.keyDir);
    u.uNight.value = e.night;
    u.uTime.value = time;

  }
}
