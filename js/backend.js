// Backend contract shared by ReplayBackend and WasmBackend (see README).
//   await start(imageBytes|null, machine, options)   stop()   reset()
//   uartWrite(Uint8Array)   gpioDrive(pin, level)
// events: 'uart' (Uint8Array), 'gpio' (one JSON line, string),
//         'status' ({state, guestNs, message}); state is one of
//         idle | starting | running | stopped | error.

export class Backend {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }
  status(state, extra = {}) { this.emit('status', { state, ...extra }); }
  async start() { throw new Error('not implemented'); }
  stop() {}
  reset() {}
  uartWrite() {}
  gpioDrive() { return false; }
}

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const gpioTimeMs = (line) => {
  const m = /"t":(\d+)/.exec(line);
  return m ? Number(m[1]) / 1e6 : 0;
};

// Plays a recording made from the native QEMU (tools/make_recording.py):
// UART chunks and GPIO lines are released on the guest clock, at real speed
// unless options.speed says otherwise. Image and machine are ignored; the
// recording says what it was.
export class ReplayBackend extends Backend {
  constructor(base = 'recordings/') {
    super();
    this.base = base;
    this.events = [];
    this.timer = null;
  }

  static async list(base = 'recordings/') {
    const r = await fetch(base + 'index.json');
    if (!r.ok) throw new Error('no recordings');
    return r.json();
  }

  async start(_image, _machine, options = {}) {
    this.stop(true);
    this.speed = options.speed || 1;
    this.status('starting', { message: 'loading recording' });
    const list = await ReplayBackend.list(this.base);
    const entry = list.find((e) => e.id === options.recording) || list[0];
    const rec = await (await fetch(this.base + entry.file)).json();
    this.meta = rec.meta;
    this.events = [
      ...rec.uart.map(([ms, data]) => ({ ms, kind: 'uart', data })),
      ...rec.gpio.map((line) => ({ ms: gpioTimeMs(line), kind: 'gpio', data: line })),
    ].sort((a, b) => a.ms - b.ms);
    this.begin();
  }

  begin() {
    this.next = 0;
    this.guestMs = 0;
    this.last = performance.now();
    this.status('running', { guestNs: 0, message: 'replaying: ' + this.meta.label });
    this.timer = setInterval(() => this.tick(), 20);
  }

  tick() {
    const now = performance.now();
    this.guestMs += (now - this.last) * this.speed;
    this.last = now;
    const ev = this.events;
    while (this.next < ev.length && ev[this.next].ms <= this.guestMs) {
      const e = ev[this.next++];
      if (e.kind === 'uart') this.emit('uart', b64(e.data));
      else this.emit('gpio', e.data);
    }
    const done = this.next >= ev.length && this.guestMs > this.meta.durationMs;
    this.status(done ? 'stopped' : 'running', {
      guestNs: Math.round(this.guestMs * 1e6),
      message: done ? 'recording ended' : 'replaying: ' + this.meta.label,
    });
    if (done) this.stop(true);
  }

  stop(quiet) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!quiet) this.status('stopped', { guestNs: Math.round((this.guestMs || 0) * 1e6), message: 'stopped' });
  }

  reset() {
    if (!this.meta) return;
    this.stop(true);
    this.emit('gpio', '{"t":0,"reset":true,"ports":6}');
    this.begin();
  }

  uartWrite() {
    // A recording has no guest to answer
  }

  gpioDrive() {
    return false;
  }
}
