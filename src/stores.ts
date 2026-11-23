import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Box } from './physics';
import { cube } from './transit';
import { PARKED_SIZE, parkedCars } from './cars';

type P2 = [number, number];
type Rect = [number, number, number, number]; // x0, z0, x1, z1
type Side = 'n' | 's' | 'e' | 'w';

export interface StoreSpec {
  kind: 'grocery' | 'gas';
  name: string;
  rect: Rect; // the building
  door: Side; // the wall with the entrance
  lot: Rect; // paved ground round it
  stalls?: Rect; // grocery: the parking rows
  canopy?: Rect; // gas: the canopy over the pumps
  islands?: Rect[];
  pumps?: P2[];
  pylon?: P2;
}

export interface StoreCtx {
  group: THREE.Group;
  gradient: THREE.DataTexture;
  /** ground under the lot (the paved surface, not the bare terrain) */
  lotAt: (x: number, z: number) => number;
  addBox: (b: Box) => void;
  rand: () => number;
}

type Spot = { x: number; y: number; z: number; yaw: number };

/** a Poly Haven prop for the city to place (on the paved lot), with its collider */
export interface PropReq { id: string; x: number; z: number; rot: number; scale: number }

export interface StoresBuilt {
  cheese: [number, number, number][];
  footprints: P2[][];
  cars: Spot[]; // parked in the lots and at the pumps
  props: PropReq[];
  lamps: { x: number; z: number; yaw: number }[]; // lot lights (the city's street lamp)
  doors: SlidingDoor[]; // the automatic doors: run updateDoors() every frame
}

// ------------------------------------------------------------------------------------------------
// canvas textures
// ------------------------------------------------------------------------------------------------

const texCache = new Map<string, THREE.CanvasTexture>();
function canvasTex(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, r: () => number) => void, repeat = false): THREE.CanvasTexture {
  let t = texCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  let seed = [...key].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  draw(c.getContext('2d')!, r);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  texCache.set(key, t);
  return t;
}

const PACK = ['#e8452e', '#f2c230', '#2f7a8a', '#3a5aa8', '#f08c3a', '#7bb04a', '#d94f8a', '#f4efe0', '#8a4a2a', '#1f6f8b', '#c8102e', '#ffd966'];
const WINE = ['#3a1e2a', '#2f4a2a', '#5a1a22', '#c9b27a', '#1f2a22', '#8a5a2a'];
const pick = <T,>(a: T[], r: () => number): T => a[Math.floor(r() * a.length)];

export type Goods = 'groceries' | 'snacks' | 'cereal' | 'canned' | 'household' | 'drinks' | 'candy' | 'wine';
type Shape = 'box' | 'can' | 'bag' | 'bottle' | 'jug';
/** what a shelf of each kind of goods holds: shapes with weights, and width / height ranges (height as a share of the bay) */
const GOODS: Record<Goods, { shapes: [Shape, number][]; w: [number, number]; h: [number, number]; rows: number; stack?: boolean }> = {
  groceries: { shapes: [['box', 0.5], ['can', 0.2], ['bottle', 0.15], ['bag', 0.15]], w: [14, 32], h: [0.4, 0.75], rows: 4 },
  snacks: { shapes: [['bag', 0.8], ['box', 0.2]], w: [18, 34], h: [0.55, 0.82], rows: 4 },
  cereal: { shapes: [['box', 1]], w: [22, 34], h: [0.72, 0.9], rows: 4 },
  canned: { shapes: [['can', 0.85], ['box', 0.15]], w: [12, 18], h: [0.32, 0.44], rows: 4, stack: true },
  household: { shapes: [['jug', 0.5], ['bottle', 0.3], ['box', 0.2]], w: [22, 40], h: [0.58, 0.86], rows: 4 },
  drinks: { shapes: [['bottle', 0.7], ['can', 0.3]], w: [10, 16], h: [0.62, 0.86], rows: 4 },
  candy: { shapes: [['box', 0.5], ['bag', 0.5]], w: [8, 14], h: [0.45, 0.72], rows: 5 },
  wine: { shapes: [['bottle', 1]], w: [10, 13], h: [0.8, 0.9], rows: 4 },
};

function drawItem(g: CanvasRenderingContext2D, shape: Shape, x: number, base: number, w: number, h: number, col: string, accent: string): void {
  const top = base - h;
  g.fillStyle = col;
  switch (shape) {
    case 'box':
      g.fillRect(x, top, w, h);
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.fillRect(x, top, w, 3); // lit top edge
      g.fillStyle = accent;
      g.beginPath();
      g.arc(x + w / 2, top + h * 0.38, Math.min(w, h) * 0.22, 0, 6.3); // the brand's logo
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.fillRect(x + 2, top + h * 0.68, w - 4, Math.max(2, h * 0.08)); // product name
      break;
    case 'can':
      g.beginPath();
      g.roundRect(x, top, w, h, 2);
      g.fill();
      g.fillStyle = accent;
      g.fillRect(x, top + h * 0.3, w, h * 0.4); // label band
      g.fillStyle = 'rgba(220,225,230,0.9)';
      g.fillRect(x + 1, top, w - 2, 2); // the rim
      g.fillRect(x + 1, base - 2, w - 2, 2);
      break;
    case 'bag': {
      g.beginPath(); // crimped top, puffed body
      g.moveTo(x + 1, top + 4);
      for (let k = 0; k <= 4; k++) g.lineTo(x + 1 + ((w - 2) * k) / 4, top + (k % 2 ? 0 : 4));
      g.lineTo(x + w, base - 3);
      g.quadraticCurveTo(x + w / 2, base + 1, x, base - 3);
      g.closePath();
      g.fill();
      g.fillStyle = accent;
      g.beginPath();
      g.ellipse(x + w / 2, top + h * 0.5, w * 0.34, h * 0.2, 0, 0, 6.3); // window onto the chips
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(x + 3, top + 6, 2, h * 0.6); // sheen on the foil
      break;
    }
    case 'bottle': {
      const nw = Math.max(3, w * 0.36);
      g.beginPath();
      g.roundRect(x + 1, top + h * 0.32, w - 2, h * 0.68, 3);
      g.fill();
      g.fillRect(x + (w - nw) / 2, top + 3, nw, h * 0.34); // neck
      g.fillStyle = accent;
      g.fillRect(x + (w - nw) / 2 - 0.5, top, nw + 1, 4); // cap
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.fillRect(x + 1, top + h * 0.52, w - 2, h * 0.2); // label
      g.fillStyle = 'rgba(255,255,255,0.3)';
      g.fillRect(x + 3, top + h * 0.36, 2, h * 0.55);
      break;
    }
    case 'jug':
      g.beginPath();
      g.roundRect(x + 1, top + 6, w - 2, h - 6, 5);
      g.fill();
      g.fillRect(x + w * 0.6, top, w * 0.25, 8); // spout
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x + w * 0.12, top + 10, w * 0.3, h * 0.18); // the handle's hole
      g.fillStyle = accent;
      g.fillRect(x + 3, top + h * 0.45, w - 6, h * 0.3);
      break;
  }
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(x + w - 2, top + 2, 2, h - 2); // shadow on the right
}

/** shelves of goods in their bays, with the shadowed back panel, the shelf edge and its price tags; tiles sideways */
function productTex(kind: Goods): THREE.CanvasTexture {
  return canvasTex(`products-${kind}`, 512, 256, (g, r) => {
    const spec = GOODS[kind];
    const bay = 256 / spec.rows;
    const shape = (): Shape => {
      let u = r();
      for (const [s, wgt] of spec.shapes) if ((u -= wgt) <= 0) return s;
      return spec.shapes[0][0];
    };
    for (let s = 0; s < spec.rows; s++) {
      const y0 = s * bay, base = y0 + bay - 8;
      const grd = g.createLinearGradient(0, y0, 0, base);
      grd.addColorStop(0, '#3e4248');
      grd.addColorStop(0.35, '#6a6e75');
      grd.addColorStop(1, '#8d9197');
      g.fillStyle = grd;
      g.fillRect(0, y0, 512, bay);
      g.fillStyle = 'rgba(30,32,36,0.35)'; // pegboard
      for (let px = 4; px < 512; px += 10) for (let py = y0 + 6; py < base - 4; py += 10) g.fillRect(px, py, 2, 2);
      let x = r() * 6;
      while (x < 512) {
        const col = kind === 'wine' ? pick(WINE, r) : pick(PACK, r);
        const accent = pick(PACK, r);
        const sh = shape();
        const w = spec.w[0] + r() * (spec.w[1] - spec.w[0]);
        const h = (spec.h[0] + r() * (spec.h[1] - spec.h[0])) * (bay - 10);
        const n = 2 + Math.floor(r() * 4); // facings of the same product
        for (let k = 0; k < n && x < 512; k++) {
          drawItem(g, sh, x, base, w, h, col, accent);
          if (spec.stack && h * 2 + 2 < bay - 10) drawItem(g, sh, x, base - h - 1, w, h, col, accent);
          x += w + 1;
        }
        x += 2 + r() * 3;
      }
      // shelf edge: a pale strip with its tags, yellow for what's on sale
      g.fillStyle = '#e4e6e9';
      g.fillRect(0, base, 512, 8);
      g.fillStyle = '#50555e';
      g.fillRect(0, base + 7, 512, 1);
      for (let tx = 4 + r() * 20; tx < 500; tx += 26 + r() * 40) {
        const sale = r() < 0.16;
        g.fillStyle = sale ? '#f6d43a' : '#ffffff';
        g.fillRect(tx, base + 1, 15, 6);
        g.fillStyle = sale ? '#c8102e' : '#30343a';
        g.fillRect(tx + 2, base + 3, 9, 2);
      }
    }
  }, true);
}

export type CoolerKind = 'drinks' | 'dairy' | 'cheese' | 'frozen' | 'beer';
/** a run of glass cooler doors, lit from inside, with what's on the wire shelves behind them; one door per 128 px */
function coolerTex(kind: CoolerKind): THREE.CanvasTexture {
  return canvasTex(`cooler-${kind}`, 512, 256, (g, r) => {
    const frozen = kind === 'frozen';
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, frozen ? '#f4fbff' : '#fbfdf6');
    grd.addColorStop(1, frozen ? '#c4dbe8' : '#d3e4ea');
    g.fillStyle = grd;
    g.fillRect(0, 0, 512, 256);
    for (let s = 0; s < 4; s++) {
      const y0 = 18 + s * 58, base = y0 + 50;
      let x = 6;
      while (x < 506) {
        if (kind === 'cheese') {
          g.fillStyle = pick(['#ffd23a', '#f6c022', '#ffe27a', '#f0a830', '#fff3c8'], r);
          if (r() < 0.5) {
            g.beginPath(); // a wedge
            g.moveTo(x, base);
            g.lineTo(x + 26, base);
            g.lineTo(x + 26, base - 22);
            g.closePath();
            g.fill();
            g.fillStyle = 'rgba(160,110,10,0.5)';
            g.beginPath();
            g.arc(x + 18, base - 6, 2.5, 0, 6.3);
            g.fill();
          } else {
            g.fillRect(x, base - 14, 26, 14); // a block in its wrapper
            g.fillStyle = pick(['#c8102e', '#2f6b4a', '#3a5aa8'], r);
            g.fillRect(x, base - 10, 26, 5);
          }
          x += 30;
        } else if (kind === 'dairy') {
          if (r() < 0.25) {
            g.fillStyle = '#f8f8f4'; // a gallon jug
            g.beginPath();
            g.roundRect(x, base - 40, 26, 40, 4);
            g.fill();
            g.fillStyle = pick(['#3a5aa8', '#e8452e', '#7bb04a', '#d94f8a'], r);
            g.fillRect(x + 2, base - 6, 22, 6);
            g.fillRect(x + 14, base - 46, 7, 6);
            x += 28;
          } else if (r() < 0.4) {
            g.fillStyle = pick(['#f4efe0', '#ffffff', '#f6d0d8'], r); // yoghurt tubs
            for (let k = 0; k < 2; k++) g.fillRect(x, base - 14 - k * 15, 16, 14);
            g.fillStyle = pick(PACK, r);
            g.fillRect(x, base - 33, 16, 4);
            x += 18;
          } else {
            g.fillStyle = r() < 0.6 ? '#ffffff' : pick(['#3a5aa8', '#e8452e', '#7bb04a'], r);
            g.fillRect(x, base - 36, 18, 36); // a carton
            g.beginPath();
            g.moveTo(x, base - 36);
            g.lineTo(x + 9, base - 44);
            g.lineTo(x + 18, base - 36);
            g.fill();
            g.fillStyle = '#3a5aa8';
            g.fillRect(x + 2, base - 24, 14, 8);
            x += 21;
          }
        } else if (kind === 'frozen') {
          if (r() < 0.5) {
            const col = pick(PACK, r); // flat boxes: pizzas, dinners
            for (let k = 0; k < 4; k++) {
              g.fillStyle = col;
              g.fillRect(x, base - 9 - k * 10, 40, 9);
              g.fillStyle = 'rgba(255,255,255,0.5)';
              g.fillRect(x + 4, base - 6 - k * 10, 18, 2);
            }
            x += 43;
          } else {
            g.fillStyle = pick(['#f4efe0', '#5a3a2a', '#f6d0d8', '#7bb04a', '#ffd966'], r); // ice cream tubs
            g.beginPath();
            g.roundRect(x, base - 26, 22, 26, 3);
            g.fill();
            g.fillStyle = pick(PACK, r);
            g.fillRect(x, base - 26, 22, 5);
            x += 24;
          }
        } else if (kind === 'beer') {
          if (s >= 2) {
            g.fillStyle = pick(['#c8102e', '#1f3a6a', '#f2c230', '#2f4a2a', '#e8e4da'], r); // 12-pack cases
            g.fillRect(x, base - 26, 44, 26);
            g.fillStyle = 'rgba(255,255,255,0.75)';
            g.fillRect(x + 4, base - 18, 24, 6);
            x += 46;
          } else {
            g.fillStyle = pick(['#5a3a14', '#2f4a2a', '#8a5a1a'], r); // brown and green bottles
            g.fillRect(x + 2, base - 32, 9, 32);
            g.fillRect(x + 4, base - 42, 5, 10);
            g.fillStyle = '#f4efe0';
            g.fillRect(x + 2, base - 22, 9, 8);
            x += 12;
          }
        } else {
          g.fillStyle = pick(PACK, r);
          g.fillRect(x + 2, base - 38, 9, 38); // a bottle
          g.fillRect(x + 4, base - 46, 5, 10);
          g.fillStyle = 'rgba(255,255,255,0.65)';
          g.fillRect(x + 2, base - 26, 9, 9);
          x += 13;
        }
      }
      g.fillStyle = '#8fa3ad'; // wire shelf, with the price rail
      g.fillRect(0, base, 512, 4);
      g.fillStyle = '#f4f6f8';
      for (let tx = 10; tx < 512; tx += 34) g.fillRect(tx, base + 1, 12, 3);
    }
    if (frozen) {
      g.fillStyle = 'rgba(255,255,255,0.16)'; // frost
      g.fillRect(0, 0, 512, 256);
    }
    // door frames, the LED strip down each mullion and the long handles
    for (let d = 0; d < 4; d++) {
      g.strokeStyle = '#2e3238';
      g.lineWidth = 8;
      g.strokeRect(d * 128 + 4, 4, 120, 248);
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.fillRect(d * 128 + 1, 8, 2, 240);
      g.fillStyle = '#c9ced4';
      g.fillRect(d * 128 + 108, 70, 6, 110);
      g.fillStyle = '#ffffff';
      g.fillRect(d * 128 + 10, 10, 24, 10); // the price sticker on the door
      g.fillStyle = '#c8102e';
      g.fillRect(d * 128 + 12, 13, 14, 4);
    }
    g.fillStyle = 'rgba(255,255,255,0.18)'; // glass sheen
    for (let d = 0; d < 4; d++) {
      g.beginPath();
      g.moveTo(d * 128 + 20, 250);
      g.lineTo(d * 128 + 60, 6);
      g.lineTo(d * 128 + 80, 6);
      g.lineTo(d * 128 + 40, 250);
      g.fill();
    }
  }, true);
}

/** vinyl composition tile: 8 x 8 tiles per repeat, each its own tone, chip-speckled, with the odd accent tile */
function floorTex(kind: 'grocery' | 'gas'): THREE.CanvasTexture {
  return canvasTex(`floor-${kind}`, 512, 512, (g, r) => {
    const T = 64;
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      let base: [number, number, number];
      if (kind === 'gas') base = (i + j) % 2 ? [214, 212, 206] : [150, 146, 140];
      else base = r() < 0.05 ? [178, 196, 184] : [232, 227, 216];
      const v = (r() - 0.5) * 10;
      g.fillStyle = `rgb(${base[0] + v},${base[1] + v},${base[2] + v})`;
      g.fillRect(i * T, j * T, T, T);
      for (let k = 0; k < 70; k++) {
        const dark = r() < 0.6;
        g.fillStyle = dark ? `rgba(70,64,58,${0.15 + r() * 0.25})` : `rgba(255,255,255,${0.2 + r() * 0.3})`;
        g.fillRect(i * T + r() * T, j * T + r() * T, 1 + r() * 2.5, 1 + r() * 1.5);
      }
    }
    // scuffs from carts and shoes, and the wax's sheen
    for (let k = 0; k < 14; k++) {
      g.strokeStyle = `rgba(40,36,32,${0.05 + r() * 0.08})`;
      g.lineWidth = 1 + r() * 2;
      const x = r() * 512, y = r() * 512;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 60, y + (r() - 0.5) * 20);
      g.stroke();
    }
    for (let k = 0; k < 8; k++) {
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.beginPath();
      g.ellipse(r() * 512, r() * 512, 80 + r() * 120, 30 + r() * 60, r() * 3, 0, 6.3);
      g.fill();
    }
    g.fillStyle = 'rgba(70,64,58,0.3)';
    for (let k = 0; k <= 8; k++) {
      g.fillRect(k * T - 0.5, 0, 1, 512);
      g.fillRect(0, k * T - 0.5, 512, 1);
    }
  }, true);
}

/** wood-look vinyl planks: the produce department's floor */
function woodTex(): THREE.CanvasTexture {
  return canvasTex('wood', 512, 512, (g, r) => {
    const P = 64; // plank width
    for (let i = 0; i < 8; i++) {
      let y = -r() * 300;
      while (y < 512) {
        const len = 180 + r() * 200;
        const t = 150 + Math.floor(r() * 40);
        g.fillStyle = `rgb(${t},${t * 0.72},${t * 0.48})`;
        g.fillRect(i * P, y, P, len);
        for (let k = 0; k < 9; k++) {
          g.strokeStyle = `rgba(${r() < 0.5 ? '70,44,24' : '230,200,160'},${0.12 + r() * 0.15})`;
          g.lineWidth = 1 + r() * 1.5;
          const gx = i * P + 4 + r() * (P - 8);
          g.beginPath();
          g.moveTo(gx, y);
          g.bezierCurveTo(gx + (r() - 0.5) * 10, y + len * 0.3, gx + (r() - 0.5) * 10, y + len * 0.7, gx + (r() - 0.5) * 6, y + len);
          g.stroke();
        }
        g.fillStyle = 'rgba(40,26,14,0.5)';
        g.fillRect(i * P, y, P, 1.5);
        y += len;
      }
      g.fillStyle = 'rgba(40,26,14,0.45)';
      g.fillRect(i * P, 0, 1.5, 512);
    }
  }, true);
}

/** a suspended ceiling: two by two 0.6 m tiles per repeat, fissured, in their white T-bar grid */
function ceilingTex(): THREE.CanvasTexture {
  return canvasTex('ceiling', 256, 256, (g, r) => {
    g.fillStyle = '#e6e3da';
    g.fillRect(0, 0, 256, 256);
    for (let k = 0; k < 900; k++) {
      g.fillStyle = `rgba(110,104,94,${0.1 + r() * 0.25})`;
      g.fillRect(r() * 256, r() * 256, 1 + r() * 3, 1);
    }
    g.fillStyle = '#f8f8f6';
    for (const p of [0, 128]) {
      g.fillRect(p, 0, 5, 256);
      g.fillRect(0, p, 256, 5);
    }
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (const p of [5, 133]) {
      g.fillRect(p, 0, 2, 256);
      g.fillRect(0, p, 256, 2);
    }
  }, true);
}

/** the hanging sign over an aisle: its number in a disc, and what's down it */
function aisleTex(n: number, a: string, b: string): THREE.CanvasTexture {
  return canvasTex(`aisle-${n}`, 512, 256, (g) => {
    g.fillStyle = '#1f4f36';
    g.fillRect(0, 0, 512, 256);
    g.strokeStyle = '#f4efe0';
    g.lineWidth = 6;
    g.strokeRect(8, 8, 496, 240);
    g.fillStyle = '#f2c230';
    g.beginPath();
    g.arc(104, 128, 72, 0, 6.3);
    g.fill();
    g.fillStyle = '#1f4f36';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '900 96px system-ui, sans-serif';
    g.fillText(String(n), 104, 134);
    g.fillStyle = '#ffffff';
    g.textAlign = 'left';
    g.font = '800 38px system-ui, sans-serif';
    g.fillText(a, 196, 96, 300);
    g.fillText(b, 196, 160, 300);
  });
}

/** checkout lane light: the lane's number, lit */
function laneTex(n: number, label = ''): THREE.CanvasTexture {
  return canvasTex(`lane-${n}-${label}`, 128, 128, (g) => {
    g.fillStyle = '#1f2128';
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#2f6fb0';
    g.beginPath();
    g.arc(64, 58, 46, 0, 6.3);
    g.fill();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 ${label ? 30 : 64}px system-ui, sans-serif`;
    g.fillText(label || String(n), 64, 62, 100);
    g.fillStyle = '#7fe0a0';
    g.font = '800 18px system-ui, sans-serif';
    g.fillText('OPEN', 64, 116);
  });
}

/** a backlit menu / price board: a title and rows of item and price */
function menuTex(title: string, rows: [string, string][], accent: string): THREE.CanvasTexture {
  return canvasTex(`menu-${title}`, 512, 256, (g) => {
    g.fillStyle = '#16181c';
    g.fillRect(0, 0, 512, 256);
    g.fillStyle = accent;
    g.fillRect(0, 0, 512, 58);
    g.fillStyle = '#ffffff';
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.font = '900 40px system-ui, sans-serif';
    g.fillText(title, 256, 31, 490);
    const cols = rows.length > 4 ? 2 : 1;
    const per = Math.ceil(rows.length / cols);
    rows.forEach(([item, price], i) => {
      const c = Math.floor(i / per), row = i % per;
      const x0 = 24 + (c * 512) / cols, x1 = ((c + 1) * 512) / cols - 24, y = 92 + row * ((256 - 80) / per);
      g.textAlign = 'left';
      g.fillStyle = '#f4efe0';
      g.font = '700 26px system-ui, sans-serif';
      g.fillText(item, x0, y, x1 - x0 - 90);
      g.textAlign = 'right';
      g.fillStyle = '#ffd23a';
      g.font = '800 28px ui-monospace, Menlo, monospace';
      g.fillText(price, x1, y);
    });
  });
}

/** a portrait window poster */
function posterTex(text: string, sub: string, bg: string, fg: string): THREE.CanvasTexture {
  return canvasTex(`poster-${text}-${bg}`, 256, 320, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 256, 320);
    g.fillStyle = fg;
    g.fillRect(12, 12, 232, 6);
    g.fillRect(12, 302, 232, 6);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const words = text.split(' ');
    const fs = words.length > 2 ? 54 : 70;
    g.font = `900 ${fs}px system-ui, sans-serif`;
    words.forEach((w, i) => g.fillText(w, 128, 110 + (i - (words.length - 1) / 2) * fs * 1.05, 230));
    g.font = '700 26px system-ui, sans-serif';
    g.fillText(sub, 128, 262, 230);
  });
}

/** the tobacco "power wall" behind a gas station counter: rows of packs in their slots */
function tobaccoTex(): THREE.CanvasTexture {
  return canvasTex('tobacco', 512, 256, (g, r) => {
    g.fillStyle = '#1c1e23';
    g.fillRect(0, 0, 512, 256);
    g.fillStyle = '#30343a';
    g.fillRect(0, 0, 512, 28);
    g.fillStyle = '#f4efe0';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '800 18px system-ui, sans-serif';
    g.fillText('TOBACCO  ·  MUST BE 21  ·  ID REQUIRED', 256, 15);
    const cols = ['#f4f1e6', '#c8102e', '#1f3a6a', '#e8a81c', '#2f7a3a', '#111214', '#8a8f96', '#6a2a7a'];
    for (let row = 0; row < 7; row++) {
      const y = 34 + row * 31;
      let x = 4;
      while (x < 506) {
        const c = pick(cols, r), n = 3 + Math.floor(r() * 4);
        for (let k = 0; k < n && x < 506; k++) {
          g.fillStyle = c;
          g.fillRect(x, y, 11, 22);
          g.fillStyle = r() < 0.5 ? '#ffffff' : '#d9d4c8';
          g.fillRect(x, y, 11, 6);
          g.fillStyle = 'rgba(0,0,0,0.3)';
          g.fillRect(x + 10, y, 1, 22);
          x += 12;
        }
        x += 2;
      }
      g.fillStyle = '#5a5f6a';
      g.fillRect(0, y + 23, 512, 4);
      g.fillStyle = '#f6d43a';
      for (let tx = 8; tx < 512; tx += 48) g.fillRect(tx, y + 23, 10, 3);
    }
  });
}

/** the scratch-off dispenser: a lit case of ticket rolls under their prices */
function lotteryTex(): THREE.CanvasTexture {
  return canvasTex('lottery', 256, 128, (g, r) => {
    g.fillStyle = '#1f2128';
    g.fillRect(0, 0, 256, 128);
    const prices = ['$1', '$2', '$3', '$5', '$5', '$10', '$20', '$30'];
    for (let i = 0; i < 8; i++) {
      const x = 4 + i * 31.5;
      g.fillStyle = '#f2c230';
      g.font = '800 15px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(prices[i], x + 14, 16);
      g.fillStyle = pick(PACK, r);
      g.fillRect(x, 24, 28, 98);
      g.fillStyle = 'rgba(255,255,255,0.65)';
      for (let k = 0; k < 5; k++) g.fillRect(x + 3 + r() * 16, 30 + r() * 80, 6, 6); // stars and dollar signs
      g.fillStyle = 'rgba(0,0,0,0.3)';
      for (let y = 44; y < 122; y += 20) g.fillRect(x, y, 28, 1); // perforations
    }
  });
}

/** a small lit screen: a register's, a card terminal's, a self checkout's */
function screenTex(kind: 'register' | 'terminal' | 'kiosk'): THREE.CanvasTexture {
  return canvasTex(`screen-${kind}`, 128, 96, (g) => {
    g.fillStyle = '#0f1218';
    g.fillRect(0, 0, 128, 96);
    g.fillStyle = kind === 'kiosk' ? '#2f6b4a' : '#1f4a8a';
    g.fillRect(4, 4, 120, 18);
    g.fillStyle = '#ffffff';
    g.font = '700 12px system-ui, sans-serif';
    g.fillText(kind === 'terminal' ? 'INSERT OR TAP' : kind === 'kiosk' ? 'SCAN FIRST ITEM' : 'TOTAL', 8, 17);
    if (kind === 'register') {
      g.fillStyle = '#d9d4c8';
      for (let i = 0; i < 4; i++) g.fillRect(8, 30 + i * 12, 70 + (i % 2) * 20, 6);
      g.fillStyle = '#7fe0a0';
      g.font = '800 16px ui-monospace, Menlo, monospace';
      g.fillText('$12.47', 66, 88);
    } else {
      g.fillStyle = '#f2c230';
      g.beginPath();
      g.roundRect(30, 34, 68, 40, 6);
      g.fill();
      g.fillStyle = '#1f2128';
      g.font = '900 16px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(kind === 'kiosk' ? 'START' : 'PAY', 64, 60);
    }
  });
}

function atmTex(): THREE.CanvasTexture {
  return canvasTex('atm', 128, 256, (g) => {
    g.fillStyle = '#2a3a5a';
    g.fillRect(0, 0, 128, 256);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.font = '900 30px system-ui, sans-serif';
    g.fillText('ATM', 64, 34);
    g.fillStyle = '#0f1218';
    g.fillRect(14, 48, 100, 70);
    g.fillStyle = '#3a7ac0';
    g.fillRect(18, 52, 92, 62);
    g.fillStyle = '#ffffff';
    g.font = '700 11px system-ui, sans-serif';
    g.fillText('WELCOME', 64, 80);
    g.fillText('INSERT CARD', 64, 96);
    g.fillStyle = '#c9ced4';
    for (let k = 0; k < 12; k++) g.fillRect(30 + (k % 3) * 18, 132 + Math.floor(k / 3) * 14, 14, 10);
    g.fillStyle = '#1f2128';
    g.fillRect(92, 136, 24, 4); // card slot
    g.fillRect(24, 204, 80, 8); // cash slot
    g.fillStyle = '#7fe0a0';
    g.fillRect(92, 132, 6, 2);
  });
}

/** the soda fountain's front: a row of flavour badges over the nozzles, the ice chute in the middle */
function fountainTex(): THREE.CanvasTexture {
  return canvasTex('fountain', 256, 256, (g) => {
    g.fillStyle = '#c9ced4';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#1f2128';
    g.fillRect(0, 0, 256, 40);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '900 24px system-ui, sans-serif';
    g.fillText('FOUNTAIN DRINKS', 128, 21, 240);
    const flav: [string, string][] = [['COLA', '#c8102e'], ['DIET', '#9aa0a6'], ['LEMON', '#7bb04a'], ['ORANGE', '#f08c3a'], ['ROOT', '#6a3a1a'], ['TEA', '#8a5a1a']];
    flav.forEach(([n, c], i) => {
      const x = 8 + i * 41;
      g.fillStyle = c;
      g.fillRect(x, 52, 36, 70);
      g.fillStyle = '#ffffff';
      g.font = '800 11px system-ui, sans-serif';
      g.fillText(n, x + 18, 90, 34);
      g.fillStyle = '#3a3d42';
      g.fillRect(x + 12, 132, 12, 20); // nozzle
      g.fillStyle = '#1f2128';
      g.fillRect(x + 8, 156, 20, 40); // lever
    });
    g.fillStyle = '#2a2d33';
    g.fillRect(0, 214, 256, 42); // drip tray
    g.fillStyle = '#5a5f6a';
    for (let x = 4; x < 256; x += 8) g.fillRect(x, 220, 4, 30);
  });
}

/** the deli case's lit trays: meats, salads and cheeses, each with its little price card */
function deliTex(): THREE.CanvasTexture {
  return canvasTex('deli', 512, 128, (g, r) => {
    g.fillStyle = '#e9edf0';
    g.fillRect(0, 0, 512, 128);
    const foods = ['#d8826a', '#e8a090', '#c45a4a', '#f2c230', '#ffe27a', '#7bb04a', '#f4efe0', '#a8442a', '#e8c890'];
    for (let x = 6; x < 506; x += 62) {
      const c = pick(foods, r);
      g.fillStyle = '#ffffff';
      g.fillRect(x, 20, 56, 96); // the tray
      g.fillStyle = c;
      if (r() < 0.5) {
        for (let k = 0; k < 5; k++) {
          g.beginPath(); // a log of ham or a wheel of cheese, sliced
          g.ellipse(x + 28, 40 + k * 14, 22, 10, 0, 0, 6.3);
          g.fill();
        }
      } else g.fillRect(x + 4, 26, 48, 84);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(x + 6, 28, 6, 70);
      g.fillStyle = '#ffffff';
      g.fillRect(x + 16, 4, 26, 13);
      g.fillStyle = '#c8102e';
      g.fillRect(x + 19, 8, 20, 5);
    }
  });
}

/** an interior door, with its sign */
function doorTex(label: string, color: string): THREE.CanvasTexture {
  return canvasTex(`door-${label}`, 128, 256, (g) => {
    g.fillStyle = color;
    g.fillRect(0, 0, 128, 256);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 6;
    g.strokeRect(3, 3, 122, 250);
    g.fillStyle = '#c9ced4';
    g.fillRect(100, 120, 10, 26); // the handle
    g.fillStyle = '#f4f6f8';
    g.fillRect(24, 50, 80, 34);
    g.fillStyle = '#1f2128';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const words = label.split(' ');
    g.font = '800 13px system-ui, sans-serif';
    words.forEach((w, i) => g.fillText(w, 64, 67 + (i - (words.length - 1) / 2) * 14, 76));
    g.fillStyle = 'rgba(0,0,0,0.2)';
    g.fillRect(0, 228, 128, 28); // kick plate
  });
}

/** the ribbed entrance mat */
function matTex(): THREE.CanvasTexture {
  return canvasTex('mat', 256, 128, (g) => {
    g.fillStyle = '#2a2d33';
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#3a3e46';
    for (let x = 8; x < 248; x += 8) g.fillRect(x, 10, 4, 108);
    g.strokeStyle = '#1a1c20';
    g.lineWidth = 8;
    g.strokeRect(4, 4, 248, 120);
    g.fillStyle = 'rgba(244,239,224,0.55)';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '900 34px system-ui, sans-serif';
    g.fillText('WELCOME', 128, 66);
  });
}

/** the round sticker on an automatic door: transparent round the edge */
function decalTex(): THREE.CanvasTexture {
  return canvasTex('door-decal', 128, 128, (g) => {
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath();
    g.arc(64, 64, 60, 0, 6.3);
    g.fill();
    g.fillStyle = '#c8102e';
    g.beginPath();
    g.arc(64, 64, 52, 0, 6.3);
    g.fill();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '900 19px system-ui, sans-serif';
    g.fillText('AUTOMATIC', 64, 52, 96);
    g.fillText('DOOR', 64, 76);
  });
}

/**
 * Gas station forecourt: poured concrete slabs (one 512 px tile = 8 m, two slabs each way) with saw-cut joints,
 * oil drips, tyre scuffs and a fine speckle. Tiles across the whole lot.
 */
export function forecourtTex(): THREE.CanvasTexture {
  return canvasTex('forecourt', 512, 512, (g, r) => {
    g.fillStyle = '#cfcac0';
    g.fillRect(0, 0, 512, 512);
    // each slab its own tone
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const t = 196 + Math.floor(r() * 22);
      g.fillStyle = `rgb(${t},${t - 4},${t - 12})`;
      g.fillRect(i * 256, j * 256, 256, 256);
    }
    // broad mottling and speckle
    for (let k = 0; k < 40; k++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '255,250,240' : '80,74,66'},${0.03 + r() * 0.05})`;
      g.beginPath();
      g.ellipse(r() * 512, r() * 512, 30 + r() * 90, 20 + r() * 70, r() * 3, 0, 6.3);
      g.fill();
    }
    for (let k = 0; k < 5000; k++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '60,56,50' : '255,252,244'},${0.06 + r() * 0.12})`;
      g.fillRect(r() * 512, r() * 512, 1 + r() * 2, 1 + r() * 2);
    }
    // oil drips: dark, soft-edged blotches, darker in the middle
    for (let k = 0; k < 9; k++) {
      const x = r() * 512, y = r() * 512, rad = 10 + r() * 34;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, 'rgba(40,36,34,0.55)');
      grd.addColorStop(0.6, 'rgba(50,46,42,0.25)');
      grd.addColorStop(1, 'rgba(50,46,42,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(x, y, rad, rad * (0.6 + r() * 0.4), r() * 3, 0, 6.3);
      g.fill();
    }
    // tyre scuffs: faint dark arcs in pairs
    g.lineWidth = 7;
    for (let k = 0; k < 6; k++) {
      const x = r() * 512, y = r() * 512, rad = 120 + r() * 200, a = r() * 6.3;
      g.strokeStyle = `rgba(40,38,36,${0.06 + r() * 0.06})`;
      for (const off of [0, 22]) {
        g.beginPath();
        g.arc(x, y, rad + off, a, a + 0.5 + r() * 0.5);
        g.stroke();
      }
    }
    // saw-cut joints between the slabs (dark groove, pale lip), and a hairline crack or two
    for (const p of [0, 256]) {
      g.fillStyle = 'rgba(60,56,50,0.75)';
      g.fillRect(p - 2, 0, 4, 512);
      g.fillRect(0, p - 2, 512, 4);
      g.fillStyle = 'rgba(255,252,244,0.35)';
      g.fillRect(p + 2, 0, 2, 512);
      g.fillRect(0, p + 2, 512, 2);
    }
    g.strokeStyle = 'rgba(70,66,60,0.45)';
    g.lineWidth = 1.5;
    for (let k = 0; k < 3; k++) {
      let x = r() * 512, y = r() * 512;
      g.beginPath();
      g.moveTo(x, y);
      for (let n = 0; n < 6; n++) {
        x += (r() - 0.5) * 70;
        y += (r() - 0.5) * 70;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  }, true);
}

function signTex(text: string, bg: string, fg: string, sub = ''): THREE.CanvasTexture {
  return canvasTex(`sign-${text}-${bg}`, 1024, 192, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 1024, 192);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 ${sub ? 104 : 120}px system-ui, sans-serif`;
    g.fillText(text, 512, sub ? 80 : 98, 980);
    if (sub) {
      g.font = '700 40px system-ui, sans-serif';
      g.fillText(sub, 512, 160, 980);
    }
  });
}

function priceTex(brand: string, color: string): THREE.CanvasTexture {
  return canvasTex(`price-${brand}`, 256, 320, (g) => {
    g.fillStyle = color;
    g.fillRect(0, 0, 256, 320);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.font = '900 34px system-ui, sans-serif';
    g.fillText(brand, 128, 50, 236);
    g.fillStyle = '#14121c';
    g.fillRect(14, 74, 228, 232);
    const rows: [string, string][] = [['REGULAR', '3.49'], ['PLUS', '3.79'], ['DIESEL', '3.99']];
    rows.forEach(([n, p], i) => {
      g.fillStyle = '#f4efe0';
      g.font = '700 20px system-ui, sans-serif';
      g.textAlign = 'left';
      g.fillText(n, 26, 110 + i * 74);
      g.fillStyle = '#ff5a3a';
      g.font = '700 52px ui-monospace, Menlo, monospace';
      g.textAlign = 'right';
      g.fillText(p, 236, 128 + i * 74);
    });
  });
}

function pumpScreenTex(): THREE.CanvasTexture {
  return canvasTex('pump-screen', 128, 192, (g) => {
    g.fillStyle = '#20242c';
    g.fillRect(0, 0, 128, 192);
    g.fillStyle = '#7fe0a0';
    g.font = '700 22px ui-monospace, Menlo, monospace';
    g.fillText('$  0.00', 14, 40);
    g.fillText('GAL 0.00', 14, 72);
    g.fillStyle = '#d9d4c8';
    for (let i = 0; i < 3; i++) g.fillRect(14 + i * 36, 110, 28, 16);
    for (let k = 0; k < 9; k++) g.fillRect(24 + (k % 3) * 28, 136 + Math.floor(k / 3) * 16, 20, 10);
  });
}

// ------------------------------------------------------------------------------------------------
// a builder in the store's own frame: x across the front, +z out of the front door, y up from the floor
// ------------------------------------------------------------------------------------------------

const YAW: Record<Side, number> = { s: 0, n: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 };

class Kit {
  private colored: THREE.BufferGeometry[] = [];
  private shellColored: THREE.BufferGeometry[] = []; // walls and roof: lit, but they cast no shadow into the room
  private textured = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private glow: THREE.BufferGeometry[] = [];
  private m: THREE.Matrix4;
  private glass: THREE.BufferGeometry[] = [];

  constructor(readonly cx: number, readonly cz: number, readonly y: number, readonly yaw: number, private ctx: StoreCtx) {
    this.m = new THREE.Matrix4().makeRotationY(yaw).setPosition(cx, y, cz);
  }

  /** world AABB of a local box (rotations are multiples of 90 degrees, so it is exact) */
  private aabb(w: number, d: number, x: number, z: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const wx = Math.abs(c) * w + Math.abs(s) * d, wz = Math.abs(s) * w + Math.abs(c) * d;
    const px = this.cx + c * x + s * z, pz = this.cz - s * x + c * z;
    return { minX: px - wx / 2, maxX: px + wx / 2, minZ: pz - wz / 2, maxZ: pz + wz / 2 };
  }
  /** world position of a local point */
  at(x: number, y: number, z: number): [number, number, number] {
    const v = new THREE.Vector3(x, y, z).applyMatrix4(this.m);
    return [v.x, v.y, v.z];
  }

  /** a coloured box standing on y0 (local). solid: 'ground' blocks from the ground up; 'float' only between its faces */
  box(w: number, h: number, d: number, x: number, y0: number, z: number, color: number, solid: 'ground' | 'float' | 'none' = 'ground', shell = false): void {
    (shell ? this.shellColored : this.colored).push(cube(w, h, d, x, y0 + h / 2, z, color));
    if (solid === 'none') return;
    const b: Box = { ...this.aabb(w, d, x, z), top: this.y + y0 + h };
    if (solid === 'float') b.bottom = this.y + y0;
    this.ctx.addBox(b);
  }
  /** collision only (glass): a solid box from the ground up to y0 + h */
  collide(w: number, h: number, d: number, x: number, y0: number, z: number): void {
    this.ctx.addBox({ ...this.aabb(w, d, x, z), top: this.y + y0 + h });
  }
  /** a textured quad facing local +z (rotY turns it), u tiled every `tile` metres */
  quad(mat: THREE.Material, w: number, h: number, x: number, y0: number, z: number, rotY = 0, tile = 0): void {
    const g = new THREE.PlaneGeometry(w, h);
    if (tile > 0) {
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (w / tile));
    }
    g.rotateY(rotY).translate(x, y0 + h / 2, z);
    let l = this.textured.get(mat);
    if (!l) this.textured.set(mat, (l = []));
    l.push(g);
  }
  /** a flat textured patch on the floor */
  floor(mat: THREE.Material, w: number, d: number, x: number, y: number, z: number, tile: number, tileD = tile): void {
    const g = new THREE.PlaneGeometry(w, d);
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / tile), uv.getY(i) * (d / tileD));
    g.rotateX(-Math.PI / 2).translate(x, y, z);
    let l = this.textured.get(mat);
    if (!l) this.textured.set(mat, (l = []));
    l.push(g);
  }
  light(w: number, d: number, x: number, y: number, z: number): void {
    this.glow.push(new THREE.BoxGeometry(w, 0.06, d).translate(x, y, z));
  }
  pane(w: number, h: number, x: number, y0: number, z: number, rotY = 0): void {
    this.glass.push(new THREE.BoxGeometry(w, h, 0.06).rotateY(rotY).translate(x, y0 + h / 2, z));
  }
  /** fruit, cans, anything round: a small coloured ball */
  ball(r: number, x: number, y: number, z: number, color: number): void {
    const g = new THREE.IcosahedronGeometry(r, 0).toNonIndexed();
    g.deleteAttribute('uv');
    g.translate(x, y, z);
    const c = new THREE.Color(color);
    g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from({ length: g.getAttribute('position').count * 3 }, (_, k) => [c.r, c.g, c.b][k % 3]), 3));
    this.colored.push(g);
  }

  /** a coloured cylinder standing on y0, its axis up (or along local x / z, centred on y0 then) */
  cyl(r: number, h: number, x: number, y0: number, z: number, color: number, axis: 'y' | 'x' | 'z' = 'y', rTop = r, seg = 12, shell = false): void {
    const g = new THREE.CylinderGeometry(rTop, r, h, seg).toNonIndexed();
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, axis === 'y' ? y0 + h / 2 : y0, z);
    (shell ? this.shellColored : this.colored).push(paint(g, color));
  }
  /** a coloured box centred on (x, y, z), tipped back by `tilt` about its own x axis, then turned by rotY */
  tbox(w: number, h: number, d: number, x: number, y: number, z: number, tilt: number, color: number, rotY = 0): void {
    this.colored.push(cube(w, h, d, 0, 0, 0, color).rotateX(tilt).rotateY(rotY).translate(x, y, z));
  }
  /** a textured panel centred on (x, y, z), facing local +z, tipped back by `tilt` (−π/2 faces straight up), then turned */
  panel(mat: THREE.Material, w: number, h: number, x: number, y: number, z: number, rotY = 0, tilt = 0): void {
    const g = new THREE.PlaneGeometry(w, h).rotateX(tilt).rotateY(rotY).translate(x, y, z);
    let l = this.textured.get(mat);
    if (!l) this.textured.set(mat, (l = []));
    l.push(g);
  }
  /** a flat textured patch on the ceiling, facing down */
  ceil(mat: THREE.Material, w: number, d: number, x: number, y: number, z: number, tile: number): void {
    const g = new THREE.PlaneGeometry(w, d);
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / tile), uv.getY(i) * (d / tile));
    g.rotateX(Math.PI / 2).translate(x, y, z);
    let l = this.textured.get(mat);
    if (!l) this.textured.set(mat, (l = []));
    l.push(g);
  }
  /** something that glows (a light, an LED strip), any shape of box */
  glowBox(w: number, h: number, d: number, x: number, y: number, z: number): void {
    this.glow.push(new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  }
  /** a pane of glass centred on (x, y, z), tipped back by `tilt`, then turned */
  tpane(w: number, h: number, x: number, y: number, z: number, rotY = 0, tilt = 0): void {
    this.glass.push(new THREE.BoxGeometry(w, h, 0.03).rotateX(tilt).rotateY(rotY).translate(x, y, z));
  }

  private sliders: { x: number; z: number; w: number; h: number }[] = [];
  /** a pair of bi-parting automatic doors, centred on local x, sliding along x in the plane z; leaves h tall */
  slider(x: number, z: number, w: number, h: number): void {
    this.sliders.push({ x, z, w, h });
  }

  finish(gradient: THREE.DataTexture, doors?: SlidingDoor[]): void {
    const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, cast: boolean) => {
      if (!geos.length) return;
      const g = mergeGeometries(geos, false);
      if (!g) return;
      g.applyMatrix4(this.m);
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      this.ctx.group.add(mesh);
    };
    const vc = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradient });
    add(this.colored, vc, true);
    add(this.shellColored, vc, false);
    for (const [mat, geos] of this.textured) add(geos, mat, false);
    add(this.glow, new THREE.MeshBasicMaterial({ color: 0xfff6dc }), false);
    add(this.glass, GLASS, false);
    // the sliding doors: each leaf its own mesh, moved every frame
    for (const sd of this.sliders) {
      const frame = new THREE.Group();
      frame.position.set(this.cx, this.y, this.cz);
      frame.rotation.y = this.yaw;
      this.ctx.group.add(frame);
      const lw = sd.w / 2 + 0.05;
      const alu = 0xa8afb6;
      const rails = mergeGeometries([
        cube(0.07, sd.h, 0.07, -lw / 2 + 0.035, sd.h / 2, 0, alu),
        cube(0.07, sd.h, 0.07, lw / 2 - 0.035, sd.h / 2, 0, alu),
        cube(lw, 0.1, 0.07, 0, sd.h - 0.05, 0, alu),
        cube(lw, 0.18, 0.07, 0, 0.09, 0, alu),
      ], false)!;
      const glass = new THREE.BoxGeometry(lw - 0.12, sd.h - 0.26, 0.02).translate(0, 0.18 + (sd.h - 0.26) / 2, 0);
      const decal = mergeGeometries([
        new THREE.PlaneGeometry(0.3, 0.3).translate(0, 1.3, 0.016),
        new THREE.PlaneGeometry(0.3, 0.3).rotateY(Math.PI).translate(0, 1.3, -0.016),
      ], false)!;
      const leaves: THREE.Object3D[] = [];
      for (const s of [-1, 1]) {
        const leaf = new THREE.Group();
        const fm = new THREE.Mesh(rails, vc);
        fm.castShadow = true;
        leaf.add(fm, new THREE.Mesh(glass, GLASS), new THREE.Mesh(decal, DECAL));
        leaf.position.set(sd.x + (s * sd.w) / 4, 0, sd.z + (s > 0 ? 0.08 : 0));
        frame.add(leaf);
        leaves.push(leaf);
      }
      const [wx, wy, wz] = this.at(sd.x, 0, sd.z);
      doors?.push({ leaves, x0: sd.x, w: sd.w, wx, wy, wz, open: 0, hold: 0, reach: sd.w / 2 + 2.4 });
    }
  }
}

export interface SlidingDoor {
  leaves: THREE.Object3D[];
  x0: number; // local centre of the doorway
  w: number;
  wx: number; // world centre, for the sensor
  wy: number;
  wz: number;
  open: number; // 0 shut .. 1 open
  hold: number; // seconds left before it starts to close
  reach: number; // the sensor's range
}

const GLASS = new THREE.MeshBasicMaterial({ color: 0xbfe3f2, transparent: true, opacity: 0.22, depthWrite: false });
const DECAL = new THREE.MeshBasicMaterial({ map: decalTex(), transparent: true, alphaTest: 0.05, side: THREE.DoubleSide });

/** give a geometry one flat vertex colour (and drop its uvs, so it merges with the boxes) */
function paint(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  g.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * The doors' sensors: open when anyone is near (the rat, a pedestrian), hold a moment once they're clear, then close.
 * Returns the distance from the first watcher to the nearest door that just started to open (Infinity if none).
 */
export function updateDoors(doors: SlidingDoor[], dt: number, who: THREE.Vector3[]): number {
  let started = Infinity;
  for (const d of doors) {
    let near = false;
    for (const p of who) {
      if (Math.abs(p.y - d.wy) < 2.5 && (p.x - d.wx) ** 2 + (p.z - d.wz) ** 2 < d.reach * d.reach) {
        near = true;
        break;
      }
    }
    if (near) {
      if (d.hold <= 0 && d.open < 0.05 && who.length) started = Math.min(started, Math.hypot(who[0].x - d.wx, who[0].z - d.wz));
      d.hold = 1.6;
    } else d.hold -= dt;
    const target = d.hold > 0 ? 1 : 0;
    const rate = target ? 1.8 : 0.9; // snappy to open, unhurried to close
    d.open = Math.max(0, Math.min(1, d.open + Math.sign(target - d.open) * Math.min(Math.abs(target - d.open), rate * dt)));
    const e = d.open * d.open * (3 - 2 * d.open);
    const travel = d.w / 2 - 0.12;
    d.leaves.forEach((l, i) => {
      const s = i ? 1 : -1;
      l.position.x = d.x0 + (s * d.w) / 4 + s * travel * e;
    });
  }
  return started;
}

const matCache = new Map<string, THREE.Material>();
const toonMap = (gradient: THREE.DataTexture, map: THREE.Texture): THREE.Material => {
  let m = matCache.get('t' + map.uuid);
  if (!m) matCache.set('t' + map.uuid, (m = new THREE.MeshToonMaterial({ map, gradientMap: gradient, side: THREE.DoubleSide })));
  return m;
};
/** a texture that lights itself: cooler interiors, screens, backlit boards */
const litMap = (map: THREE.Texture): THREE.Material => {
  let m = matCache.get('l' + map.uuid);
  if (!m) matCache.set('l' + map.uuid, (m = new THREE.MeshBasicMaterial({ map, color: 0xeeeeee, side: THREE.DoubleSide })));
  return m;
};

/** the shell: floor, three solid walls, a glass front with a doorway, and a roof with a parapet you can walk under */
function shell(k: Kit, W: number, D: number, H: number, door: { x: number; w: number }, wall: number, trim: number, gradient: THREE.DataTexture, glassH: number, look: { floor: 'grocery' | 'gas'; ceiling: number }): void {
  const T = 0.35;
  // floor slab (solid from the ground up) and tiles
  k.box(W, 0.6, D, 0, -0.6, 0, 0xb9b2a4);
  k.floor(toonMap(gradient, floorTex(look.floor)), W - 2 * T, D - 2 * T, 0, 0.012, 0, 2.4);
  // back and side walls
  k.box(W, H, T, 0, 0, -D / 2 + T / 2, wall, 'ground', true);
  k.box(T, H, D, -W / 2 + T / 2, 0, 0, wall, 'ground', true);
  k.box(T, H, D, W / 2 - T / 2, 0, 0, wall, 'ground', true);
  // front: knee wall, glass and mullions either side of the doorway; the glass is solid
  const fz = D / 2 - T / 2;
  for (const [a, b] of [[-W / 2, door.x - door.w / 2], [door.x + door.w / 2, W / 2]] as const) {
    const w = b - a, x = (a + b) / 2;
    if (w < 0.05) continue;
    k.box(w, 0.7, T, x, 0, fz, trim, 'ground', true);
    k.pane(w, glassH - 0.7, x, 0.7, fz);
    k.collide(w, glassH, T, x, 0, fz);
    const n = Math.max(1, Math.round(w / 2.4));
    for (let i = 0; i <= n; i++) k.box(0.12, glassH - 0.7, 0.22, a + (w * i) / n, 0.7, fz, 0x2a2d33, 'none', true);
  }
  // the band over the windows and the doorway
  k.box(W, H - glassH, T, 0, glassH, fz, wall, 'float', true);
  // the automatic doors: two leaves that part and slide outside the fixed glass, under the operator's housing;
  // a sill the rat stands on, and the motion sensors, outside and in, with their little red eyes
  const dz = fz + 0.27, leafH = glassH - 0.3;
  k.slider(door.x, dz, door.w, leafH);
  k.box(door.w * 2 + 0.3, 0.3, 0.27, door.x, leafH, fz + 0.31, 0xa8afb6, 'none', true);
  k.box(door.w * 2 + 0.3, 0.02, 0.02, door.x, leafH + 0.04, fz + 0.45, 0x5a5f6a, 'none', true);
  k.box(door.w + 0.4, 0.6, 0.5, door.x, -0.6, fz + 0.35, 0xb9b2a4);
  k.box(door.w * 2 + 0.2, 0.012, 0.1, door.x, 0, dz + 0.04, 0x5a5f6a, 'none', true); // floor guide track
  for (const side of [1, -1]) {
    const sz = side > 0 ? fz + 0.5 : fz - 0.24, sy = (side > 0 ? leafH : glassH) - 0.08;
    k.box(0.32, 0.08, 0.12, door.x, sy, sz, 0x1f2128, 'none', true);
    k.box(0.04, 0.03, 0.02, door.x + 0.1, sy + 0.01, sz + side * 0.07, 0xff2a1a, 'none', true);
  }
  // roof: a floating slab, with a parapet round it, and a pale ceiling under it
  k.box(W + 0.4, 0.45, D + 0.4, 0, H, 0, trim, 'float', true);
  k.box(W - 2 * T, 0.04, D - 2 * T, 0, H - 0.04, 0, look.ceiling, 'none', true);
  for (const [w, d, x, z] of [[W + 0.4, 0.3, 0, -D / 2], [W + 0.4, 0.3, 0, D / 2], [0.3, D + 0.4, -W / 2, 0], [0.3, D + 0.4, W / 2, 0]] as const) k.box(w, 0.7, d, x, H + 0.45, z, trim, 'float', true);
}

// ------------------------------------------------------------------------------------------------
// exterior clutter shared by the stores
// ------------------------------------------------------------------------------------------------

/** a commercial dumpster on casters: body, overhanging dark lid, lift pockets. long = its length runs along local x */
function dumpster(k: Kit, x: number, y: number, z: number, longX: boolean, color: number, out: StoresBuilt): void {
  const L = 2.0, Dp = 1.4;
  const [w, d] = longX ? [L, Dp] : [Dp, L];
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(0.18, 0.18, 0.18, x + dx * (w / 2 - 0.2), y, z + dz * (d / 2 - 0.2), 0x1f2128, 'none');
  k.box(w, 1.2, d, x, y + 0.18, z, color);
  k.box(w + 0.08, 0.1, d + 0.12, x, y + 1.38, z, 0x1f2a26, 'none');
  // fork pockets along both long sides
  for (const s of [-1, 1]) {
    if (longX) k.box(w * 0.8, 0.16, 0.12, x, y + 0.75, z + s * (d / 2 + 0.05), 0x2a2d33, 'none');
    else k.box(0.12, 0.16, d * 0.8, x + s * (w / 2 + 0.05), y + 0.75, z, 0x2a2d33, 'none');
  }
  void out;
}

/** a short yellow steel bollard */
function bollard(k: Kit, x: number, y: number, z: number): void {
  k.box(0.22, 1.0, 0.22, x, y, z, 0xf2c230);
  k.box(0.24, 0.08, 0.24, x, y + 1.0, z, 0x2a2d33, 'none');
}

/** a chest freezer of bagged ice with its sign */
function iceChest(k: Kit, x: number, y: number, z: number, gradient: THREE.DataTexture): void {
  k.box(2.0, 1.35, 0.85, x, y, z, 0xf4f6f8);
  k.box(2.05, 0.12, 0.9, x, y + 1.35, z, 0x3a7ac0, 'none');
  k.quad(toonMap(gradient, signTex('ICE', '#3a7ac0', '#ffffff')), 1.6, 0.42, x, y + 0.55, z + 0.43);
}

/** a pallet stacked with boxes (or empty), the boxes strapped */
function pallet(k: Kit, x: number, y: number, z: number, load: number): void {
  k.box(1.2, 0.14, 1.0, x, y, z, 0x9a7048);
  for (const dz of [-0.4, 0, 0.4]) k.box(1.2, 0.04, 0.12, x, y + 0.14, z + dz, 0xb0845a, 'none');
  if (load > 0) {
    k.box(1.1, 0.4 * load, 0.92, x, y + 0.18, z, 0xc6a272);
    k.box(1.12, 0.05, 0.05, x, y + 0.18 + 0.2 * load, z + 0.46, 0x2a2d33, 'none');
  }
}

// ------------------------------------------------------------------------------------------------
// the grocery
// ------------------------------------------------------------------------------------------------

function buildGrocery(st: StoreSpec, ctx: StoreCtx, out: StoresBuilt): void {
  const [x0, z0, x1, z1] = st.rect;
  const ns = st.door === 'n' || st.door === 's';
  const W = ns ? x1 - x0 : z1 - z0, D = ns ? z1 - z0 : x1 - x0, H = 6.5;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const base = Math.max(...[[x0, z0], [x1, z0], [x0, z1], [x1, z1]].map(([x, z]) => ctx.lotAt(x, z))) + 0.12;
  const k = new Kit(cx, cz, base, YAW[st.door], ctx);
  const g = ctx.gradient;
  shell(k, W, D, H, { x: 0, w: 4.4 }, 0xe9dfc8, 0x2f6b4a, g, 3.4, { floor: 'grocery', ceiling: 0x464a50 });
  steps(k, ctx, D / 2, 0, 4.4, base);

  // facade: an awning over the windows and the big sign
  k.box(W + 0.4, 0.5, 1.6, 0, 3.5, D / 2 + 0.8, 0x2f6b4a, 'float');
  k.quad(toonMap(g, signTex(st.name, '#2f6b4a', '#fff6dc', 'GROCERIES · DELI · CHEESE')), 18, 2.4, 0, 4.0, D / 2 + 0.2);

  const rand = ctx.rand;
  const ix = W / 2 - 0.35; // inside faces of the side walls are at ±ix
  const aisleZ0 = -D / 2 + 4.2, aisleZ1 = D / 2 - 9;
  const len = aisleZ1 - aisleZ0, mz = (aisleZ0 + aisleZ1) / 2;
  const laneZ = D / 2 - 5;

  // ---- an open ceiling, painted dark: bar joists across it, two silver ducts down its length, lights hung on rods ----
  for (let x = -W / 2 + 2; x < W / 2 - 1; x += 3) k.box(0.1, 0.45, D - 0.8, x, H - 0.5, 0, 0x5a5e65, 'none', true);
  for (const z of [-6, 5]) k.cyl(0.38, W - 1.2, 0, H - 1.0, z, 0xb4bac0, 'x', 0.38, 12, true);
  const fixture = (x: number, z: number, l: number, alongZ: boolean) => {
    const y = H - 1.7;
    k.box(alongZ ? 0.3 : l, 0.1, alongZ ? l : 0.3, x, y, z, 0xd6d8da, 'none', true);
    k.glowBox(alongZ ? 0.2 : l - 0.1, 0.03, alongZ ? l - 0.1 : 0.2, x, y - 0.015, z);
    for (const t of [-0.4, 0.4]) k.box(0.02, 1.6, 0.02, x + (alongZ ? 0 : t * l), y + 0.1, z + (alongZ ? t * l : 0), 0x5a5e65, 'none', true);
  };
  const pendant = (x: number, z: number, shade: number) => {
    k.box(0.02, 3.2, 0.02, x, H - 3.2, z, 0x1f2128, 'none', true);
    k.cyl(0.32, 0.3, x, H - 3.5, z, shade, 'y', 0.08, 12, true);
    k.glowBox(0.36, 0.02, 0.36, x, H - 3.5, z);
  };

  // ---- aisles: gondolas running front to back, stocked to suit the aisle they face, numbered signs hung over each ----
  const gaps: { x: number; kind: Goods; a: string; b: string }[] = [
    { x: -12.5, kind: 'cereal', a: 'CEREAL · COFFEE', b: 'BREAKFAST · TEA' },
    { x: -7.5, kind: 'groceries', a: 'BAKING · SPICES', b: 'PASTA · RICE' },
    { x: -2.5, kind: 'canned', a: 'CANNED GOODS', b: 'SOUP · BEANS' },
    { x: 2.5, kind: 'household', a: 'PAPER · CLEANING', b: 'PET FOOD' },
    { x: 7.5, kind: 'snacks', a: 'CHIPS · COOKIES', b: 'CANDY · NUTS' },
    { x: 12.5, kind: 'drinks', a: 'SODA · WATER', b: 'FROZEN MEALS' },
    { x: 17.5, kind: 'drinks', a: 'ICE CREAM', b: 'FROZEN PIZZA' },
  ];
  const facing = (x: number): Goods => gaps.find((gp) => Math.abs(gp.x - x) < 0.1)?.kind ?? 'groceries';
  const GH = 1.95;
  const ends: Goods[] = ['snacks', 'drinks', 'cereal', 'household', 'candy', 'canned'];
  for (let x = -15; x <= 10 + 1e-3; x += 5) {
    gondola(k, g, x, aisleZ0, aisleZ1, GH, facing(x - 2.5), facing(x + 2.5), [ends[(x + 15) / 5 % ends.length], ends[((x + 15) / 5 + 3) % ends.length]], rand, { overstock: true, sale: true, skipTop: x === -5 ? mz - 2 : undefined });
  }
  // on top of the middle gondola: a stray wheel of cheese for climbers
  out.cheese.push([...k.at(-5, GH + 0.08, mz - 2)] as [number, number, number]);
  // the frozen aisle: a double-sided run of glass-door freezers, lit inside, frost on the glass
  {
    const x = 15, fh = 2.3;
    const fr = litMap(coolerTex('frozen'));
    k.box(1.6, fh, len, x, 0, mz, 0xe9edf0);
    for (const s of [-1, 1]) {
      k.quad(fr, len - 0.1, fh - 0.42, x + s * 0.81, 0.12, mz, (s * Math.PI) / 2, 3.0);
      k.glowBox(0.03, 0.05, len - 0.2, x + s * 0.83, fh - 0.26, mz);
    }
    k.box(1.7, 0.35, len + 0.1, x, fh, mz, 0x3a7ac0, 'none');
    for (const s of [-1, 1]) k.box(1.62, fh, 0.06, x, 0, mz + s * (len / 2 + 0.03), 0xd6dadd, 'none');
  }
  gaps.forEach((gp, i) => {
    const m = litMap(aisleTex(i + 1, gp.a, gp.b));
    k.box(2.66, 1.36, 0.04, gp.x, 3.62, mz, 0x1f2128, 'none', true);
    k.panel(m, 2.6, 1.3, gp.x, 4.3, mz + 0.03, 0);
    k.panel(m, 2.6, 1.3, gp.x, 4.3, mz - 0.03, Math.PI);
    for (const dx of [-1, 1]) k.box(0.03, H - 4.98, 0.03, gp.x + dx, 4.98, mz, 0x8a909c, 'none', true);
    // strip lights down the aisle, either side of its sign
    fixture(gp.x, (aisleZ0 + mz - 1.6) / 2, mz - 1.6 - aisleZ0, true);
    fixture(gp.x, (mz + 1.6 + aisleZ1) / 2, aisleZ1 - mz - 1.6, true);
  });
  for (let x = -20; x <= 20 + 1e-3; x += 5) {
    for (const z of [laneZ - 1, laneZ + 2.5]) fixture(x, z, 3.0, false);
    fixture(x, -D / 2 + 2.6, 3.0, false);
  }

  // ---- back wall: a long run of coolers, dairy and drinks, with a cheese case in the middle, each with its sign ----
  const cw = W - 2;
  const third = cw / 3;
  const kinds: CoolerKind[] = ['dairy', 'cheese', 'drinks'];
  const labels: [string, string, string, string][] = [['DAIRY', '#2f6b4a', '#fff6dc', 'MILK · EGGS · BUTTER'], ['CHEESE SHOP', '#f2c230', '#5a3a0a', 'AGED · FRESH · IMPORTED'], ['BEVERAGES', '#1f4a8a', '#ffffff', 'COLD DRINKS · JUICE']];
  kinds.forEach((kind, i) => {
    const x = -cw / 2 + third * (i + 0.5);
    k.box(third, 2.4, 1.2, x, 0, -D / 2 + 0.95, 0xf0f2f4);
    k.quad(litMap(coolerTex(kind)), third - 0.1, 2.0, x, 0.18, -D / 2 + 1.56, 0, 3.0);
    k.box(third, 0.4, 0.15, x, 2.4, -D / 2 + 1.5, kind === 'cheese' ? 0xf2c230 : 0x2f6b4a, 'none');
    k.glowBox(third - 0.2, 0.04, 0.05, x, 2.36, -D / 2 + 1.6);
    const [t, bg, fg, sub] = labels[i];
    k.quad(toonMap(g, signTex(t, bg, fg, sub)), 7, 1.3, x, 3.0, -D / 2 + 0.37);
  });
  out.cheese.push([...k.at(0, 2.42, -D / 2 + 0.95)] as [number, number, number]); // on the cheese case

  // ---- produce, along the left wall: wood-look floor, a tiered wet rack under a canopy, heaped tables, bananas ----
  {
    const wx = -ix;
    k.floor(toonMap(g, woodTex()), 7.6, 20.5, wx + 3.8, 0.024, -2.25, 1.6);
    const rz = -3, rl = 18;
    k.box(1.7, 0.8, rl, wx + 0.85, 0, rz, 0x2b332c);
    k.box(1.1, 0.25, rl, wx + 0.55, 0.8, rz, 0x2b332c);
    k.box(0.55, 0.25, rl, wx + 0.275, 1.05, rz, 0x2b332c);
    const veg = [0x6fb03a, 0x3f8a3a, 0x2f6a2a, 0xf08c1c, 0xd9302a, 0xf2d23a, 0x5a2a5a, 0xc8282a, 0x9ac85a, 0xe8e0c8];
    const tiers: [number, number][][] = [[[1.25, 0.8], [1.55, 0.8]], [[0.7, 1.05], [0.95, 1.05]], [[0.15, 1.3], [0.4, 1.3]]];
    for (let s = 0; s < rl / 1.5; s++) {
      const z0 = rz - rl / 2 + s * 1.5;
      for (const tier of tiers) {
        const col = veg[Math.floor(rand() * veg.length)];
        for (const [tx, ty] of tier) for (let z = z0 + 0.17; z < z0 + 1.4; z += 0.27) k.ball(0.13, wx + tx, ty + 0.1, z + (rand() - 0.5) * 0.04, col);
      }
      k.box(1.7, 0.12, 0.03, wx + 0.85, 0.8, z0, 0x1f2128, 'none'); // divider
      k.box(0.02, 0.08, 0.2, wx + 1.71, 0.68, z0 + 0.75, 0xffffff, 'none'); // price card
    }
    k.box(0.05, 1.1, rl, wx + 0.03, 1.3, rz, 0xb8c8d0, 'none', true); // the mirror behind
    k.box(1.4, 0.22, rl, wx + 0.7, 2.6, rz, 0x2f6b4a, 'none', true); // canopy, with its light and the misting bar
    k.glowBox(0.1, 0.03, rl - 0.2, wx + 1.2, 2.58, rz);
    k.box(0.03, 0.03, rl, wx + 1.0, 2.45, rz, 0x9aa0a6, 'none', true);
    k.quad(toonMap(g, signTex('FRESH PRODUCE', '#2f6b4a', '#fff6dc', 'LOCAL · ORGANIC · IN SEASON')), 9, 1.7, wx + 0.02, 3.2, rz, Math.PI / 2);
    const fruit = [0xd9302a, 0x6fb03a, 0xf08c1c, 0xf2d23a, 0x9a3a7a, 0xc8282a];
    [-8, -2.5, 3].forEach((tz, ti) => {
      const tx = -19.2;
      k.box(2.0, 0.75, 3.2, tx, 0, tz, 0x7a4e30);
      k.box(2.1, 0.06, 3.3, tx, 0.75, tz, 0x5a3a24, 'none');
      k.collide(1.7, 1.2, 3.0, tx, 0, tz);
      for (const half of [-1, 1]) {
        const col = fruit[(ti * 2 + (half > 0 ? 1 : 0)) % fruit.length];
        const hz = tz + half * 0.8;
        for (let layer = 0; layer < 3; layer++) {
          const nx = 5 - layer, nz = 4 - layer, step = 0.34;
          for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) k.ball(0.17, tx + (a - (nx - 1) / 2) * step, 0.98 + layer * 0.24, hz + (b - (nz - 1) / 2) * step, col);
        }
        k.box(0.02, 0.22, 0.4, tx + 1.06, 0.45, hz, 0xffffff, 'none');
        k.box(0.02, 0.06, 0.3, tx + 1.075, 0.55, hz, 0xc8102e, 'none');
      }
      for (const dz of [-0.8, 0.8]) pendant(tx, tz + dz, 0x2f6b4a);
    });
    // the banana stand: a crate with a tree of hooks
    {
      const bx = -19.2, bz = 6.3;
      k.box(0.9, 0.7, 0.9, bx, 0, bz, 0x7a4e30);
      k.box(0.06, 1.2, 0.06, bx, 0.7, bz, 0x3a3d42, 'none');
      for (let a = 0; a < 4; a++) {
        const ang = (a * Math.PI) / 2 + 0.4;
        for (let j = 0; j < 4; j++) k.tbox(0.06, 0.24, 0.06, bx + Math.cos(ang) * 0.2 + (j - 1.5) * 0.04, 1.42, bz + Math.sin(ang) * 0.2, 0.3, 0xf2d23a, -ang);
      }
      for (let j = 0; j < 9; j++) k.tbox(0.07, 0.07, 0.26, bx + ((j % 3) - 1) * 0.22, 0.75, bz + (Math.floor(j / 3) - 1) * 0.22, 0, j % 4 ? 0xf2d23a : 0x9ac85a, j * 0.6);
    }
  }

  // ---- the bakery, front left: a rack of bagged loaves and a table of cakes and pies ----
  {
    const wx = -ix, bz = 10.6, bx = wx + 0.35;
    k.box(0.06, 2.0, 4.0, wx + 0.03, 0, bz, 0x6a4a3a, 'none');
    for (const s of [-1, 1]) k.box(0.7, 2.0, 0.05, bx, 0, bz + s * 1.975, 0x6a4a3a, 'none');
    k.collide(0.7, 2.0, 4.0, bx, 0, bz);
    for (let s = 0; s < 4; s++) {
      const sy = 0.25 + s * 0.45;
      k.box(0.68, 0.03, 3.9, bx, sy, bz, 0x6a4a3a, 'none');
      for (let z = bz - 1.8; z < bz + 1.7; z += 0.3) {
        k.box(0.42, 0.14 + rand() * 0.07, 0.24, bx + 0.05, sy + 0.03, z + 0.15, [0xc68a4a, 0xa8642a, 0xe0b070, 0x8a4a1a][Math.floor(rand() * 4)], 'none');
      }
    }
    k.quad(toonMap(g, signTex('BAKERY', '#8a4a1a', '#fff6dc', 'BAKED FRESH DAILY')), 4.5, 0.85, wx + 0.02, 2.6, bz, Math.PI / 2);
    const tx = -19.8;
    k.box(1.4, 0.8, 2.6, tx, 0, bz, 0xe9e3d4);
    k.box(1.5, 0.05, 2.7, tx, 0.8, bz, 0x8a5a3a, 'none');
    [[-0.35, -0.8, 0xf6b0c0], [0.35, -0.8, 0x5a3a2a], [-0.35, 0, 0xf4efe0], [0.35, 0, 0xc68a4a], [-0.35, 0.8, 0xd9302a], [0.35, 0.8, 0xf2d23a]].forEach(([dx, dz, c], i) => {
      k.cyl(0.24, 0.02, tx + dx, 0.85, bz + dz, 0xffffff);
      if (i % 2) k.cyl(0.2, 0.06, tx + dx, 0.87, bz + dz, 0xa8642a, 'y', 0.18); // a pie
      else k.cyl(0.18, 0.18, tx + dx, 0.87, bz + dz, c); // a cake
      k.tpane(0.42, 0.3, tx + dx, 1.05, bz + dz, 0, 0);
    });
    pendant(tx, bz - 0.7, 0x8a4a1a);
    pendant(tx, bz + 0.7, 0x8a4a1a);
  }

  // ---- the deli, on the right wall: a lit case with sloped glass, slicers behind it, the menu board over them ----
  {
    const z = -6, L = 6, cx2 = ix - 2.85;
    k.box(1.1, 0.85, L, cx2, 0, z, 0xe9e3d4);
    k.box(1.12, 0.14, L + 0.02, cx2, 0, z, 0x9aa0a6, 'none');
    k.collide(1.1, 1.45, L, cx2, 0, z);
    k.panel(litMap(deliTex()), L - 0.1, 0.8, cx2 + 0.05, 0.98, z, -Math.PI / 2, -1.2);
    k.tpane(L - 0.05, 0.62, cx2 - 0.45, 1.13, z, -Math.PI / 2, -0.45);
    k.box(0.55, 0.03, L, cx2 + 0.27, 1.42, z, 0xc9ced4, 'none');
    k.box(0.04, 0.57, L, cx2 + 0.53, 0.85, z, 0xc9ced4, 'none');
    k.glowBox(0.05, 0.03, L - 0.2, cx2 + 0.2, 1.39, z);
    for (const s of [-1, 1]) k.box(1.1, 0.6, 0.05, cx2, 0.85, z + s * (L / 2 - 0.025), 0xc9ced4, 'none');
    k.box(0.9, 0.95, L, ix - 0.45, 0, z, 0xc9ced4);
    for (const dz of [-1.6, 1.6]) {
      const sx = ix - 0.5;
      k.box(0.45, 0.18, 0.55, sx, 0.95, z + dz, 0xd6d0c4, 'none'); // slicer base
      k.cyl(0.17, 0.03, sx - 0.05, 1.3, z + dz, 0xd9dde1, 'z');
      k.box(0.3, 0.06, 0.3, sx - 0.12, 1.13, z + dz + 0.18, 0x9aa0a6, 'none'); // carriage
    }
    k.box(0.35, 0.1, 0.35, ix - 0.5, 0.95, z, 0xf4f6f8, 'none'); // scale
    k.panel(litMap(menuTex('DELI', [['HONEY HAM', '6.99/lb'], ['ROAST TURKEY', '7.49/lb'], ['SALAMI', '5.99/lb'], ['SWISS', '5.49/lb'], ['CHEDDAR', '4.99/lb'], ['POTATO SALAD', '3.49/lb']], '#8a2a2a')), 5, 1.25, ix - 0.02, 2.3, z, -Math.PI / 2);
    k.quad(toonMap(g, signTex('DELI', '#8a2a2a', '#fff6dc')), 4, 0.8, ix - 0.02, 3.3, z, -Math.PI / 2);
    for (const dz of [-2, 0, 2]) pendant(cx2, z + dz, 0x8a2a2a);
    // take a number
    k.box(0.05, 1.2, 0.05, cx2 - 0.8, 0, z + L / 2 + 0.4, 0x8a909c, 'none');
    k.box(0.16, 0.22, 0.12, cx2 - 0.8, 1.2, z + L / 2 + 0.4, 0xc8102e, 'none');
    out.cheese.push([...k.at(cx2 + 0.27, 1.47, z + 2.2)] as [number, number, number]);
  }

  // ---- wine and spirits along the right wall, a stack of soda cases, and the customer service desk ----
  {
    const z = 2.75, L = 7.5;
    k.box(0.9, 2.2, L, ix - 0.45, 0, z, 0x5a3a2a);
    k.quad(toonMap(g, productTex('wine')), L, 2.0, ix - 0.91, 0.12, z, -Math.PI / 2, 3.2);
    k.box(1.0, 0.08, L + 0.1, ix - 0.45, 2.2, z, 0x3a2418, 'none');
    k.quad(toonMap(g, signTex('WINE & SPIRITS', '#5a1a22', '#f4efe0')), 5, 0.94, ix - 0.02, 2.7, z, -Math.PI / 2);
    pallet(k, 19.3, 0, 2.8, 0);
    for (let l = 0; l < 3; l++) for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) k.box(0.52, 0.3, 0.44, 19.3 - 0.28 + a * 0.56, 0.18 + l * 0.3, 2.8 - 0.23 + b * 0.46, (l + a + b) % 2 ? 0xc8102e : 0x1f4a8a, 'none');
    k.collide(1.12, 1.08, 0.92, 19.3, 0, 2.8);
    k.box(0.03, 0.5, 0.03, 19.3, 1.08, 2.8, 0x8a909c, 'none');
    k.panel(toonMap(g, posterTex('2 FOR $5', 'SODA 12-PACKS', '#c8102e', '#ffffff')), 0.5, 0.62, 19.3, 1.85, 2.8, -Math.PI / 2);
    const sx = ix - 2.2, sz = 10.4;
    k.box(1.2, 1.1, 3.4, sx, 0, sz, 0xd6d0c4);
    k.box(1.3, 0.05, 3.5, sx, 1.1, sz, 0x3a3d42, 'none');
    k.box(0.4, 0.12, 0.4, sx + 0.2, 1.15, sz - 0.6, 0x2a2d33, 'none');
    k.tbox(0.36, 0.26, 0.04, sx + 0.2, 1.45, sz - 0.6, -0.3, 0x1f2128, Math.PI / 2);
    k.panel(litMap(signTex('CUSTOMER SERVICE', '#1f4a8a', '#ffffff')), 3.6, 0.68, sx, 3.2, sz, -Math.PI / 2);
    for (const dz of [-1.4, 1.4]) k.box(0.02, H - 3.54, 0.02, sx, 3.54, sz + dz, 0x8a909c, 'none', true);
  }

  // ---- checkouts across the front: belt, scanner, register and card reader, bag carousel, lane light, impulse rack ----
  {
    const candy = toonMap(g, productTex('candy'));
    const reg = litMap(screenTex('register')), term = litMap(screenTex('terminal'));
    const drinks = litMap(coolerTex('drinks'));
    [-15, -9.5, 9.5, 15].forEach((x, i) => {
      const z = laneZ;
      k.box(0.9, 0.9, 2.4, x, 0, z - 0.6, 0xd6d0c4);
      k.box(0.92, 0.12, 2.42, x, 0, z - 0.6, 0x3a3d42, 'none');
      k.box(0.66, 0.03, 2.3, x, 0.9, z - 0.6, 0x1f2128, 'none'); // belt
      for (const s of [-1, 1]) k.box(0.1, 0.06, 2.4, x + s * 0.39, 0.9, z - 0.6, 0xc9ced4, 'none');
      k.box(0.5, 0.05, 0.05, x, 0.93, z - 1.1, 0x5a8a3a, 'none'); // a divider stick on the belt
      k.box(0.9, 0.95, 0.7, x, 0, z + 0.95, 0xd6d0c4); // scan bed
      k.box(0.3, 0.02, 0.35, x - 0.12, 0.95, z + 0.95, 0x1f2128, 'none');
      k.box(0.4, 0.12, 0.42, x + 0.22, 0.95, z + 0.95, 0x2a2d33, 'none'); // register drawer
      k.box(0.04, 0.35, 0.04, x + 0.3, 1.07, z + 0.95, 0x3a3d42, 'none');
      k.tbox(0.05, 0.3, 0.38, x + 0.31, 1.52, z + 0.95, 0, 0x1f2128);
      k.panel(reg, 0.34, 0.26, x + 0.34, 1.52, z + 0.95, Math.PI / 2);
      k.box(0.03, 0.25, 0.03, x - 0.4, 0.9, z + 0.5, 0x3a3d42, 'none'); // card reader on its stalk
      k.tbox(0.12, 0.18, 0.05, x - 0.42, 1.2, z + 0.5, -0.5, 0x1f2128, -Math.PI / 2);
      k.panel(term, 0.09, 0.07, x - 0.447, 1.215, z + 0.5, -Math.PI / 2, -0.5);
      k.box(0.9, 0.75, 0.75, x, 0, z + 1.68, 0xd6d0c4); // bagging well and carousel
      k.cyl(0.03, 0.65, x, 0.75, z + 1.68, 0x8a909c);
      for (let b = 0; b < 3; b++) {
        const a = b * 2.1;
        k.box(0.26, 0.34, 0.2, x + Math.cos(a) * 0.2, 0.95, z + 1.68 + Math.sin(a) * 0.2, 0xf4f6f8, 'none');
      }
      // the lane light, numbered both ways
      const ln = litMap(laneTex(i + 1));
      k.box(0.05, 1.5, 0.05, x + 0.4, 0.9, z - 1.7, 0x8a909c, 'none');
      k.box(0.36, 0.36, 0.06, x + 0.4, 2.4, z - 1.7, 0x1f2128, 'none');
      k.panel(ln, 0.32, 0.32, x + 0.4, 2.58, z - 1.665, 0);
      k.panel(ln, 0.32, 0.32, x + 0.4, 2.58, z - 1.735, Math.PI);
      // the impulse rack along the queue, with a little drinks cooler at its end
      const rx = x - 1.5;
      k.box(0.4, 1.4, 2.0, rx, 0, z - 0.6, 0xcfd3d8);
      k.quad(candy, 2.0, 1.2, rx + 0.21, 0.12, z - 0.6, Math.PI / 2, 2.0);
      k.quad(candy, 2.0, 1.2, rx - 0.21, 0.12, z - 0.6, -Math.PI / 2, 2.0);
      k.box(0.5, 1.5, 0.5, rx, 0, z + 0.75, 0xf0f2f4);
      k.quad(drinks, 0.42, 1.2, rx + 0.255, 0.15, z + 0.75, Math.PI / 2, 1.6);
    });
    // self checkouts by the door
    const kiosk = litMap(screenTex('kiosk'));
    for (const x of [4.4, 6.2]) {
      const z = laneZ + 0.4;
      k.box(0.7, 0.85, 0.6, x, 0, z, 0xe9e3d4);
      k.box(0.5, 0.03, 0.4, x, 0.85, z, 0x1f2128, 'none');
      k.box(0.06, 0.6, 0.06, x, 0.85, z + 0.25, 0x3a3d42, 'none');
      k.tbox(0.46, 0.34, 0.05, x, 1.5, z + 0.25, -0.35, 0x1f2128, Math.PI);
      k.panel(kiosk, 0.4, 0.29, x, 1.51, z + 0.222, Math.PI, -0.35);
      k.box(0.55, 0.75, 0.45, x + 0.65, 0, z, 0x8a909c); // bagging stand
      k.box(0.5, 0.36, 0.3, x + 0.65, 0.75, z, 0xf4f6f8, 'none');
    }
    const sc = litMap(signTex('SELF CHECKOUT', '#2f6b4a', '#ffffff'));
    k.panel(sc, 3.0, 0.56, 5.6, 3.0, laneZ + 0.43, 0);
    k.panel(sc, 3.0, 0.56, 5.6, 3.0, laneZ + 0.37, Math.PI);
    for (const dx of [-1.2, 1.2]) k.box(0.02, H - 3.28, 0.02, 5.6 + dx, 3.28, laneZ + 0.4, 0x8a909c, 'none', true);
  }

  // ---- by the door: the mat, carts, a stack of baskets, a wet-floor sign down aisle 3, posters in the windows ----
  k.floor(toonMap(g, matTex()), 4.0, 2.0, 0, 0.03, D / 2 - 1.4, 4.0, 2.0);
  for (let i = 0; i < 4; i++) cart(k, -5.2 + i * 0.4 - 1.5, D / 2 - 2.0, 0);
  k.box(0.5, 0.45, 0.36, 3.0, 0, D / 2 - 1.3, 0xc8102e);
  for (let j = 0; j < 6; j++) k.box(0.52, 0.02, 0.38, 3.0, 0.08 + j * 0.07, D / 2 - 1.3, 0x8a0a1e, 'none');
  for (const s of [-1, 1]) k.tbox(0.34, 0.64, 0.02, -2.5, 0.3, -4 + s * 0.1, s * 0.18, 0xf2c230);
  ([
    [-19, posterTex('WEEKLY SPECIALS', 'SAVE MORE EVERY DAY', '#c8102e', '#ffffff')],
    [-13, posterTex('2 FOR $5', 'SELECT SNACKS', '#f2c230', '#c8102e')],
    [13, posterTex('FRESH CHEESE', 'CUT DAILY', '#2f6b4a', '#fff6dc')],
    [19, posterTex('NOW HIRING', 'ASK INSIDE', '#1f4a8a', '#ffffff')],
  ] as [number, THREE.CanvasTexture][]).forEach(([x, t]) => k.panel(toonMap(g, t), 0.85, 1.06, x, 1.7, D / 2 - 0.3, 0));

  // ---- outside the front: bollards, an ice chest, newspaper boxes, a bench, bins either side of the doors ----
  // things outside stand on the paved lot, a step or two below the store floor (local y 0)
  const lotY = (lx: number, lz: number) => {
    const [wx, , wz] = k.at(lx, 0, lz);
    return ctx.lotAt(wx, wz) - base;
  };
  for (let x = -W / 2 + 2; x <= W / 2 - 2; x += 3) if (Math.abs(x) > 3.6) bollard(k, x, lotY(x, D / 2 + 2.4), D / 2 + 2.4);
  iceChest(k, 8, lotY(8, D / 2 + 0.8), D / 2 + 0.75, g);
  for (let i = 0; i < 3; i++) {
    const x = -8.5 + i * 0.75;
    k.box(0.55, 1.05, 0.5, x, lotY(x, D / 2 + 0.7), D / 2 + 0.7, [0x2f6fb0, 0xd94f2a, 0xf2c230][i]); // newspaper boxes
  }
  k.box(2.2, 0.12, 0.5, -13, lotY(-13, D / 2 + 0.9) + 0.45, D / 2 + 0.9, 0x6a4a3a); // bench seat
  for (const dx of [-0.9, 0.9]) k.box(0.1, 0.45, 0.45, -13 + dx, lotY(-13, D / 2 + 0.9), D / 2 + 0.9, 0x2a2d33, 'none');
  for (const x of [-3.4, 3.4]) {
    const [wx, , wz] = k.at(x, 0, D / 2 + 1.0);
    out.props.push({ id: 'metal_trash_can', x: wx, z: wz, rot: 0, scale: 1.1 });
  }
  // a cart corral in front, with a couple of strays
  {
    const cz2 = D / 2 + 5.4;
    for (const cx2 of [-12, 12]) {
      const cy = lotY(cx2, cz2);
      k.box(0.08, 1.0, 5.0, cx2 - 0.85, cy, cz2, 0x8a909c, 'none');
      k.box(0.08, 1.0, 5.0, cx2 + 0.85, cy, cz2, 0x8a909c, 'none');
      k.box(1.78, 0.08, 0.08, cx2, cy + 1.0, cz2 - 2.5, 0x8a909c, 'none');
      k.collide(1.8, 1.0, 5.0, cx2, cy, cz2);
      for (let i = 0; i < 3; i++) cart(k, cx2, cz2 + 1.5 - i * 0.45, cy);
    }
    cart(k, -18, D / 2 + 8, lotY(-18, D / 2 + 8));
    cart(k, 17, D / 2 + 10.5, lotY(17, D / 2 + 10.5));
  }

  // ---- the loading dock on the east side: a raised platform, roll-up doors, dumpsters, a compactor, pallets ----
  {
    const sx = W / 2; // outside face of the side wall
    const dz0 = -D / 2 + 4;
    const gy = (lx: number, lz: number) => lotY(lx, lz);
    // the dock: a truck-height platform with black rubber bumpers, and two roll-up doors above it
    const dockY = gy(sx + 1.6, dz0 + 2.25), dockTop = dockY + 1.1;
    k.box(3.0, 1.1, 8.5, sx + 1.5, dockY, dz0 + 2.25, 0xb9b2a4);
    for (const dz of [dz0 - 1, dz0 + 1, dz0 + 3.5, dz0 + 5.5]) k.box(0.2, 0.45, 0.35, sx + 3.1, dockY + 0.45, dz, 0x1f2128, 'none');
    k.box(0.12, 0.08, 8.5, sx + 2.94, dockTop, dz0 + 2.25, 0xf2c230, 'none'); // safety edge
    for (const dz of [dz0, dz0 + 4.5]) {
      k.box(0.08, 3.0, 3.2, sx + 0.04, dockTop, dz, 0x9aa0a6, 'none');
      for (let y = dockTop + 0.3; y < dockTop + 3.0; y += 0.35) k.box(0.1, 0.04, 3.2, sx + 0.06, y, dz, 0x6a7078, 'none');
      k.box(0.15, 0.3, 3.5, sx + 0.08, dockTop + 3.0, dz, 0x2a2d33, 'none');
    }
    // dumpsters, a compactor and pallets behind the dock
    dumpster(k, sx + 5.5, gy(sx + 5.5, -D / 2 + 1.6), -D / 2 + 1.6, true, 0x2f6b4a, out);
    dumpster(k, sx + 8.2, gy(sx + 8.2, -D / 2 + 1.6), -D / 2 + 1.6, true, 0x35506b, out);
    {
      const x = sx + 5.0, z = dz0 + 11, y = gy(x, z);
      k.box(2.4, 2.2, 4.2, x, y, z, 0x5a6470); // compactor
      k.box(1.6, 1.0, 1.0, x, y + 2.2, z + 1.4, 0x3a4048, 'ground');
      k.box(2.5, 0.2, 0.2, x, y + 1.3, z - 2.12, 0xf2c230, 'none');
    }
    for (let i = 0; i < 4; i++) {
      const x = sx + 4.2 + (i % 2) * 1.4, z = dz0 + 4 + Math.floor(i / 2) * 1.2;
      pallet(k, x, gy(x, z), z, i === 3 ? 0 : 1 + (i % 2) * 0.6);
    }
    for (let i = 0; i < 3; i++) {
      const [wx, , wz] = k.at(sx + 7.5, 0, dz0 + 3 + i * 0.7);
      out.props.push({ id: 'cardboard_box_01', x: wx, z: wz, rot: i * 0.7, scale: 1.4 });
    }
    const [bx, , bz] = k.at(sx + 7.6, 0, -D / 2 + 3.4);
    out.props.push({ id: 'trashbag', x: bx, z: bz, rot: 0.4, scale: 1.2 });
    const [bx2, , bz2] = k.at(sx + 8.4, 0, -D / 2 + 3.6);
    out.props.push({ id: 'trashbag', x: bx2, z: bz2, rot: 2.1, scale: 1.1 });
  }

  // the parking lot: stalls in two rows facing a drive aisle, and lights down the aisle
  if (st.stalls) {
    parking(st.stalls, ctx, ctx.gradient, out.cars);
    const [sx0, sz0, sx1, sz1] = st.stalls;
    const mz = (sz0 + sz1) / 2;
    for (let x = sx0 + 10; x < sx1 - 5; x += 22) out.lamps.push({ x, z: mz, yaw: 0 });
  }
  out.footprints.push([[x0, z0], [x1, z0], [x1, z1], [x0, z1]]);
  k.finish(g, out.doors);
}

/** a double-sided shelving gondola along local z: stocked both faces, endcaps at both ends, overstock cases on top */
function gondola(k: Kit, g: THREE.DataTexture, x: number, z0: number, z1: number, h: number, left: Goods, right: Goods, ends: Goods[], rand: () => number, opts: { overstock?: boolean; sale?: boolean; skipTop?: number } = {}): void {
  const len = z1 - z0, mz = (z0 + z1) / 2;
  k.box(1.1, h, len, x, 0, mz, 0xcfd3d8);
  k.box(1.22, 0.14, len + 0.02, x, 0, mz, 0x3a3d42, 'none'); // the base deck's kick plate
  k.box(1.2, 0.05, len + 0.1, x, h, mz, 0x8a909c, 'none');
  k.quad(toonMap(g, productTex(right)), len, h - 0.2, x + 0.56, 0.15, mz, Math.PI / 2, 3.2);
  k.quad(toonMap(g, productTex(left)), len, h - 0.2, x - 0.56, 0.15, mz, -Math.PI / 2, 3.2);
  const sale = toonMap(g, posterTex('SALE', 'SAVE NOW', '#c8102e', '#ffd23a'));
  ([[z1, 1], [z0, -1]] as const).forEach(([ez, dir], i) => {
    const ec = ez + dir * 0.25;
    k.box(1.1, h, 0.5, x, 0, ec, 0xcfd3d8);
    k.box(1.22, 0.14, 0.52, x, 0, ec, 0x3a3d42, 'none');
    k.quad(toonMap(g, productTex(ends[i % ends.length])), 1.04, h - 0.2, x, 0.15, ez + dir * 0.505, dir > 0 ? 0 : Math.PI, 3.2);
    if (opts.sale) {
      k.box(0.03, 0.3, 0.03, x, h, ec, 0x8a909c, 'none');
      k.panel(sale, 0.4, 0.5, x, h + 0.55, ec, dir > 0 ? 0 : Math.PI);
    }
  });
  if (opts.overstock) {
    for (let z = z0 + 0.8; z < z1 - 0.8; z += 1.3 + rand() * 1.2) {
      if ((opts.skipTop !== undefined && Math.abs(z - opts.skipTop) < 1.4) || rand() < 0.4) continue;
      const c = new THREE.Color(0xc6a272).multiplyScalar(0.8 + rand() * 0.25).getHex();
      k.box(0.6 + rand() * 0.35, 0.3 + rand() * 0.35, 0.5 + rand() * 0.4, x + (rand() - 0.5) * 0.2, h + 0.05, z, c, 'float');
    }
  }
}

function cart(k: Kit, x: number, z: number, y: number): void {
  const red = 0xc8102e, wire = 0x9aa0a6;
  k.box(0.6, 0.45, 0.9, x, y + 0.45, z, wire, 'ground');
  k.box(0.62, 0.05, 0.05, x, y + 1.0, z + 0.5, red, 'none'); // handle
  for (const [dx, dz] of [[-0.25, -0.38], [0.25, -0.38], [-0.25, 0.38], [0.25, 0.38]]) k.box(0.04, 0.45, 0.04, x + dx, y, z + dz, 0x2a2d33, 'none');
}

/** painted stalls: two facing rows of 2.8 m bays along the lot's long side; some of them taken */
function parking(r: Rect, ctx: StoreCtx, gradient: THREE.DataTexture, cars: Spot[]): void {
  const [x0, z0, x1, z1] = r;
  const geos: THREE.BufferGeometry[] = [];
  const line = (ax: number, az: number, bx: number, bz: number) => {
    const L = Math.hypot(bx - ax, bz - az), mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const g = new THREE.PlaneGeometry(0.14, L).rotateX(-Math.PI / 2).rotateY(-Math.atan2(bx - ax, bz - az));
    g.translate(mx, ctx.lotAt(mx, mz) + 0.02, mz);
    geos.push(g);
  };
  const along = x1 - x0 >= z1 - z0;
  const [a0, a1, b0, b1] = along ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  const P = (a: number, b: number): [number, number] => (along ? [a, b] : [b, a]);
  const depth = 5.4;
  [[b0, b0 + depth], [b1 - depth, b1]].forEach(([s0, s1], row) => {
    for (let a = a0; a <= a1 + 1e-3; a += 2.8) {
      line(...P(a, s0), ...P(a, s1));
      if (a + 2.8 <= a1 + 1e-3 && ctx.rand() < 0.45) {
        const [x, z] = P(a + 1.4, (s0 + s1) / 2);
        // nose in to the bay, toward the aisle-side edge's opposite (cars back out into the aisle)
        const yaw = (along ? 0 : Math.PI / 2) + (row ? 0 : Math.PI) + (ctx.rand() - 0.5) * 0.08;
        cars.push({ x, y: ctx.lotAt(x, z), z, yaw });
      }
    }
  });
  if (!geos.length) return;
  const mat = new THREE.MeshToonMaterial({ color: 0xf4f1e6, gradientMap: gradient });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = mat.polygonOffsetUnits = -3;
  const mesh = new THREE.Mesh(mergeGeometries(geos, false)!, mat);
  mesh.receiveShadow = true;
  ctx.group.add(mesh);
}

// ------------------------------------------------------------------------------------------------
// gas stations
// ------------------------------------------------------------------------------------------------

const BRAND: Record<string, [number, string]> = { 'CHEDDAR GAS': [0xe8a81c, '#e8a81c'], 'QUIK RAT': [0x2f6fb0, '#2f6fb0'], RATCO: [0xc8102e, '#c8102e'] };

function buildGas(st: StoreSpec, ctx: StoreCtx, out: StoresBuilt): void {
  const [brandHex, brandCss] = BRAND[st.name] ?? [0x2f7a8a, '#2f7a8a'];
  const g = ctx.gradient;
  const world = new Kit(0, 0, 0, 0, ctx); // world-frame pieces: canopy, islands, pumps, pylon

  // ---- the shop ----
  const [x0, z0, x1, z1] = st.rect;
  const ns = st.door === 'n' || st.door === 's';
  const W = ns ? x1 - x0 : z1 - z0, D = ns ? z1 - z0 : x1 - x0, H = 4.4;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const base = Math.max(...[[x0, z0], [x1, z0], [x0, z1], [x1, z1]].map(([x, z]) => ctx.lotAt(x, z))) + 0.12;
  const k = new Kit(cx, cz, base, YAW[st.door], ctx);
  shell(k, W, D, H, { x: -W / 2 + 3, w: 2.2 }, 0xf4f1e6, brandHex, g, 3.0, { floor: 'gas', ceiling: 0xe6e3da });
  steps(k, ctx, D / 2, -W / 2 + 3, 2.2, base);
  k.quad(toonMap(g, signTex(st.name, brandCss, '#ffffff', 'FOOD MART')), W - 1, 1.2, 0, 3.1, D / 2 + 0.2);
  const ix = W / 2 - 0.35, iz = D / 2 - 0.35; // inside faces of the walls
  const doorX = -W / 2 + 3;

  // ---- a suspended ceiling with flat troffer lights in its grid ----
  k.ceil(litMap(ceilingTex()), W - 0.7, D - 0.7, 0, H - 0.06, 0, 1.2);
  for (let x = -W / 2 + 1.9; x < W / 2 - 1; x += 2.4) for (const z of [-2.4, 0.6, 3.0]) {
    k.glowBox(0.56, 0.02, 1.16, x, H - 0.075, z);
    k.box(0.62, 0.01, 1.22, x, H - 0.07, z, 0xf4f4f2, 'none', true);
  }

  // ---- coolers along the back wall, drinks and a beer section, under a lit header ----
  {
    const cx2 = (-ix + 3.6) / 2, cl = 3.6 + ix, cz2 = -D / 2 + 0.85, face = cz2 + 0.51;
    k.box(cl, 2.4, 1.0, cx2, 0, cz2, 0xf0f2f4);
    const split = -0.6;
    k.quad(litMap(coolerTex('drinks')), split + ix - 0.05, 2.0, (-ix + split) / 2, 0.18, face, 0, 3.0);
    k.quad(litMap(coolerTex('beer')), 3.6 - split - 0.05, 2.0, (split + 3.6) / 2, 0.18, face, 0, 3.0);
    k.box(cl, 0.42, 0.12, cx2, 2.4, face - 0.04, brandHex, 'none');
    k.glowBox(cl - 0.2, 0.04, 0.05, cx2, 2.36, face + 0.02);
    k.quad(toonMap(g, signTex('COLD DRINKS', brandCss, '#ffffff')), 2.2, 0.4, (-ix + split) / 2, 2.41, face + 0.03);
    k.quad(toonMap(g, signTex('COLD BEER', brandCss, '#ffffff')), 2.2, 0.4, (split + 3.6) / 2, 2.41, face + 0.03);
  }
  // the back-room door and the restroom
  k.quad(toonMap(g, doorTex('EMPLOYEES ONLY', '#6a4a3a')), 0.95, 2.1, 5.3, 0, -iz + 0.02);
  k.quad(toonMap(g, doorTex('RESTROOM', '#3a5a7a')), 0.95, 2.1, ix - 0.02, 0, -2.9, -Math.PI / 2);

  // ---- the counter, along the right side: register, card reader, scratch-offs, roller grill, the tobacco wall behind ----
  {
    const cx2 = 4.2, cz2 = 1.5, L = 4.2;
    k.box(0.9, 0.95, L, cx2, 0, cz2, 0xd6d0c4);
    k.box(1.0, 0.05, L + 0.1, cx2, 0.95, cz2, 0x3a3d42);
    k.box(0.92, 0.12, L + 0.02, cx2, 0, cz2, 0x2a2d33, 'none');
    k.quad(toonMap(g, productTex('candy')), L - 0.2, 0.7, cx2 - 0.455, 0.15, cz2, -Math.PI / 2, 2.0); // the impulse rack on its front
    k.box(2.0, 0.95, 0.7, 5.65, 0, 3.95, 0xd6d0c4); // the return, by the window
    k.box(2.0, 0.05, 0.75, 5.65, 0.95, 3.95, 0x3a3d42);
    // register: drawer, the clerk's screen, the customer's little display
    k.box(0.42, 0.12, 0.45, 4.45, 1.0, 1.7, 0x2a2d33, 'none');
    k.box(0.04, 0.3, 0.04, 4.5, 1.12, 1.7, 0x3a3d42, 'none');
    k.tbox(0.38, 0.3, 0.05, 4.52, 1.55, 1.7, -0.3, 0x1f2128, Math.PI / 2);
    k.panel(litMap(screenTex('register')), 0.34, 0.26, 4.545, 1.557, 1.7, Math.PI / 2, -0.3);
    k.tbox(0.2, 0.12, 0.04, 4.2, 1.2, 1.7, -0.2, 0x1f2128, -Math.PI / 2);
    // card reader, customer side
    k.box(0.03, 0.12, 0.03, 3.95, 1.0, 1.05, 0x3a3d42, 'none');
    k.tbox(0.12, 0.18, 0.05, 3.93, 1.2, 1.05, -0.5, 0x1f2128, -Math.PI / 2);
    k.panel(litMap(screenTex('terminal')), 0.09, 0.07, 3.903, 1.215, 1.05, -Math.PI / 2, -0.5);
    // scratch-off dispenser
    k.box(0.35, 0.45, 1.2, 4.35, 1.0, 0.25, 0x1f2128, 'none');
    k.panel(litMap(lotteryTex()), 1.15, 0.4, 4.172, 1.23, 0.25, -Math.PI / 2);
    // candy and gum by the register, a tip jar
    k.box(0.4, 0.22, 0.7, 4.0, 1.0, 2.4, 0xcfd3d8, 'none');
    k.quad(toonMap(g, productTex('candy')), 0.7, 0.2, 3.795, 1.01, 2.4, -Math.PI / 2, 2.0);
    k.cyl(0.07, 0.18, 4.25, 1.0, 2.3, 0xcfe3ea);
    // roller grill under a sneeze guard
    k.box(0.6, 0.14, 0.9, 4.2, 1.0, 3.15, 0xc9ced4, 'none');
    for (let i = 0; i < 8; i++) {
      const rz = 2.8 + i * 0.1;
      k.cyl(0.02, 0.5, 4.2, 1.16, rz, 0x8a909c, 'x', 0.02, 6);
      if (i % 3 !== 2) k.cyl(0.028, 0.16, 4.2 + ((i * 37) % 5 - 2) * 0.07, 1.19, rz, 0xb5523a, 'x', 0.028, 6);
    }
    k.tpane(0.9, 0.3, 4.0, 1.38, 3.15, -Math.PI / 2, -0.4);
    k.panel(litMap(signTex('HOT DOGS 2/$3', '#c8102e', '#ffffff')), 0.8, 0.15, 3.89, 1.08, 3.15, -Math.PI / 2);
    out.cheese.push([...k.at(cx2, 1.07, -0.35)] as [number, number, number]);
    // the tobacco wall behind the clerk, and the lotto jackpot board over it
    k.box(0.45, 2.6, L, ix - 0.225, 0, cz2, 0x22252b);
    k.quad(toonMap(g, tobaccoTex()), L - 0.1, 2.3, ix - 0.455, 0.2, cz2, -Math.PI / 2, L - 0.1);
    k.panel(litMap(menuTex('LOTTO', [['JACKPOT', '$212 MILLION'], ['MEGA PICK', '$148 MILLION'], ['DAILY 4', '$5,000']], '#c8102e')), 3.0, 0.9, ix - 0.02, 3.3, cz2, -Math.PI / 2);
  }

  // ---- two snack gondolas down the middle, endcaps toward the door ----
  const gz0 = -1.9, gz1 = 1.6;
  gondola(k, g, -2.6, gz0, gz1, 1.5, 'snacks', 'candy', ['snacks', 'drinks'], ctx.rand, { sale: true });
  gondola(k, g, 0.6, gz0, gz1, 1.5, 'groceries', 'household', ['candy', 'snacks'], ctx.rand, { sale: true });

  // ---- the coffee bar along the left wall: brewer and pots, cups, cappuccino, the fountain, the slush machine ----
  {
    const bx = -ix + 0.4, bz = -0.5, L = 5.4;
    k.box(0.8, 0.9, L, bx, 0, bz, 0x6a4a3a);
    k.box(0.85, 0.05, L + 0.05, bx, 0.9, bz, 0x2a2d33);
    const top = 0.95;
    // brewer with three pots on their warmers
    k.box(0.5, 0.75, 1.1, bx - 0.1, top, -2.5, 0x2a2d33);
    k.panel(toonMap(g, signTex('FRESH COFFEE', '#6a3a1a', '#f4efe0')), 1.0, 0.19, bx + 0.155, top + 0.6, -2.5, Math.PI / 2);
    for (let i = 0; i < 3; i++) {
      const pz = -2.85 + i * 0.35;
      k.cyl(0.09, 0.02, bx + 0.15, top, pz, 0x1f2128);
      k.cyl(0.08, 0.2, bx + 0.15, top + 0.02, pz, i === 1 ? 0xe8742a : 0x3a2418, 'y', 0.06);
      k.box(0.03, 0.12, 0.03, bx + 0.25, top + 0.06, pz, 0x1f2128, 'none');
    }
    // cups in three sizes, and lids
    [0.045, 0.055, 0.065].forEach((r, i) => k.cyl(r, 0.35, bx + 0.1, top, -1.7 + i * 0.17, 0xf4f1e6, 'y', r * 1.1));
    k.cyl(0.06, 0.15, bx + 0.1, top, -1.2, 0x1f2128);
    // cappuccino machine
    k.box(0.45, 0.65, 0.5, bx - 0.05, top, -0.6, 0x3a3d42);
    k.panel(litMap(screenTex('kiosk')), 0.3, 0.22, bx + 0.18, top + 0.45, -0.6, Math.PI / 2);
    // fountain drinks, with the ice bin on top
    k.box(0.6, 1.0, 1.0, bx - 0.02, top, 0.4, 0xc9ced4);
    k.panel(litMap(fountainTex()), 0.95, 0.95, bx + 0.285, top + 0.5, 0.4, Math.PI / 2);
    k.box(0.5, 0.2, 0.9, bx - 0.05, top + 1.0, 0.4, 0x2a2d33, 'none');
    // slush machine: two churning bowls
    k.box(0.5, 0.35, 0.8, bx - 0.05, top, 1.6, 0x2a2d33, 'none');
    [[1.4, 0x3a7ac0], [1.8, 0xd9302a]].forEach(([z, c]) => {
      k.cyl(0.17, 0.45, bx - 0.05, top + 0.35, z, c, 'y', 0.15);
      k.cyl(0.16, 0.08, bx - 0.05, top + 0.8, z, 0xf4f6f8);
    });
    k.collide(0.8, 1.95, L, bx, 0, bz);
    k.panel(litMap(menuTex('HOT & COLD', [['COFFEE', '1.29'], ['CAPPUCCINO', '1.79'], ['FOUNTAIN', '0.99'], ['SLUSH', '1.49']], '#6a3a1a')), 3.4, 1.0, -ix + 0.02, 2.7, bz, Math.PI / 2);
    // a bin by the end of the bar
    k.cyl(0.25, 0.9, -ix + 0.4, 0, 2.85, brandHex);
    k.cyl(0.26, 0.06, -ix + 0.4, 0.9, 2.85, 0x2a2d33);
  }

  // ---- along the front windows: an ice cream chest, the ATM; the mat inside the door; posters on the glass ----
  {
    const cx2 = -0.6, cz2 = 4.1;
    k.box(2.0, 0.85, 0.85, cx2, 0, cz2, 0xf4f6f8);
    k.panel(litMap(coolerTex('frozen')), 1.85, 0.7, cx2, 0.8, cz2, 0, -Math.PI / 2);
    k.tpane(1.95, 0.8, cx2, 0.87, cz2, 0, -Math.PI / 2);
    k.quad(toonMap(g, signTex('ICE CREAM', '#d94f8a', '#ffffff')), 1.2, 0.22, cx2, 0.5, cz2 - 0.43, Math.PI);
    k.box(0.7, 1.6, 0.6, 2.4, 0, iz - 0.4, 0x2a3a5a); // the ATM, facing into the shop
    k.panel(litMap(atmTex()), 0.6, 1.2, 2.4, 1.0, iz - 0.71, Math.PI);
  }
  k.floor(toonMap(g, matTex()), 2.2, 1.2, doorX, 0.03, iz - 0.75, 2.2, 1.2);
  k.box(0.18, 0.12, 0.14, ix - 0.1, H - 0.4, iz - 0.1, 0x1f2128, 'none', true); // a security camera
  k.ball(0.25, -ix + 0.3, H - 0.6, -iz + 0.3, 0xc9ced4); // the round mirror in the corner
  ([
    [-1.3, posterTex('COLD BEER', '2 FOR $12', '#1f3a6a', '#ffffff')],
    [1.0, posterTex('LOTTO', 'PLAY HERE', '#c8102e', '#ffd23a')],
    [5.6, posterTex('ATM INSIDE', 'NO FEE MEMBERS', '#2f7a3a', '#ffffff')],
  ] as [number, THREE.CanvasTexture][]).forEach(([x, t]) => k.panel(toonMap(g, t), 0.7, 0.88, x, 1.6, D / 2 - 0.3, 0));

  // ---- round the shop: bollards along the windows, ice, propane, the air machine, a dumpster behind ----
  const lotY = (lx: number, lz: number) => {
    const [wx, , wz] = k.at(lx, 0, lz);
    return ctx.lotAt(wx, wz) - base;
  };
  for (let x = -W / 2 + 5; x <= W / 2 - 1; x += 2.4) bollard(k, x, lotY(x, D / 2 + 1.3), D / 2 + 1.3);
  iceChest(k, W / 2 - 2.0, lotY(W / 2 - 2, D / 2 + 0.75), D / 2 + 0.7, g);
  {
    // propane exchange: a steel cage of tanks
    const x = 1.2, z = D / 2 + 0.75, y = lotY(x, z);
    k.box(1.9, 1.5, 0.8, x, y, z, 0x8a909c, 'ground');
    for (let i = 0; i < 4; i++) k.box(0.32, 0.55, 0.32, x - 0.6 + i * 0.4, y + 0.08, z, 0xf4f1e6, 'none');
    for (let i = 0; i < 4; i++) k.box(0.32, 0.55, 0.32, x - 0.6 + i * 0.4, y + 0.75, z, 0xf4f1e6, 'none');
    k.box(1.92, 0.3, 0.06, x, y + 1.3, z + 0.42, 0xc8102e, 'none');
  }
  {
    // the air & water machine against the side wall
    const x = -W / 2 - 0.6, z = D / 2 - 2.0, y = lotY(x, z);
    k.box(0.6, 1.5, 0.5, x, y, z, 0xc8102e);
    k.box(0.5, 0.3, 0.06, x, y + 1.0, z + 0.26, 0x1f2128, 'none');
    k.box(0.12, 0.6, 0.12, x - 0.35, y + 0.4, z, 0x1f2128, 'none');
  }
  // a dumpster and stacked tyres behind the shop, oil drums by the side
  dumpster(k, -1.0, lotY(-1.0, -D / 2 - 1.3), -D / 2 - 1.3, true, BRAND[st.name]?.[0] === 0x2f6fb0 ? 0x2f6b4a : 0x35506b, out);
  for (let i = 0; i < 4; i++) k.box(0.62, 0.2, 0.62, 3.0, lotY(3.0, -D / 2 - 1.2) + i * 0.2, -D / 2 - 1.2, 0x1f1d22); // tyres, stacked
  for (const dz of [-1.2, -0.5]) {
    const [wx, , wz] = k.at(W / 2 + 0.7, 0, dz);
    out.props.push({ id: 'Barrel_01', x: wx, z: wz, rot: dz, scale: 1.0 });
  }
  out.footprints.push([[x0, z0], [x1, z0], [x1, z1], [x0, z1]]);
  k.finish(g, out.doors);

  // ---- the canopy over the pumps ----
  if (st.canopy) {
    const [a0, b0, a1, b1] = st.canopy;
    const ccx = (a0 + a1) / 2, ccz = (b0 + b1) / 2;
    const y = Math.max(...[[a0, b0], [a1, b0], [a0, b1], [a1, b1]].map(([x, z]) => ctx.lotAt(x, z)));
    const w = a1 - a0, d = b1 - b0;
    world.box(w, 0.9, d, ccx, y + 5.2, ccz, 0xf4f1e6, 'float');
    world.box(w + 0.1, 0.5, d + 0.1, ccx, y + 5.45, ccz, brandHex, 'none'); // fascia band
    for (let x = a0 + 2.5; x < a1 - 1; x += 4) for (const z of [ccz - d / 4, ccz + d / 4]) world.light(2.0, 0.6, x, y + 5.17, z);
    for (const [px, pz] of [[a0 + 1.4, ccz], [a1 - 1.4, ccz]]) world.box(0.55, 5.2, 0.55, px, ctx.lotAt(px, pz), pz, 0xd6d0c4);
  }
  for (const r of st.islands ?? []) {
    const [a0, b0, a1, b1] = r;
    const mx = (a0 + a1) / 2, mz = (b0 + b1) / 2;
    world.box(a1 - a0, 0.2, b1 - b0, mx, ctx.lotAt(mx, mz), mz, 0xc4c0b4);
    for (const ex of [a0 + 0.3, a1 - 0.3]) world.box(0.18, 0.9, 0.18, ex, ctx.lotAt(ex, mz) + 0.2, mz, 0xf2c230); // bollards
    // a bin and a squeegee bucket on the island, between the pumps
    out.props.push({ id: 'metal_trash_can', x: mx, z: mz, rot: 0, scale: 0.9 });
    world.box(0.32, 0.4, 0.32, mx + 1.0, ctx.lotAt(mx + 1.0, mz) + 0.2, mz, 0x2f6fb0);
    world.box(0.04, 0.7, 0.04, mx + 1.05, ctx.lotAt(mx + 1.0, mz) + 0.6, mz, 0x1f2128, 'none'); // squeegee handle
  }
  // a vacuum station at the far end of the forecourt
  if (st.canopy) {
    const [a0, b0, a1, b1] = st.lot;
    const vx = a0 + 1.4 < st.rect[0] ? a0 + 1.4 : a1 - 1.4, vz = (b0 + b1) / 2;
    const y = ctx.lotAt(vx, vz);
    world.box(0.9, 1.6, 0.9, vx, y, vz, BRAND[st.name]?.[0] ?? 0x2f7a8a);
    world.box(0.1, 1.6, 0.1, vx, y + 1.6, vz, 0x8a909c, 'none');
    world.box(1.4, 0.1, 0.1, vx, y + 3.2, vz, 0x8a909c, 'none');
  }
  const screen = toonMap(g, pumpScreenTex());
  (st.pumps ?? []).forEach(([px, pz], i) => {
    // every other pump has a car filling up beside it, on the outside of the island
    if (i % 3 === 0) {
      const outward = i % 2 ? 1 : -1;
      const cz2 = pz + outward * 2.6;
      out.cars.push({ x: px, y: ctx.lotAt(px, cz2), z: cz2, yaw: Math.PI / 2 });
    }
    const y = ctx.lotAt(px, pz) + 0.2;
    world.box(1.0, 1.75, 0.55, px, y, pz, brandHex);
    world.box(1.05, 0.3, 0.6, px, y + 1.75, pz, 0xf4f1e6, 'none');
    for (const s of [-1, 1]) {
      world.quad(screen, 0.42, 0.62, px, y + 0.95, pz + s * 0.285, s > 0 ? 0 : Math.PI);
      world.box(0.06, 0.9, 0.06, px + 0.55, y + 0.4, pz + s * 0.2, 0x1f2128, 'none'); // hose
    }
  });
  if (st.pylon) {
    const [px, pz] = st.pylon;
    const y = ctx.lotAt(px, pz);
    world.box(0.35, 7, 0.35, px, y, pz, 0x5a5f6a);
    world.box(2.5, 3.2, 0.35, px, y + 4.4, pz, 0x1f2128); // climbable: a rat can scramble up onto the sign
    const price = toonMap(g, priceTex(st.name, brandCss));
    for (const s of [-1, 1]) world.quad(price, 2.3, 2.9, px, y + 4.55, pz + s * 0.18, s > 0 ? 0 : Math.PI);
    out.cheese.push([px, y + 7.6, pz]);
  }
  world.finish(g);
}

/** if the floor sits above the paved lot at the doorway, a few concrete steps up to it */
function steps(k: Kit, ctx: StoreCtx, frontZ: number, doorX: number, doorW: number, base: number): void {
  const [wx, , wz] = k.at(doorX, 0, frontZ + 0.6);
  const rise = base - ctx.lotAt(wx, wz);
  const n = Math.ceil(Math.max(0, rise - 0.05) / 0.18);
  for (let i = 1; i <= n; i++) k.box(doorW + 1.2, 0.2, 0.55, doorX, -(rise * i) / (n + 1) - 0.2, frontZ + 0.1 + i * 0.55 - 0.27, 0xc4c0b4);
}

export function buildStores(stores: StoreSpec[], ctx: StoreCtx): StoresBuilt {
  const out: StoresBuilt = { cheese: [], footprints: [], cars: [], props: [], lamps: [], doors: [] };
  for (const st of stores) {
    if (st.kind === 'grocery') buildGrocery(st, ctx, out);
    else buildGas(st, ctx, out);
  }
  // the parked cars: drawn instanced, and solid enough for a rat to climb onto the roof
  ctx.group.add(parkedCars(out.cars, ctx.gradient, 3));
  for (const c of out.cars) {
    const along = Math.abs(Math.cos(c.yaw)) > 0.5; // nose along z
    const hx = (along ? PARKED_SIZE.wid : PARKED_SIZE.len) / 2, hz = (along ? PARKED_SIZE.len : PARKED_SIZE.wid) / 2;
    ctx.addBox({ minX: c.x - hx, maxX: c.x + hx, minZ: c.z - hz, maxZ: c.z + hz, top: c.y + PARKED_SIZE.top });
  }
  return out;
}
