import * as THREE from 'three';
import { Atmosphere } from './atmosphere';
import { Sfx } from './audio';
import { Cat } from './cat';
import { Human } from './human';
import { Fleet, setCarNight } from './cars';
import { InkPipeline } from './ink';
import { Rat, MAX_FUEL } from './rat';
import { buildCity, loadCity } from './city';
import { MapView } from './mapview';
import { Judges, type Verdict } from './pageant';
import { chunkInstances, cullChunks, instancify, splitMeshes, type ChunkedInstances } from './chunk';
import { initTouch, touch } from './touch';
import { buildWorld, makeToonGradient, TOTAL_CHEESE, type World } from './world';

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('c') as HTMLCanvasElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false; // the ink pipeline renders 3 times a frame; count them all, reset once per frame

// ---- dynamic resolution: drop the pixel ratio when frames run long, creep back up when there's headroom ----
// ?res=1 pins it (no auto-scaling)
const RES_MAX = Math.min(window.devicePixelRatio, 2);
const RES_MIN = Math.min(0.6, RES_MAX);
const resPinned = new URLSearchParams(location.search).get('res');
let resScale = resPinned ? Number(resPinned) : Math.min(RES_MAX, 1.5);
let resCeiling = resPinned ? resScale : RES_MAX; // a level that once ran too slow is never retried
renderer.setPixelRatio(resScale);
const perf = { acc: 0, frames: 0, warm: 2, good: 0 };
function tuneResolution(dt: number): void {
  if (resPinned) return;
  if ((perf.warm -= dt) > 0) return; // ignore shader-compile hitches at startup
  perf.acc += dt;
  perf.frames++;
  if (perf.acc < 1) return;
  const ms = (perf.acc / perf.frames) * 1000;
  perf.acc = perf.frames = 0;
  if (ms > 22 && resScale > RES_MIN) {
    resCeiling = resScale - 0.01;
    resScale = Math.max(RES_MIN, resScale - 0.15);
    perf.good = 0;
    renderer.setPixelRatio(resScale);
    resize();
  } else if (ms < 18 && resScale + 0.1 <= resCeiling) {
    if (++perf.good >= 4) {
      perf.good = 0;
      resScale += 0.1;
      renderer.setPixelRatio(resScale);
      resize();
    }
  } else perf.good = 0;
}

// ---- stats overlay: ` or F3 (or ?stats) ----
const statsEl = document.getElementById('stats')!;
let statsOn = new URLSearchParams(location.search).has('stats');
statsEl.classList.toggle('on', statsOn);
const stats = { t: 0, frames: 0, worst: 0, sim: 0, draw: 0 };
/** sim = game logic ms, draw = three's CPU-side render submission ms (GPU time isn't visible from JS) */
function drawStats(dt: number, extra: string, simMs: number, drawMs: number): void {
  if (!statsOn) return;
  stats.t += dt;
  stats.frames++;
  stats.worst = Math.max(stats.worst, dt);
  stats.sim += simMs;
  stats.draw += drawMs;
  if (stats.t < 0.5) return;
  const i = renderer.info;
  statsEl.textContent =
    `${Math.round(stats.frames / stats.t)} fps · avg ${((stats.t / stats.frames) * 1000).toFixed(1)} ms · worst ${(stats.worst * 1000).toFixed(0)} ms\n` +
    `cpu: sim ${(stats.sim / stats.frames).toFixed(1)} ms · render ${(stats.draw / stats.frames).toFixed(1)} ms\n` +
    `draw calls ${i.render.calls} · tris ${(i.render.triangles / 1000).toFixed(0)}k\n` +
    `geos ${i.memory.geometries} · tex ${i.memory.textures} · programs ${i.programs?.length ?? 0}\n` +
    `res ×${resScale.toFixed(2)}${resPinned ? ' (pinned)' : ''} · ${extra}`;
  stats.t = stats.frames = stats.worst = stats.sim = stats.draw = 0;
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 300);
if (statsOn) Object.assign(window, { __scene: scene, __renderer: renderer, __camera: camera }); // poke at it from devtools
const ink = new InkPipeline(renderer);
const sfx = new Sfx();

// ---- world, weather, actors ----
const gradient = makeToonGradient();
// the real-place city (baked from OpenStreetMap by scripts/bake.mjs); ?map=grid for the old procedural blocks
async function createWorld(): Promise<World> {
  const q = new URLSearchParams(location.search);
  if (q.get('map') !== 'grid') {
    try {
      const data = await loadCity(q.get('map') ?? 'wrigleyville');
      return buildCity(data, gradient, { exag: Number(q.get('exag') ?? 1) });
    } catch (e) {
      console.warn('city failed, using the grid world', e);
    }
  }
  return buildWorld(gradient);
}
const world = await createWorld();
if (world.osmCredit) {
  const c = document.getElementById('credit');
  if (c) c.textContent = `Map data ${world.osmCredit} · terrain: Mapzen/AWS`;
}
scene.add(world.group);
ink.hide.push(world.beacon);
// split the city-sized instanced meshes (windows, grass, trees) into cullable cells; ?nochunk to compare
if (!new URLSearchParams(location.search).has('nochunk') && world.windows.mesh instanceof THREE.InstancedMesh) {
  world.group.updateMatrixWorld(true);
  const glass = world.windows.mesh;
  chunkInstances(world.group, 1500, new Map([[glass, (c: ChunkedInstances) => (world.windows.mesh = c)]]));
  splitMeshes(world.group);
  // once the Poly Haven models are in, fold the hundreds of lamp/hydrant/crate copies into instanced cells
  void world.propsReady?.then(() => {
    const r = instancify(world.group);
    if (statsOn) console.log(`[perf] instanced ${r.merged} prop meshes into ${r.sets} sets`);
  });
}

const atmo = new Atmosphere(scene, world);
ink.hide.push(atmo.rainMesh, atmo.dome);

const level = { collider: world.collider, pipes: world.pipes };

const rat = new Rat(gradient);
rat.spawn(world.spawn);
if (statsOn) Object.assign(window, { __rat: rat });
scene.add(rat.group);

const cats = world.catRoutes.map((route, i) => {
  const cat = new Cat(gradient, [0xc9803a, 0x55545e, 0x24222a][i % 3], route, i + 1);
  scene.add(cat.group);
  return cat;
});

// pedestrians: they walk the sidewalks, wait for the walk signal and cross on the zebras
const humans: Human[] = [];
const PEDS = 400;
const PED_RADIUS = 80; // only pedestrians this close to the rat are drawn and simulated
const CAR_RADIUS = 140;
for (let i = 0; i < PEDS && world.walkStarts.length; i++) {
  const start = world.walkStarts[Math.floor((i * world.walkStarts.length) / PEDS)];
  const h = new Human(gradient, world.walkNet, start, i % 2 ? 1 : -1, scene, i + 1);
  scene.add(h.group);
  humans.push(h);
}

// traffic
const fleet = new Fleet(world.carRoads ?? [], world.terrainAt ?? (() => 0));
fleet.spawn(gradient, scene, 250);

const keys = new Set<string>();
let camYawInit = Number(new URLSearchParams(location.search).get('yaw') ?? Math.PI + 0.55); // default: look toward +x/+z, into the city

// debug URL params: ?hour=22&rain=1&at=x,z,y&yaw=1.2
{
  const q = new URLSearchParams(location.search);
  if (q.has('hour') || q.has('rain')) atmo.setWeather(Number(q.get('hour') ?? 17.4), Number(q.get('rain') ?? 0));
  if (q.has('at')) {
    const [x, z, y] = q.get('at')!.split(',').map(Number);
    rat.spawn(new THREE.Vector3(x, y ?? 0, z));
  }
  if (q.has('climb')) {
    // ?climb=pipeIndex,height  → start mid-climb
    const [i, h] = q.get('climb')!.split(',').map(Number);
    const p = world.pipes[i];
    rat.attach(p, h);
    camYawInit = Math.atan2(p.nx, p.nz) + 0.5;
  }
  if (q.has('ped')) {
    // ?ped=N → stand 2.6 m from pedestrian N, camera looking at them
    const h = humans[Number(q.get('ped'))];
    rat.spawn(new THREE.Vector3(h.pos.x + 2.1, h.pos.y, h.pos.z));
    camYawInit = Math.PI / 2;
  }
  if (q.has('keys')) for (const k of q.get('keys')!.split(',')) keys.add(k);
}

// ---- game state ----
const MAX_HEARTS = 3;
let hearts = MAX_HEARTS;
let carried = 0;
let banked = 0;
let won = false;
let camSnap = true;
$('total').textContent = String(TOTAL_CHEESE);

// ---- the judges ----
const judges = new Judges();
let judgeTimer = 0;
let slowmo = 0; // real seconds of slow motion left
let shake = 0;
function showVerdict(v: Verdict): void {
  const el = $('judges');
  el.innerHTML = `<div class="jn">${v.name}</div><div class="js">${v.scores.map((s) => `<span>${s}</span>`).join('')}</div><div class="jt">+${v.total} ★</div>`;
  el.classList.remove('on');
  void el.offsetWidth; // restart the pop-in animation
  el.classList.add('on');
  judgeTimer = 2.2;
  $('stars').textContent = String(judges.stars);
  sfx.applause(v.quality);
}

function drawHearts() {
  $('hearts').innerHTML = Array.from({ length: MAX_HEARTS }, (_, i) => `<span class="${i < hearts ? '' : 'off'}">♥</span>`).join('');
}
function drawCounts() {
  $('carried').textContent = String(carried);
  $('banked').textContent = String(banked);
}
let toastTimer = 0;
function toast(msg: string, secs = 1.6) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  toastTimer = secs;
}
drawHearts();
drawCounts();

function takeHit(fromX: number, fromZ: number, why: string) {
  if (!rat.hit(fromX, fromZ)) return;
  sfx.hurt();
  shake = 0.22;
  judges.caught();
  hearts--;
  const lost = carried;
  carried = 0;
  for (const c of world.cheese) {
    if (c.state === 'carried') {
      c.state = 'free'; // the haul scatters back where it was
      c.mesh.visible = true;
    }
  }
  const flash = $('flash');
  flash.style.transition = 'none';
  flash.style.opacity = '0.55';
  requestAnimationFrame(() => {
    flash.style.transition = 'opacity .5s';
    flash.style.opacity = '0';
  });
  if (hearts <= 0) {
    hearts = MAX_HEARTS;
    rat.spawn(world.spawn);
    rat.hurt = 2.5;
    camSnap = true;
    toast('CAUGHT · BACK TO THE SEWER', 2.4);
  } else {
    toast(lost ? `${why} · DROPPED ${lost} CHEESE` : why, 1.5);
  }
  drawHearts();
  drawCounts();
}

// ---- map: open with M, click to teleport ----
let camYaw = camYawInit;
const mapView = world.map
  ? new MapView(world.map, (x, z) => {
      // nearest open ground to the clicked spot (not inside a building or tree)
      const bd = world.map!.bounds;
      x = THREE.MathUtils.clamp(x, bd.x0 + 10, bd.x1 - 10);
      z = THREE.MathUtils.clamp(z, bd.z0 + 10, bd.z1 - 10);
      let best: [number, number] | null = null;
      for (let r = 0; r <= 60 && !best; r += 1.5) {
        for (let a = 0; a < (r ? 12 : 1) && !best; a++) {
          const px = x + Math.cos(a * 0.5236) * r, pz = z + Math.sin(a * 0.5236) * r;
          const y = world.collider.terrain(px, pz) + 0.6;
          if (!world.collider.solidAt(px, y, pz, 0.35)) best = [px, pz];
        }
      }
      const [px, pz] = best ?? [x, z];
      rat.spawn(new THREE.Vector3(px, world.collider.ground(px, pz, world.collider.terrain(px, pz) + 1, 0.1, 0.25), pz));
      camSnap = true;
      mapView!.setOpen(false);
      canvas.requestPointerLock?.();
      toast('TELEPORTED', 1);
    })
  : null;
/** loose cheese and the nest, for the map */
function mapMarks(): { x: number; z: number; kind: 'cheese' | 'nest' }[] {
  const out: { x: number; z: number; kind: 'cheese' | 'nest' }[] = [{ x: world.nest.x, z: world.nest.z, kind: 'nest' }];
  for (const c of world.cheese) if (c.state === 'free') out.push({ x: c.mesh.position.x, z: c.mesh.position.z, kind: 'cheese' });
  return out;
}
function toggleMap(v = !mapView?.open): void {
  if (!mapView) return;
  mapView.setOpen(v);
  if (v) document.exitPointerLock?.();
  else canvas.requestPointerLock?.();
}

if (new URLSearchParams(location.search).has('openmap')) mapView?.setOpen(true); // debug

// ---- input ----
const debugLift = Number(new URLSearchParams(location.search).get('lift') ?? 0); // debug: aim the camera up to inspect the sky
let camPitch = Number(new URLSearchParams(location.search).get('pitch') ?? 0.38);
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyM') toggleMap();
  if (e.code === 'Escape' && mapView?.open) mapView.setOpen(false);
  if (e.code === 'KeyN') atmo.skipHours(1);
  if (e.code === 'KeyR') atmo.toggleRain();
  if (e.code === 'Backquote' || e.code === 'F3') {
    e.preventDefault();
    statsOn = !statsOn;
    statsEl.classList.toggle('on', statsOn);
  }
});

// ---- gamepad: left stick move, right stick look, A jump/fly, B or a trigger sprint, Start map ----
const pad = { x: 0, z: 0, lookX: 0, lookY: 0, jump: false, sprint: false, connected: false };
let padStartWas = false;
const dead = (v: number) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
function pollGamepad(): void {
  const gp = navigator.getGamepads?.().find((g) => g?.connected) ?? null;
  pad.connected = !!gp;
  if (!gp) {
    pad.x = pad.z = pad.lookX = pad.lookY = 0;
    pad.jump = pad.sprint = false;
    return;
  }
  const b = (i: number) => !!gp.buttons[i]?.pressed;
  pad.x = dead(gp.axes[0] ?? 0);
  pad.z = -dead(gp.axes[1] ?? 0);
  pad.lookX = dead(gp.axes[2] ?? 0);
  pad.lookY = dead(gp.axes[3] ?? 0);
  pad.jump = b(0);
  pad.sprint = b(1) || b(6) || b(7) || b(10);
  if (b(9) && !padStartWas) toggleMap();
  padStartWas = b(9);
  if (b(0) && !document.body.classList.contains('playing')) {
    document.body.classList.add('playing');
    sfx.init();
  }
}
initTouch(() => toggleMap());
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  camYaw -= e.movementX * 0.0025;
  camPitch = THREE.MathUtils.clamp(camPitch + e.movementY * 0.0025, 0.08, 1.2);
});
$('start').addEventListener('click', () => {
  document.body.classList.add('playing');
  canvas.requestPointerLock?.();
  sfx.init();
});
document.addEventListener('pointerlockchange', () => {
  // gamepad players never hold pointer lock, so don't kick them back to the title screen
  if (document.pointerLockElement !== canvas && !mapView?.open && !pad.connected && !touch.enabled) document.body.classList.remove('playing');
});
if (location.search.includes('shot')) document.body.classList.add('playing'); // skip the title overlay for screenshots

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  ink.resize();
}
addEventListener('resize', resize);
resize();

// ---- loop ----
const camPos = new THREE.Vector3();
const lookAt = new THREE.Vector3();
const camDir = new THREE.Vector3();
let last = performance.now();
let lastWeather = 0;
const two = (n: number) => String(n).padStart(2, '0');
const camDist = Number(new URLSearchParams(location.search).get('dist') ?? 2.7);
const BASE_FOV = 60;
let stepT = 0;
let lastFuel = '', lastClock = '', lastWx = '';

/** Pull the camera in front of any wall between it and the rat. */
const aerial = new URLSearchParams(location.search).has('aerial'); // debug: whole-map view, no fog, no wall clipping
if (aerial) {
  camera.far = 2000;
  camera.updateProjectionMatrix();
}
function clipCamera(from: THREE.Vector3, to: THREE.Vector3): void {
  if (aerial) return;
  camDir.copy(to).sub(from);
  const full = camDir.length();
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (world.collider.solidAt(from.x + camDir.x * t, from.y + camDir.y * t, from.z + camDir.z * t, 0.15)) {
      // keep the camera at least 0.7 m out
      const keep = Math.max(0.7 / Math.max(full, 1e-3), (i - 1) / steps);
      to.copy(from).addScaledVector(camDir, Math.min(1, keep));
      return;
    }
  }
}

let simTime = 0;
function frame(now: number) {
  const rawDt = Math.max(0, (now - last) / 1000); // rAF's timestamp can precede performance.now() on frame 1
  const realDt = Math.min(0.05, rawDt); // simulation step is clamped; stats + resolution tuning use the true frame time
  last = now;
  renderer.info.reset();
  const cpu0 = performance.now();
  pollGamepad();
  if (mapView?.open) {
    mapView.draw(rat.pos.x, rat.pos.z, camYaw, mapMarks());
    requestAnimationFrame(frame);
    return;
  }
  // near misses briefly slow the world down (the camera and HUD stay on real time)
  const dt = slowmo > 0 ? realDt * 0.3 : realDt;
  slowmo = Math.max(0, slowmo - realDt);
  simTime += dt;
  const t = simTime;

  if (keys.has('KeyQ')) camYaw += realDt * 1.8;
  if (keys.has('KeyE')) camYaw -= realDt * 1.8;
  camYaw -= touch.lookDX * 0.005;
  camPitch = THREE.MathUtils.clamp(camPitch + touch.lookDY * 0.004, 0.08, 1.2);
  touch.lookDX = touch.lookDY = 0;
  camYaw -= pad.lookX * realDt * 2.6;
  camPitch = THREE.MathUtils.clamp(camPitch + pad.lookY * realDt * 1.6, 0.08, 1.2);

  world.signals.update(t);
  world.powerLines?.update(dt, t, rat.pos);
  world.plants?.update(t);
  atmo.update(dt, rat.pos, camera, t);
  if (aerial) {
    (scene.fog as THREE.Fog).near = 1e5;
    (scene.fog as THREE.Fog).far = 2e5;
  }
  const env = atmo.env;

  rat.update(
    dt,
    {
      x: THREE.MathUtils.clamp((keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + pad.x + touch.x, -1, 1),
      z: THREE.MathUtils.clamp((keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) + pad.z + touch.z, -1, 1),
      sprint: keys.has('ShiftLeft') || keys.has('ShiftRight') || pad.sprint || touch.sprint,
      jump: keys.has('Space') || pad.jump || touch.jump,
    },
    camYaw,
    level,
  );
  if (rat.jumped) {
    rat.jumped = false;
    sfx.squeak();
  }
  // paw patter: one step per ~0.5 m on the ground
  if (rat.grounded && rat.mode === 'walk' && rat.speed > 0.6) {
    stepT -= rat.speed * dt;
    if (stepT <= 0) {
      stepT = 0.5;
      sfx.footstep(env.rain);
    }
  }
  sfx.setWind(rat.flying ? 1 : rat.grounded ? 0 : Math.min(1, Math.abs(rat.vy) / 20));

  // ---- cats ----
  const sight = 9 + 5 * env.night - 4 * env.rain;
  for (const cat of cats) {
    const was = cat.state;
    if (cat.update(dt, rat, world.collider, { sight, night: env.night })) takeHit(cat.pos.x, cat.pos.z, 'CAT!');
    if (was !== 'alert' && cat.state === 'alert') {
      sfx.hiss();
      sfx.sting();
    }
  }

  setCarNight(env.night);
  // ---- cars + pedestrians: many exist, but only those near the rat are shown and simulated ----
  // (off-screen agents freeze in place; hysteresis stops them flickering at the edge)
  const near = (p: THREE.Vector3, r: number, on: boolean) => {
    const d = Math.hypot(p.x - rat.pos.x, p.z - rat.pos.z);
    return d < (on ? r * 1.15 : r);
  };
  fleet.cars.forEach((c) => {
    const on = near(c.pos, CAR_RADIUS, c.active);
    c.setActive(on);
    if (on && c.update(dt, rat)) {
      sfx.stomp();
      takeHit(c.pos.x, c.pos.z, 'RUN OVER!');
    }
  });

  humans.forEach((h) => {
    h.setActive(near(h.pos, PED_RADIUS, h.active));
    if (h.update(dt, rat, t, env)) {
      sfx.stomp();
      takeHit(h.pos.x, h.pos.z, 'STOMPED!');
    }
  });

  // ---- the judges are watching ----
  for (const v of judges.update(dt, rat, fleet.cars, cats)) {
    if (v.name === 'NEAR MISS') {
      sfx.whoosh();
      slowmo = 0.35 + v.quality * 0.35;
    }
    showVerdict(v);
  }

  // ---- cheese: bob, spin, pick up ----
  for (const c of world.cheese) {
    if (c.state !== 'free') continue;
    c.mesh.rotation.y += dt * 2;
    c.mesh.position.y = c.baseY + Math.sin(t * 2 + c.mesh.position.x) * 0.05;
    const dx = c.mesh.position.x - rat.pos.x;
    const dz = c.mesh.position.z - rat.pos.z;
    const dy = c.mesh.position.y - (rat.pos.y + 0.15);
    if (dx * dx + dz * dz + dy * dy < 0.3) {
      c.state = 'carried';
      c.mesh.visible = false;
      carried++;
      sfx.pickup();
      drawCounts();
    }
  }

  // ---- the nest: stand on the manhole to bank what you're carrying ----
  const nd = Math.hypot(rat.pos.x - world.nest.x, rat.pos.z - world.nest.z);
  if (nd < 0.9 && rat.pos.y < 0.5 && carried > 0) {
    banked += carried;
    for (const c of world.cheese) if (c.state === 'carried') c.state = 'banked';
    toast(`+${carried} CHEESE IN THE NEST`);
    showVerdict(judges.haul(carried));
    carried = 0;
    if (hearts < MAX_HEARTS) hearts++;
    sfx.bank();
    drawHearts();
    drawCounts();
    if (banked >= TOTAL_CHEESE && !won) {
      won = true;
      toast("AMERICA'S NEXT TOP RAT", 8);
      rat.crown();
      sfx.fanfare();
    }
  }
  const pulse = 1 + Math.sin(t * 3) * 0.05;
  world.beacon.scale.set(pulse, 1, pulse);

  // ---- HUD ----
  // (only touch the DOM when a value actually changes: style writes every frame cost layout time)
  const fuel = `${Math.round((rat.fuel / MAX_FUEL) * 100)}%`;
  if (fuel !== lastFuel) $('fuelbar').style.width = lastFuel = fuel;
  if (toastTimer > 0 && (toastTimer -= realDt) <= 0) $('toast').classList.remove('on');
  if (judgeTimer > 0 && (judgeTimer -= realDt) <= 0) $('judges').classList.remove('on');
  const hh = Math.floor(env.hour), mm = Math.floor((env.hour % 1) * 60);
  const clock = `${two(hh)}:${two(mm)}`;
  if (clock !== lastClock) $('time').textContent = lastClock = clock;
  const wx = env.rain > 0.5 ? 'RAIN' : env.rain > 0.1 ? 'DRIZZLE' : env.night > 0.5 ? 'CLEAR NIGHT' : 'CLEAR';
  if (wx !== lastWx) $('wx').textContent = lastWx = wx;
  if (t - lastWeather > 0.25) {
    lastWeather = t;
    sfx.setRain(env.rain);
    sfx.setCity(1 - 0.75 * env.night);
  }
  if (env.flash > 0.97) setTimeout(() => sfx.thunder(), 300 + Math.random() * 900);

  // ---- follow camera (orbit behind the rat, never inside a wall) ----
  const dist = camDist;
  lookAt.set(rat.pos.x, rat.pos.y + 0.28 + debugLift, rat.pos.z);
  camPos.set(
    lookAt.x + Math.sin(camYaw) * Math.cos(camPitch) * dist,
    lookAt.y + Math.sin(camPitch) * dist,
    lookAt.z + Math.cos(camYaw) * Math.cos(camPitch) * dist,
  );
  clipCamera(lookAt, camPos);
  if (camSnap) camera.position.copy(camPos);
  else camera.position.lerp(camPos, 1 - Math.exp(-realDt * 14));
  camSnap = false;
  // hits shake the camera (rotational: the rat stays centred)
  if (shake > 0.002) {
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    camera.position.z += (Math.random() - 0.5) * shake;
    shake *= Math.exp(-realDt * 7);
  }
  camera.lookAt(lookAt);
  // speed sells itself: widen the lens when sprinting or flying
  const fov = BASE_FOV + (rat.speed > 5.5 ? 5 : 0) + (rat.flying ? 8 : 0) - (slowmo > 0 ? 4 : 0);
  if (Math.abs(camera.fov - fov) > 0.05) {
    camera.fov += (fov - camera.fov) * (1 - Math.exp(-realDt * 5));
    camera.updateProjectionMatrix();
  }

  const cpu1 = performance.now();
  if (!aerial) cullChunks(camera.position, (scene.fog as THREE.Fog).far + 10);
  ink.render(scene, camera, t);
  const cpu2 = performance.now();
  if (statsOn) drawStats(Math.min(rawDt, 1), `cars ${fleet.cars.filter((c) => c.active).length}/${fleet.cars.length} · peds ${humans.filter((h) => h.active).length}/${humans.length}`, cpu1 - cpu0, cpu2 - cpu1);
  tuneResolution(Math.min(rawDt, 1));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
