// ISP and image sensor trace events (QEMU's `-trace` log lines) as frames:
// what the driver programmed, the interrupts and channel buffers, the sensor.
// Lines look like "[2026-11-21T13:47:30.962692Z |PID@SECS.USEC:]ingenic_isp_frame VIC 0 frame 1: ...".

export const ISP_TRACE_ARGS = ['-msg', 'timestamp=on', '-trace', 'ingenic_isp_*', '-trace', 'ingenic_t20_isp_*',
  '-trace', 'ingenic_t30_ncu_*', '-trace', 'image_sensor_*',
  // the reads are most of a log and say little the writes do not
  '-trace', '-ingenic_isp_read', '-trace', '-ingenic_t20_isp_read', '-trace', '-ingenic_t30_ncu_read', '-trace', '-image_sensor_read'];

const LINE = /^(?:(\d{4}-\d\d-\d\dT)(\d\d):(\d\d):(\d\d\.\d+)Z |\d+@(\d+\.\d+):)?((?:ingenic_(?:isp|t20_isp|t30_ncu)|image_sensor)_\w+) ?(.*)$/;
const ACCESS = /^0x([0-9a-f]+) (->|<-|\|=) 0x([0-9a-f]+)(?: at 0x([0-9a-f]+))? ?(\S*)$/;
const SENSOR = /^input (\d+) 0x([0-9a-f]+) (<-|->) 0x([0-9a-f]+)$/;
const CHAN = /^pipeline (\d+) channel (\d+): (?:frame (\d+) dropped, (.*)|frame (\d+) into|(\S+) 0x)/;
const WRITES = { ingenic_isp_write: 'isp', ingenic_isp_shadow: 'isp', ingenic_isp_rcfg_write: 'isp',
  ingenic_t20_isp_write: 'apical', ingenic_t30_ncu_write: 'ncu' };
// Registers that hold no state (status, clears, FIFO pushes, ports): not worth listing
export const VOLATILE = /(^|\.)(int_sta1?|int_clr1?|int_msk1?|done_(sta|clr|y|uv|frame)|tick_(sta|clr)|y_push|uv_push|clr_(y|uv|done_y|done_uv)|shadow|shadow_open|rcfg_trig|rcfg_trig_hi|ch_busy|push_sta|busy|idle|ready|base_curr|base_last|count)$|^(top\.(clr|clr_all|sta)|core\.(int_sta|port_sta))$/;

const DEVS = ['isp', 'apical', 'ncu'];
export const devKey = (dev, off) => (dev.startsWith('sensor') ? 3 + Number(dev.slice(6)) : DEVS.indexOf(dev)) * 4294967296 + off;
export const regLabel = (dev, off, name) => (dev === 'isp' ? '' : dev + ' ') + (name || '0x' + off.toString(16).padStart(dev.startsWith('sensor') ? 4 : 5, '0'));

// One line to an event object, or null for a line that is no ISP event.
// {ev, t (seconds or null), kind: 'write'|'frame'|'vic'|'irq'|'chan'|'exposure'|'stream'|'note', ...}
export function parseLine(line, lastT = null) {
  const m = LINE.exec(line);
  if (!m) return null;
  let t = lastT;
  if (m[2] !== undefined) t = (+m[2] * 60 + +m[3]) * 60 + +m[4];
  else if (m[5] !== undefined) t = +m[5];
  const ev = m[6], args = m[7], e = { ev, args, t };
  const dev = WRITES[ev];
  if (dev) {
    const a = ACCESS.exec(args);
    if (!a || a[2] === '->') return null;
    return Object.assign(e, { kind: 'write', dev, off: parseInt(a[1], 16), val: parseInt(a[3], 16) >>> 0, name: a[5] });
  }
  switch (ev) {
    case 'image_sensor_write': {
      const s = SENSOR.exec(args);
      return s ? Object.assign(e, { kind: 'write', dev: 'sensor' + s[1], off: parseInt(s[2], 16), val: parseInt(s[4], 16), name: '' }) : null;
    }
    case 'ingenic_isp_frame': {
      const f = /^VIC (\d+) frame (\d+)/.exec(args);
      return f ? Object.assign(e, { kind: 'frame', dev: 'isp', vic: +f[1], frame: +f[2] }) : null;
    }
    case 'ingenic_t20_isp_frame': {
      const f = /^frame (\d+) starts/.exec(args);
      return f ? Object.assign(e, { kind: 'frame', dev: 'apical', vic: 0, frame: +f[1] }) : null;
    }
    case 'ingenic_isp_vic_irq': {
      const f = /^VIC (\d+) interrupt (\d)/.exec(args);
      return f ? Object.assign(e, { kind: 'irq', who: 'vic' + f[1], level: +f[2] }) : null;
    }
    case 'ingenic_isp_irq': case 'ingenic_t20_isp_irq': {
      const f = /interrupt (\d)/.exec(args);
      return f ? Object.assign(e, { kind: 'irq', who: 'isp', level: +f[1] }) : null;
    }
    case 'ingenic_isp_chan_push': case 'ingenic_isp_chan_done': case 'ingenic_isp_chan_drop': {
      const c = CHAN.exec(args);
      return c ? Object.assign(e, { kind: 'chan', op: ev.slice(17), ch: `${c[1]}.${c[2]}`, why: c[4] }) : null;
    }
    case 'image_sensor_exposure': {
      const x = /^input (\d+) exposure (\d+)\/16 lines, gain (\d+)\/1024/.exec(args);
      return x ? Object.assign(e, { kind: 'exposure', dev: 'sensor' + x[1], lines: +x[2], gain: +x[3] }) : null;
    }
    case 'image_sensor_stream': {
      const x = /^input (\d+) streaming (\d)/.exec(args);
      return x ? Object.assign(e, { kind: 'stream', dev: 'sensor' + x[1], on: x[2] === '1' }) : null;
    }
    case 'ingenic_isp_vic': case 'ingenic_t20_isp_vic': case 'ingenic_isp_vic_wait':
    case 'ingenic_isp_clock': case 'ingenic_isp_reset': case 'ingenic_isp_csi': case 'ingenic_isp_mclk': case 'ingenic_isp_switch':
      return Object.assign(e, { kind: 'note' });
  }
  return null;
}

const ROWS = 300;       // frames kept
const NOTES = 40;

export class IspModel {
  constructor() { this.clear(); }
  clear() {
    this.regs = new Map();      // devKey -> last value written
    this.frames = [];           // finished frames, oldest first (ring of ROWS)
    this.cur = this.newFrame(0);
    this.frame = 0;
    this.total = 0;             // frames seen
    this.drops = 0;
    this.irqs = { isp: 0 };
    this.exposure = new Map();  // sensor -> {lines, gain}
    this.streaming = new Map();
    this.notes = [];
    this.lines = 0;
    this.arrivals = [];         // performance.now() of each frame, for the rate
    this.lastT = null;
    this.dirty = true;
  }
  newFrame(n) { return { n, t: this.lastT, irq: {}, chan: new Map(), writes: new Map(), exp: null, net: null, open: false }; }
  // Text of any size; a trailing partial line is the caller's to hold back
  feed(text) {
    let i = 0;
    while (i < text.length) {
      let j = text.indexOf('\n', i);
      if (j < 0) j = text.length;
      if (j > i) this.line(text.slice(i, j));
      i = j + 1;
    }
  }
  line(l) {
    const e = parseLine(l, this.lastT);
    if (!e) return;
    this.lines++;
    this.lastT = e.t;
    const cur = this.cur;
    switch (e.kind) {
      case 'write': {
        const k = devKey(e.dev, e.off), w = cur.writes.get(k);
        if (w) w.val = e.val;
        else if (!VOLATILE.test(e.name)) cur.writes.set(k, { label: regLabel(e.dev, e.off, e.name), old: this.regs.get(k), val: e.val });
        this.regs.set(k, e.val);
        break;
      }
      case 'frame':
        // VIC 0 (or the Apical core) paces the rows; other VICs' frames only count
        if (e.vic !== 0) { cur.irq['f' + e.vic] = e.frame; break; }
        this.close();
        this.frame = e.frame;
        this.total++;
        this.arrivals.push(performance.now());
        if (this.arrivals.length > 200) this.arrivals.shift();
        this.cur = this.newFrame(e.frame);
        break;
      case 'irq': if (e.level) { cur.irq[e.who] = (cur.irq[e.who] || 0) + 1; this.irqs[e.who] = (this.irqs[e.who] || 0) + 1; } break;
      case 'chan': {
        const c = cur.chan.get(e.ch) || { push: 0, done: 0, drop: 0, why: new Set() };
        c[e.op]++;
        if (e.op === 'drop') { this.drops++; c.why.add(e.why); }
        cur.chan.set(e.ch, c);
        break;
      }
      case 'exposure':
        this.exposure.set(e.dev, { lines: e.lines / 16, gain: e.gain / 1024 });
        cur.exp = `${e.lines / 16 | 0} lines ${(e.gain / 1024).toFixed(2)}x`;
        break;
      case 'stream':
        this.streaming.set(e.dev, e.on);
        this.note(`${e.dev} streaming ${e.on ? 'on' : 'off'}`);
        break;
      case 'note': this.note(`${e.ev.replace(/^ingenic_(t20_)?isp_|^image_sensor_/, '')}: ${e.args}`); break;
    }
    this.dirty = true;
  }
  note(s) {
    this.notes.push(`frame ${this.frame}  ${s}`);
    if (this.notes.length > NOTES) this.notes.shift();
  }
  // A frame's net register changes: from the value before it to the last in it
  close() {
    const c = this.cur, net = [];
    for (const w of c.writes.values()) if (w.old !== w.val) net.push(w);
    c.net = net;
    c.writes = null;
    this.frames.push(c);
    if (this.frames.length > ROWS) this.frames.shift();
  }
  fps() {
    const a = this.arrivals, now = performance.now();
    const recent = a.filter((x) => now - x < 5000);
    return recent.length > 1 ? (recent.length - 1) / ((recent[recent.length - 1] - recent[0]) / 1000) : 0;
  }
}

const hex = (v) => '0x' + (v >>> 0).toString(16);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The card's body, repainted at most a few times a second.
export class IspPanel {
  constructor(els, model) {
    this.el = els;
    this.m = model;
    this.shown = 30;
    this.last = 0;
    els.rows.addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-n]');
      if (!tr) return;
      const f = this.m.frames.findLast((x) => x.n === +tr.dataset.n);
      if (f) { f.open = !f.open; this.render(); }
    });
    const loop = (now) => {
      if (this.m.dirty && now - this.last > 250) { this.last = now; this.render(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  render() {
    const m = this.m, el = this.el;
    m.dirty = false;
    const exp = [...m.exposure].map(([d, x]) => `${d} ${x.lines.toFixed(0)} lines, ${x.gain.toFixed(2)}x`).join('; ');
    const strm = [...m.streaming].map(([d, on]) => `${d} ${on ? 'on' : 'off'}`).join(', ');
    const irq = Object.entries(m.irqs).map(([k, v]) => `${k} ${v}`).join(', ');
    el.sum.textContent = '';
    for (const [k, v] of [['Frame', m.frame], ['Rate', m.fps() ? m.fps().toFixed(1) + ' /s' : '-'], ['Dropped', m.drops],
      ['IRQs', irq || '-'], ['Sensor', strm || '-'], ['Exposure', exp || '-'], ['Registers', m.regs.size]]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = k; dd.textContent = v; el.sum.append(dt, dd);
    }
    const out = [];
    const from = Math.max(0, m.frames.length - this.shown);
    for (let i = m.frames.length - 1; i >= from; i--) {
      const f = m.frames[i];
      const irqs = Object.entries(f.irq).filter(([k]) => k[0] !== 'f').map(([k, v]) => `${k} ${v}`).join(', ');
      const chans = [...f.chan].map(([c, x]) => `ch${c} ` + [x.push && `push ${x.push}`, x.done && `done ${x.done}`,
        x.drop && `drop ${x.drop} (${[...x.why].join(', ')})`].filter(Boolean).join(' ')).join('; ');
      const net = f.net, lim = f.open ? net.length : 6;
      const regs = net.slice(0, lim).map((w) => `<span title="${esc(w.label)} ${w.old === undefined ? '' : hex(w.old) + ' -> '}${hex(w.val)}">${esc(w.label)} <em>${hex(w.val)}</em></span>`).join(' ')
        + (net.length > lim ? ` <a>+${net.length - lim} more</a>` : '');
      out.push(`<tr data-n="${f.n}"${f.open ? ' class="open"' : ''}><td>${f.n || 'init'}</td><td>${esc(irqs) || '-'}</td><td>${esc(chans) || '-'}</td><td class="regs">${regs || '-'}</td><td>${esc(f.exp || '')}</td></tr>`);
    }
    el.rows.innerHTML = out.join('');
    el.notes.textContent = m.notes.slice(-6).reverse().join('\n');
    el.empty.hidden = m.lines > 0;
  }
}
