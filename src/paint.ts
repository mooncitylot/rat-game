import * as THREE from 'three';

const INK = '#14121c';

function canvasTex(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.Texture(); // node (tests)
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export const SHOP_NAMES = [
  'NOODLE BAR', 'PIZZA', 'CHEESE & CO', 'LAUNDROMAT', 'BAKERY', 'VINYL', 'DELI', 'PHARMACY', 'HARDWARE', 'DUMPLINGS',
  'BOOKS', 'PHO 99', 'CAFE', 'TAILOR', 'FLOWERS', 'ARCADE', 'BUTCHER', 'SUSHI', 'TACOS', 'FISH & CHIPS',
];
const SIGN_COLORS: [string, string][] = [
  ['#e8452e', '#fff3d6'], ['#1f6f8b', '#ffe9a8'], ['#f2c230', '#1b1a2e'], ['#2c3a6b', '#ffd7e0'],
  ['#3f8a5a', '#fff3d6'], ['#fff3d6', '#c8321f'], ['#8a3a6a', '#ffe9a8'], ['#14121c', '#ffd23a'],
];

export function makeSign(text: string, pair: number): THREE.Texture {
  const [bg, fg] = SIGN_COLORS[pair % SIGN_COLORS.length];
  return canvasTex(512, 128, (ctx) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, 492, 108);
    ctx.font = '900 76px Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 76;
    while (ctx.measureText(text).width > 440 && size > 30) {
      size -= 4;
      ctx.font = `900 ${size}px Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif`;
    }
    // a hard ink shadow behind light lettering; dark lettering stays crisp without one
    const l = parseInt(fg.slice(1, 3), 16) * 0.299 + parseInt(fg.slice(3, 5), 16) * 0.587 + parseInt(fg.slice(5, 7), 16) * 0.114;
    if (l > 140) {
      ctx.lineWidth = 8;
      ctx.strokeStyle = INK;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, 258, 70);
    }
    ctx.fillStyle = fg;
    ctx.fillText(text, 256, 66);
  });
}

const PALETTES = [
  ['#f2c230', '#e8452e', '#1f6f8b', '#fff3d6', '#8a3a6a'],
  ['#3f8a5a', '#f2c230', '#e86a8a', '#fff3d6', '#2c3a6b'],
  ['#e8452e', '#2c3a6b', '#f2a23a', '#bfe3d0', '#14121c'],
  ['#8a3a6a', '#f2c230', '#3fb0a8', '#fff3d6', '#e8452e'],
];

function rnd(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** Bold flat street-art murals: big shapes, thick ink outlines. */
export function makeMural(seed: number): THREE.Texture {
  const r = rnd(seed * 7919 + 13);
  const pal = PALETTES[seed % PALETTES.length];
  return canvasTex(768, 384, (ctx) => {
    const W = 768, H = 384;
    ctx.fillStyle = pal[3];
    ctx.fillRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 7;
    ctx.strokeStyle = INK;

    // background bands
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = pal[Math.floor(r() * pal.length)];
      ctx.beginPath();
      const y = (H / 4) * i;
      ctx.moveTo(0, y);
      for (let x = 0; x <= W; x += 48) ctx.lineTo(x, y + Math.sin(x * 0.02 + i * 2) * 22 + 10);
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.fill();
    }
    // a big sun / moon
    ctx.fillStyle = pal[0];
    ctx.beginPath();
    ctx.arc(W * (0.2 + r() * 0.6), H * 0.38, 78 + r() * 40, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // triangles (cheese!) and stars
    for (let i = 0; i < 4; i++) {
      const cx = r() * W, cy = H * (0.45 + r() * 0.45), s = 36 + r() * 54;
      ctx.fillStyle = pal[Math.floor(r() * pal.length)];
      ctx.beginPath();
      ctx.moveTo(cx, cy - s);
      ctx.lineTo(cx + s, cy + s * 0.7);
      ctx.lineTo(cx - s, cy + s * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = INK;
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.arc(cx + (k - 1) * s * 0.4, cy + s * 0.2 + (k % 2) * 10, s * 0.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // a rat in the middle
    const rx = W * (0.3 + r() * 0.4), ry = H * 0.68, k = 1.2 + r() * 0.6;
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.ellipse(rx, ry, 70 * k, 38 * k, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rx + 62 * k, ry - 14 * k, 26 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rx + 50 * k, ry - 38 * k, 13 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(rx - 68 * k, ry);
    ctx.bezierCurveTo(rx - 130 * k, ry + 10 * k, rx - 120 * k, ry - 60 * k, rx - 170 * k, ry - 40 * k);
    ctx.stroke();
    ctx.fillStyle = pal[1];
    ctx.beginPath();
    ctx.arc(rx + 74 * k, ry - 16 * k, 5 * k, 0, Math.PI * 2);
    ctx.fill();
    // paint drips along the top edge
    ctx.fillStyle = pal[2];
    for (let x = 20; x < W; x += 60 + r() * 40) {
      ctx.fillRect(x, 0, 12, 20 + r() * 50);
    }
  });
}
