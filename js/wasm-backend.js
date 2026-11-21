import { Backend } from './backend.js';

const RAM_MB = { 'ingenic-t10': 64, 'ingenic-t20': 128, 'ingenic-t21': 64, 'ingenic-t23': 64,
  'ingenic-t30': 128, 'ingenic-t31': 128, 'ingenic-t32': 256, 'ingenic-t33': 256,
  'ingenic-t40': 256, 'ingenic-t41': 256, 'ingenic-a1': 256 };
// "[   12.345678] " kernel timestamps stand in for guest time between GPIO lines
const KTS = /\[\s*(\d+\.\d{6})\]/g;

// Runs the Emscripten build of the fork (core/README.md) inside js/wasm-worker.js.
// Needs a cross-origin isolated page. Stop and Reset terminate the worker.
export class WasmBackend extends Backend {
  constructor(base = 'core/') {
    super();
    this.base = base;
    this.worker = null;
    this.timer = null;
  }

  static async available(base = 'core/') {
    try {
      const r = await fetch(base + 'qemu-system-mipsel.wasm', { method: 'HEAD' });
      return r.ok && self.crossOriginIsolated && typeof Worker !== 'undefined';
    } catch {
      return false;
    }
  }

  async start(image, machine, options = {}) {
    this.stop(true);
    if (!image) throw new Error('the WebAssembly backend needs an image (file or URL)');
    if (!RAM_MB[machine]) throw new Error('pick a machine');
    this.last = { image, machine, options };
    this.guestNs = 0;
    this.kbase = undefined;
    this.tail = '';
    this.status('starting', { message: 'loading QEMU and booting in this browser' });
    // On the page itself by default: a worker of our own (?worker) could not
    // start the build's pthread pool in Chromium, so nothing booted there.
    const inline = !new URLSearchParams(location.search).has('worker');
    if (inline && WasmBackend.ran) throw new Error('this page already ran a guest and cannot end it: reload to boot again');
    if (inline) WasmBackend.ran = true;
    const w = inline ? { postMessage: () => {}, terminate: () => {} } : new Worker(new URL('./wasm-worker.js', import.meta.url), { type: 'module', name: 'qemu' });
    this.worker = w;
    const onmessage = ({ data }) => {
      if (w !== this.worker) return;
      switch (data.type) {
        case 'uart': this.uart(data.bytes); break;
        case 'gpio': this.gpio(data.text); break;
        case 'isp': this.emit('isp', data.text); break;
        case 'ready': this.status('running', { guestNs: this.guestNs, message: 'running in this browser' }); break;
        case 'log': console.warn('[qemu]', data.text); break;
        case 'error': this.status('error', { message: data.message }); this.kill(); break;
      }
    };
    const req = { type: 'start', image, machine, variant: options.variant || '',
      ramMb: options.ramMb || RAM_MB[machine], sensor: options.sensor || null, isp: !!options.isp, wifi: options.wifi || null, bootrom: options.bootrom || null, bootPins: options.bootPins || '', base: new URL(this.base, location.href).href };
    if (inline) {
      // On the page itself: no nested workers, but Stop and Reset cannot end it
      const r = await import('./wasm-runner.js');
      w.postMessage = (m) => r.input(m.bytes);
      r.run(req, (data) => onmessage({ data }));
    } else {
      w.onmessage = onmessage;
      w.onerror = (e) => { this.status('error', { message: e.message || 'worker failed' }); this.kill(); };
      w.postMessage(req);
    }
    this.timer = setInterval(() => this.status('running', { guestNs: this.guestNs }), 500);
  }

  uart(bytes) {
    this.emit('uart', bytes);
    this.tail = (this.tail + new TextDecoder('latin1').decode(bytes)).slice(-200);
    let m, ts = null;
    KTS.lastIndex = 0;
    while ((m = KTS.exec(this.tail))) ts = Number(m[1]);
    // kernel time starts when the kernel does: anchor it on the guest time of its first line
    if (ts !== null) {
      if (this.kbase === undefined) this.kbase = this.guestNs;
      this.guestNs = Math.max(this.guestNs, this.kbase + Math.round(ts * 1e9));
    }
  }

  gpio(text) {
    for (const line of text.split('\n')) {
      if (!line) continue;
      const m = /"t":(\d+)/.exec(line);
      if (m) this.guestNs = Math.max(this.guestNs, Number(m[1]));
      this.emit('gpio', line);
    }
  }

  kill() {
    clearInterval(this.timer); this.timer = null;
    this.worker?.terminate();
    this.worker = null;
  }

  stop(quiet) {
    this.kill();
    if (!quiet) this.status('stopped', { guestNs: this.guestNs, message: WasmBackend.ran ? 'output stopped; the guest keeps running until you reload the page' : 'stopped' });
  }

  // The build has no system reset hook: a reset is a fresh boot.
  async reset() {
    if (WasmBackend.ran) return this.status('error', { message: 'reload the page to reset: the guest cannot be restarted in place' });
    if (this.last) await this.start(this.last.image, this.last.machine, this.last.options);
  }

  uartWrite(bytes) { this.worker?.postMessage({ type: 'input', bytes: Array.from(bytes) }); }
  gpioDrive() { return false; }
}
