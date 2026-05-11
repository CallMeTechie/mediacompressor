// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderUploadFailure } from './upload-failure-render.js';

/**
 * Plan 8f Task 4 (Rev. 2.1 WC-i18n-f17): browser-side i18n bridge contract
 * tests for the upload-wizard's flash-banner.
 *
 * Two layers:
 *
 *   1. JSDOM unit-tests of `renderUploadFailure` (the canonical TypeScript
 *      implementation in `upload-failure-render.ts`). Asserts the DE-locale
 *      render-shape and the EN-fallback when no t-function is wired.
 *
 *   2. Drift-guard against `apps/api/public/js/upload-wizard.js`. The
 *      browser-script carries an inline-IIFE that mirrors the TypeScript
 *      canonical (security-hook blocks `eval`/`new Function`/`vm.Script`,
 *      so we can't load the IIFE into JSDOM directly — instead we grep
 *      the literal i18n-key strings + the documented test-API surface to
 *      catch silent drift).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_WIZARD_JS = path.join(__dirname, '..', '..', 'public', 'js', 'upload-wizard.js');

describe('PFLICHT WC-i18n-f17: renderUploadFailure (TypeScript canonical)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<form id="upload-form"></form><div id="upload-progress"></div>';
  });

  it('renders DE flash-banner using injected t-function', () => {
    const map = new Map<string, string>([
      ['upload_failed_prefix', 'Upload fehlgeschlagen: '],
      ['upload_failed_unknown_error', 'Unbekannter Fehler'],
    ]);
    const t = vi.fn((key: string) => map.get(key) ?? key);
    const progressBox = document.getElementById('upload-progress') as HTMLElement;
    const form = document.getElementById('upload-form') as HTMLElement;
    renderUploadFailure(progressBox, form, { message: 'Network timeout' }, t as never);
    const flash = progressBox.querySelector('.flash-error') as HTMLElement;
    expect(flash).toBeTruthy();
    expect(flash.textContent).toBe('Upload fehlgeschlagen: Network timeout');
    // Canonical: BOTH key-lookups happen unconditionally; the fallback is
    // pre-resolved before the err.message branch picks the active value.
    // This is the test-contract that the drift-guard pins for the browser
    // script — both keys must appear as literal strings in upload-wizard.js.
    expect(t).toHaveBeenCalledWith('upload_failed_prefix');
    expect(t).toHaveBeenCalledWith('upload_failed_unknown_error');
    // Form must be revealed again so the user can retry.
    expect(form.style.display).toBe('block');
  });

  it('falls back to canonical EN if t is null (defense)', () => {
    const progressBox = document.getElementById('upload-progress') as HTMLElement;
    const form = document.getElementById('upload-form') as HTMLElement;
    renderUploadFailure(progressBox, form, null, null);
    const flash = progressBox.querySelector('.flash-error') as HTMLElement;
    expect(flash).toBeTruthy();
    expect(flash.textContent).toBe('Upload failed: unknown error');
  });

  it('uses textContent (NOT innerHTML) so attacker-shaped err.message is HTML-escaped', () => {
    // XSS-hardening assertion: even if tus-js-client receives an attacker-
    // shaped error, the rendered banner must NOT inject a runnable <script>.
    const progressBox = document.getElementById('upload-progress') as HTMLElement;
    const form = document.getElementById('upload-form') as HTMLElement;
    renderUploadFailure(progressBox, form, { message: '<script>alert(1)</script>' }, null);
    const flash = progressBox.querySelector('.flash-error') as HTMLElement;
    expect(flash).toBeTruthy();
    // The literal `<script>` text is the textContent value — the browser
    // HTML-escapes it on render — and there must be NO actual <script>
    // child element in the DOM.
    expect(flash.textContent).toBe('Upload failed: <script>alert(1)</script>');
    expect(progressBox.querySelector('script')).toBeNull();
  });
});

describe('PFLICHT WC-i18n-f17 drift-guard: browser-script mirrors TypeScript canonical', () => {
  it('upload-wizard.js contains the same i18n key-strings as TypeScript renderUploadFailure', () => {
    const browserCode = readFileSync(UPLOAD_WIZARD_JS, 'utf-8');
    // Drift-detection: if either file changes the keys, both must change.
    expect(browserCode).toContain("'upload_failed_prefix'");
    expect(browserCode).toContain("'upload_failed_unknown_error'");
    // Test-API surface that the bridge-test relies on.
    expect(browserCode).toMatch(/window\.MC\._upload\s*=\s*\{\s*renderUploadFailure/);
  });

  it('upload-wizard.js uses textContent (NOT just innerHTML) for the flash-banner', () => {
    const browserCode = readFileSync(UPLOAD_WIZARD_JS, 'utf-8');
    // XSS-hardening regression-guard: the browser-script must build the
    // banner via createElement + textContent. A regression that swaps in a
    // raw `innerHTML = '<p…>' + err.message + '</p>'` concatenation would
    // re-introduce stored-XSS via attacker-shaped err.message.
    expect(browserCode).toMatch(/document\.createElement\(['"]p['"]\)/);
    expect(browserCode).toMatch(/\.textContent\s*=\s*prefix\s*\+\s*message/);
  });

  it('upload-wizard.js reads window.MC.t (Rev. 2 WC-i18n-f14 namespace)', () => {
    const browserCode = readFileSync(UPLOAD_WIZARD_JS, 'utf-8');
    // Pin the namespace to `window.MC.t`, NOT a top-level `window.mcT`.
    expect(browserCode).toMatch(/window\.MC\s*&&\s*window\.MC\.t/);
    expect(browserCode).not.toMatch(/window\.mcT\b/);
  });
});
