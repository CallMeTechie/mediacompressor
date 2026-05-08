// Spec Sektion 6 C6: SSE-Fallback. If 30 s pass without any event/heartbeat,
// switch to polling. Every 60 s try reopening SSE.
//
// htmx-ext-sse fires `htmx:sseMessage` on every event. We use that as a
// freshness signal. Reset a 30s timer on every message; on timeout, swap the
// SSE-listening div to a polling div.
//
// C3-LI inline-API note — htmx-2.0.x API contract used here:
//   - Event `htmx:sseMessage` fires on every SSE event (htmx-ext-sse 2.2.x).
//     We bind via `addEventListener('htmx:sseMessage', ...)` on each target.
//   - Event `htmx:beforeSwap` fires before swap; setting the detail field
//     'shouldSwap' = false cancels the swap (htmx 2.0.x docs).
//     The session-redirect handler in /static/js/htmx-session-redirect.js owns
//     this — loaded globally on every HTML page via base.hbs so polling pages
//     without SSE (e.g. job-list) ALSO get session-expiry redirect protection.
//   - `window.htmx.process(element)` re-evaluates hx-* attributes on the
//     element after we mutate them (htmx 2.0.x docs).
//   - We discover targets via `document.querySelectorAll('[data-sse-target]')`
//     so additional Plan-8c admin pages can co-exist with their own targets.
// If htmx >= 3.0 ever lands, the literal-test in job-detail-page.test.ts
// validates these strings still appear; refactor before bumping the version.
//
// C5-LI: iterate over ALL [data-sse-target] elements (Plan-8c may add more),
// each with its own per-target state via closure-per-iteration.
(function () {
  var targets = document.querySelectorAll('[data-sse-target]');
  if (targets.length === 0) return;

  var FALLBACK_MS = 30000;
  var RECONNECT_MS = 60000;
  var TICK_MS = 5000;

  // C8-LI: WC-PL5 session-redirect-handler is NOT defined here anymore — it
  // moved to a separate always-loaded script (htmx-session-redirect.js,
  // loaded in base.hbs after htmx). That way HTMX-polling pages without SSE
  // (e.g. job-list) ALSO get session-expiry-redirect protection.

  // C5-LI: per-target state via closure-per-iteration.
  targets.forEach(function (target) {
    var lastEventAt = Date.now();
    var mode = 'sse'; // 'sse' | 'polling'

    // Listen to sseMessage events bubbling from this specific target.
    target.addEventListener('htmx:sseMessage', function () {
      lastEventAt = Date.now();
    });

    // FU1: SSE mode now uses hx-get + hx-trigger="sse:..." (not sse-swap), so
    // the SSE event TRIGGERS an HTMX-GET to the fragment route, which renders
    // the styled status-badge from job-detail-status.hbs. Switching to polling
    // means: keep hx-get/hx-swap, but replace `hx-trigger="sse:..."` with
    // `hx-trigger="every 3s"` and tear down the SSE connection.
    function switchToPolling() {
      if (mode === 'polling') return;
      mode = 'polling';
      target.removeAttribute('hx-ext');
      target.removeAttribute('sse-connect');
      target.setAttribute('hx-get', target.dataset.fragmentUrl);
      target.setAttribute('hx-trigger', 'every 3s');
      target.setAttribute('hx-swap', 'innerHTML');
      if (window.htmx) window.htmx.process(target);
      setTimeout(restoreSse, RECONNECT_MS);
    }

    function restoreSse() {
      if (mode === 'sse') return;
      mode = 'sse';
      target.setAttribute('hx-ext', 'sse');
      target.setAttribute('sse-connect', target.dataset.sseUrl);
      target.setAttribute('hx-get', target.dataset.fragmentUrl);
      target.setAttribute('hx-trigger', 'sse:status, sse:progress, sse:snapshot');
      target.setAttribute('hx-swap', 'innerHTML');
      if (window.htmx) window.htmx.process(target);
      lastEventAt = Date.now();
    }

    function tick() {
      if (mode === 'sse' && Date.now() - lastEventAt > FALLBACK_MS) {
        switchToPolling();
      }
      setTimeout(tick, TICK_MS);
    }
    setTimeout(tick, TICK_MS);
  });
})();
