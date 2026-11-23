import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makePoly, type Poly } from './citycollider';
import type { Box } from './physics';

type P2 = [number, number];

export interface CourthouseCtx {
  x: number; // centre of the hall
  z: number;
  groundY: number;
  roofY: number; // top of the hall the facade kit built
  group: THREE.Group;
  gradient: THREE.DataTexture;
  addPoly: (p: Poly) => void;
  addBox: (b: Box) => void;
}

// the plan the generator lays down (metres from the centre): the hall is 40 x 26, with 16 m wide entrance
// pavilions standing 6 m proud on the north and south fronts
const PAVILION_Z = 19;
const PAVILION_HALF = 8;

const STONE = 0xe9e1cd, COLUMN = 0xf3eee0, DRUM = 0xe3d9c2, COPPER = 0x6fae98, GOLD = 0xd9b24a, STEP = 0xd8d0bc;

const octagon = (cx: number, cz: number, r: number): P2[] =>
  Array.from({ length: 8 }, (_, k) => [cx + Math.cos((k * Math.PI) / 4 + Math.PI / 8) * r, cz + Math.sin((k * Math.PI) / 4 + Math.PI / 8) * r] as P2);

function clockFace(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2b2a30';
  g.beginPath();
  g.arc(128, 128, 126, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#f6f0dc';
  g.beginPath();
  g.arc(128, 128, 112, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#2b2a30';
  for (let h = 0; h < 12; h++) {
    const a = (h / 12) * Math.PI * 2;
    g.lineWidth = h % 3 ? 4 : 9;
    g.beginPath();
    g.moveTo(128 + Math.sin(a) * 92, 128 - Math.cos(a) * 92);
    g.lineTo(128 + Math.sin(a) * 106, 128 - Math.cos(a) * 106);
    g.stroke();
  }
  // ten past ten
  const hand = (a: number, len: number, w: number) => {
    g.lineWidth = w;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(128, 128);
    g.lineTo(128 + Math.sin(a) * len, 128 - Math.cos(a) * len);
    g.stroke();
  };
  hand(((10 + 10 / 60) / 12) * Math.PI * 2, 58, 10);
  hand((10 / 60) * Math.PI * 2, 86, 6);
  g.fillStyle = '#2b2a30';
  g.beginPath();
  g.arc(128, 128, 8, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function cityFlag(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 192;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4efe0';
  g.fillRect(0, 0, 192, 128);
  // the river: a blue wave across the middle, and a gold star above it
  g.fillStyle = '#2d6fa8';
  g.beginPath();
  g.moveTo(0, 70);
  for (let x = 0; x <= 192; x += 4) g.lineTo(x, 70 + Math.sin(x / 24) * 8);
  for (let x = 192; x >= 0; x -= 4) g.lineTo(x, 92 + Math.sin(x / 24) * 8);
  g.fill();
  g.fillStyle = '#d9a21e';
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? 9 : 20, a = (k * Math.PI) / 5 - Math.PI / 2;
    g.lineTo(96 + Math.cos(a) * r, 38 + Math.sin(a) * r);
  }
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The courthouse's monumental parts, on top of the plain hall the facade kit built: columned porticos with
 * pediments over a flight of steps on the north and south fronts, and on the roof a drum with four clock faces, a
 * copper dome, a gilded lantern and the city flag. All of it is solid, and the lantern top is the best cheese spot in town.
 */
export function buildCourthouse(ctx: CourthouseCtx): { cheese: [number, number, number][] } {
  const { x: cx, z: cz, groundY: gy, roofY } = ctx;
  const toon = (c: number) => new THREE.MeshToonMaterial({ color: c, gradientMap: ctx.gradient });
  const parts = new Map<number, THREE.BufferGeometry[]>();
  const add = (color: number, g: THREE.BufferGeometry) => {
    const ni = g.index ? g.toNonIndexed() : g;
    ni.deleteAttribute('uv');
    let l = parts.get(color);
    if (!l) parts.set(color, (l = []));
    l.push(ni);
  };
  const box = (color: number, w: number, h: number, d: number, x: number, y: number, z: number, solid = true) => {
    add(color, new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z));
    if (solid) ctx.addBox({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top: y + h });
  };
  const cheese: [number, number, number][] = [];

  // ---- porticos: steps, six columns, entablature and pediment, on both fronts ----
  const hallH = roofY - gy;
  for (const side of [-1, 1]) {
    const face = cz + side * PAVILION_Z;
    const W = PAVILION_HALF * 2 + 2;
    // three steps up to a podium
    for (let k = 0; k < 3; k++) {
      const depth = 6.4 - k * 0.9;
      box(STEP, W + 2 - k * 0.8, 0.28 * (k + 1), depth, cx, gy, face + (side * depth) / 2);
    }
    const podY = gy + 0.84;
    const colZ = face + side * 4.6;
    const colH = Math.max(5, hallH - 2.8);
    for (let k = 0; k < 6; k++) {
      const x = cx - 7.5 + k * 3;
      add(COLUMN, new THREE.CylinderGeometry(0.5, 0.58, colH, 14).translate(x, podY + colH / 2, colZ));
      add(STONE, new THREE.BoxGeometry(1.4, 0.35, 1.4).translate(x, podY + 0.17, colZ)); // base
      add(STONE, new THREE.BoxGeometry(1.4, 0.35, 1.4).translate(x, podY + colH - 0.17, colZ)); // capital
      ctx.addBox({ minX: x - 0.55, maxX: x + 0.55, minZ: colZ - 0.55, maxZ: colZ + 0.55, top: podY + colH });
    }
    // entablature, from the pavilion face out over the columns
    const entY = podY + colH;
    const entD = 5.6;
    box(STONE, W, 1.3, entD, cx, entY, face + (side * entD) / 2);
    // pediment: a low triangle across the front
    const tri = new THREE.Shape([new THREE.Vector2(-W / 2, 0), new THREE.Vector2(W / 2, 0), new THREE.Vector2(0, 3.1)]);
    const ped = new THREE.ExtrudeGeometry(tri, { depth: entD, bevelEnabled: false });
    ped.translate(0, 0, -entD / 2);
    ped.translate(cx, entY + 1.3, face + (side * entD) / 2);
    add(STONE, ped);
    // stepped collision under the slopes, so the rat can scramble up to the apex
    for (let k = 0; k < 3; k++) {
      const w = W * (0.85 - k * 0.3);
      ctx.addBox({ minX: cx - w / 2, maxX: cx + w / 2, minZ: Math.min(face, face + side * entD), maxZ: Math.max(face, face + side * entD), top: entY + 1.3 + (k + 1) * 0.95 });
    }
    cheese.push([cx, entY + 1.3 + 2.0, face + side * entD * 0.5]);
  }

  // ---- the drum, the dome, the lantern ----
  const drumR = 7.2, drumH = 6.2;
  const base = roofY;
  box(STONE, 19, 1.6, 19, cx, base, cz); // a square plinth on the roof
  const drumY = base + 1.6;
  add(DRUM, new THREE.CylinderGeometry(drumR, drumR, drumH, 32).translate(cx, drumY + drumH / 2, cz));
  add(STONE, new THREE.CylinderGeometry(drumR + 0.45, drumR + 0.45, 0.6, 32).translate(cx, drumY + drumH - 0.3, cz)); // cornice
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2 + Math.PI / 16;
    add(COLUMN, new THREE.BoxGeometry(0.7, drumH - 0.8, 0.5).rotateY(-a).translate(cx + Math.cos(a) * (drumR + 0.2), drumY + (drumH - 0.8) / 2, cz + Math.sin(a) * (drumR + 0.2)));
  }
  ctx.addPoly(makePoly(octagon(cx, cz, drumR + 0.3), drumY + drumH));
  const domeY = drumY + drumH;
  const domeR = drumR + 0.2;
  add(COPPER, new THREE.SphereGeometry(domeR, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2).translate(cx, domeY, cz));
  // copper ribs
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const rib = new THREE.TorusGeometry(domeR + 0.02, 0.09, 4, 20, Math.PI / 2);
    rib.rotateY(Math.PI / 2).rotateY(a).translate(cx, domeY, cz);
    add(0x5a917d, rib);
  }
  // the dome as rings of steps for the collider
  for (let k = 1; k <= 5; k++) {
    const t = (k / 6) * (Math.PI / 2);
    ctx.addPoly(makePoly(octagon(cx, cz, domeR * Math.cos(t - Math.PI / 12)), domeY + domeR * Math.sin(t)));
  }
  const lanY = domeY + domeR - 0.25;
  add(STONE, new THREE.CylinderGeometry(1.9, 1.9, 0.4, 16).translate(cx, lanY + 0.2, cz));
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    add(COLUMN, new THREE.CylinderGeometry(0.14, 0.14, 2.4, 8).translate(cx + Math.cos(a) * 1.5, lanY + 0.4 + 1.2, cz + Math.sin(a) * 1.5));
  }
  add(GOLD, new THREE.CylinderGeometry(1.0, 1.0, 2.4, 12).translate(cx, lanY + 0.4 + 1.2, cz)); // the lamp room
  add(STONE, new THREE.CylinderGeometry(2.0, 2.0, 0.35, 16).translate(cx, lanY + 2.8 + 0.17, cz));
  add(GOLD, new THREE.SphereGeometry(1.9, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(cx, lanY + 3.15, cz));
  ctx.addPoly(makePoly(octagon(cx, cz, 1.95), lanY + 3.15 + 1.2));
  cheese.push([cx, lanY + 3.15 + 1.2, cz]);
  // flagpole and flag
  const poleY = lanY + 3.15 + 1.6;
  add(0x8a8d93, new THREE.CylinderGeometry(0.06, 0.08, 6, 6).translate(cx, poleY + 3, cz));
  add(GOLD, new THREE.SphereGeometry(0.18, 8, 6).translate(cx, poleY + 6.1, cz));
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.6, 8, 1), new THREE.MeshToonMaterial({ map: cityFlag(), gradientMap: ctx.gradient, side: THREE.DoubleSide }));
  {
    // a frozen ripple
    const pos = flag.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin((pos.getX(i) + 1.2) * 2.4) * 0.12 * ((pos.getX(i) + 1.2) / 2.4));
    flag.geometry.computeVertexNormals();
  }
  flag.position.set(cx + 1.25, poleY + 5.0, cz);
  ctx.group.add(flag);

  // clock faces on the drum, one to each point of the compass
  const faceMat = new THREE.MeshBasicMaterial({ map: clockFace() });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const m = new THREE.Mesh(new THREE.CircleGeometry(1.9, 32), faceMat);
    m.position.set(cx + Math.sin(a) * (drumR + 0.72), drumY + drumH * 0.52, cz + Math.cos(a) * (drumR + 0.72));
    m.rotation.y = a;
    ctx.group.add(m);
  }

  for (const [color, list] of parts) {
    const g = mergeGeometries(list, false);
    if (!g) continue;
    const mesh = new THREE.Mesh(g, toon(color));
    mesh.castShadow = mesh.receiveShadow = true;
    ctx.group.add(mesh);
  }
  return { cheese };
}
