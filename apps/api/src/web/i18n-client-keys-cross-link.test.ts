import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_I18N_KEYS } from './i18n-client-keys.js';

/**
 * Plan 8f Task 4 (Rev. 2 WC-i18n-f13): cross-link guard for the
 * `CLIENT_I18N_KEYS` const-tuple — every entry MUST exist as a non-empty
 * string in BOTH `apps/api/locales/en/<ns>.json` AND
 * `apps/api/locales/de/<ns>.json`.
 *
 * Without this guard, a typo in `i18n-client-keys.ts` (e.g.
 * `upload_failed_prefx`) would silently inject the key-string itself into
 * the `<meta name="mc-i18n">` payload — `window.MC.t('upload_failed_prefix')`
 * on the browser-side would then return the literal key, and the
 * upload-failure flash banner would render `upload_failed_prefix: …`.
 *
 * Mirrors the pattern of `i18n-jobs-enum-cross-link.test.ts` (Plan 8e Task 5
 * review concern #2).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', '..', 'locales');

/**
 * Load a locale JSON file and return its top-level entries as a Map. Using
 * a Map (rather than direct `obj[key]` bracket-access on the parsed object)
 * sidesteps the `security/detect-object-injection` ESLint rule for
 * computed-string property reads — see the same pattern in
 * `i18n-jobs-enum-cross-link.test.ts`.
 */
function loadNsJson(locale: 'en' | 'de', ns: string): Map<string, unknown> {
  const raw = readFileSync(path.join(LOCALES_DIR, locale, `${ns}.json`), 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return new Map(Object.entries(parsed));
}

function assertNonEmptyString(value: unknown, ctx: string): asserts value is string {
  expect(typeof value, `${ctx}: expected string`).toBe('string');
  expect((value as string).length, `${ctx}: expected non-empty`).toBeGreaterThan(0);
}

describe('CLIENT_I18N_KEYS cross-link guard', () => {
  it('PFLICHT WC-i18n-f13: every CLIENT_I18N_KEYS entry exists in en + de locale-files', () => {
    for (const { ns, key } of CLIENT_I18N_KEYS) {
      for (const lng of ['en', 'de'] as const) {
        const file = loadNsJson(lng, ns);
        const value = file.get(key);
        expect(value, `${lng}/${ns}.json missing key "${key}"`).toBeTruthy();
        assertNonEmptyString(value, `${lng}/${ns}.json[${key}]`);
      }
    }
  });

  it('PFLICHT WC-i18n-f13: CLIENT_I18N_KEYS is non-empty (sanity)', () => {
    // Defensive: an empty CLIENT_I18N_KEYS would make the cross-link test
    // above pass vacuously while the runtime payload is empty. Guard against
    // an accidental `[]` regression.
    expect(CLIENT_I18N_KEYS.length).toBeGreaterThan(0);
  });
});
