// GPIO state from the model's JSON lines: {"t":ns,"pin":"PB14","gpio":46,
// "fn":"out"|"in"|"irq"|"func", "lvl":0|1, "func":n, "trig":..., "mask":..,
// "pc":"0x..."|"src":"ext"} and {"t":..,"reset":true,"ports":n}.

export class GpioModel {
  constructor() { this.clear(); }
  clear() {
    this.pins = new Map();       // gpio number -> state
    this.series = new Map();     // gpio number -> [[tMs, level], ...]
    this.recent = [];
    this.ports = 0;
    this.lastMs = 0;
  }
  // Returns the parsed event, or null for a line that is not JSON.
  apply(line) {
    let e;
    try { e = JSON.parse(line); } catch { return null; }
    const tMs = (e.t || 0) / 1e6;
    this.lastMs = Math.max(this.lastMs, tMs);
    if (e.reset) {
      for (const p of this.pins.values()) p.known = false;
      this.ports = Math.max(this.ports, e.ports || 0);
      e.kind = 'reset';
      return e;
    }
    const p = this.pins.get(e.gpio) || { gpio: e.gpio, pin: e.pin, changes: 0 };
    const was = p.lvl;
    Object.assign(p, { fn: e.fn, func: e.func, trig: e.trig, mask: e.mask, pc: e.pc, src: e.src, tMs, known: true });
    p.lvl = e.lvl;
    p.changes++;
    this.pins.set(e.gpio, p);
    this.ports = Math.max(this.ports, (e.gpio >> 5) + 1);
    e.kind = 'pin';
    e.tMs = tMs;
    e.levelChanged = e.lvl !== undefined && was !== undefined && e.lvl !== was;
    if (e.lvl !== undefined) {
      const s = this.series.get(e.gpio) || [];
      s.push([tMs, e.lvl]);
      this.series.set(e.gpio, s);
    }
    this.recent.push(e);
    if (this.recent.length > 200) this.recent.shift();
    return e;
  }
  // Pins worth a row in the timeline: those whose level has changed.
  toggling() {
    const rows = [];
    for (const [g, s] of this.series) {
      let flips = 0;
      for (let i = 1; i < s.length; i++) if (s[i][1] !== s[i - 1][1]) flips++;
      if (flips) rows.push({ gpio: g, pin: this.pins.get(g).pin, last: s[s.length - 1][0] });
    }
    return rows.sort((a, b) => a.gpio - b.gpio);
  }
}

const FN_LABEL = { out: 'output', in: 'input', irq: 'interrupt', func: 'function' };

export class PinTable {
  constructor(root, onClick) {
    this.root = root;
    this.onClick = onClick;
    this.cells = new Map();
    this.ports = 0;
    this.timers = new Map();
    root.addEventListener('click', (ev) => {
      const c = ev.target.closest('.pin');
      if (c) this.onClick(Number(c.dataset.gpio));
    });
  }
  ensure(ports) {
    for (; this.ports < ports; this.ports++) {
      const port = this.ports;
      const row = document.createElement('div');
      row.className = 'port';
      row.innerHTML = `<div class="port-name">P${String.fromCharCode(65 + port)}</div><div class="pins"></div>`;
      const box = row.querySelector('.pins');
      for (let i = 0; i < 32; i++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pin';
        b.dataset.gpio = port * 32 + i;
        b.textContent = i;
        b.title = `P${String.fromCharCode(65 + port)}${i} (${port * 32 + i}): reset state`;
        box.appendChild(b);
        this.cells.set(port * 32 + i, b);
      }
      this.root.appendChild(row);
    }
  }
  clear() {
    this.root.textContent = '';
    this.cells.clear();
    this.ports = 0;
  }
  update(model, e) {
    this.ensure(model.ports);
    if (e.kind === 'reset') {
      // A reset leaves pins that nothing has touched since in their reset
      // state, which the trace does not repeat: keep the last known one, dimmed.
      for (const c of this.cells.values()) c.classList.add('stale');
      return;
    }
    const c = this.cells.get(e.gpio);
    const p = model.pins.get(e.gpio);
    if (!c) return;
    c.className = 'pin fn-' + p.fn;
    if (p.lvl === undefined) delete c.dataset.lvl; else c.dataset.lvl = p.lvl;
    const detail = p.fn === 'func' ? `function ${p.func}` : p.fn === 'irq'
      ? `interrupt, ${p.trig}${p.mask ? ', masked' : ''}, level ${p.lvl}` : `${FN_LABEL[p.fn]}, level ${p.lvl}`;
    const who = p.src === 'ext' ? 'outside the guest' : `guest pc ${p.pc}`;
    c.title = `${p.pin} (gpio ${p.gpio}): ${detail}\nchanged at ${(p.tMs / 1000).toFixed(3)} s by ${who}\n${p.changes} changes`;
    c.classList.add('hot');
    clearTimeout(this.timers.get(e.gpio));
    this.timers.set(e.gpio, setTimeout(() => c.classList.remove('hot'), 1500));
  }
}

// Logic-analyser strip: one lane per toggling pin, time on the x axis.
export class Timeline {
  constructor(canvas, model) {
    this.cv = canvas;
    this.model = model;
    this.windowS = 30;
    this.follow = true;
    this.endMs = 0;
    this.dirty = true;
    this.hover = null;
    const ro = new ResizeObserver(() => { this.dirty = true; });
    ro.observe(canvas.parentElement);
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.follow = false;
      this.endMs = Math.max(0, this.endMs + Math.sign(ev.deltaY) * this.windowS * 100);
      this.dirty = true;
    }, { passive: false });
    canvas.addEventListener('pointermove', (ev) => { this.hover = ev.offsetX; this.dirty = true; });
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.dirty = true; });
    const loop = () => { if (this.dirty) this.draw(); requestAnimationFrame(loop); };
    loop();
  }
  invalidate() { this.dirty = true; }
  setWindow(s) { this.windowS = s; this.dirty = true; }
  setFollow(f) { this.follow = f; this.dirty = true; }
  css(name) { return getComputedStyle(this.cv).getPropertyValue(name).trim(); }
  draw() {
    this.dirty = false;
    const cv = this.cv, dpr = window.devicePixelRatio || 1;
    const w = cv.parentElement.clientWidth;
    const rows = this.model.toggling();
    const laneH = 26, top = 22, labelW = 96;
    const h = Math.max(90, top + rows.length * laneH + 8);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const fg = this.css('--fg'), dim = this.css('--dim'), grid = this.css('--line'), hi = this.css('--accent'), ext = this.css('--warn');
    g.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'middle';
    const winMs = this.windowS > 0 ? this.windowS * 1000 : Math.max(1000, this.model.lastMs);
    if (this.follow) this.endMs = Math.max(this.model.lastMs, winMs);
    const end = this.endMs, start = end - winMs;
    const x0 = labelW, x1 = w - 8;
    const X = (t) => x0 + (t - start) / winMs * (x1 - x0);
    // time axis
    const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600].find((s) => winMs / 1000 / s <= 10) || 600;
    g.strokeStyle = grid; g.fillStyle = dim; g.lineWidth = 1;
    for (let s = Math.ceil(start / 1000 / step) * step; s * 1000 <= end; s += step) {
      const x = Math.round(X(s * 1000)) + 0.5;
      g.beginPath(); g.moveTo(x, top - 6); g.lineTo(x, h); g.stroke();
      g.fillText(s.toFixed(step < 1 ? 1 : 0) + ' s', x + 3, 9);
    }
    if (!rows.length) {
      g.fillStyle = dim;
      g.fillText('no pin has changed level yet', x0 + 8, top + 22);
      return;
    }
    rows.forEach((r, i) => {
      const y = top + i * laneH + 4, yh = y, yl = y + laneH - 12;
      g.fillStyle = fg;
      g.fillText(`${r.pin}  ${r.gpio}`, 6, y + (laneH - 8) / 2);
      g.strokeStyle = grid;
      g.beginPath(); g.moveTo(x0, yl + 6.5); g.lineTo(x1, yl + 6.5); g.stroke();
      const s = this.model.series.get(r.gpio);
      g.lineWidth = 1.6; g.strokeStyle = hi;
      g.beginPath();
      let prev = null;
      for (const [t, l] of s) {
        const x = Math.min(Math.max(X(t), x0), x1);
        const yy = l ? yh : yl;
        if (prev === null) g.moveTo(x, yy);
        else { g.lineTo(x, prev); g.lineTo(x, yy); }
        prev = yy;
      }
      if (prev !== null) g.lineTo(Math.min(Math.max(X(Math.max(end, s[s.length - 1][0])), x0), x1), prev);
      g.stroke();
      g.lineWidth = 1;
      // outside-driven changes get a marker
      for (const e of this.model.recent) {
        if (e.gpio === r.gpio && e.src === 'ext' && e.tMs >= start && e.tMs <= end) {
          g.fillStyle = ext; g.fillRect(X(e.tMs) - 2, (e.lvl ? yh : yl) - 2, 4, 4);
        }
      }
    });
    if (this.hover !== null && this.hover >= x0 && this.hover <= x1) {
      const t = start + (this.hover - x0) / (x1 - x0) * winMs;
      g.strokeStyle = dim; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(this.hover + 0.5, top - 6); g.lineTo(this.hover + 0.5, h); g.stroke();
      g.setLineDash([]);
      g.fillStyle = fg;
      g.fillText((t / 1000).toFixed(3) + ' s', Math.min(this.hover + 6, w - 70), h - 8);
    }
  }
}
