// GPIO state from the model's JSON lines: {"t":ns,"pin":"PB14","gpio":46,
// "fn":"out"|"in"|"irq"|"func", "lvl":0|1, "func":n, "trig":..., "mask":..,
// "pc":"0x..."|"src":"ext"} and {"t":..,"reset":true,"ports":n}.
// Timer unit and PWM lines ride the same stream: {"t":ns,"pwm":n|"tcu":n,
// "lvl":0|1, "period":ns, "high":ns, "edge":ns, "src":"hw"|..., "pc":"0x..."}
// and {"t":..,"reset":true,"channels":n}. A line with a period describes
// every edge until that channel's next line.

export class GpioModel {
  constructor() { this.clear(); }
  clear() {
    this.pins = new Map();       // gpio number -> state
    this.series = new Map();     // gpio number -> [[tMs, level], ...]
    this.recent = [];
    this.pwm = new Map();        // "pwm0" | "tcu1" -> {name, lines: [{tMs, lvl, period, high, edge}], ...}
    this.ports = 0;
    this.lastMs = 0;
  }
  // Returns the parsed event, or null for a line that is not JSON.
  apply(line) {
    let e;
    try { e = JSON.parse(line); } catch { return null; }
    const tMs = (e.t || 0) / 1e6;
    this.lastMs = Math.max(this.lastMs, tMs);
    if (e.reset && e.ports === undefined) { e.kind = 'pwm-reset'; return e; }
    const ch = e.pwm !== undefined ? 'pwm' : e.tcu !== undefined ? 'tcu' : null;
    if (ch) {
      const name = ch + e[ch];
      const c = this.pwm.get(name) || { name, kind: ch, n: e[ch], lines: [] };
      const line = { tMs, lvl: e.lvl, period: e.period || 0, high: e.high || 0, edge: e.edge || 0 };
      Object.assign(c, line, { src: e.src, pc: e.pc });
      if (line.period || (c.lines.length && line.lvl !== c.lines[0].lvl)) c.active = true;
      c.lines.push(line);
      if (c.lines.length > 20000) c.lines.splice(0, 5000);
      this.pwm.set(name, c);
      e.kind = 'pwm'; e.name = name; e.tMs = tMs;
      return e;
    }
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
  // PWM and timer outputs worth a lane: any that has toggled or been given a period
  activePwm() {
    const rows = [];
    for (const c of this.pwm.values()) if (c.active) rows.push(c);
    return rows.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.n - b.n));
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

// What a PWM or timer line says about its output
export function pwmText(c) {
  if (!c.period) return { hz: '', duty: '', what: `steady ${c.lvl}` };
  const hz = 1e9 / c.period, duty = 100 * c.high / c.period;
  const f = hz >= 1e4 ? (hz / 1e3).toPrecision(4) + ' kHz' : hz.toPrecision(4) + ' Hz';
  return { hz: f, duty: duty.toPrecision(3) + '%', what: `${f}, ${duty.toPrecision(3)}% high` };
}

// PWM and timer-unit outputs: level, period and duty, one row each.
export class PwmTable {
  constructor(root) { this.root = root; this.rows = new Map(); this.dirty = new Set(); }
  clear() { this.root.textContent = ''; this.rows.clear(); this.dirty.clear(); }
  update(c) {
    if (!this.rows.has(c.name)) {
      const r = document.createElement('div');
      r.className = 'pwm-row';
      r.innerHTML = '<b></b><i class="lvl"></i><span class="f"></span><span class="d"></span><span class="bar"><u></u></span>';
      r.querySelector('b').textContent = c.name;
      // Every channel reports once at reset; show a row only once its output has done something
      r.hidden = true;
      this.rows.set(c.name, r);
      r.dataset.order = (c.kind === 'pwm' ? 0 : 1000) + c.n;
      // keep pwm before tcu, each by number
      const all = [...this.rows.values()].sort((x, y) => x.dataset.order - y.dataset.order);
      this.root.textContent = '';
      for (const el of all) this.root.appendChild(el);
    }
    this.dirty.add(c);
  }
  // Called once per animation frame: PWM lines can arrive faster than they can be painted
  flush() {
    for (const c of this.dirty) {
      const r = this.rows.get(c.name), t = pwmText(c);
      if (c.period || c.lvl) r.hidden = false;
      r.querySelector('.lvl').dataset.lvl = c.lvl;
      r.querySelector('.f').textContent = t.hz || '-';
      r.querySelector('.d').textContent = t.duty || '-';
      r.querySelector('u').style.width = (c.period ? 100 * c.high / c.period : c.lvl * 100) + '%';
      r.title = `${c.name}: level ${c.lvl}, ${t.what}\nlast change at ${(c.tMs / 1000).toFixed(3)} s ${c.src === 'hw' ? 'by the block' : c.pc ? 'by guest pc ' + c.pc : ''}`;
    }
    this.dirty.clear();
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
    const rows = this.model.toggling(), pwm = this.model.activePwm();
    const laneH = 26, top = 22, labelW = 96;
    const h = Math.max(90, top + (rows.length + pwm.length) * laneH + 8);
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
    if (!rows.length && !pwm.length) {
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
    const pc = this.css('--c-in');
    pwm.forEach((c, i) => {
      const y = top + (rows.length + i) * laneH + 4, yl = y + laneH - 12;
      g.fillStyle = fg;
      g.fillText(c.name, 6, y + (laneH - 8) / 2);
      g.strokeStyle = grid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x0, yl + 6.5); g.lineTo(x1, yl + 6.5); g.stroke();
      this.drawPwm(g, c, y, yl, X, start, end, x0, x1, pc);
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
  // One PWM lane. A line with a period stands for every edge until the next line; where
  // the edges are closer than a few pixels they are drawn as a band as tall as the duty.
  drawPwm(g, c, yh, yl, X, start, end, x0, x1, color) {
    const L = c.lines, cl = (t) => Math.min(Math.max(X(t), x0), x1);
    g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 1.6;
    let prevY = null;
    const step = (t, y) => {
      const x = cl(t);
      if (prevY === null) g.moveTo(x, y);
      else { if (y !== prevY) g.lineTo(x, prevY); g.lineTo(x, y); }
      prevY = y;
    };
    g.beginPath();
    for (let i = 0; i < L.length; i++) {
      const l = L[i], a = l.tMs, b = i + 1 < L.length ? L[i + 1].tMs : Math.max(end, a);
      if (b < start || a > end) continue;
      const lvlY = (v) => (v ? yh : yl);
      if (!l.period) { step(a, lvlY(l.lvl)); step(b, lvlY(l.lvl)); continue; }
      const P = l.period / 1e6, H = l.high / 1e6;
      const cycles = (Math.min(b, end) - Math.max(a, start)) / P;
      if (cycles * 2 > (x1 - x0) / 3) {
        g.stroke();
        g.globalAlpha = .35;
        const duty = l.high / l.period;
        g.fillRect(cl(Math.max(a, start)), yl - (yl - yh) * duty, Math.max(1, cl(Math.min(b, end)) - cl(Math.max(a, start))), (yl - yh) * duty);
        g.globalAlpha = 1;
        g.beginPath(); prevY = null;
        continue;
      }
      let lvl = l.lvl, next = a + l.edge / 1e6;
      step(a, lvlY(lvl));
      if (next < start - P) next += Math.floor((start - next) / P) * P;
      for (let guard = 0; next < Math.min(b, end) && guard < 4000; guard++) {
        lvl ^= 1;
        if (next >= start) step(next, lvlY(lvl));
        next += lvl ? H : P - H;
      }
      step(Math.min(b, end), lvlY(lvl));
    }
    g.stroke();
    g.lineWidth = 1;
  }
}
