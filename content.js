// ── FELCA Reporter — content.js ───────────────────────────────────────────
// Loaded on all YouTube pages. Signals readiness to the background worker
// and ensures ytcfg is accessible for the injected script.

(function () {
  // Nothing active needed here — the background.js uses executeScript
  // to inject injectAndReport() directly, which reads window.ytcfg.
  // This content script file is kept for potential future use and
  // ensures the extension has content-script context on YouTube pages.
})();
