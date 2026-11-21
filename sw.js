/*
 * qemu-web service worker, in the style of the image builder's sw.js.
 *
 * QEMU's WebAssembly build runs on threads, which need SharedArrayBuffer, which a
 * browser only grants a cross-origin isolated page. GitHub Pages cannot send the two
 * headers that make a page isolated, so this worker adds them to every same-origin
 * response. The first visit loads before the worker controls the page; sw-register.js
 * reloads once so the page comes back isolated.
 *
 * Page and fixed-name .js/.css/.wasm files are fetched network-first (a cheap 304 when
 * unchanged) so a redeploy lands on a normal reload. Cross-origin requests pass through.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function isolate(r) {
  if (r.status === 0) return r;
  const h = new Headers(r.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const fresh = req.mode === "navigate" ? "reload" : /\.(?:js|css|wasm|json)$/.test(url.pathname) ? "no-cache" : undefined;
  event.respondWith(fetch(req, fresh ? { cache: fresh } : {}).catch(() => fetch(req)).then(isolate));
});
