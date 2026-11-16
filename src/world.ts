import * as THREE from 'three';
import { FacadeKit, loadStyled, texBox } from './facade';
import { Props, propBox } from './props';
import { TrafficSignals } from './signals';
import { StreetLamps } from './streetlamps';
import { BoxCollider, type Collider } from './collider';
import { SidewalkNet, type Net, type Node } from './human';
import type { Box } from './physics';
import type { ChunkedInstances } from './chunk';

export type { Box };

/** A drainpipe the rat can shin up. (x,z) is the pipe centre, (nx,nz) points from the wall out into the alley. */
export interface Pipe {
  x: number;
  z: number;
  nx: number;
  nz: number;
  top: number; // roof height
}

export interface Cheese {
  mesh: THREE.Object3D;
  baseY: number;
  state: 'free' | 'carried' | 'banked';
}

export interface Ring {
  cx: number;
  cz: number;
  half: number;
  c: number; // block grid column
  r: number; // block grid row
}

export interface World {
  group: THREE.Group;
  boxes: Box[];
  collider: Collider;
  pipes: Pipe[];
  cheese: Cheese[];
  spawn: THREE.Vector3;
  nest: THREE.Vector3;
  lamps: THREE.Vector3[];
  bulbMat: THREE.MeshBasicMaterial;
  windows: { mesh: THREE.InstancedMesh | ChunkedInstances; thr: number[] };
  propsReady?: Promise<void>; // every Poly Haven prop loaded and placed
  rings: Ring[]; // sidewalk loops the pedestrians walk (grid world)
  walkNet: Net; // pedestrian graph
  walkStarts: Node[]; // good places to start people
  osmCredit?: string;
  /** flat 2D layers for the pause-menu map, plus named places to jump to */
  map?: {
    bounds: { x0: number; x1: number; z0: number; z1: number };
    water: { pts: [number, number][]; lake: boolean }[];
    roads: { pts: [number, number][]; w: number; alley: boolean }[];
    buildings: [number, number][][];
    green: { pts: [number, number][]; forest: boolean }[];
    rails: [number, number][][];
    places: { name: string; x: number; z: number }[];
  };
  carRoads?: { pts: [number, number][]; w: number; oneway: boolean }[]; // drivable streets
  terrainAt?: (x: number, z: number) => number;
  catRoutes: THREE.Vector2[][]; // alley patrols
  beacon: THREE.Object3D;
  signals: TrafficSignals;
  powerLines?: { update: (dt: number, time: number, rat: THREE.Vector3) => void };
  plants?: { update: (t: number) => void };
  size: { w: number; d: number };
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 3-band gradient so MeshToonMaterial lights in flat steps. */
export function makeToonGradient(): THREE.DataTexture {
  const data = new Uint8Array([70, 70, 70, 255, 150, 150, 150, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// brick styles (see FacadeKit): a weighted pick, so most blocks are red/cream/slate and a few are grungy
const STYLES = [0, 0, 1, 2, 3, 4, 5, 5];
export const TOTAL_CHEESE = 20;

export function buildWorld(gradient: THREE.DataTexture): World {
  const rand = mulberry32(1337);
  const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)];
  const group = new THREE.Group();
  const boxes: Box[] = [];
  const pipes: Pipe[] = [];
  const lamps: THREE.Vector3[] = [];
  const rings: Ring[] = [];
  const catRoutes: THREE.Vector2[][] = [];

  const toon = (color: number) => new THREE.MeshToonMaterial({ color, gradientMap: gradient });
  const shadowed = <T extends THREE.Mesh>(m: T): T => {
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // ---- layout ----
  const COLS = 3, ROWS = 2;
  const SETBACK = 3.2; // sidewalk width: building line to curb
  const BLOCK = 26.8 + 2 * SETBACK; // block footprint (the buildings themselves stay 26.8 m deep)
  const STREET = 9; // street width between blocks
  const PITCH = BLOCK + STREET;
  const ALLEY = 3.2; // alley width through the middle of each block
  const totalW = COLS * PITCH + STREET;
  const totalD = ROWS * PITCH + STREET;

  // asphalt
  const asphalt = loadStyled('/textures/asphalt_02_diff_1k.jpg', { levels: 9, contrast: 0.2, sat: 0, blur: 5, recolor: 0x7e7e9a, gain: 1.3 });
  asphalt.repeat.set(totalW / 8, totalD / 8);
  const road = shadowed(new THREE.Mesh(new THREE.PlaneGeometry(totalW, totalD), new THREE.MeshToonMaterial({ color: 0xffffff, map: asphalt, gradientMap: gradient })));
  road.rotation.x = -Math.PI / 2;
  road.position.set(totalW / 2, 0, totalD / 2);
  group.add(road);

  // lane dashes
  const dashMat = toon(0xe6d9a8);
  const dashGeo = new THREE.PlaneGeometry(0.25, 2);
  const dashes: THREE.Matrix4[] = [];
  const m4 = new THREE.Matrix4();
  for (let c = 0; c <= COLS; c++) {
    const x = c * PITCH + STREET / 2;
    for (let z = 1; z < totalD - 1; z += 4) {
      m4.compose(new THREE.Vector3(x, 0.02, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), new THREE.Vector3(1, 1, 1));
      dashes.push(m4.clone());
    }
  }
  for (let r = 0; r <= ROWS; r++) {
    const z = r * PITCH + STREET / 2;
    for (let x = 1; x < totalW - 1; x += 4) {
      m4.compose(new THREE.Vector3(x, 0.02, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2)), new THREE.Vector3(1, 1, 1));
      dashes.push(m4.clone());
    }
  }
  const dashMesh = new THREE.InstancedMesh(dashGeo, dashMat, dashes.length);
  dashes.forEach((d, i) => dashMesh.setMatrixAt(i, d));
  group.add(dashMesh);

  // zebra crossings on every street arm that leaves an intersection
  {
    const along = new THREE.PlaneGeometry(3.0, 0.55); // bars for arms running along x
    const across = new THREE.PlaneGeometry(0.55, 3.0); // bars for arms running along z
    const xw: { m: THREE.Matrix4; ax: boolean }[] = [];
    const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    for (let i = 0; i <= COLS; i++) {
      for (let j = 0; j <= ROWS; j++) {
        const ix = i * PITCH + STREET / 2, iz = j * PITCH + STREET / 2;
        const arms: [number, number, boolean][] = [[1, 0, i < COLS], [-1, 0, i > 0], [0, 1, j < ROWS], [0, -1, j > 0]];
        for (const [dx, dz, ok] of arms) {
          if (!ok) continue;
          for (let k = -3; k <= 3; k++) {
            const px = ix + dx * (STREET / 2 + SETBACK / 2) + (dx === 0 ? k * 1.1 : 0);
            const pz = iz + dz * (STREET / 2 + SETBACK / 2) + (dz === 0 ? k * 1.1 : 0);
            xw.push({ m: new THREE.Matrix4().compose(new THREE.Vector3(px, 0.025, pz), flat, new THREE.Vector3(1, 1, 1)), ax: dx !== 0 });
          }
        }
      }
    }
    const zebra = toon(0xf2eee0);
    for (const ax of [true, false]) {
      const list = xw.filter((x) => x.ax === ax);
      const im = new THREE.InstancedMesh(ax ? along : across, zebra, list.length);
      list.forEach((x, n) => im.setMatrixAt(n, x.m));
      im.receiveShadow = true;
      group.add(im);
    }
  }

  const kit = new FacadeKit(gradient, rand);
  group.add(kit.group);
  const pavement = loadStyled('/textures/concrete_pavement_diff_1k.jpg', { levels: 5, contrast: 0.9, blur: 1.2, recolor: 0xd6cdc8, gain: 1.3 });
  const pavementMat = new THREE.MeshToonMaterial({ color: 0xffffff, map: pavement, gradientMap: gradient });

  const addBox = (cx: number, cz: number, w: number, h: number, d: number, color: number, y0 = 0, collide = true) => {
    const mesh = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toon(color)));
    mesh.position.set(cx, y0 + h / 2, cz);
    group.add(mesh);
    if (collide) boxes.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, top: y0 + h });
    return mesh;
  };

  const roofSpots: [number, number, number][] = [];
  const otherSpots: [number, number, number][] = [];
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfff1b0 });
  const props = new Props(gradient, bulbMat);
  const signals = new TrafficSignals(gradient);
  const streetLamps = new StreetLamps(gradient, bulbMat);
  const solid = (id: string, x: number, z: number, y0: number, scale: number, rotY = 0) => {
    props.place(group, id, { x, y: y0, z, rotY, scale });
    const b = propBox(id, x, z, y0, scale, rotY);
    boxes.push(b);
    return b;
  };

  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const x0 = STREET + c * PITCH;
      const z0 = STREET + r * PITCH;
      const cx = x0 + BLOCK / 2;
      const cz = z0 + BLOCK / 2;

      // sidewalk slab (a step up from the street)
      const slab = texBox(BLOCK, 0.22, BLOCK, 3, pavementMat);
      slab.position.set(cx, 0.11, cz);
      group.add(slab);
      boxes.push({ minX: cx - BLOCK / 2, maxX: cx + BLOCK / 2, minZ: cz - BLOCK / 2, maxZ: cz + BLOCK / 2, top: 0.22 });
      rings.push({ cx, cz, half: BLOCK / 2 - SETBACK / 2, c, r });

      // two buildings per block, split by a N-S alley
      const bw = (BLOCK - 2 * SETBACK - ALLEY) / 2;
      const bd = BLOCK - 2 * SETBACK;
      for (let s = 0; s < 2; s++) {
        const bx = cx + (s === 0 ? -1 : 1) * (ALLEY / 2 + bw / 2);
        const h = 9 + Math.floor(rand() * 5) * 3.5 + (c === 1 && r === 0 ? 8 : 0);
        // drainpipes up the alley wall (the rat can climb these); chosen first so windows can dodge them
        const nx = s === 0 ? 1 : -1;
        const slots = [-12.2, -5.2, 1.8, 8.4];
        const pipeZs = [0, 1].map(() => cz + slots.splice(Math.floor(rand() * slots.length), 1)[0]);

        const extra = kit.addBuilding({ cx: bx, cz, w: bw, d: bd, h, style: pick(STYLES), plinth: Math.floor(rand() * 4), alleyDir: nx as 1 | -1, pipeZs });
        boxes.push({ minX: bx - bw / 2, maxX: bx + bw / 2, minZ: cz - bd / 2, maxZ: cz + bd / 2, top: h }, ...extra);
        if (rand() < 0.7) roofSpots.push([bx + (rand() - 0.5) * 3, h, cz + (rand() - 0.5) * (bd - 10)]);

        const wallX = bx + nx * (bw / 2);
        for (const pz of pipeZs) {
          const px = wallX + nx * 0.12;
          const pipe = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, h, 8), toon(0x5a5f6a)));
          pipe.position.set(px, h / 2, pz);
          group.add(pipe);
          // brackets so it reads as a pipe, not a pole
          for (let k = 1; k < Math.floor(h / 3.5); k++) {
            const clamp = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.26), toon(0x3a3d46)));
            clamp.position.set(px - nx * 0.04, k * 3.5, pz);
            group.add(clamp);
          }
          pipes.push({ x: px, z: pz, nx, nz: 0, top: h });
        }
      }

      // alley clutter: dumpsters (primitive), Poly Haven crates / barrels / boxes / a tyre
      const zs = [cz - 9, cz - 2, cz + 6, cz + 11];
      zs.forEach((z, i) => {
        const side = i % 2 === 0 ? -1 : 1;
        const x = cx + side * (ALLEY / 2 - 0.9);
        if (i % 3 === 0) {
          addBox(x, z, 1.4, 1.1, 2.2, 0x2f6b4a, 0.22);
          addBox(x, z, 1.5, 0.12, 2.3, 0x24523a, 1.32, false);
          otherSpots.push([x, 1.32, z]);
        } else if (i % 3 === 1) {
          solid('wooden_crate_01', x, z, 0.22, 1.3, Math.PI / 2);
          const top = solid('plastic_crate_01', x, z, 0.22 + 0.35 * 1.3, 1.5, Math.PI / 2);
          otherSpots.push([x, top.top, z]);
        } else {
          solid('Barrel_01', x, z, 0.22, 1.3);
        }
      });
      solid('cardboard_box_01', cx - 0.7, cz + 12.9, 0.22, 1.3, rand() * Math.PI);
      solid('cardboard_box_01', cx + 0.9, cz - 12.9, 0.22, 1.3, rand() * Math.PI);
      solid('old_tyre', cx - ALLEY / 2 + 0.25, cz + 3.6, 0.22, 1.3, Math.PI / 2);

      // sidewalk furniture, kept on the outer 0.7 m so pedestrians (who walk 1 m in) don't clip it
      solid('fire_hydrant', x0 + 0.38, z0 + 5 + rand() * 8, 0.22, 1.3, Math.floor(rand() * 4) * (Math.PI / 2));
      solid('utility_box_01', x0 + 0.42, z0 + 21 + rand() * 6, 0.22, 1.2, Math.PI / 2);
      solid('metal_trash_can', x0 + BLOCK - 0.4, z0 + 4 + rand() * 8, 0.22, 1.0);
      solid('metal_trash_can', x0 + BLOCK - 0.4, z0 + 21 + rand() * 6, 0.22, 1.0);
      for (let k = 0; k < 3; k++) {
        const bx = x0 + 4 + k * 8 + rand() * 4;
        const bag = solid('trashbag', bx, z0 + BLOCK - 0.42, 0.22, 1.0, rand() * 6);
        if (k === 0) otherSpots.push([bx, bag.top, z0 + BLOCK - 0.42]);
      }

      // street lamps stand on the sidewalk, one on each curb, arms reaching over the street
      const ll = 0.7; // distance in from the curb
      ([
        [x0 + BLOCK * 0.3, z0 + ll, Math.PI / 2], // north curb
        [x0 + BLOCK * 0.7, z0 + BLOCK - ll, -Math.PI / 2], // south curb
        [x0 + ll, z0 + BLOCK * 0.5, Math.PI], // west curb
        [x0 + BLOCK - ll, z0 + BLOCK * 0.5, 0], // east curb
      ] as [number, number, number][]).forEach(([lx, lz, rot]) => {
        lamps.push(streetLamps.add(lx, 0, lz, rot, { h: 6.2, banner: true }));
      });

      // traffic signals on all four corners (poles stand 0.7 m in from both curbs)
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        signals.addPole(sx < 0 ? x0 + 0.7 : x0 + BLOCK - 0.7, sz < 0 ? z0 + 0.7 : z0 + BLOCK - 0.7, sx, sz);
      }
    }
  }
  signals.finish();
  group.add(signals.group);
  streetLamps.finish();
  group.add(streetLamps.group);

  // cat patrols run the length of each alley column, straight through the cross streets
  for (let c = 0; c < COLS; c++) {
    const x = STREET + c * PITCH + BLOCK / 2;
    catRoutes.push([new THREE.Vector2(x, 3), new THREE.Vector2(x, totalD / 2), new THREE.Vector2(x, totalD - 3), new THREE.Vector2(x, totalD / 2)]);
  }

  const windows = kit.finish();

  // ---- nest: a manhole at the middle intersection, with a light beam so you can find it from rooftops ----
  const spawn = new THREE.Vector3(STREET / 2 + PITCH, 0, STREET / 2 + PITCH);
  const nest = spawn.clone();
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.05, 20), toon(0x2b2b33));
  lid.position.set(nest.x, 0.03, nest.z);
  lid.receiveShadow = true;
  group.add(lid);
  const ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.58, 0.72, 28), new THREE.MeshBasicMaterial({ color: 0x8fe39a }));
  ringMesh.rotation.x = -Math.PI / 2;
  ringMesh.position.set(nest.x, 0.06, nest.z);
  group.add(ringMesh);
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.45, 40, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x8fe39a, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
  );
  beacon.position.set(nest.x, 20, nest.z);
  group.add(beacon);

  // ---- cheese: 4 on rooftops (the hard ones), the rest in alleys, on dumpsters and in the street ----
  for (let i = 0; i < 6; i++) {
    otherSpots.push([STREET / 2 + rand() * (totalW - STREET), 0, STREET / 2 + Math.floor(rand() * (ROWS + 1)) * PITCH]);
  }
  const shuffle = <T,>(a: T[]): T[] => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const roofPick = shuffle(roofSpots).slice(0, 4);
  const spots = [...roofPick, ...shuffle(otherSpots).slice(0, TOTAL_CHEESE - roofPick.length)];
  const cheese: Cheese[] = [];
  const placeholderGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.12, 3);
  const placeholderMat = new THREE.MeshToonMaterial({ color: 0xffd23a, gradientMap: gradient, emissive: 0x6a4a00 });
  for (const [x, surface, z] of spots) {
    const holder = new THREE.Group();
    const y = surface + 0.12; // hovers a little above whatever it sits on
    holder.position.set(x, y, z);
    const ph = new THREE.Mesh(placeholderGeo, placeholderMat); // shown until the Poly Haven cheese box arrives
    ph.castShadow = true;
    holder.add(ph);
    group.add(holder);
    props.place(holder, 'CheeseBox_01', { x: 0, y: -0.04, z: 0, scale: 2.2, emissive: 0xa07a10, replace: ph });
    cheese.push({ mesh: holder, baseY: y, state: 'free' });
  }

  const walkNet = new SidewalkNet(rings);
  const walkStarts: Node[] = rings.flatMap((r) => [0, 1, 2, 3].map((k) => ({ c: r.c, r: r.r, k })));

  return {
    group,
    boxes,
    collider: new BoxCollider(boxes),
    pipes,
    cheese,
    spawn,
    nest,
    lamps,
    bulbMat,
    windows,
    propsReady: props.ready(),
    rings,
    walkNet,
    walkStarts,
    catRoutes,
    beacon,
    signals,
    size: { w: totalW, d: totalD },
  };
}
