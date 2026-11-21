import { ReplayBackend } from './backend.js';
import { WasmBackend } from './wasm-backend.js';
import { NativeBackend } from './native-backend.js';
import { MACHINES, describeImage, fmtBytes, socFromText } from './imageinfo.js';
import { STAGES, StageDetector, stripAnsi } from './stages.js';
import { GpioModel, PinTable, Timeline } from './gpio.js';

const $ = (id) => document.getElementById(id);
// Messages show in the header; between messages it says whether the page is
// isolated only when it is not (then the WebAssembly backend cannot run).
const WARN = /fail|could not|blocked|too big|first|pick a|cannot|error/i;
function restMsg() {
  const m = $('msg');
  m.className = 'badge bad';
  m.textContent = 'not isolated: WebAssembly needs HTTPS or localhost';
  m.title = 'The page must be cross-origin isolated (COOP and COEP) for QEMU\'s threads';
  m.hidden = self.crossOriginIsolated;
}
// A message that stays until the next one
function status(msg) {
  const m = $('msg');
  clearTimeout(toast.h);
  m.className = 'badge info'; m.textContent = m.title = msg; m.hidden = false;
}
const toast = (msg) => {
  const m = $('msg');
  m.className = 'badge ' + (WARN.test(msg) ? 'bad' : 'info');
  m.textContent = m.title = msg;
  m.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(restMsg, 6000);
};
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

// theme
const root = document.documentElement;
const savedTheme = store.get('theme');
if (savedTheme) root.dataset.theme = savedTheme;
const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
$('theme').onclick = () => {
  root.dataset.theme = isDark() ? 'light' : 'dark';
  store.set('theme', root.dataset.theme);
  applyTermTheme(); timeline.invalidate();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTermTheme(); timeline.invalidate(); });

// isolation badge
restMsg();

// terminal
const term = new Terminal({ convertEol: true, scrollback: 10000, fontSize: 13, cursorBlink: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('term'));
function applyTermTheme() {
  const cs = getComputedStyle(root);
  term.options.theme = {
    // dark in both themes: the firmware's colours are chosen for a dark screen
    background: cs.getPropertyValue('--term-bg').trim(), foreground: '#e3e7ef',
    cursor: '#5aa2ff', selectionBackground: '#3b5a8a',
  };
}
applyTermTheme();
new ResizeObserver(() => { try { fit.fit(); } catch { /* not laid out yet */ } }).observe($('term'));

const LOG_CAP = 8 << 20;
let logChunks = [], logBytes = 0;
const textDec = new TextDecoder('latin1');
const textEnc = new TextEncoder();
const logText = () => stripAnsi(logChunks.map((c) => textDec.decode(c)).join(''));
function logPush(bytes) {
  logChunks.push(bytes); logBytes += bytes.length;
  while (logBytes > LOG_CAP && logChunks.length > 1) logBytes -= logChunks.shift().length;
}
$('copy').onclick = async () => {
  const text = term.getSelection() || logText();
  try { await navigator.clipboard.writeText(text); toast(term.hasSelection() ? 'Selection copied' : 'Log copied'); }
  catch { toast('Copy blocked by the browser'); }
};
$('save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([logText()], { type: 'text/plain' }));
  a.download = `thingino-console-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('clear').onclick = () => { term.clear(); logChunks = []; logBytes = 0; };

// gpio
const model = new GpioModel();
const pinTable = new PinTable($('pins'), (gpio) => drivePin(gpio));
const timeline = new Timeline($('tl'), model);
$('win').onchange = (e) => timeline.setWindow(Number(e.target.value));
$('follow').onchange = (e) => timeline.setFollow(e.target.checked);
function onGpio(line) {
  const e = model.apply(line);
  if (!e) return;
  $('pins-empty').hidden = true;
  pinTable.update(model, e);
  timeline.invalidate();
  if (e.kind === 'pin') {
    const li = document.createElement('li');
    const lvl = e.lvl === undefined ? '' : ' ' + e.lvl;
    li.innerHTML = `${(e.tMs / 1000).toFixed(3).padStart(8)} s  <b>${e.pin}</b> ${e.fn}${lvl}  ${e.src ? 'outside' : e.pc}`;
    const ul = $('recent');
    ul.prepend(li);
    while (ul.children.length > 60) ul.lastChild.remove();
  }
}
function drivePin(gpio) {
  const p = model.pins.get(gpio);
  if (!p || (p.fn !== 'in' && p.fn !== 'irq')) return toast('Only input pins can be driven');
  const next = p.lvl ? 0 : 1;
  // Stub: the adapter's gpioDrive(pin, level) is where the core's in-pX
  // properties get set once the module exposes them.
  toast(backend.gpioDrive(p.pin, next) ? `${p.pin} driven ${next}` : 'This backend cannot drive pins yet');
}

// stages
const stages = new StageDetector();
const stageList = $('stages');
STAGES.slice(1).forEach((s) => { const li = document.createElement('li'); li.textContent = s; stageList.appendChild(li); });
function showStage() {
  [...stageList.children].forEach((li, i) => {
    li.classList.toggle('done', i + 1 < stages.stage);
    li.classList.toggle('now', i + 1 === stages.stage);
  });
}

// image
let image = null;
let bootrom = null;
const SENSORS = 'cv2003 cv2005 cv8001 gc1084 gc2023 gc2053 gc2063 gc2083 gc3003a gc4023 gc4653 gc4663 gc5603 gc5613 imx307 imx327 jxf22 jxf23 jxf28 jxf37 jxh42 jxh62 jxh63p jxk04 jxq03 jxq03p mis2008 mis20c1 os02b10 os02g10 os02n10 os03b10 os04d10 os05a10 os08a10 os08c10 ov2710 ov2735b ov9712 ov9732 ov9750 ps5250 ps5260 sc1235 sc1a4t sc2135 sc2232 sc2232h sc2235 sc223a sc2300 sc2310 sc231hai sc2331 sc2332 sc2336 sc2336p sc301iot sc3235 sc3332 sc3335 sc3336 sc3338 sc401ai sc4236 sc4336 sc4336p sc500ai sc5235 sc5336 sc8238 sc830ai sc835hai'.split(' ');
// The sensor and bus each qemu_* test image is built for
const PART_SENSOR = { t10n: ['jxh42', 'i2c0'], t20x: ['jxf22', 'i2c0'], t21n: ['sc2232h', 'i2c0'], t23n: ['sc2336', 'i2c0'],
  t30x: ['sc4236', 'i2c0'], t31x: ['gc2053', 'i2c0'], t32nq: ['cv8001', 'i2c0'], t40nn: ['imx307', 'i2c1'], t41nq: ['gc4023', 'i2c0'] };
$('sensor').innerHTML = '<option value="">none</option>' + SENSORS.map((s) => `<option>${s}</option>`).join('');
// Wi-Fi chips the fork models, with the names thingino's camera configs use for them
const WIFI = [
  ['atbm6031', 'sdio', 'atbm6031 atbm6031x'], ['atbm6041', 'sdio', 'atbm6041'], ['atbm6441', 'sdio', 'atbm6441'],
  ['atbm6062s', 'sdio', 'atbm6062s'], ['atbm6162s', 'sdio', 'atbm6162s'],
  ['rtl8189fs', 'sdio', 'rtl8189fs rtl8189ftv'], ['rtl8189es', 'sdio', 'rtl8189es rtl8189etv'], ['rtl8192fs', 'sdio', 'rtl8192fs'],
  ['aic8800d80-sdio', 'sdio', 'aic8800d40'], ['aic8800d40l-sdio', 'sdio', ''], ['bcm43438', 'sdio', 'syn4343 bcm43438'],
  ['bcm43436', 'sdio', 'bcm43436'], ['hi3881', 'sdio', 'hi3881'], ['ssv6158', 'sdio', 'ssv6158'],
  ['aic8800', 'usb', 'aic8800d'], ['aic8800d80', 'usb', 'aic8800u'], ['aic8800dc', 'usb', 'aic8800dc'], ['aic8800dw', 'usb', 'aic8800dw'],
  ['atbm6012b', 'usb', 'atbm6012b'], ['atbm6012bx', 'usb', 'atbm6012bx'], ['atbm6032', 'usb', 'atbm6032'], ['atbm6132u', 'usb', 'atbm6132u'],
  ['atbm6062u', 'usb', 'atbm6062u'], ['atbm6062cu', 'usb', 'atbm6062cu'], ['atbm6132cu', 'usb', 'atbm6132cu'],
  ['mt7601u', 'usb', 'mt7601 mt7601u mt7601sta'], ['rtl8188fu', 'usb', 'rtl8188ftv rtl8188fu'], ['rtl8188eu', 'usb', 'rtl8188eu rtl8188eus'],
  ['rtl8733bu', 'usb', 'rtl8131bu rtl8731 rtl8731bu rtl8733bu'], ['ssv6155p', 'usb', 'ssv6155 ssv6155p ssv6256p'], ['ssv6355', 'usb', 'ssv6355'],
  ['swt6621s', 'usb', 'swt6621s'], ['txw901u', 'usb', 'txw901u'], ['wq9001', 'usb', 'wq9001'], ['ws73v100', 'usb', 'ws73v100'],
].map(([chip, bus, names]) => ({ chip, bus, names: names.split(' ').filter(Boolean) }));
$('wifi').innerHTML = '<option value="">none</option>' + WIFI.map((w) => `<option value="${w.chip}">${w.chip} (${w.bus.toUpperCase()})</option>`).join('');
const showWifiCfg = () => document.querySelectorAll('.wifi-cfg').forEach((e) => { e.hidden = !$('wifi').value; });
$('wifi').onchange = showWifiCfg;
function pickWifi(name) {
  const words = name.toLowerCase().split(/[^a-z0-9]+/);
  $('wifi').value = WIFI.find((w) => w.names.some((n) => words.includes(n)))?.chip || '';
  showWifiCfg();
}
function wifiOption() {
  const w = WIFI.find((x) => x.chip === $('wifi').value);
  return w ? { chip: w.chip, bus: w.bus === 'usb' ? 'usb-bus.0' : 'msc1', usb: w.bus === 'usb', ssid: $('ssid').value, psk: $('psk').value } : null;
}
function pickSensor(name, variant) {
  const words = name.toLowerCase().split(/[^a-z0-9]+/);
  const hit = SENSORS.filter((s) => words.includes(s)).sort((a, b) => b.length - a.length)[0];
  const [model, bus] = hit ? [hit, PART_SENSOR[variant]?.[1] || 'i2c0'] : (PART_SENSOR[variant] || ['', 'i2c0']);
  $('sensor').value = model; $('sensor-bus').value = bus;
  pickWifi(name);
}
$('bootrom').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 4 << 20) { e.target.value = ''; return toast('That file is too big for a bootrom'); }
  bootrom = { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name };
  $('bootrom-clear').hidden = false; $('boot-src-label').hidden = false;
};
$('bootrom-clear').onclick = () => { bootrom = null; $('bootrom').value = ''; $('bootrom-clear').hidden = true; $('boot-src-label').hidden = true; };
const machineSel = $('machine');
machineSel.add(new Option('auto (from image)', ''));
for (const [soc, m] of Object.entries(MACHINES)) machineSel.add(new Option(`${m} (${soc})`, m));
function setImage(bytes, name) {
  const info = describeImage(bytes, name);
  image = { bytes, info };
  machineSel.value = info.soc ? MACHINES[info.soc] : '';
  $('variant').value = info.variant || '';
  pickSensor(name, info.variant || '');
  const rows = [['Image', name], ['Size', `${fmtBytes(info.size)} (${info.size} bytes)`],
    ['SoC', info.soc ? `${info.variant.toUpperCase()} (from ${info.source})` : 'unknown, pick a machine'],
    ['Flash', info.flash], ['U-Boot', info.uboot || 'not found']];
  const dl = $('info');
  dl.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k; dd.textContent = v;
    dl.append(dt, dd);
  }
}
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) setImage(new Uint8Array(await f.arrayBuffer()), f.name);
};
$('load-url').onclick = async () => {
  const url = $('url').value.trim();
  if (!url) return;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const total = Number(r.headers.get('content-length')) || 0;
    const parts = []; let got = 0;
    const rd = r.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      parts.push(value); got += value.length;
      $('load-url').textContent = total ? Math.round(got / total * 100) + '%' : fmtBytes(got);
    }
    const bytes = new Uint8Array(got);
    let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
    setImage(bytes, decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'image.bin'));
  } catch (err) {
    toast('Fetch failed: ' + err.message);
  } finally {
    $('load-url').textContent = 'Fetch';
  }
};

// backends
const backends = { replay: new ReplayBackend() };
let backend = backends.replay;
const wasmOpt = [...$('backend').options].find((o) => o.value === 'wasm');
WasmBackend.available().then((ok) => {
  if (ok) { backends.wasm = new WasmBackend(); setTimeout(() => pickWasm()); }
  else { wasmOpt.disabled = true; wasmOpt.textContent += self.crossOriginIsolated ? ' (no module in core/)' : ' (needs an isolated page)'; }
  bind();
});
const nativeOpt = [...$('backend').options].find((o) => o.value === 'native');
let staticImages = null;
// GitHub release downloads send no CORS header, so firmware and master images come
// through the web flasher's proxy; the newest QEMU test images are mirrored on the site.
const FW_PROXY = 'https://thingino-dfu-fw.thingino.workers.dev/fw';
const releases = {};
async function loadReleases() {
  $('rel-label').hidden = false; $('srv-label').hidden = false;
  $('release').innerHTML = '<option>Loading…</option>'; $('release').disabled = true;
  $('srvimg').options[0].textContent = 'Loading…';
  status('Loading thingino releases…');
  try {
    const idx = await (await fetch('images/index.json')).json();
    releases[idx.release] = { label: `${idx.release.replace('qemu-images-', 'QEMU test images ')}`,
      images: idx.images.map((i) => ({ id: i.id, url: 'images/' + i.file, name: i.name, size: i.size })) };
  } catch { /* no mirror */ }
  try {
    const r = await fetch('https://api.github.com/repos/themactep/thingino-firmware/releases?per_page=40');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    for (const x of await r.json()) {
      const m = /^(firmware|master)-(.+)$/.exec(x.tag_name);
      if (x.draft || !m) continue;
      // Only images whose name carries a SoC this QEMU models
      const imgs = x.assets.filter((a) => /^thingino-.+\.bin$/.test(a.name) && MACHINES[socFromText(a.name.slice(9, -4))?.family])
        .map((a) => ({ id: a.name.slice(0, -4), name: a.name.slice(9, -4), size: a.size,
          url: `${FW_PROXY}?tag=${encodeURIComponent(x.tag_name)}&name=${encodeURIComponent(a.name)}` }));
      if (imgs.length) releases[x.tag_name] = { label: `${m[1]} ${m[2]}`, images: imgs };
    }
  } catch (err) { toast('Could not list thingino releases: ' + err.message); }
  $('release').innerHTML = ''; $('release').disabled = false;
  if (!Object.keys(releases).length) { $('rel-label').hidden = true; $('srvimg').options[0].textContent = '(use the file above)'; return; }
  toast(`Found ${Object.keys(releases).length} releases`);
  for (const [tag, r] of Object.entries(releases)) $('release').add(new Option(`${r.label} (${r.images.length})`, tag));
  $('rel-label').hidden = $('imgfilter').hidden = false;
  $('srv-label').firstChild.textContent = 'Image ';
  showRelease();
  pickWasm();
}
function showRelease() {
  const rel = releases[$('release').value];
  if (!rel) return;
  const q = $('imgfilter').value.trim().toLowerCase();
  staticImages = Object.fromEntries(rel.images.map((i) => [i.id, i]));
  const sel = $('srvimg');
  sel.length = 1;
  sel.options[0].textContent = '(use the file above)';
  for (const i of rel.images) if (!q || i.name.toLowerCase().includes(q)) sel.add(new Option(`${i.name} (${fmtBytes(i.size)})`, i.id));
}
$('release').onchange = showRelease;
$('imgfilter').oninput = showRelease;
// A static site (no server) opens on the WebAssembly backend once both checks are in
function pickWasm() {
  if (staticImages && backends.wasm && backend !== backends.wasm) { $('backend').value = 'wasm'; $('backend').dispatchEvent(new Event('change')); }
}
NativeBackend.available().then(async (ok) => {
  if (!ok) {
    nativeOpt.remove();
    await loadReleases();
    return;
  }
  backends.native = new NativeBackend();
  bind();
  for (const i of await NativeBackend.images()) $('srvimg').add(new Option(`${i.id} (${fmtBytes(i.size)})`, i.id));
});
$('srvimg').onchange = (e) => {
  const hit = socFromText(e.target.value.split('/').pop().replace(/\.bin$/, ''));
  if (hit) { machineSel.value = MACHINES[hit.family]; $('variant').value = hit.variant; }
  pickSensor(e.target.value.split('/').pop(), hit?.variant || '');
};
// No recordings (the public site ships none): no Replay option
const noReplay = () => { [...$('backend').options].find((o) => o.value === 'replay')?.remove(); $('rec-label').hidden = true; pickWasm(); };
ReplayBackend.list().then((list) => {
  if (!list.length) return noReplay();
  for (const r of list) $('recording').add(new Option(r.label, r.id));
}).catch(noReplay);

const stateEl = $('st-state');
let lastSample = null;
let runStart = null;
setInterval(() => {
  const live = runStart !== null;
  $('st-elapsed').textContent = live ? fmtElapsed((performance.now() - runStart) / 1000) : '-';
}, 500);
const backendName = () => $('backend').value;
const fmtElapsed = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function setState(state) {
  if ((state === 'starting' || state === 'running') && runStart === null) runStart = performance.now();
  if (state !== 'starting' && state !== 'running') runStart = null;
  stateEl.textContent = state; stateEl.dataset.state = state;
  const live = state === 'running' || state === 'starting';
  $('start').disabled = live;
  $('stop').disabled = !live;
  $('reset').disabled = !live;
}
function onStatus(s) {
  setState(s.state);
  if (s.message !== undefined) $('st-msg').textContent = s.message || '-';
  if (s.guestNs !== undefined) {
    $('st-time').textContent = (s.guestNs / 1e9).toFixed(3) + ' s';
    const now = performance.now();
    // Guest time arrives in steps (kernel timestamps, GPIO events), so measure
    // between steps over a sliding window rather than per status tick.
    if (!lastSample) lastSample = [{ ns: s.guestNs, at: now }];
    else if (s.guestNs !== lastSample[lastSample.length - 1].ns) {
      lastSample.push({ ns: s.guestNs, at: now });
      while (lastSample.length > 2 && now - lastSample[1].at > 15000) lastSample.shift();
      const a = lastSample[0], span = now - a.at;
      if (span >= 2000) $('st-speed').textContent = ((s.guestNs - a.ns) / 1e6 / span).toFixed(2) + 'x real time';
    }
    // No guest clock output for a while (quiet init): nothing current to measure
    else if (now - lastSample[lastSample.length - 1].at > 10000) $('st-speed').textContent = '-';
  }
}
function bind() {
  for (const b of Object.values(backends)) {
    if (b.bound) continue;
    b.bound = true;
    b.on('uart', (bytes) => { term.write(bytes); logPush(bytes); const was = stages.stage; if (stages.feed(bytes) !== was) showStage(); })
      .on('gpio', onGpio)
      .on('status', (s) => { if (b === backend) onStatus(s); });
  }
}
bind();
$('backend').onchange = (e) => {
  backend.stop(true);
  $('srv-label').hidden = e.target.value === 'replay';
  $('rec-label').hidden = e.target.value !== 'replay';
  $('speed-label').hidden = e.target.value !== 'replay';
  $('hw-row').hidden = e.target.value === 'replay';
  backend = backends[e.target.value];
  setState('idle');
};
term.onData((d) => backend.uartWrite(textEnc.encode(d)));

function clearRun() {
  runStart = null;
  term.reset(); logChunks = []; logBytes = 0;
  stages.reset(); showStage();
  model.clear(); pinTable.clear(); timeline.invalidate();
  $('recent').textContent = ''; $('pins-empty').hidden = false;
  $('st-time').textContent = '0.000 s'; $('st-speed').textContent = '-';
  lastSample = null;
}
$('start').onclick = async () => {
  const mode = $('backend').value;
  const serverImage = mode === 'native' ? $('srvimg').value : '';
  const wantServer = $('srvimg').value && !image;
  if (mode === 'wasm' && wantServer) {
    try {
      const id = $('srvimg').value;
      if (staticImages) toast('Downloading ' + staticImages[id].name + '…');
      const r = await fetch(staticImages ? staticImages[id].url : 'api/image?id=' + encodeURIComponent(id));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setImage(new Uint8Array(await r.arrayBuffer()), $('srvimg').value.split('/').pop());
    } catch (err) { return toast('Server image failed: ' + err.message); }
  }
  if (mode !== 'replay' && !image && !serverImage) return toast('Load an image first');
  if (mode !== 'replay' && !machineSel.value) return toast('Pick a machine');
  clearRun();
  try {
    await backend.start(image?.bytes ?? null, machineSel.value, {
      variant: $('variant').value.trim(), speed: Number($('speed').value), recording: $('recording').value,
      serverImage, name: image?.info.name,
      sensor: $('sensor').value ? { model: $('sensor').value, bus: $('sensor-bus').value } : null,
      wifi: wifiOption(),
      bootrom: bootrom?.bytes ?? null, bootPins: bootrom ? $('boot-src').value : '',
    });
  } catch (err) {
    setState('error');
    $('st-msg').textContent = err.message;
  }
};
$('stop').onclick = () => backend.stop();
$('reset').onclick = () => { clearRun(); backend.reset(); };
showStage();
setState('idle');
if (new URLSearchParams(location.search).has('autostart')) {
  if (new URLSearchParams(location.search).get('speed')) $('speed').value = new URLSearchParams(location.search).get('speed');
  setTimeout(() => $('start').click(), 300);
}
