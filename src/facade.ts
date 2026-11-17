import * as THREE from 'three';
import { asset } from './asset';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeMural, makeSign, SHOP_NAMES } from './paint';
import type { Box } from './physics';

/**
 * Poly Haven photo textures, flattened toward a hand-painted look: slight blur + posterised channels,
 * so the brick courses read as graphic marks rather than photo noise. The returned texture is usable
 * immediately; it fills in once the image arrives.
 */
export function loadStyled(url: string, opts: { size?: number; levels?: number; contrast?: number; sat?: number; blur?: number; recolor?: number; gain?: number; seams?: boolean } = {}): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.Texture(); // node (tests)
  url = asset(url);
  const { size = 512, levels = 6, contrast = 1.15, sat = 0.9, blur = 0.7, recolor, gain = 1, seams = false } = opts;
  const rgb = recolor === undefined ? null : [((recolor >> 16) & 255) / 255, ((recolor >> 8) & 255) / 255, (recolor & 255) / 255];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#9a8a80';
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const img = new Image();
  img.onload = () => {
    ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(img, 0, 0, size, size);
    ctx.filter = 'none';
    const data = ctx.getImageData(0, 0, size, size);
    const px = data.data;
    const L = levels - 1;
    for (let i = 0; i < px.length; i += 4) {
      const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
      for (let c = 0; c < 3; c++) {
        let v = px[i + c] / 255;
        v = lum + (v - lum) * sat; // desaturate a touch
        v = (v - 0.5) * contrast + 0.5;
        v = Math.max(0, Math.min(1, v));
        px[i + c] = Math.round(v * L) / L * 255;
      }
      if (rgb) {
        // keep the texture's light/dark pattern, take the palette from `recolor`
        const l = Math.min(1, ((px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255) * gain);
        for (let c = 0; c < 3; c++) px[i + c] = Math.min(255, l * rgb[c] * 255 * 1.25);
      }
    }
    ctx.putImageData(data, 0, 0);
    if (seams) {
      // vertical panel joints: one per texture repeat, like the plinth in the reference
      ctx.fillStyle = 'rgba(46, 34, 56, 0.55)';
      ctx.fillRect(0, 0, Math.max(3, size / 100), size);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.fillRect(Math.max(3, size / 100), 0, 2, size);
    }
    tex.needsUpdate = true;
  };
  img.src = url;
  return tex;
}

/** A box whose UVs are in world metres (one texture repeat = `tile` m), with an optional per-face offset. */
export function texBox(w: number, h: number, d: number, tile: number, mat: THREE.Material | THREE.Material[], du = 0, dv = 0): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]; // +x -x +y -y +z -z
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / tile + du, (uv.getY(i) * dims[f][1]) / tile + dv);
    }
  }
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export interface BuildingSpec {
  cx: number;
  cz: number;
  w: number; // x extent
  d: number; // z extent
  h: number; // roof height
  style: number; // brick style 0..5 (5 is the grungy one)
  plinth: number; // plinth colour 0..3
  alleyDir: 1 | -1; // which x side faces the alley (1: +x). Keep that side flush so pipes can climb it.
  pipeZs: number[]; // world z of drainpipes on the alley face: no windows there
}


/** A building with an arbitrary footprint (from OpenStreetMap). Points are in world metres, positive winding. */
export interface PolySpec {
  pts: [number, number][];
  baseY: number; // lowest ground under the building
  floors: number; // storeys above the ground floor level
  ground: 'shop' | 'res'; // shop: tall ground floor with shopfronts; res: raised basement + stoop
  style: number;
  plinth: number;
  /** per edge (edge i runs pts[i] -> pts[i+1]) */
  street: boolean[];
  alley: boolean[];
  party: boolean[]; // shares a wall with a neighbour: blank brick
  shopName: (string | null)[];
  /** per edge: metres from the wall to the iron fence round a front yard (0 = no yard). Residential street faces only. */
  yard?: number[];
  groundAt?: (x: number, z: number) => number; // terrain height, so yard fences and paths sit on the real ground
  seed: number;
}
/** A solid footprint (positive winding, outward normal of edge a->b is (dz, -dx)) the rat can bump into or stand on. */
export interface SolidShape {
  pts: [number, number][];
  top: number; // absolute height
}
export interface PolyResult {
  roofY: number;
  solids: SolidShape[]; // stoop steps and walls, yard fences
  pipes: { x: number; z: number; nx: number; nz: number; top: number }[];
}

const BASE = 0.22; // top of the sidewalk slab
const PLINTH = 3.4;
const WIN_W = 1.5;
const WIN_H = 2.0;
const PITCH_X = 3.0;
const PITCH_Y = 3.5;
const FENCE_H = 1.65; // front-yard iron fence: nearly pedestrian height
const PATH_TOP = 0.15; // yard path, just under the sidewalk slab (0.16)

/** Builds detailed building facades. Instanced windows/sills, merged stone trim. */
export class FacadeKit {
  readonly group = new THREE.Group();
  private brickStyles: THREE.Texture[];
  private brickTile = [12, 12, 12, 12, 12, 6];
  private plasters: THREE.Texture[];
  private murals: THREE.MeshToonMaterial[] = [];
  private frameMat: THREE.MeshToonMaterial;
  private roofTex: THREE.Texture;
  private toon: (c: number, map?: THREE.Texture) => THREE.MeshToonMaterial;
  private stoneMat: THREE.MeshToonMaterial;
  private stepMat: THREE.MeshToonMaterial;
  private doorMats: THREE.MeshToonMaterial[];
  private awningMats: THREE.MeshToonMaterial[];
  private metalMat: THREE.MeshToonMaterial;
  private ironMat: THREE.MeshToonMaterial;
  private pathMat: THREE.MeshToonMaterial;
  private jointMat: THREE.MeshToonMaterial;
  private batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private brickMats = new Map<string, THREE.MeshToonMaterial>();

  private glassXf: THREE.Matrix4[] = [];
  private frameXf: THREE.Matrix4[] = [];
  private sillXf: THREE.Matrix4[] = [];
  private thr: number[] = [];

  constructor(gradient: THREE.DataTexture, private rand: () => number) {
    const base = '/textures/';
    const b9 = base + 'brick_wall_09_diff_1k.jpg';
    const big = { size: 1024, levels: 7 };
    this.brickStyles = [
      loadStyled(b9, { ...big, contrast: 1.2 }), // red-brown
      loadStyled(b9, { ...big, contrast: 1.15, recolor: 0xe6d6ae, gain: 1.4 }), // cream
      loadStyled(b9, { ...big, contrast: 1.15, recolor: 0x8d9bb5, gain: 1.4 }), // slate blue
      loadStyled(b9, { ...big, contrast: 1.15, recolor: 0xe07a58, gain: 1.35 }), // terracotta
      loadStyled(b9, { ...big, contrast: 1.15, recolor: 0x8a5a52, gain: 1.3 }), // dark plum
      loadStyled(base + 'brick_wall_001_diffuse_1k.jpg', { size: 1024, levels: 6, contrast: 1.0, sat: 0.8, blur: 1.2 }), // worn
    ];
    this.plasters = [0xf0a5ac, 0x7fc2bd, 0xe6d9b0, 0xe0b24a].map((c) => loadStyled(base + 'beige_wall_001_diff_1k.jpg', { levels: 8, contrast: 1.1, recolor: c, gain: 1.15, seams: true }));
    this.roofTex = loadStyled(base + 'concrete_wall_004_diff_1k.jpg', { levels: 6, recolor: 0x948f88, gain: 1.3 });
    this.toon = (c, map) => new THREE.MeshToonMaterial({ color: c, gradientMap: gradient, map: map ?? null });
    this.stoneMat = this.toon(0xd6c9b2);
    this.stepMat = this.toon(0xffffff, loadStyled(base + 'concrete_wall_004_diff_1k.jpg', { size: 512, levels: 7, contrast: 1.2, recolor: 0xd4c8b0, gain: 1.55 }));
    this.metalMat = this.toon(0x5e6470);
    this.ironMat = this.toon(0x101114); // wrought-iron black
    this.pathMat = this.toon(0xe6e0d2); // plain concrete, matches the sidewalk slabs
    this.jointMat = this.toon(0x6f6a60);
    this.frameMat = this.toon(0x1d2236);
    for (let i = 0; i < 6; i++) this.murals.push(new THREE.MeshToonMaterial({ map: makeMural(i + 1), gradientMap: gradient }));
    this.doorMats = [0x2b2230, 0x1f3a4a, 0x4a2a2a, 0x2a3a2a].map((c) => this.toon(c));
    this.awningMats = [0xd94a3a, 0x2f7a8a, 0xe0b23a, 0x3a5aa8, 0xf0e6d0].map((c) => this.toon(c));
  }

  private brick(style: number): THREE.MeshToonMaterial {
    const key = String(style);
    let m = this.brickMats.get(key);
    if (!m) {
      m = this.toon(0xffffff, this.brickStyles[style]);
      this.brickMats.set(key, m);
    }
    return m;
  }

  /** Queue a box for merging with every other piece that shares its material. */
  private trim(mat: THREE.Material, w: number, h: number, d: number, m: THREE.Matrix4): void {
    const g = new THREE.BoxGeometry(w, h, d);
    g.applyMatrix4(m);
    let list = this.batches.get(mat);
    if (!list) this.batches.set(mat, (list = []));
    list.push(g);
  }

  /** A run of black iron fence along local x in [x0, x1]: posts with finials, rails, a picket every 0.2 m. About head height on a person. */
  private fence(at: (x: number, y: number, z: number) => THREE.Matrix4, x0: number, x1: number): void {
    const len = x1 - x0;
    if (len < 0.25) return;
    const H = FENCE_H, mat = this.ironMat;
    const mid = (x0 + x1) / 2;
    for (const y of [H - 0.12, H * 0.5, 0.28]) this.trim(mat, len, 0.05, 0.05, at(mid, y, 0)); // top, middle and bottom rails
    const posts = Math.max(1, Math.round(len / 2.4));
    for (let k = 0; k <= posts; k++) {
      const x = x0 + (len * k) / posts;
      this.trim(mat, 0.1, H + 0.1, 0.1, at(x, (H + 0.1) / 2, 0));
      this.trim(mat, 0.15, 0.08, 0.15, at(x, H + 0.14, 0)); // cap
    }
    const bars = Math.max(1, Math.floor(len / 0.2));
    for (let k = 0; k < bars; k++) {
      const x = x0 + (len * (k + 0.5)) / bars;
      this.trim(mat, 0.025, H - 0.05, 0.025, at(x, (H - 0.05) / 2, 0));
      this.trim(mat, 0.05, 0.08, 0.05, at(x, H + 0.02, 0)); // spear tip
    }
  }

  addBuilding(s: BuildingSpec): Box[] {
    const { cx, cz, w, d, h } = s;
    const colliders: Box[] = [];
    const rand = this.rand;
    const du = rand() * 4, dv = rand() * 4;
    const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

    // ---- walls: big-format brick above, coloured plaster plinth below, stone course between ----
    const wallH = h - 0.5 - BASE;
    const wall = texBox(w, wallH, d, this.brickTile[s.style], this.brick(s.style), du, dv);
    wall.position.set(cx, BASE + wallH / 2, cz);
    this.group.add(wall);

    const plinth = texBox(w + 0.2, PLINTH, d + 0.2, 2.4, this.toon(0xffffff, this.plasters[s.plinth % this.plasters.length]), du, dv);
    plinth.position.set(cx, BASE + PLINTH / 2, cz);
    this.group.add(plinth);
    this.trim(this.stoneMat, w + 0.4, 0.26, d + 0.4, T(cx, BASE + PLINTH + 0.13, cz));

    // ---- cornice (flush on the alley side so the pipes meet the roof cleanly) ----
    const ext = 0.32;
    const cornice = texBox(w + ext, 0.5, d + ext * 2, 2.6, [this.stoneMat, this.stoneMat, this.toon(0xffffff, this.roofTex), this.stoneMat, this.stoneMat, this.stoneMat]);
    cornice.position.set(cx - s.alleyDir * (ext / 2), h - 0.25, cz); // overhangs everywhere except the alley side
    this.group.add(cornice);

    // ---- a stone band at every storey break: gives the brick its big panel look ----
    const topY = h - 0.5;
    for (let y = BASE + PLINTH + 0.26 + 1.6 + PITCH_Y / 2; y < topY - 0.5; y += PITCH_Y) {
      this.trim(this.stoneMat, w + 0.14, 0.16, d + 0.14, T(cx, y, cz));
    }

    // ---- windows, pilasters, shopfronts, murals ----
    const faces: { nx: number; nz: number; ry: number; span: number; alley: boolean }[] = [
      { nx: 0, nz: 1, ry: 0, span: w, alley: false },
      { nx: 0, nz: -1, ry: Math.PI, span: w, alley: false },
      { nx: 1, nz: 0, ry: Math.PI / 2, span: d, alley: s.alleyDir === 1 },
      { nx: -1, nz: 0, ry: -Math.PI / 2, span: d, alley: s.alleyDir === -1 },
    ];
    const one = new THREE.Vector3(1, 1, 1);
    for (const f of faces) {
      const wallPos = new THREE.Vector3(cx + (f.nx * w) / 2, 0, cz + (f.nz * d) / 2);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, f.ry, 0));
      const alongX = f.nz !== 0; // faces on +/-z run along x
      const cols = Math.max(1, Math.floor((f.span - 1.8) / PITCH_X));
      const centre = (i: number) => (i - (cols - 1) / 2) * PITCH_X;

      // windows, one row per storey
      for (let y = BASE + PLINTH + 0.26 + 1.6; y + WIN_H / 2 + 0.9 < topY; y += PITCH_Y) {
        for (let i = 0; i < cols; i++) {
          const off = centre(i);
          const worldAlong = alongX ? wallPos.x + off : wallPos.z + off;
          if (f.alley && s.pipeZs.some((pz) => Math.abs(pz - worldAlong) < 1.3)) continue;
          const p = wallPos.clone();
          p.y = y;
          if (alongX) p.x += off;
          else p.z += off;
          const m = new THREE.Matrix4().compose(p, q, one);
          this.glassXf.push(m.clone().multiply(T(0, 0, 0.02)));
          this.frameXf.push(m.clone());
          const depth = f.alley ? 0.5 : 1; // shallower sills where drainpipes run
          this.sillXf.push(m.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(0, -WIN_H / 2 - 0.08, 0.12 * depth + 0.08), new THREE.Quaternion(), new THREE.Vector3(1, 1, depth))));
          const roll = rand();
          this.thr.push(roll < 0.07 ? -1 : roll < 0.65 ? rand() : 9); // a few always lit, most come on at night, some never
        }
      }

      // pilasters at the corners and between every second pair of windows (not on the alley face)
      if (!f.alley) {
        const offs = [-f.span / 2 + 0.3, f.span / 2 - 0.3];
        for (let i = 1; i < cols - 1; i += 2) offs.push((centre(i) + centre(i + 1)) / 2);
        for (const off of offs) {
          const p = wallPos.clone();
          p.y = (BASE + PLINTH + 0.26 + topY) / 2;
          if (alongX) p.x += off;
          else p.z += off;
          p.x += f.nx * 0.08;
          p.z += f.nz * 0.08;
          this.trim(this.stoneMat, 0.5, topY - (BASE + PLINTH + 0.26), 0.3, new THREE.Matrix4().compose(p, q, one));
        }
      }

      if (f.nz !== 0) {
        // ---- shopfront on the street faces: door, two display windows, lettered sign, striped awning ----
        const p = wallPos.clone();
        const dOff = (rand() - 0.5) * 3.2;
        p.x += dOff;
        const m = new THREE.Matrix4().compose(p, q, one);
        const L = (x: number, y: number, z: number) => m.clone().multiply(T(x, y, z));
        const doorMat = this.doorMats[Math.floor(rand() * this.doorMats.length)];
        this.trim(this.stoneMat, 2.1, 2.9, 0.1, L(0, BASE + 1.45, 0.12));
        this.trim(doorMat, 1.6, 2.6, 0.14, L(0, BASE + 1.3, 0.18));
        this.trim(this.metalMat, 0.08, 0.08, 0.1, L(0.55, BASE + 1.3, 0.28)); // handle

        // display windows either side of the door
        const SW = 2.4, SH = 1.8, SY = 1.85;
        for (const sx of [-1, 1]) {
          const ox = sx * 2.55;
          this.glassXf.push(m.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(ox, SY, 0.13), new THREE.Quaternion(), new THREE.Vector3((SW - 0.1) / (WIN_W - 0.06), (SH - 0.1) / (WIN_H - 0.06), 1))));
          this.thr.push(0.05 + rand() * 0.4); // shops light up early
          this.trim(this.frameMat, SW + 0.14, 0.12, 0.14, L(ox, SY + SH / 2, 0.17));
          this.trim(this.frameMat, SW + 0.14, 0.12, 0.14, L(ox, SY - SH / 2, 0.17));
          this.trim(this.frameMat, 0.12, SH, 0.14, L(ox - SW / 2, SY, 0.17));
          this.trim(this.frameMat, 0.12, SH, 0.14, L(ox + SW / 2, SY, 0.17));
          this.trim(this.frameMat, 0.08, SH, 0.1, L(ox, SY, 0.15));
          this.trim(this.stoneMat, SW + 0.4, 0.12, 0.3, L(ox, SY - SH / 2 - 0.1, 0.25)); // sill
        }

        // sign across the whole shop
        const name = SHOP_NAMES[Math.floor(rand() * SHOP_NAMES.length)];
        const signTex = makeSign(name, Math.floor(rand() * 8));
        const ink = new THREE.MeshBasicMaterial({ color: 0x14121c });
        const signMesh = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.5, 0.12), [ink, ink, ink, ink, new THREE.MeshBasicMaterial({ map: signTex }), ink]);
        m.clone().multiply(T(0, 3.35, 0.16)).decompose(signMesh.position, signMesh.quaternion, signMesh.scale);
        signMesh.castShadow = true;
        this.group.add(signMesh);

        const a = Math.floor(rand() * this.awningMats.length);
        const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.32, 0, 0));
        for (let k = 0; k < 6; k++) {
          const mat = this.awningMats[(a + (k % 2 ? 4 : 0)) % this.awningMats.length];
          const local = new THREE.Matrix4().compose(new THREE.Vector3((k - 2.5) * 0.5, 3.0, 0.7), tilt, one);
          this.trim(mat, 0.5, 0.08, 1.4, m.clone().multiply(local));
        }
      } else if (rand() < 0.8) {
        // ---- mural on the plinth of the side walls, in the widest gap between drainpipes ----
        const lo = cz - d / 2 + 0.6, hi = cz + d / 2 - 0.6;
        const zs = f.alley ? [...s.pipeZs].sort((a, b) => a - b) : [];
        const gaps: [number, number][] = [];
        let start = lo;
        for (const pz of zs) {
          gaps.push([start, pz - 0.9]);
          start = pz + 0.9;
        }
        gaps.push([start, hi]);
        const best = gaps.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
        const width = Math.min(best[1] - best[0], 6.5);
        if (width > 2.2) {
          const mural = new THREE.Mesh(new THREE.PlaneGeometry(width, 2.7), this.murals[Math.floor(rand() * this.murals.length)]);
          mural.position.set(wallPos.x + f.nx * 0.115, 2.0, (best[0] + best[1]) / 2);
          mural.quaternion.copy(q);
          mural.receiveShadow = true;
          this.group.add(mural);
        }
      }
    }

    // ---- rooftop kit: an AC unit and a chimney you can scramble onto ----
    const acX = cx + (rand() - 0.5) * (w - 4);
    const acZ = cz - d / 2 + 3.2;
    this.trim(this.metalMat, 2.2, 1.1, 1.6, T(acX, h + 0.55, acZ));
    this.trim(this.stoneMat, 2.3, 0.1, 1.7, T(acX, h + 1.15, acZ));
    colliders.push({ minX: acX - 1.1, maxX: acX + 1.1, minZ: acZ - 0.8, maxZ: acZ + 0.8, top: h + 1.1 });
    const chX = cx - s.alleyDir * (w / 2 - 1.2), chZ = cz + d / 2 - 1.5;
    this.trim(this.brick(s.style), 0.9, 2.4, 0.9, T(chX, h + 1.2, chZ));
    colliders.push({ minX: chX - 0.45, maxX: chX + 0.45, minZ: chZ - 0.45, maxZ: chZ + 0.45, top: h + 2.4 });
    return colliders;
  }


  // ------------------------------------------------------------------------------------------------
  // arbitrary footprints
  // ------------------------------------------------------------------------------------------------

  /** One wall quad on edge a->b between heights y0..y1, UVs in world metres, front face outward (n = right-hand normal). */
  private wallQuad(mat: THREE.Material, a: [number, number], b: [number, number], y0: number, y1: number, tile: number, u0: number, push = 0): void {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz);
    const nx = dz / L, nz = -dx / L;
    // a proud quad is also lengthened by `push`, so the wedge that opens at an outside corner is covered
    const ex = (dx / L) * push, ez = (dz / L) * push;
    const ax = a[0] + nx * push - ex, az = a[1] + nz * push - ez, bx = b[0] + nx * push + ex, bz = b[1] + nz * push + ez;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([nx, 0, nz, nx, 0, nz, nx, 0, nz, nx, 0, nz], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, y0 / tile, u0 + L / tile, y0 / tile, u0 + L / tile, y1 / tile, u0, y1 / tile], 2));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    let list = this.batches.get(mat);
    if (!list) this.batches.set(mat, (list = []));
    list.push(g);
  }

  private roofMat: THREE.MeshToonMaterial | null = null;

  addPoly(s: PolySpec): PolyResult {
    const rand = (() => {
      let x = s.seed >>> 0 || 1;
      return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    })();
    const pts = s.pts;
    const n = pts.length;
    const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
    const one = new THREE.Vector3(1, 1, 1);
    const result: PolyResult = { roofY: 0, pipes: [], solids: [] };

    /** footprint from four corners, wound the way the collider wants */
    const solid = (corners: [number, number][], top: number): void => {
      let a2 = 0;
      for (let k = 0; k < 4; k++) a2 += corners[k][0] * corners[(k + 1) % 4][1] - corners[(k + 1) % 4][0] * corners[k][1];
      result.solids.push({ pts: a2 < 0 ? [...corners].reverse() : corners, top });
    };
    const STOREY = 4.0;
    const plinthH = s.ground === 'shop' ? 3.8 : 1.5;
    const firstFloor = s.ground === 'shop' ? 1 : 0; // shop buildings: floor 0 is the shopfront storey
    const nUpper = s.ground === 'shop' ? s.floors - 1 : s.floors;
    const roofY = s.baseY + plinthH + Math.max(0, nUpper) * STOREY + 0.6;
    result.roofY = roofY;
    void firstFloor;
    const brickMat = this.brick(s.style);
    const plasterMat = this.toon(0xffffff, this.plasters[s.plinth % this.plasters.length]);
    const tile = this.brickTile[s.style];
    const wallBottom = s.baseY - 0.6; // dips below the lowest ground so slopes never show a gap
    const stoneBand = (a: [number, number], b: [number, number], y: number, h: number, depth: number, extend: number) => {
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
      const nx = dz / L, nz = -dx / L;
      const mx = (a[0] + b[0]) / 2 + nx * depth * 0.5, mz = (a[1] + b[1]) / 2 + nz * depth * 0.5;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(nx, nz), 0));
      this.trim(this.stoneMat, L + extend, h, depth, new THREE.Matrix4().compose(new THREE.Vector3(mx, y, mz), q, one));
    };

    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz);
      if (L < 0.01) continue;
      const dxn = dx / L, dzn = dz / L;
      const nx = dzn, nz = -dxn; // outward
      const ry = Math.atan2(nx, nz);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0));
      const u0 = rand() * 6;

      // wall + plinth + trim
      this.wallQuad(brickMat, a, b, wallBottom + plinthH, roofY - 0.5, tile, u0);
      this.wallQuad(plasterMat, a, b, wallBottom, s.baseY + plinthH, 2.4, u0, 0.1);
      if (L < 0.5) continue; // chamfered corners: wall only, no trim/windows
      stoneBand(a, b, s.baseY + plinthH + 0.13, 0.26, 0.4, 0.3); // course over the plinth
      stoneBand(a, b, roofY - 0.25, 0.5, 0.62, 0.4); // cornice
      for (let k = 1; k <= nUpper; k++) {
        const y = s.baseY + plinthH + k * STOREY - 0.05;
        if (y < roofY - 1.5) stoneBand(a, b, y, 0.16, 0.18, 0.1); // storey break
      }

      // drainpipes on alley walls: the rat's way up
      const pipeAt: number[] = [];
      if (s.alley[i] && L > 5) {
        const count = L > 11 ? 2 : 1;
        for (let k = 0; k < count; k++) pipeAt.push(((k + 0.5) / count) * L + (rand() - 0.5) * (L / count) * 0.5);
        for (const along of pipeAt) {
          const px = a[0] + dxn * along + nx * 0.12, pz = a[1] + dzn * along + nz * 0.12;
          result.pipes.push({ x: px, z: pz, nx, nz, top: roofY });
        }
      }

      // windows on every upper storey (not on shared walls)
      if (!s.party[i] && L > 2.5) {
        const cols = Math.max(1, Math.floor((L - 1.0) / PITCH_X));
        for (let f = 0; f < Math.max(0, nUpper); f++) {
          const y = s.baseY + plinthH + f * STOREY + STOREY * 0.5 + 0.1;
          for (let c = 0; c < cols; c++) {
            const along = L / 2 + (c - (cols - 1) / 2) * PITCH_X;
            if (pipeAt.some((p) => Math.abs(p - along) < 1.3)) continue;
            const m = new THREE.Matrix4().compose(new THREE.Vector3(a[0] + dxn * along, y, a[1] + dzn * along), q, one);
            this.glassXf.push(m.clone().multiply(T(0, 0, 0.02)));
            this.frameXf.push(m.clone());
            const depth = s.alley[i] ? 0.5 : 1;
            this.sillXf.push(m.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(0, -WIN_H / 2 - 0.08, 0.12 * depth + 0.08), new THREE.Quaternion(), new THREE.Vector3(1, 1, depth))));
            const roll = rand();
            this.thr.push(roll < 0.07 ? -1 : roll < 0.7 ? rand() : 9);
          }
        }
        // raised-basement windows on residential ground floors
        if (s.ground === 'res' && plinthH > 1.2 && !s.alley[i]) {
          for (let c = 0; c < cols; c++) {
            const along = L / 2 + (c - (cols - 1) / 2) * PITCH_X;
            const m = new THREE.Matrix4().compose(new THREE.Vector3(a[0] + dxn * along, s.baseY + 0.9, a[1] + dzn * along), q, one);
            this.trim(this.frameMat, 0.9, 0.5, 0.1, m.clone().multiply(T(0, 0, 0.14)));
          }
        }
      }

      // street faces: shopfront or stoop
      if (s.street[i] && !s.party[i] && L >= 4.5) {
        const base = new THREE.Vector3(a[0] + dxn * L / 2, s.baseY, a[1] + dzn * L / 2);
        const dOff = (rand() - 0.5) * Math.max(0, L - 8) * 0.5;
        base.x += dxn * dOff;
        base.z += dzn * dOff;
        const m = new THREE.Matrix4().compose(base, q, one);
        const Lm = (x: number, y: number, z: number) => m.clone().multiply(T(x, y, z));
        const doorMat = this.doorMats[Math.floor(rand() * this.doorMats.length)];
        const push = s.ground === 'shop' ? 0.1 : 0.1; // plinth is proud by 0.1
        if (s.ground === 'shop') {
          this.trim(this.stoneMat, 2.1, 2.9, 0.1, Lm(0, 1.45, push + 0.02));
          this.trim(doorMat, 1.6, 2.6, 0.14, Lm(0, 1.3, push + 0.08));
          const SW = 2.4, SH = 1.8, SY = 1.85;
          const sides = L >= 10 ? [-1, 1] : L >= 7 ? [1] : [];
          for (const sx of sides) {
            const ox = sx * 2.55;
            this.glassXf.push(m.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(ox, SY, push + 0.03), new THREE.Quaternion(), new THREE.Vector3((SW - 0.1) / (WIN_W - 0.06), (SH - 0.1) / (WIN_H - 0.06), 1))));
            this.thr.push(0.05 + rand() * 0.4);
            this.trim(this.frameMat, SW + 0.14, 0.12, 0.14, Lm(ox, SY + SH / 2, push + 0.07));
            this.trim(this.frameMat, SW + 0.14, 0.12, 0.14, Lm(ox, SY - SH / 2, push + 0.07));
            this.trim(this.frameMat, 0.12, SH, 0.14, Lm(ox - SW / 2, SY, push + 0.07));
            this.trim(this.frameMat, 0.12, SH, 0.14, Lm(ox + SW / 2, SY, push + 0.07));
            this.trim(this.frameMat, 0.08, SH, 0.1, Lm(ox, SY, push + 0.05));
            this.trim(this.stoneMat, SW + 0.4, 0.12, 0.3, Lm(ox, SY - SH / 2 - 0.1, push + 0.15));
          }
          const name = s.shopName[i] ?? SHOP_NAMES[Math.floor(rand() * SHOP_NAMES.length)];
          const sw = Math.min(L - 0.6, sides.length === 2 ? 5.2 : 3.6);
          const ink = new THREE.MeshBasicMaterial({ color: 0x14121c });
          const signMesh = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.5, 0.12), [ink, ink, ink, ink, new THREE.MeshBasicMaterial({ map: makeSign(name.toUpperCase().slice(0, 22), Math.floor(rand() * 8)) }), ink]);
          m.clone().multiply(T(0, 3.35, push + 0.06)).decompose(signMesh.position, signMesh.quaternion, signMesh.scale);
          signMesh.castShadow = true;
          this.group.add(signMesh);
          const a0 = Math.floor(rand() * this.awningMats.length);
          const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.32, 0, 0));
          for (let k = 0; k < 6; k++) {
            const mat = this.awningMats[(a0 + (k % 2 ? 4 : 0)) % this.awningMats.length];
            this.trim(mat, 0.5, 0.08, 1.4, m.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3((k - 2.5) * 0.5, 3.0, push + 0.6), tilt, one)));
          }
        } else {
          // residential: a stoop. A landing at the door, three treads down, stepped cheek walls and iron rails.
          const RISER = plinthH / 4, TREAD = 0.42, LAND = 0.95, SW = 2.1;
          const surround = this.stepMat;
          // door, framed in stone, with a transom, panels, a knob and a little canopy
          this.trim(surround, 2.3, 3.0, 0.14, Lm(0, plinthH + 1.5, push + 0.03));
          this.trim(this.frameMat, 1.34, 2.34, 0.1, Lm(0, plinthH + 1.2, push + 0.1));
          this.trim(doorMat, 1.2, 2.2, 0.14, Lm(0, plinthH + 1.1, push + 0.14));
          for (const py of [0.62, 1.6]) this.trim(this.frameMat, 0.84, 0.7, 0.05, Lm(0, plinthH + py, push + 0.22));
          this.trim(this.metalMat, 0.1, 0.1, 0.1, Lm(0.44, plinthH + 1.05, push + 0.26));
          this.trim(this.frameMat, 1.0, 0.36, 0.06, Lm(0, plinthH + 2.55, push + 0.12));
          this.trim(surround, 2.7, 0.14, 1.0, Lm(0, plinthH + 3.1, push + 0.5));
          for (const sx of [-1, 1]) this.trim(this.metalMat, 0.08, 0.4, 0.08, Lm(sx * 1.2, plinthH + 2.9, push + 0.92));
          // landing and treads
          this.trim(this.stepMat, SW + 0.2, plinthH, LAND, Lm(0, plinthH / 2, push + LAND / 2));
          for (let k = 0; k < 3; k++) {
            const top = plinthH - RISER * (k + 1);
            this.trim(this.stepMat, SW + (k === 0 ? 0.12 : 0), top, TREAD + 0.05, Lm(0, top / 2, push + LAND + TREAD * (k + 0.5)));
            this.trim(this.stoneMat, SW + 0.04, 0.05, 0.08, Lm(0, top + 0.01, push + LAND + TREAD * (k + 1) - 0.02)); // nosing
          }
          // cheek walls stepping down, and a rail along each side
          for (const sx of [-1, 1]) {
            const cx = sx * (SW / 2 + 0.12);
            this.trim(this.stepMat, 0.24, plinthH + 0.5, LAND, Lm(cx, (plinthH + 0.5) / 2, push + LAND / 2));
            for (let k = 0; k < 3; k++) {
              const top = plinthH - RISER * (k + 1) + 0.5;
              this.trim(this.stepMat, 0.24, top, TREAD + 0.05, Lm(cx, top / 2, push + LAND + TREAD * (k + 0.5)));
            }
            const y0 = plinthH + 0.5 + 0.95, y1 = plinthH - RISER * 3 + 0.5 + 0.95; // rail height at the landing and at the foot
            const z0 = push + LAND - 0.05, z1 = push + LAND + TREAD * 3 - 0.1;
            const len = Math.hypot(z1 - z0, y1 - y0), ang = Math.atan2(y0 - y1, z1 - z0);
            const rail = new THREE.Matrix4().compose(new THREE.Vector3(cx, (y0 + y1) / 2, (z0 + z1) / 2), new THREE.Quaternion().setFromEuler(new THREE.Euler(ang, 0, 0)), one);
            this.trim(this.metalMat, 0.06, 0.06, len, m.clone().multiply(rail));
            const mid = new THREE.Matrix4().compose(new THREE.Vector3(cx, (y0 + y1) / 2 - 0.4, (z0 + z1) / 2), new THREE.Quaternion().setFromEuler(new THREE.Euler(ang, 0, 0)), one);
            this.trim(this.metalMat, 0.04, 0.04, len, m.clone().multiply(mid));
            for (const [zz, yy] of [[z0, y0], [z1, y1]]) this.trim(this.metalMat, 0.07, 1.0, 0.07, Lm(cx, yy - 0.5, zz));
            for (let k = 0; k < 4; k++) {
              const t = (k + 0.5) / 4;
              this.trim(this.metalMat, 0.03, 0.85, 0.03, Lm(cx, y0 + (y1 - y0) * t - 0.5, z0 + (z1 - z0) * t));
            }
          }
          // collision for the stoop: a landing, a staircase the rat can scramble up (7 even risers, each within its
          // step-up reach, close to the drawn treads), and the cheek walls
          {
            const box = (lx: number, lz: number, w: number, d: number, h: number): void => {
              const c = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sz]) => {
                const v = new THREE.Vector3(lx + (sx * w) / 2, 0, lz + (sz * d) / 2).applyMatrix4(m);
                return [v.x, v.z] as [number, number];
              });
              solid(c, s.baseY + h);
            };
            box(0, push + LAND / 2, SW + 0.2, LAND, plinthH);
            const footZ = push + LAND + TREAD * 3, stepD = (TREAD * 3) / 6;
            for (let j = 0; j < 6; j++) box(0, footZ - (j + 0.5) * stepD, SW, stepD, (plinthH * (j + 1)) / 7);
            for (const sx of [-1, 1]) {
              const cx = sx * (SW / 2 + 0.12);
              box(cx, push + LAND / 2, 0.24, LAND, plinthH + 0.5);
              for (let k = 0; k < 3; k++) box(cx, push + LAND + TREAD * (k + 0.5), 0.24, TREAD + 0.05, plinthH - RISER * (k + 1) + 0.5);
            }
          }
          // front yard: an iron fence along the edge with a gate at the stoop, and a path from gate to steps
          const yd = s.yard?.[i] ?? 0;
          if (yd > 0) {
            const gx = dOff, GATE = 1.7;
            const gnd = (x: number, z: number) => (s.groundAt ? s.groundAt(x, z) : s.baseY);
            const cx0 = a[0] + dxn * (L / 2) + nx * yd, cz0 = a[1] + dzn * (L / 2) + nz * yd;
            const fy = gnd(cx0, cz0) - 0.05; // fence stands on the ground at its midpoint
            const at = (x: number, y: number, z: number) => new THREE.Matrix4().compose(
              new THREE.Vector3(a[0] + dxn * (L / 2 + x) + nx * yd, fy + y, a[1] + dzn * (L / 2 + x) + nz * yd), q, one).multiply(T(0, 0, z));
            this.fence(at, -L / 2, Math.min(L / 2, gx - GATE / 2));
            this.fence(at, Math.max(-L / 2, gx + GATE / 2), L / 2);
            // fence collision: a thin wall for each run, with the gate left open (top is the spear tips)
            const wall = (x0: number, x1: number): void => {
              if (x1 - x0 < 0.25) return;
              const P = (x: number, o: number): [number, number] => [a[0] + dxn * (L / 2 + x) + nx * (yd + o), a[1] + dzn * (L / 2 + x) + nz * (yd + o)];
              solid([P(x0, -0.07), P(x1, -0.07), P(x1, 0.07), P(x0, 0.07)], fy + FENCE_H + 0.1);
            };
            wall(-L / 2, Math.min(L / 2, gx - GATE / 2));
            wall(Math.max(-L / 2, gx + GATE / 2), L / 2);
            for (const sx of [-1, 1]) {
              this.trim(this.ironMat, 0.14, FENCE_H + 0.2, 0.14, at(gx + sx * GATE / 2, (FENCE_H + 0.2) / 2, 0)); // gate posts
              this.trim(this.ironMat, 0.2, 0.1, 0.2, at(gx + sx * GATE / 2, FENCE_H + 0.25, 0));
            }
            // concrete path from the foot of the steps out through the gate to the sidewalk, with a joint every ~1.6 m.
            // Heights are local to the stoop frame (origin at baseY); the slab is deep so slopes never bury or float it.
            const foot = push + LAND + TREAD * 3 - 0.1, end = yd + 0.9;
            const plen = end - foot;
            const px = base.x + nx * (foot + plen / 2), pz = base.z + nz * (foot + plen / 2);
            const top = gnd(px, pz) - s.baseY + PATH_TOP;
            const bot = Math.min(0, top - PATH_TOP) - 0.4;
            const PW = 2.2; // wider than the gate, so the path flares out at the steps
            this.trim(this.pathMat, PW, top - bot, plen, Lm(0, (top + bot) / 2, (foot + end) / 2));
            for (const sx of [-1, 1]) this.trim(this.jointMat, 0.1, 0.02, plen, Lm(sx * (PW / 2 - 0.05), top + 0.004, (foot + end) / 2)); // dark edging
            const nj = Math.max(1, Math.round(plen / 1.6));
            for (let k = 1; k < nj; k++) this.trim(this.jointMat, PW, 0.01, 0.06, Lm(0, top + 0.006, foot + (plen * k) / nj));
          }
        }
      }
    }

    // roof: a flat cap
    const contour = pts.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const pos: number[] = [], uv: number[] = [];
    for (const p of pts) {
      pos.push(p[0], roofY - 0.02, p[1]);
      uv.push(p[0] / 4, p[1] / 4);
    }
    const roof = new THREE.BufferGeometry();
    roof.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    roof.setAttribute('normal', new THREE.Float32BufferAttribute(pts.flatMap(() => [0, 1, 0]), 3));
    roof.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    // triangulateShape winds for a y-up (x right, z toward viewer) plane: flip so faces point up
    roof.setIndex(tris.flatMap((t) => [t[0], t[2], t[1]]));
    if (!this.roofMat) this.roofMat = this.toon(0xffffff, this.roofTex);
    let list = this.batches.get(this.roofMat);
    if (!list) this.batches.set(this.roofMat, (list = []));
    list.push(roof);
    return result;
  }

  /** Bake the merged trim and the instanced window parts. Returns the glass mesh (the lights) and its thresholds. */
  finish(): { mesh: THREE.InstancedMesh; thr: number[]; pos: Float32Array } {
    for (const [mat, geos] of this.batches) {
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      geos.forEach((g) => g.dispose());
    }
    this.batches.clear();

    // window frame: outer ring + a cross of mullions, in one geometry
    const bar = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    const t = 0.13;
    const frameGeo = mergeGeometries([
      bar(WIN_W + t, t, 0.16, 0, WIN_H / 2, 0.08),
      bar(WIN_W + t, t, 0.16, 0, -WIN_H / 2, 0.08),
      bar(t, WIN_H, 0.16, -WIN_W / 2, 0, 0.08),
      bar(t, WIN_H, 0.16, WIN_W / 2, 0, 0.08),
      bar(0.08, WIN_H, 0.1, 0, 0, 0.05),
      bar(WIN_W, 0.08, 0.1, 0, 0.1, 0.05),
    ])!;
    const sillGeo = new THREE.BoxGeometry(WIN_W + 0.5, 0.14, 0.4);
    const glassGeo = new THREE.PlaneGeometry(WIN_W - 0.06, WIN_H - 0.06);

    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, xf: THREE.Matrix4[], shadows: boolean) => {
      const im = new THREE.InstancedMesh(geo, mat, xf.length);
      xf.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = shadows;
      im.receiveShadow = shadows;
      this.group.add(im);
      return im;
    };
    mk(frameGeo, this.frameMat, this.frameXf, true);
    mk(sillGeo, this.stoneMat, this.sillXf, true);
    const glass = mk(glassGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), this.glassXf, false);
    this.glassXf.forEach((_, i) => glass.setColorAt(i, new THREE.Color(0x232a3d)));
    // per window: world x, y, z of the pane and its outward normal (x, z), so lit windows can cast light
    const pos = new Float32Array(this.glassXf.length * 5);
    this.glassXf.forEach((m, i) => {
      const e = m.elements;
      pos.set([e[12], e[13], e[14], e[8], e[10]], i * 5);
    });
    return { mesh: glass, thr: this.thr, pos };
  }
}
