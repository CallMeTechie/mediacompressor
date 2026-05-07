// C8-LI: WC-PL5 session-expiry handler. Loaded on EVERY HTML page (not just
// SSE-pages) so HTMX-polling responses that 303 to /login during a logged-in
// session don't get swapped into the page DOM as broken /login HTML.
//
// htmx-2.0.x API contract:
//   - Event `htmx:beforeSwap` fires before a swap; setting
//     `event.detail.shouldSwap = false` cancels the swap.
//   - `event.detail.xhr.responseURL` is the FINAL URL after redirect-follow
//     (XHR auto-follows 303 by default in browsers).
(function () {
  document.body.addEventListener('htmx:beforeSwap', function (ev) {
    var xhr = ev.detail && ev.detail.xhr;
    if (!xhr || !xhr.responseURL) return;
    if (
      xhr.responseURL.endsWith('/login') ||
      xhr.responseURL.indexOf('/login?') !== -1
    ) {
      window.location.href = '/login';
      ev.detail.shouldSwap = false;
    }
  });
})();
