import { Backend } from './backend.js';

// Talks to tools/serve.py's /api (a native QEMU on the server): SSE for the
// UART and GPIO streams, POSTs for keystrokes, reset and pin drives.
export class NativeBackend extends Backend {
  constructor(base = 'api/') {
    super();
    this.base = base;
    this.es = [];
    this.poll = null;
    this.q = Promise.resolve();
  }

  static async available(base = 'api/') {
    try { return (await fetch(base + 'status')).ok; } catch { return false; }
  }

  static async images(base = 'api/') {
    return (await fetch(base + 'images')).json();
  }

  async post(path, body, type = 'application/octet-stream') {
    const r = await fetch(this.base + path, { method: 'POST', body, headers: { 'Content-Type': type } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  }

  // options.serverImage names an image the server lists; otherwise the bytes are uploaded
  async start(image, machine, options = {}) {
    this.closeAll();
    this.status('starting', { message: 'starting QEMU on the server' });
    const sensor = options.sensor ? { sensor: options.sensor.model, bus: options.sensor.bus } : {};
    if (options.bootPins) sensor.bootpins = options.bootPins;
    if (options.wifi) Object.assign(sensor, { wifi: options.wifi.chip, ssid: options.wifi.ssid, psk: options.wifi.psk });
    await this.post('bootrom', options.bootrom || new Uint8Array(0));
    const qs = new URLSearchParams({ machine, variant: options.variant || '', name: options.name || 'upload.bin', ...sensor });
    let st;
    if (options.serverImage) {
      st = await this.post('start', JSON.stringify({ image: options.serverImage, machine, variant: options.variant || '', ...sensor }), 'application/json');
    } else {
      if (!image) throw new Error('load an image or pick a server image');
      st = await this.post('start?' + qs, image);
    }
    this.open('uart', (d) => this.emit('uart', Uint8Array.from(atob(d), (c) => c.charCodeAt(0))));
    this.open('gpio', (d) => this.emit('gpio', d));
    this.poll = setInterval(() => this.refresh(), 500);
    this.refresh(st);
  }

  open(name, onData) {
    const es = new EventSource(this.base + name);
    es.onmessage = (e) => onData(e.data);
    es.addEventListener('end', () => es.close());
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) es.close(); };
    this.es.push(es);
  }

  async refresh(st) {
    try {
      st ||= await (await fetch(this.base + 'status')).json();
    } catch { return; }
    if (st.state === 'error') this.status('error', { message: st.error });
    else this.status(st.state, { guestNs: st.guestNs, message: st.state === 'running' ? 'native QEMU, pid ' + st.pid + ' (guest time is wall time since start)' : st.state });
    if (st.state === 'error' || st.state === 'stopped') this.closeStreams();
  }

  closeStreams() {
    clearInterval(this.poll); this.poll = null;
    setTimeout(() => { for (const e of this.es) e.close(); this.es = []; }, 1000);
  }

  closeAll() {
    clearInterval(this.poll); this.poll = null;
    for (const e of this.es) e.close();
    this.es = [];
  }

  stop(quiet) {
    this.closeAll();
    this.post('stop', '').catch(() => {});
    if (!quiet) this.status('stopped', { message: 'stopped' });
  }

  reset() { this.post('reset', '').catch((e) => this.status('error', { message: e.message })); }

  uartWrite(bytes) {
    this.q = this.q.then(() => this.post('uart', bytes)).catch(() => {});
  }

  gpioDrive(pin, level) {
    this.post('drive', JSON.stringify({ pin, level }), 'application/json').catch((e) => this.status('running', { message: 'drive failed: ' + e.message }));
    return true;
  }
}
