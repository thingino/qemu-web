// Runs the Emscripten QEMU: in a worker (wasm-worker.js) or on the page (inline).
// run(data, post): data = {image, machine, variant, ramMb, base}; input(bytes) queues keystrokes.
// post gets {type:"uart", bytes, port}, {type:"gpio", text} (pin, timer unit and PWM JSON lines), {type:"isp", text} (ISP trace log lines), {type:"ready"}, {type:"log", text}, {type:"error", message}.
import { ISP_TRACE_ARGS } from './isp.js';
export const enc = new TextEncoder();
let m = null, pending = [], port = 1, post = null;

function pump() {
  // The UART FIFO takes only so many bytes; what it refuses waits. The call
  // takes the big lock, so it must never run inside an output callback.
  if (!m || !pending.length) return;
  m.HEAPU8.set(enc.encode(`uart${port}\0`), Number(m._qemu_wasm_chr_idbuf()));
  while (pending.length) {
    const n = Math.min(pending.length, 64);
    m.HEAPU8.set(pending.slice(0, n), Number(m._qemu_wasm_chr_inbuf()));
    const got = m._qemu_wasm_chr_input(n);
    pending.splice(0, got);
    if (got < n) break;
  }
}
setInterval(pump, 20);

export function input(bytes) { pending.push(...bytes); }

export async function run(data, send) {
  post = send;
  try {
    const { default: factory } = await import(data.base + 'qemu-system-mipsel.js');
    // The T31's console is its second serial port; other SoCs may speak on
    // either, so they get both and the first to speak is the console.
    const both = data.machine !== 'ingenic-t31';
    const args = ['-M', data.machine, '-display', 'none', '-monitor', 'none',
      '-drive', 'file=/flash.bin,format=raw,if=none,id=flash0,file.locking=off'];
    if (both) args.push('-chardev', 'file,id=uart0,path=/dev/uart0out', '-serial', 'chardev:uart0');
    else args.push('-serial', 'null');
    args.push('-chardev', 'file,id=uart1,path=/dev/uart1out', '-serial', 'chardev:uart1',
      '-m', `${data.ramMb}M`);
    if (data.variant) args.push('-global', `${data.machine}.soc-variant=${data.variant}`);
    if (data.sensor) args.push('-device', `image-sensor,model=${data.sensor.model},bus=${data.sensor.bus},stamp=on`);
    if (data.wifi) {
      const q = (v) => String(v).replace(/,/g, ',,');
      args.push('-device', `${data.wifi.chip},bus=${data.wifi.bus}${data.wifi.usb ? ',port=1' : ''},ssid=${q(data.wifi.ssid)}${data.wifi.psk ? ',psk=' + q(data.wifi.psk) : ''}`);
    }
    if (data.bootrom) args.push('-bios', '/bootrom.bin', '-global', `ingenic-gpio.in-pc=${data.bootPins || '0xfffffffd'}`);
    args.push('-chardev', 'file,id=gpiotrace,path=/dev/gpiotrace', '-global', 'ingenic-gpio.trace=gpiotrace',
      '-chardev', 'file,id=tcutrace,path=/dev/tcutrace', '-global', 'ingenic-tcu.trace=tcutrace',
      '-chardev', 'file,id=pwmtrace,path=/dev/pwmtrace', '-global', 'ingenic-pwm.trace=pwmtrace');
    if (data.isp) args.push(...ISP_TRACE_ARGS, '-D', '/dev/isptrace');
    let active = null;
    const uartDev = (n) => ({ open() {}, close() {}, read() { return 0; },
      write(_s, buf, off, len) {
        if (active === null) { active = n; port = n; }
        if (active === n) {
          const bytes = buf.slice(off, off + len);
          post({ type: 'uart', bytes }, [bytes.buffer]);
        }
        return len;
      } });
    // A device whose writes are text lines, sent on as whole lines of one message type
    const lineDev = (type) => {
      let tail = '';
      const dec = new TextDecoder();
      return { open() {}, close() {}, read() { return 0; },
        write(_s, buf, off, len) {
          // the heap is shared memory, which TextDecoder refuses: copy first
          tail += dec.decode(buf.slice(off, off + len), { stream: true });
          const i = tail.lastIndexOf('\n');
          if (i >= 0) { post({ type, text: tail.slice(0, i) }); tail = tail.slice(i + 1); }
          return len;
        } };
    };
    await factory({
      arguments: args,
      locateFile: (p) => data.base + p,
      preRun: [(mod) => {
        m = mod;
        const FS = mod.FS;
        FS.writeFile('/flash.bin', data.image);
        if (data.bootrom) FS.writeFile('/bootrom.bin', data.bootrom);
        for (const [i, name, dev] of [[0, 'uart0out', uartDev(0)], [1, 'uart1out', uartDev(1)], [2, 'gpiotrace', lineDev('gpio')], [3, 'tcutrace', lineDev('gpio')], [4, 'pwmtrace', lineDev('gpio')], [5, 'isptrace', lineDev('isp')]]) {
          const id = FS.makedev(64, i);
          FS.registerDevice(id, dev);
          FS.mkdev('/dev/' + name, id);
        }
      }],
      print: () => {},
      printErr: (s) => { if (!s.startsWith('warning: unsupported')) post({ type: 'log', text: s }); },
    });
    post({ type: 'ready' });
  } catch (e) {
    post({ type: 'error', message: String(e?.message || e) });
  }
}
