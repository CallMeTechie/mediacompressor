// Hijack the form-submit, run a tus-resumable upload to /uploads/, then on
// onSuccess redirect to /jobs/<jobId>. The tusd Pre-Create-Hook reads
// metadata.kind + metadata.profile to enforce allowlists and reserve quota.
//
// Plan 8f Task 4 (Rev. 2 WC-i18n-f4 + Rev. 2.1 WC-i18n-f17):
//   - onError reads i18n strings via window.MC.t (populated by
//     /static/js/i18n-bridge.js from <meta name="mc-i18n">). The drift-guard
//     test in apps/api/src/web/upload-wizard-client.test.ts asserts the
//     literal i18n-key strings in this file mirror the canonical TypeScript
//     spec at apps/api/src/web/upload-failure-render.ts.
//   - The flash-banner is built via document.createElement + textContent
//     (NOT innerHTML) — XSS-hardening against attacker-shaped err.message.
(function () {
  // Plan 8f Task 4: inline-implementation that mirrors
  // apps/api/src/web/upload-failure-render.ts (drift-protected by
  // upload-wizard-client.test.ts integration-test).
  function renderUploadFailure(progressBox, formEl, err, t) {
    var prefix = t ? t('upload_failed_prefix') : 'Upload failed: ';
    var fallback = t ? t('upload_failed_unknown_error') : 'unknown error';
    var message = err && err.message ? err.message : fallback;
    var p = document.createElement('p');
    p.className = 'flash flash-error';
    p.textContent = prefix + message;
    progressBox.innerHTML = '';
    progressBox.appendChild(p);
    formEl.style.display = 'block';
  }
  window.MC = window.MC || {};
  // Test-API surface: upload-wizard-client.test.ts's drift-guard asserts the
  // existence of this expression literally (regex-match). Keep the
  // assignment-shape stable.
  window.MC._upload = { renderUploadFailure: renderUploadFailure };

  var form = document.getElementById('upload-form');
  if (!form) return;
  var progressBox = document.getElementById('upload-progress');
  var percentSpan = document.getElementById('upload-percent');
  var progressBar = document.getElementById('upload-bar');

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var fd = new FormData(form);
    var file = fd.get('file');
    if (!(file instanceof File)) return;
    var kind = String(fd.get('kind') || 'image');
    var profile = String(fd.get('profile') || 'web-optimized');
    var csrf = String(fd.get('_csrf') || '');

    progressBox.hidden = false;
    form.style.display = 'none';

    var upload = new window.tus.Upload(file, {
      endpoint: '/uploads/',
      retryDelays: [0, 3000, 5000, 10000, 20000],
      metadata: {
        filename: file.name,
        filetype: file.type || 'application/octet-stream',
        kind: kind,
        profile: profile,
      },
      headers: {
        'X-CSRF-Token': csrf,
      },
      onProgress: function (sent, total) {
        var pct = total ? Math.floor((sent / total) * 100) : 0;
        percentSpan.textContent = String(pct);
        progressBar.value = pct;
      },
      onError: function (err) {
        var t = window.MC && window.MC.t ? window.MC.t : null;
        renderUploadFailure(progressBox, form, err, t);
      },
      onSuccess: function () {
        var url = upload.url || '';
        var jobId = url.split('/').pop();
        if (jobId) window.location.href = '/jobs/' + jobId;
      },
    });
    upload.start();
  });
})();
