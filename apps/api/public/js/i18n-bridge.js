// Plan 8f Task 4 (Rev. 2 WC-i18n-f8 + Rev. 2 WC-i18n-f14 + Rev. 2.1 WC-i18n-f19):
// minimal client-side i18n reader.
//
// Reads pre-resolved strings from <meta name="mc-i18n" content="..."> (server-
// injected by view-plugin via the `json` Handlebars-helper) and exposes
// `window.MC.t(key, vars?)` with key-fallback for unknowns.
//
// CSP-discipline (WC-i18n-f8): the bootstrap-payload is shipped as a
// data-attribute on a static <meta> tag, NOT as inline-<script>. This keeps
// the page-level CSP `script-src 'self'` enforceable without `'unsafe-inline'`
// — production-browsers would silently block the bootstrap and fall back to
// rendering literal key-strings. Regression-guard:
// `apps/api/src/web/i18n-bridge.test.ts` asserts the response-body contains
// `<meta name="mc-i18n" content=` AND DOES NOT contain
// `<script ...>window.MC_I18N = ...`.
//
// Namespace (WC-i18n-f14): `window.MC.t` (NOT a top-level `window.mcT`) so the
// global is grouped under a project-namespace and a future name-collision
// with another script's `mcT` cannot silently shadow it.
//
// Lifetime (WC-i18n-f19): window.MC.t is populated ONCE at page-load from the
// <meta name="mc-i18n"> bootstrap. After a runtime locale-change (e.g.
// POST /locale → page-reload), this module re-initializes from the new
// <meta>. Within a single page-session, client-side strings remain at the
// locale of the original page-load. HTMX-fragment-renders inherit
// window.MC.t from the parent page; they don't carry their own meta-tag.
// If a future feature needs locale-aware strings AFTER an in-page
// locale-switch (without page-reload), consider re-running this IIFE on a
// custom event or extending /locale to push a postMessage.
//
// XSS-safety: <meta content> is HTML-attribute-encoded server-side by the
// `json`-helper (& → &amp;, " → &quot;, ' → &#39;, < → <, plus U+2028/9
// defense-in-depth). Browser HTML-decodes on attribute-read, then JSON.parse
// produces strings. Caller responsibility: use textContent (not innerHTML)
// when rendering values that may contain user-controlled fragments — the
// bridge returns plain strings, no DOM-helpers.
(function () {
  var i18n = {};
  var meta = document.querySelector('meta[name="mc-i18n"]');
  if (meta) {
    try {
      i18n = JSON.parse(meta.getAttribute('content') || '{}');
    } catch (_e) {
      // Malformed JSON — fall back to empty; window.MC.t then returns the raw
      // key-string for every lookup (loud-broken, visible to QA).
    }
  }
  window.MC = window.MC || {};
  window.MC.t = function (key, vars) {
    var raw = Object.prototype.hasOwnProperty.call(i18n, key) ? i18n[key] : key;
    if (!vars) return raw;
    return String(raw).replace(/\{\{\s*(\w+)\s*\}\}/g, function (_, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : '';
    });
  };
})();
