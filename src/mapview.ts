import type { World } from './world';

type Pt = [number, number];

/** Full-screen city map: click anywhere (or a place button) to teleport. North is up. */
export class MapView {
  readonly el = document.createElement('div');
  private cv = document.createElement('canvas');
  private ctx = this.cv.getContext('2d')!;
  private base = document.createElement('canvas');
  private W = 1200;
  private H = 720;
  private hover: Pt | null = null;
  open = false;

  constructor(private map: NonNullable<World['map']>, onGo: (x: number, z: number) => void) {
    this.el.id = 'map';
    this.el.innerHTML = '<div class="mp"><div class="mt">CITY MAP <span>click to teleport · M or ESC to close</span></div><div class="mb"></div><div class="mpl"></div></div>';
    const box = this.el.querySelector('.mb')!;
    box.appendChild(this.cv);
    const b = map.bounds;
    this.H = Math.round((this.W * (b.z1 - b.z0)) / (b.x1 - b.x0)); // keep the real aspect ratio
    this.cv.width = this.base.width = this.W;
    this.cv.height = this.base.height = this.H;
    const list = this.el.querySelector('.mpl')!;
    for (const p of map.places) {
      const b = document.createElement('button');
      b.textContent = p.name;
      b.onclick = (e) => {
        e.stopPropagation();
        onGo(p.x, p.z);
      };
      list.appendChild(b);
    }
    this.cv.addEventListener('mousemove', (e) => (this.hover = this.toWorld(e)));
    this.cv.addEventListener('mouseleave', () => (this.hover = null));
    this.cv.addEventListener('click', (e) => {
      const w = this.toWorld(e);
      if (w) onGo(w[0], w[1]);
    });
    document.body.appendChild(this.el);
    this.paintBase();
  }

  private toWorld(e: MouseEvent): Pt | null {
    const r = this.cv.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
    const b = this.map.bounds;
    return [b.x0 + u * (b.x1 - b.x0), b.z0 + v * (b.z1 - b.z0)];
  }
  private px(x: number, z: number): Pt {
    const b = this.map.bounds;
    return [((x - b.x0) / (b.x1 - b.x0)) * this.W, ((z - b.z0) / (b.z1 - b.z0)) * this.H];
  }

  private paintBase(): void {
    const c = this.base.getContext('2d')!;
    const k = this.W / (this.map.bounds.x1 - this.map.bounds.x0);
    c.fillStyle = '#e8dcc0';
    c.fillRect(0, 0, this.W, this.H);
    const path = (pts: Pt[], close: boolean) => {
      c.beginPath();
      pts.forEach((p, i) => {
        const [x, y] = this.px(p[0], p[1]);
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      });
      if (close) c.closePath();
    };
    for (const w of this.map.water) {
      path(w.pts, true);
      c.fillStyle = '#8fb8d8';
      c.fill();
    }
    for (const g of this.map.green) {
      path(g.pts, true);
      c.fillStyle = g.forest ? '#5c9a54' : '#a9cf8a';
      c.fill();
    }
    c.lineCap = c.lineJoin = 'round';
    for (const r of this.map.roads) {
      path(r.pts, false);
      c.strokeStyle = '#fbf7ea';
      c.lineWidth = Math.max(1, r.w * k * (r.alley ? 0.8 : 1));
      c.stroke();
    }
    for (const b of this.map.buildings) {
      path(b, true);
      c.fillStyle = '#b8977c';
      c.fill();
    }
    c.setLineDash([6, 4]);
    for (const r of this.map.rails) {
      path(r, false);
      c.strokeStyle = '#4a4f5c';
      c.lineWidth = 3;
      c.stroke();
    }
    c.setLineDash([]);
  }

  setOpen(v: boolean): void {
    this.open = v;
    this.el.classList.toggle('on', v);
  }

  draw(x: number, z: number, yaw: number, marks: readonly { x: number; z: number; kind: 'cheese' | 'nest' }[] = []): void {
    if (!this.open) return;
    const c = this.ctx;
    c.drawImage(this.base, 0, 0);
    // objectives: loose cheese (yellow wedges) and the nest (green ring)
    c.lineWidth = 2;
    c.strokeStyle = '#14121c';
    for (const m of marks) {
      const [px, py] = this.px(m.x, m.z);
      c.beginPath();
      if (m.kind === 'nest') {
        c.fillStyle = '#3fbf5a';
        c.arc(px, py, 8, 0, 7);
        c.fill();
        c.stroke();
        c.beginPath();
        c.fillStyle = '#14121c';
        c.arc(px, py, 3, 0, 7);
        c.fill();
      } else {
        c.fillStyle = '#ffcf40';
        c.moveTo(px - 6, py + 5);
        c.lineTo(px + 6, py + 5);
        c.lineTo(px + 6, py - 5);
        c.closePath();
        c.fill();
        c.stroke();
      }
    }
    c.fillStyle = '#14121c';
    c.font = '12px ui-monospace, Menlo, monospace';
    for (const p of this.map.places) {
      const [px, py] = this.px(p.x, p.z);
      c.beginPath();
      c.arc(px, py, 4, 0, 7);
      c.fill();
      c.fillText(p.name, px + 7, py + 4);
    }
    if (this.hover) {
      const [px, py] = this.px(this.hover[0], this.hover[1]);
      c.strokeStyle = '#c0152a';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(px, py, 9, 0, 7);
      c.stroke();
    }
    const [rx, ry] = this.px(x, z);
    c.save();
    c.translate(rx, ry);
    c.rotate(-yaw);
    c.fillStyle = '#ff5a6a';
    c.strokeStyle = '#14121c';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, -9);
    c.lineTo(6, 6);
    c.lineTo(-6, 6);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }
}
