import type { Namespace } from './i18n.js';

/**
 * Plan 8f Task 4 (Rev. 2.1, WC-i18n-f20): Single source-of-truth for the
 * client-side i18n key-set. Both `view-plugin.ts` (computes the
 * `_clientI18n` payload that `<meta name="mc-i18n">` carries to the browser)
 * AND `i18n-client-keys-cross-link.test.ts` (Rev. 2 WC-i18n-f13 typo-guard:
 * asserts every entry exists in en + de locale-files) import this constant
 * — a single edit propagates to runtime AND the regression-test, so a typo
 * cannot silently inject a key-as-string into the browser.
 *
 * Extracted to its own file (not inlined in view-plugin.ts) so the test can
 * import without dragging in Fastify/server boot machinery.
 *
 * Per-page key-set optimization (bundle-bloat) deferred to Plan 9/10.
 */
export const CLIENT_I18N_KEYS: ReadonlyArray<{ ns: Namespace; key: string }> = [
  { ns: 'jobs', key: 'upload_failed_prefix' },
  { ns: 'jobs', key: 'upload_failed_unknown_error' },
] as const;
