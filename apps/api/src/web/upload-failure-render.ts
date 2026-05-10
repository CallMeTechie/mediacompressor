/**
 * Plan 8f Task 4 (Rev. 2.1 WC-i18n-f17): Pure render-function for the
 * upload-failure flash banner.
 *
 * The browser-script `apps/api/public/js/upload-wizard.js` has a
 * functionally-equivalent inline-IIFE implementation. The drift-guard in
 * `apps/api/src/web/upload-wizard-client.test.ts` asserts the browser-script
 * contains the same i18n key-string-literals as this canonical TypeScript
 * spec — if either file changes the keys without the other, the drift-guard
 * fails. Pragmatic trade-off: ~10 lines duplicated, in exchange for NOT
 * needing `eval`/`new Function`/`vm.Script`-magic to evaluate the browser
 * IIFE under JSDOM (security-hook blocks code-injection patterns).
 *
 * XSS-safety: writes the message via `textContent`, NOT `innerHTML` — even
 * though `err.message` is library-supplied, the textContent-write defeats
 * any HTML-injection in the unlikely case the client receives an
 * attacker-shaped payload.
 *
 * Pure: caller supplies the DOM elements and the t-function. No globals,
 * no DOM-queries inside the function — testable in any DOM-environment.
 */
export type UploadFailureT = (
  key: 'upload_failed_prefix' | 'upload_failed_unknown_error',
) => string;

export function renderUploadFailure(
  progressBox: HTMLElement,
  formEl: HTMLElement,
  err: { message?: string } | null,
  t: UploadFailureT | null,
): void {
  const prefix = t ? t('upload_failed_prefix') : 'Upload failed: ';
  const fallback = t ? t('upload_failed_unknown_error') : 'unknown error';
  const message = err?.message ?? fallback;
  const p = document.createElement('p');
  p.className = 'flash flash-error';
  p.textContent = prefix + message;
  progressBox.innerHTML = '';
  progressBox.appendChild(p);
  formEl.style.display = 'block';
}
