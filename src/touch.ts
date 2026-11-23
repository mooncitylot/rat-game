/** On-screen controls for touch devices: left stick moves, right side drags to peek (camera auto-follows), buttons for jump/sprint/map. */
export const touch = { enabled: false, x: 0, z: 0, lookDX: 0, lookDY: 0, jump: false, sprint: false };

export function initTouch(onMap: () => void): void {
  if (!matchMedia('(pointer: coarse)').matches && !('ontouchstart' in window)) return;
  touch.enabled = true;
  document.body.classList.add('touch');

  const css = document.createElement('style');
  css.textContent = `
    body.touch #help { display: none; }
    body.touch #start p:last-child::after { content: ' (touch)'; }
    #tc { position: fixed; inset: 0; pointer-events: none; display: none; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
    body.touch.playing #tc { display: block; }
    #tc .zone { z-index: 3; pointer-events: auto; position: absolute; top: 0; bottom: 0; touch-action: none; }
    #tc .zl { left: 0; width: 42%; }
    #tc .zr { right: 0; width: 58%; }
    #tc .base { position: absolute; width: 120px; height: 120px; margin: -60px 0 0 -60px; border-radius: 50%; border: 3px solid rgba(239,230,210,.6); background: rgba(20,18,28,.3); display: none; pointer-events: none; }
    #tc .knob { position: absolute; left: 50%; top: 50%; width: 52px; height: 52px; margin: -26px 0 0 -26px; border-radius: 50%; background: rgba(239,230,210,.7); }
    #tc .btn { z-index: 6; pointer-events: auto; position: absolute; width: 74px; height: 74px; border-radius: 50%; border: 3px solid rgba(239,230,210,.7); background: rgba(20,18,28,.45); color: #efe6d2; font: bold 13px ui-monospace, Menlo, monospace; letter-spacing: .05em; display: grid; place-items: center; touch-action: none; }
    #tc .btn.on { background: rgba(255,176,48,.7); color: #14121c; }
    #tc .jump { right: calc(20px + env(safe-area-inset-right)); bottom: calc(28px + env(safe-area-inset-bottom)); width: 90px; height: 90px; }
    #tc .run { right: calc(124px + env(safe-area-inset-right)); bottom: calc(24px + env(safe-area-inset-bottom)); }
    #tc .map { right: calc(20px + env(safe-area-inset-right)); bottom: calc(136px + env(safe-area-inset-bottom)); width: 54px; height: 54px; }
  `;
  document.head.appendChild(css);

  const root = document.createElement('div');
  root.id = 'tc';
  root.innerHTML = `
    <div class="zone zl"><div class="base"><div class="knob"></div></div></div>
    <div class="zone zr"></div>
    <div class="btn map" data-b="map">MAP</div>
    <div class="btn run" data-b="sprint">RUN</div>
    <div class="btn jump" data-b="jump">JUMP</div>`;
  document.body.appendChild(root);

  const zl = root.querySelector<HTMLElement>('.zl')!;
  const zr = root.querySelector<HTMLElement>('.zr')!;
  const base = zl.querySelector<HTMLElement>('.base')!;
  const knob = base.querySelector<HTMLElement>('.knob')!;
  const R = 55;

  // movement stick: floats where the thumb lands
  let stickId = -1, sx = 0, sy = 0;
  zl.addEventListener('pointerdown', (e) => {
    if (stickId >= 0) return;
    stickId = e.pointerId;
    zl.setPointerCapture(e.pointerId);
    sx = e.clientX; sy = e.clientY;
    base.style.display = 'block';
    base.style.left = sx + 'px';
    base.style.top = sy + 'px';
    knob.style.transform = '';
  });
  zl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    let dx = e.clientX - sx, dy = e.clientY - sy;
    const len = Math.hypot(dx, dy);
    if (len > R) { dx *= R / len; dy *= R / len; }
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    const m = Math.min(1, len / R);
    const k = len > 1e-3 ? m / len : 0;
    const ax = (e.clientX - sx) * k, ay = (e.clientY - sy) * k;
    touch.x = Math.abs(ax) < 0.12 ? 0 : ax;
    touch.z = Math.abs(ay) < 0.12 ? 0 : -ay;
  });
  const endStick = (e: PointerEvent) => {
    if (e.pointerId !== stickId) return;
    stickId = -1;
    touch.x = touch.z = 0;
    base.style.display = 'none';
  };
  zl.addEventListener('pointerup', endStick);
  zl.addEventListener('pointercancel', endStick);

  // look: drag anywhere on the right
  let lookId = -1, lx = 0, ly = 0;
  zr.addEventListener('pointerdown', (e) => {
    if (lookId >= 0) return;
    lookId = e.pointerId;
    zr.setPointerCapture(e.pointerId);
    lx = e.clientX; ly = e.clientY;
  });
  zr.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    touch.lookDX += e.clientX - lx;
    touch.lookDY += e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
  });
  const endLook = (e: PointerEvent) => { if (e.pointerId === lookId) lookId = -1; };
  zr.addEventListener('pointerup', endLook);
  zr.addEventListener('pointercancel', endLook);

  // buttons (hold: jump and sprint; tap: map)
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".btn"))) {
    const which = el.dataset.b!;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.classList.add('on');
      if (which === 'jump') touch.jump = true;
      else if (which === 'sprint') touch.sprint = true;
      else onMap();
    });
    const up = () => {
      el.classList.remove('on');
      if (which === 'jump') touch.jump = false;
      else if (which === 'sprint') touch.sprint = false;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  root.addEventListener('contextmenu', (e) => e.preventDefault());
}
