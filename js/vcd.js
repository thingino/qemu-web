// VCD (waveform) files from the pin and ISP traces, and the text ring they come from.
import { parseLine, devKey, VOLATILE } from './isp.js';

// Bounded text: whole blocks (about 64 KB) drop off the front once the total passes cap
export class TextRing {
  constructor(cap) { this.cap = cap; this.clear(); }
  clear() { this.parts = []; this.head = 0; this.cur = ''; this.size = 0; this.cut = false; }
  push(text) {
    if (!text) return;
    this.cur += text; this.size += text.length;
    if (this.cur.length < 65536) return;
    this.parts.push(this.cur); this.cur = '';
    while (this.size > this.cap && this.head < this.parts.length) { this.size -= this.parts[this.head++].length; this.cut = true; }
    if (this.head > 256) { this.parts.splice(0, this.head); this.head = 0; }
  }
  text() { return this.parts.slice(this.head).join('') + this.cur; }
}

function vcdId(n) {
  let s = '';
  for (;;) {
    s = String.fromCharCode(33 + n % 94) + s;
    n = Math.floor(n / 94);
    if (!n) return s;
    n--;
  }
}
const safe = (n) => n.replace(/[^A-Za-z0-9_]/g, '_');

// GPIO, timer unit and PWM JSON lines (one text, any order) to VCD. A PWM line with a period
// stands for every edge up to the next line of that channel, drawn here up to maxEdges in all.
export function pinsVcd(text, maxEdges = 400000) {
  const evs = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { evs.push(JSON.parse(l)); } catch { /* a cut line */ }
  }
  evs.sort((a, b) => (a.t || 0) - (b.t || 0));
  const sig = (e) => e.pin ?? (e.pwm !== undefined ? 'pwm' + e.pwm : e.tcu !== undefined ? 'tcu' + e.tcu : null);
  const by = new Map();
  let end = 0;
  for (const e of evs) {
    end = Math.max(end, e.t || 0);
    const n = sig(e);
    if (n !== null) (by.get(n) || by.set(n, []).get(n)).push(e);
  }
  if (!by.size) return null;
  const rank = (n) => { const m = /^(\D+)(\d+)$/.exec(n); return [n[0] === 'P' ? 0 : 1, m ? m[1] : n, m ? +m[2] : 0]; };
  const names = [...by.keys()].sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || x[2] - y[2]; });
  const ch = [];
  let budget = maxEdges;
  for (const n of names) {
    const lines = by.get(n);
    lines.forEach((e, i) => {
      if (e.pin !== undefined) { ch.push([e.t || 0, n, e.fn === 'func' ? 'z' : String(e.lvl)]); return; }
      ch.push([e.t, n, String(e.lvl)]);
      ch.push([e.t, n + '_duty', 'r' + +(e.period ? e.high / e.period : e.lvl).toPrecision(6)]);
      if (!e.period) return;
      const until = i + 1 < lines.length ? lines[i + 1].t : end;
      let lvl = e.lvl, t = e.t + e.edge;
      while (t < until && budget-- > 0) { lvl ^= 1; ch.push([t, n, String(lvl)]); t += lvl ? e.high : e.period - e.high; }
    });
  }
  const ids = new Map(), out = ['$timescale 1ns $end', '$scope module pins $end'];
  for (const n of names) {
    ids.set(n, vcdId(ids.size)); out.push(`$var wire 1 ${ids.get(n)} ${safe(n)} $end`);
    if (n[0] !== 'P') { ids.set(n + '_duty', vcdId(ids.size)); out.push(`$var real 1 ${ids.get(n + '_duty')} ${n}_duty $end`); }
  }
  out.push('$upscope $end', '$enddefinitions $end');
  ch.sort((a, b) => a[0] - b[0]);
  let now = null;
  for (const [t, n, v] of ch) {
    if (t !== now) { out.push('#' + t); now = t; }
    out.push(v[0] === 'r' ? `${v} ${ids.get(n)}` : `${v}${ids.get(n)}`);
  }
  out.push('#' + end);
  return out.join('\n') + '\n';
}

// The ISP trace log to VCD: each register that changes (written once shows nothing, so left
// out), VIC frame counters, and the sensor's exposure and gain.
export function ispVcd(text) {
  const regs = new Map(), changes = [], count = new Map(), names = new Map();
  let t0 = null, lastNs = 0, lastT = null, seq = 0;
  const add = (ns, key, scope, name, v) => { count.set(key, (count.get(key) || 0) + 1); names.set(key, [scope, name]); changes.push([ns, key, v]); };
  for (const l of text.split('\n')) {
    const e = parseLine(l, lastT);
    if (!e) continue;
    lastT = e.t; seq++;
    const t = e.t ?? seq * 1e-6;
    if (t0 === null) t0 = t;
    const ns = lastNs = Math.max(Math.trunc((t - t0) * 1e9), lastNs);
    if (e.kind === 'write') {
      if (VOLATILE.test(e.name)) continue;
      const k = devKey(e.dev, e.off);
      if (regs.get(k) === e.val) continue;
      regs.set(k, e.val);
      add(ns, k, e.dev, e.name ? `${e.name}_${e.off.toString(16).padStart(5, '0')}` : 'r' + e.off.toString(16).padStart(5, '0'), e.val);
    } else if (e.kind === 'frame') add(ns, 'f' + e.dev + e.vic, e.dev, `vic${e.vic}_frame`, e.frame);
    else if (e.kind === 'exposure') {
      add(ns, 'x' + e.dev, e.dev, 'exposure16', e.lines);
      add(ns, 'g' + e.dev, e.dev, 'gain1024', e.gain);
    }
  }
  const keep = [...count].filter(([, n]) => n > 1).map(([k]) => k);
  if (!keep.length) return null;
  const ids = new Map(keep.map((k, i) => [k, vcdId(i)]));
  const out = ['$timescale 1ns $end'];
  for (const scope of [...new Set(keep.map((k) => names.get(k)[0]))].sort()) {
    out.push(`$scope module ${scope} $end`);
    for (const k of keep) if (names.get(k)[0] === scope) out.push(`$var wire 32 ${ids.get(k)} ${safe(names.get(k)[1])} $end`);
    out.push('$upscope $end');
  }
  out.push('$enddefinitions $end');
  let last = null;
  for (const [ns, k, v] of changes) {
    if (!ids.has(k)) continue;
    if (ns !== last) { out.push('#' + ns); last = ns; }
    out.push(`b${(v >>> 0).toString(2)} ${ids.get(k)}`);
  }
  return out.join('\n') + '\n';
}

export function saveText(text, name, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
