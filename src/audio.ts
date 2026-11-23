/** Tiny synth sound: no asset files. Browsers need a user gesture first, so call init() from a click. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    // a couple of seconds of white noise, shared by the beds and bursts below
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // city bed: the same noise, low-passed into a distant traffic rumble
    const city = ctx.createBufferSource();
    city.buffer = buf;
    city.loop = true;
    city.playbackRate.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    this.cityGain = ctx.createGain();
    this.cityGain.gain.value = 0.05;
    city.connect(lp).connect(this.cityGain).connect(this.master);
    city.start();

    // wind while flying: high-passed noise that swells with the tail rotor
    const wind = ctx.createBufferSource();
    wind.buffer = buf;
    wind.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 600;
    hp.Q.value = 0.8;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(hp).connect(this.windGain).connect(this.master);
    wind.start();

    // the L: a low rumble with a slow clatter, only audible when a train is near
    const tr = ctx.createBufferSource();
    tr.buffer = buf;
    tr.loop = true;
    tr.playbackRate.value = 0.7;
    const tlp = ctx.createBiquadFilter();
    tlp.type = 'bandpass';
    tlp.frequency.value = 140;
    tlp.Q.value = 0.9;
    this.trainGain = ctx.createGain();
    this.trainGain.gain.value = 0;
    const clack = ctx.createOscillator();
    clack.frequency.value = 7; // wheel joints
    const clackAmt = ctx.createGain();
    clackAmt.gain.value = 0.35;
    clack.connect(clackAmt).connect(this.trainGain.gain);
    clack.start();
    tr.connect(tlp).connect(this.trainGain).connect(this.master);
    tr.start();
  }

  private noise: AudioBuffer | null = null;
  private cityGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private trainGain: GainNode | null = null;

  /** 0 = sleepy small hours, 1 = rush hour */
  setCity(busy: number): void {
    if (this.cityGain && this.ctx) this.cityGain.gain.setTargetAtTime(0.02 + busy * 0.06, this.ctx.currentTime, 1);
  }

  /** 0..1: how near an L train is */
  setTrain(level: number): void {
    if (this.trainGain && this.ctx) this.trainGain.gain.setTargetAtTime(level * 0.35, this.ctx.currentTime, 0.2);
  }

  setWind(level: number): void {
    if (this.windGain && this.ctx) this.windGain.gain.setTargetAtTime(level * 0.12, this.ctx.currentTime, 0.15);
  }

  /** a short filtered noise burst (paws, claps, whooshes) */
  private burst(freq: number, q: number, dur: number, vol: number, delay = 0, sweepTo = freq): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  footstep(): void { this.burst(2600, 2, 0.04, 0.05); }
  /** an automatic door's motor and the soft rush of its leaves, quieter with distance */
  doorSlide(dist: number): void {
    const v = 0.12 * Math.max(0, 1 - dist / 14);
    if (v <= 0.005) return;
    this.burst(900, 0.8, 0.7, v, 0, 400);
    this.tone('sine', 140, 120, 0.6, v * 0.5);
  }
  whoosh(): void { this.burst(300, 1.2, 0.45, 0.35, 0, 2400); }
  /** the judges' bell, then the crowd */
  applause(score: number): void {
    this.tone('triangle', 1318, 1318, 0.4, 0.15);
    const claps = 6 + Math.round(score * 2);
    for (let i = 0; i < claps; i++) this.burst(1400 + Math.random() * 1200, 1.5, 0.05, 0.12, 0.15 + Math.random() * 0.9);
  }
  /** crowning fanfare */
  fanfare(): void {
    [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => this.tone('square', f, f, i === 6 ? 0.8 : 0.16, 0.12, i * 0.14));
    this.applause(10);
  }
  /** a quick two-note sting when a cat spots you */
  sting(): void { this.tone('square', 196, 196, 0.12, 0.12); this.tone('square', 185, 185, 0.3, 0.12, 0.12); }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  pickup(): void { this.tone('square', 660, 660, 0.07, 0.12); this.tone('square', 990, 990, 0.1, 0.12, 0.07); }
  bank(): void { [523, 659, 784, 1046].forEach((f, i) => this.tone('triangle', f, f, 0.18, 0.2, i * 0.08)); }
  squeak(): void { this.tone('triangle', 1500, 2400, 0.09, 0.12); }
  hurt(): void { this.tone('sawtooth', 220, 50, 0.35, 0.3); this.tone('square', 1800, 600, 0.12, 0.12); }
  hiss(): void { this.tone('sawtooth', 700, 300, 0.25, 0.1); }
  stomp(): void { this.tone('sine', 120, 30, 0.3, 0.5); }
}
