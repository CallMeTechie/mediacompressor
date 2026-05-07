// Hijack the form-submit, run a tus-resumable upload to /uploads/, then on
// onSuccess redirect to /jobs/<jobId>. The tusd Pre-Create-Hook reads
// metadata.kind + metadata.profile to enforce allowlists and reserve quota.
(function () {
  const form = document.getElementById('upload-form');
  if (!form) return;
  const progressBox = document.getElementById('upload-progress');
  const percentSpan = document.getElementById('upload-percent');
  const progressBar = document.getElementById('upload-bar');

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const file = fd.get('file');
    if (!(file instanceof File)) return;
    const kind = String(fd.get('kind') || 'image');
    const profile = String(fd.get('profile') || 'web-optimized');
    const csrf = String(fd.get('_csrf') || '');

    progressBox.hidden = false;
    form.style.display = 'none';

    const upload = new window.tus.Upload(file, {
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
      onProgress: (sent, total) => {
        const pct = total ? Math.floor((sent / total) * 100) : 0;
        percentSpan.textContent = String(pct);
        progressBar.value = pct;
      },
      onError: (err) => {
        progressBox.innerHTML =
          '<p class="flash flash-error">Upload failed: ' +
          (err && err.message ? err.message : 'unknown error') +
          '</p>';
        form.style.display = 'block';
      },
      onSuccess: () => {
        const url = upload.url || '';
        const jobId = url.split('/').pop();
        if (jobId) window.location.href = '/jobs/' + jobId;
      },
    });
    upload.start();
  });
})();
