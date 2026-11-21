// Register sw.js; on the first visit the page is not yet isolated, so reload once
// when the worker takes control (guarded so a browser that refuses never loops).
if ("serviceWorker" in navigator && !self.crossOriginIsolated) {
  navigator.serviceWorker.register("sw.js").then(() => {
    let tried = false;
    try { tried = sessionStorage.getItem("qemu-web-isolate") === "1"; } catch (_) {}
    if (tried) return;
    const go = () => { try { sessionStorage.setItem("qemu-web-isolate", "1"); } catch (_) {} location.reload(); };
    if (navigator.serviceWorker.controller) go();
    else navigator.serviceWorker.addEventListener("controllerchange", go);
  }).catch(() => {});
}
