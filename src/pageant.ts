import type { Rat } from './rat';
import type { Car } from './cars';
import type { Cat } from './cat';

/** A stunt the judges just scored. */
export interface Verdict {
  name: string;
  scores: [number, number, number];
  total: number;
  /** 0..1: how impressive it was (drives the applause and slow-mo) */
  quality: number;
}

const NEAR_MISS = 1.5; // m, rat-to-car centre distance that counts as a near miss
const MIN_AIR = 1.1; // s airborne before a landing gets judged

/**
 * America's Next Top Rat: three judges score every stunt from 1 to 10.
 * One of them is famously hard to please.
 */
export class Judges {
  stars = 0;
  private air = 0;
  private peak = 0;
  private takeoffY = 0;
  private carCooldown = new WeakMap<Car, number>();
  private chased = new WeakSet<Cat>();
  private clock = 0;

  private verdict(name: string, quality: number): Verdict {
    const q = Math.max(0, Math.min(1, quality));
    const base = 3 + q * 7;
    const judge = (bias: number) => Math.max(1, Math.min(10, Math.round(base + bias + (Math.random() - 0.5) * 2)));
    const scores: [number, number, number] = [judge(0.4), judge(0), judge(-1.6)]; // the last judge is a tough crowd
    const total = scores[0] + scores[1] + scores[2];
    this.stars += total;
    return { name, scores, total, quality: q };
  }

  /** Call once per frame after the rat and cars have moved. Returns any stunts scored this frame. */
  update(dt: number, rat: Rat, cars: readonly Car[], cats: readonly Cat[]): Verdict[] {
    this.clock += dt;
    const out: Verdict[] = [];

    // ---- hang time: a long flight or fall that ends on your feet ----
    if (!rat.grounded && rat.mode === 'walk') {
      if (this.air === 0) {
        this.takeoffY = rat.pos.y;
        this.peak = rat.pos.y;
      }
      this.air += dt;
      this.peak = Math.max(this.peak, rat.pos.y);
    } else {
      if (rat.grounded && this.air >= MIN_AIR && rat.hurt <= 0) {
        const height = this.peak - Math.min(this.takeoffY, rat.pos.y);
        out.push(this.verdict(height > 8 ? 'SKY DIVE' : 'HANG TIME', (this.air - MIN_AIR) / 3 + height / 25));
      }
      this.air = 0;
    }

    // ---- near miss: a moving car brushes past and you live ----
    if (rat.hurt <= 0) {
      for (const c of cars) {
        if (!c.active || c.speed < 4) continue;
        if (rat.pos.y - c.pos.y > 1.4) continue; // on a roof, not in the road
        const d = Math.hypot(c.pos.x - rat.pos.x, c.pos.z - rat.pos.z);
        if (d > NEAR_MISS) continue;
        if ((this.carCooldown.get(c) ?? -1) > this.clock) continue;
        this.carCooldown.set(c, this.clock + 3);
        out.push(this.verdict('NEAR MISS', (c.speed - 4) / 8 + (NEAR_MISS - d) / NEAR_MISS / 2));
      }
    }

    // ---- escape: a cat gave chase and gave up ----
    for (const cat of cats) {
      if (cat.state === 'chase') this.chased.add(cat);
      else if (this.chased.has(cat) && (cat.state === 'patrol' || cat.state === 'rest')) {
        this.chased.delete(cat);
        out.push(this.verdict('GOT AWAY', 0.55));
      }
    }
    return out;
  }

  /** a cheese run banked: bigger hauls impress more */
  haul(count: number): Verdict {
    return this.verdict(count >= 4 ? 'BIG CHEESE' : 'DELIVERY', (count - 1) / 5);
  }

  /** forget an escape in progress (the rat got caught) */
  caught(): void {
    this.chased = new WeakSet();
  }
}
