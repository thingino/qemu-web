# qemu-web

Boot thingino firmware for Ingenic cameras in your browser. The page runs the
thingino QEMU fork, compiled to WebAssembly, and shows the serial console (you can
type into it) and live GPIO activity: a pin table and a timeline.

Pick an image from a thingino release (the QEMU test images, any `firmware-*` or
`master-*` release) or load a `.bin` from your computer. Optionally attach an image
sensor model, or load a bootrom dump to boot through the real bootrom (choose SPI
flash, SD card or USB as the boot source).

## Browser support

Chrome, Edge or Firefox, current versions. The build uses 64-bit WebAssembly memory
and threads; Safari supports neither combination yet. Expect about 1.5 GB of memory
use in the tab.

## How it works

- `core/`: QEMU (`qemu-system-mipsel`) built with Emscripten for wasm64, with a
  WebAssembly TCG backend that compiles hot guest code to WebAssembly modules.
- `sw.js`: QEMU's threads need `SharedArrayBuffer`, which a browser only grants a
  cross-origin isolated page. GitHub Pages cannot send the headers for that, so this
  small service worker adds them; the first visit reloads once.
- Images: the newest `qemu-images-*` release is mirrored into the site by the Pages
  workflow. Firmware and master release images are fetched through the thingino web
  flasher's download proxy, because GitHub release downloads send no CORS header.
  Release lists come straight from the GitHub API.

## Source

The page code is MIT licensed (see `LICENSE`). xterm.js is MIT (`vendor/`).

QEMU is GPL-2.0-or-later. The binaries in `core/` are built from the thingino QEMU
fork, https://github.com/gtxaspec/qemu, branch `card/wasm-tcg`. The WebAssembly TCG
backend in it is Kohei Tokunaga's "wasm: Add Wasm TCG backend based on wasm64" series
(v4, qemu-devel, January 2026), ported to the fork.

## Running it locally

Any static server works, for example `python3 -m http.server`, then open
http://localhost:8000/. A service worker needs `localhost` or HTTPS.
