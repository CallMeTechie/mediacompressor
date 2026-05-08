import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import handlebars from 'handlebars';
import type { FastifyRequest } from 'fastify';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  detectLocaleFromHeader,
  initI18n,
  registerI18nHelper,
  registerIfEqHelper,
  resetI18n,
  type SupportedLocale,
} from './i18n.js';

/**
 * Builds a minimal stand-in for FastifyRequest covering the fields detectLocale
 * actually reads (`cookies.mc_locale` + `headers['accept-language']`). Casting
 * via `unknown` avoids dragging the entire FastifyRequest surface area into
 * the test fixture.
 */
function makeReq(opts: {
  cookieLocale?: string;
  acceptLanguage?: string;
}): FastifyRequest {
  return {
    cookies: opts.cookieLocale ? { mc_locale: opts.cookieLocale } : {},
    headers: opts.acceptLanguage ? { 'accept-language': opts.acceptLanguage } : {},
  } as unknown as FastifyRequest;
}

describe('web/i18n', () => {
  it('detectLocaleFromHeader("de-DE,en;q=0.9") -> "de"', () => {
    expect(detectLocaleFromHeader('de-DE,en;q=0.9')).toBe('de');
  });

  it('detectLocaleFromHeader("en") -> "en"', () => {
    expect(detectLocaleFromHeader('en')).toBe('en');
  });

  it('detectLocaleFromHeader("fr") -> "en" (fallback)', () => {
    expect(detectLocaleFromHeader('fr')).toBe('en');
  });

  it('detectLocaleFromHeader(undefined) -> "en"', () => {
    expect(detectLocaleFromHeader(undefined)).toBe('en');
  });

  it('detectLocale: cookie mc_locale=de overrides Accept-Language', () => {
    const req = makeReq({ cookieLocale: 'de', acceptLanguage: 'en' });
    expect(detectLocale(req)).toBe('de');
  });

  it('WC-AD7 PFLICHT: cookie mc_locale="evil-marker" falls through to default (allowlist-rejection)', () => {
    // Forged cookie value MUST NOT be returned -- otherwise an attacker could
    // inject arbitrary strings into i18next's loadPath template via the
    // {{lng}} placeholder. Allowlist guarantees only `en`/`de` ever flow.
    const req = makeReq({ cookieLocale: 'evil-marker', acceptLanguage: 'en' });
    expect(detectLocale(req)).toBe(DEFAULT_LOCALE);
    // Sanity: DEFAULT_LOCALE itself is in the supported set.
    expect((SUPPORTED_LOCALES as readonly string[]).includes(DEFAULT_LOCALE)).toBe(true);
  });

  it('detectLocale: no cookie + Accept-Language: de -> "de"', () => {
    const req = makeReq({ acceptLanguage: 'de' });
    expect(detectLocale(req)).toBe('de');
  });

  describe('with i18next instance loaded from locales/', () => {
    beforeAll(async () => {
      // Reset the singleton so this describe-block starts from a clean state.
      resetI18n();
    });

    afterAll(() => {
      // Drop the loaded singleton so a sibling test-file rebuilding from disk
      // sees a fresh load (matters when the locales/ files change between
      // runs in dev).
      resetI18n();
    });

    it('WC-AD3 PFLICHT: i18n.t("unknown_key_test", {lng: "de"}) returns the key-text (not empty)', async () => {
      const i18n = await initI18n();
      const out = i18n.t('unknown_key_test', { lng: 'de' });
      // i18next's default missing-key behaviour: return the key itself, NOT
      // an empty string. Verify the value is non-empty so templates don't
      // silent-render an empty span when a translation key is added but the
      // resource file isn't reloaded.
      expect(out).toBe('unknown_key_test');
      expect(out).not.toBe('');
    });

    it('C2-AD-PR + C9-AD-PR PFLICHT: i18next loads en+de admin namespaces successfully', async () => {
      // Stronger than existsSync-only -- this asserts file-existence + valid
      // JSON + correct loadPath + correct namespace + correct keys, all in
      // one. Catches build-time-missing files (file gone -> load throws),
      // invalid-JSON (parse fails), namespace-config-drift (wrong loadPath
      // template), key-removal (`nav_users` deleted from de/admin.json). If
      // a future Dockerfile-refactor drops the locales/ COPY, vitest fails
      // fast with a clear message rather than production-boot-crash.
      resetI18n();
      const i18n = await initI18n();
      expect(i18n.t('nav_users', { lng: 'en' })).toBe('Users');
      expect(i18n.t('nav_users', { lng: 'de' })).toBe('Benutzer');
      expect(i18n.t('flash_user_updated', { lng: 'de' })).toBe('Benutzer aktualisiert.');
    });

    it('C1-AD-PR PFLICHT: helper @root-fallback inside {{#each}} loop renders correct locale', async () => {
      // Inside a `{{#each items}}{{t 'nav_users'}}{{/each}}` block,
      // Handlebars rebinds `this` to the each-iter item (here: empty `{}`).
      // Without the @root-fallback in the helper, every iteration would fall
      // through to DEFAULT_LOCALE ('en') and emit "Users". With @root, the
      // helper sees `_locale: 'de'` from the original render data and emits
      // "Benutzer" twice -- proving the locale is preserved across nesting.
      resetI18n();
      const i18n = await initI18n();
      registerI18nHelper(i18n);

      const tmpl = handlebars.compile(`{{#each items}}{{t 'nav_users'}}|{{/each}}`);
      const out = tmpl({ _locale: 'de' as SupportedLocale, items: [{}, {}] });
      // Two iterations, both must produce 'Benutzer' (de). Without the
      // @root-lookup, this would be 'Users|Users|' (en, the default).
      expect(out).toBe('Benutzer|Benutzer|');
    });

    it('C7-AD-PR: ifEq helper renders true-branch on equality, inverse on mismatch', () => {
      registerIfEqHelper();
      const tmpl = handlebars.compile(
        `{{#ifEq _locale 'en'}}EN{{else}}OTHER{{/ifEq}}`,
      );
      expect(tmpl({ _locale: 'en' })).toBe('EN');
      expect(tmpl({ _locale: 'de' })).toBe('OTHER');
    });
  });
});
