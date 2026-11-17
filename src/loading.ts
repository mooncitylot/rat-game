// The loading screen is plain HTML in index.html (so it shows while this bundle is still downloading).
// Here we only drive it: stage text, download progress, and the hide/fail states.
const el = document.getElementById('loading');
const stageEl = el?.querySelector<HTMLElement>('.stage');
const barEl = el?.querySelector<HTMLElement>('.bar');
const fillEl = el?.querySelector<HTMLElement>('.fill');
const t0 = performance.now();
const marks: string[] = [];

export const loading = {
  /** Name the current stage. Pass a 0..1 fraction for a real bar, or nothing for the shimmer (work that blocks the thread). */
  stage(text: string, frac?: number): void {
    if (stageEl) stageEl.textContent = text;
    barEl?.classList.toggle('wait', frac === undefined);
    if (fillEl && frac !== undefined) fillEl.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
    marks.push(`${Math.round(performance.now() - t0)} ms  ${text}`);
  },
  /** Let the browser paint the new stage text before a long synchronous job starts. */
  paint(): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 120); // rAF never fires in a background tab
      requestAnimationFrame(() => setTimeout(() => (clearTimeout(t), resolve()), 0));
    });
  },
  done(): void {
    marks.push(`${Math.round(performance.now() - t0)} ms  ready`);
    if (new URLSearchParams(location.search).has('stats')) console.log('[load]\n' + marks.join('\n'));
    document.body.classList.add('loaded');
    setTimeout(() => el?.remove(), 600);
  },
  fail(message: string): void {
    if (!el) return;
    el.classList.add('failed');
    const p = el.querySelector('.err p');
    if (p) p.textContent = message;
    el.querySelector('#retry')?.addEventListener('click', () => location.reload());
  },
};
