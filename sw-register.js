// Register sw.js and get the page under its control, which is what makes it
// cross-origin isolated. Two cases need one reload: the first visit (the worker
// is installed after the page loaded) and a hard refresh (the browser bypasses
// the worker for that load). The reload carries ?isolate, so a browser that
// refuses service workers stops there instead of reloading forever; an isolated
// page drops the marker from the address bar.
(function () {
  if (!("serviceWorker" in navigator)) return;
  const url = new URL(location.href);
  const tried = url.searchParams.has("isolate");
  if (self.crossOriginIsolated) {
    if (tried) { url.searchParams.delete("isolate"); history.replaceState(null, "", url); }
    navigator.serviceWorker.register("sw.js").catch(() => {});
    return;
  }
  if (tried) { navigator.serviceWorker.register("sw.js").catch(() => {}); return; }
  navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).then(() => {
    // ready means the worker is active, so this load comes back under it
    url.searchParams.set("isolate", "");
    location.replace(url);
  }).catch(() => {});
})();
