import * as THREE from 'three';
import type { Edge, Net, Node } from './human';

const SIDEWALK_H = 0.16;
const key = (x: number, z: number) => `${Math.round(x * 5)},${Math.round(z * 5)}`;

interface Way {
  pts: [number, number][];
  crossing: boolean;
}

/** Pedestrian graph built from the mapped footways: sidewalks, crossings, paths. Nodes are snapped vertices. */
export class PolyNet implements Net {
  private pos: [number, number][] = [];
  private adj: { to: number; crossing: boolean }[][] = [];
  private ids = new Map<string, number>();
  readonly starts: Node[] = [];

  constructor(ways: Way[], private terrain: (x: number, z: number) => number) {
    const id = (p: [number, number]) => {
      const k = key(p[0], p[1]);
      let i = this.ids.get(k);
      if (i === undefined) {
        i = this.pos.length;
        this.ids.set(k, i);
        this.pos.push(p);
        this.adj.push([]);
      }
      return i;
    };
    for (const w of ways) {
      for (let i = 0; i + 1 < w.pts.length; i++) {
        const a = id(w.pts[i]), b = id(w.pts[i + 1]);
        if (a === b) continue;
        this.adj[a].push({ to: b, crossing: w.crossing });
        this.adj[b].push({ to: a, crossing: w.crossing });
      }
    }
    // good starting points: sidewalk nodes that connect onward
    this.adj.forEach((l, i) => {
      if (l.length >= 2 && l.every((e) => !e.crossing)) this.starts.push({ c: i, r: 0, k: 0 });
    });
  }

  private edge(from: number, to: number, crossing: boolean): Edge {
    const a = new THREE.Vector2(...this.pos[from]), b = new THREE.Vector2(...this.pos[to]);
    const len = a.distanceTo(b) || 0.01;
    const hx = (b.x - a.x) / len, hz = (b.y - a.y) / len;
    return { a, b, len, hx, hz, kind: crossing ? 'cross' : 'side', axis: Math.abs(hx) > Math.abs(hz) ? 'x' : 'z', to: { c: to, r: 0, k: 0 }, free: true };
  }

  first(n: Node): Edge {
    const l = this.adj[n.c];
    const e = l[Math.floor(Math.random() * l.length)];
    return this.edge(n.c, e.to, e.crossing);
  }

  next(arrived: Edge): Edge {
    const here = arrived.to.c;
    const l = this.adj[here];
    const from = this.ids.get(key(arrived.a.x, arrived.a.y));
    let options = l.filter((e) => e.to !== from);
    if (!options.length) options = l; // dead end: turn around
    // mostly keep going straight; sometimes take a side street or a crossing
    const scored = options.map((e) => {
      const dx = this.pos[e.to][0] - this.pos[here][0], dz = this.pos[e.to][1] - this.pos[here][1];
      const dl = Math.hypot(dx, dz) || 1;
      const straight = (dx / dl) * arrived.hx + (dz / dl) * arrived.hz;
      return { e, w: Math.exp(straight * 2.2) * (e.crossing ? 0.5 : 1) + 0.05 };
    });
    const total = scored.reduce((s, o) => s + o.w, 0);
    let r = Math.random() * total;
    for (const o of scored) {
      r -= o.w;
      if (r <= 0) return this.edge(here, o.e.to, o.e.crossing);
    }
    return this.edge(here, scored[0].e.to, scored[0].e.crossing);
  }

  height(x: number, z: number, kind: 'side' | 'cross'): number {
    return this.terrain(x, z) + (kind === 'side' ? SIDEWALK_H : 0.07);
  }
}
