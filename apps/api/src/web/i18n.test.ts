import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import handlebars from 'handlebars';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  detectLocaleFromHeader,
  i18nFastifyPlugin,
  initI18n,
  registerI18nHelper,
  registerIfEqHelper,
  registerTKindHelper,
  registerTProfileHelper,
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
      // Plan 8e Task 7: defaultNS flipped from 'admin' to 'common', so admin-
      // namespace lookups must pass `ns: 'admin'` explicitly. Without it,
      // i18next would resolve from `common` and miss these admin-only keys.
      expect(i18n.t('nav_users', { lng: 'en', ns: 'admin' })).toBe('Users');
      expect(i18n.t('nav_users', { lng: 'de', ns: 'admin' })).toBe('Benutzer');
      expect(i18n.t('flash_user_updated', { lng: 'de', ns: 'admin' })).toBe(
        'Benutzer aktualisiert.',
      );
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

      // Plan 8e Task 7: defaultNS flipped to 'common', so admin-namespace
      // keys need explicit `ns='admin'` in the {{t}}-helper invocation —
      // mirrors the post-flip annotation pattern in admin-*.hbs templates.
      const tmpl = handlebars.compile(
        `{{#each items}}{{t 'nav_users' ns='admin'}}|{{/each}}`,
      );
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

    it('Plan 8e Task 1 PFLICHT: loads all 6 namespaces (common, auth, dashboard, jobs, profile, admin) for each locale', async () => {
      // After Plan 8e Task 1, the ns-list spans 6 namespaces. This test
      // verifies i18next-fs-backend actually loaded the resource bundle for
      // every (locale, namespace) pair — catching missing-file regressions
      // (e.g. a locale-file deleted in a refactor) and load-path-template
      // breakage (`{{lng}}/{{ns}}.json`).
      resetI18n();
      const i18n = await initI18n();
      const namespaces = ['common', 'auth', 'dashboard', 'jobs', 'profile', 'admin'];
      for (const ns of namespaces) {
        expect(i18n.hasResourceBundle('en', ns), `en/${ns}`).toBe(true);
        expect(i18n.hasResourceBundle('de', ns), `de/${ns}`).toBe(true);
      }
    });

    // Plan 8e Task 5 (review concern #1, WC-i18n-task5-C1): tKind helper
    // unit tests — verify locale-resolution + missing-key-fallback contract
    // for the `{{tKind kind}}` Handlebars helper used in job-list-rows.hbs
    // and job-detail.hbs (via `kind=(tKind job.kind)` subexpression).
    it('PFLICHT WC-i18n-task5-C1 (helper): tKind resolves known kind to DE-label inside @root._locale=de scope', async () => {
      resetI18n();
      const i18n = await initI18n();
      registerTKindHelper(i18n);
      const tmpl = handlebars.compile(`{{tKind kind}}`);
      // de.jobs.kind_image === "Bild"; en.jobs.kind_image === "Image".
      expect(tmpl({ _locale: 'de' as SupportedLocale, kind: 'image' })).toBe('Bild');
      expect(tmpl({ _locale: 'en' as SupportedLocale, kind: 'image' })).toBe('Image');
    });

    it('PFLICHT WC-i18n-task5-C1 (helper): tKind on unknown kind returns the bare key (loud-broken, not silent-empty)', async () => {
      resetI18n();
      const i18n = await initI18n();
      registerTKindHelper(i18n);
      const tmpl = handlebars.compile(`{{tKind kind}}`);
      // i18next default missing-key handler returns the key string.
      expect(tmpl({ _locale: 'de' as SupportedLocale, kind: 'zzzunknown' })).toBe(
        'kind_zzzunknown',
      );
    });

    it('PFLICHT WC-i18n-task5-C1 (helper): tProfile resolves "web-optimized" via dash->underscore normalization in DE scope', async () => {
      resetI18n();
      const i18n = await initI18n();
      registerTProfileHelper(i18n);
      const tmpl = handlebars.compile(`{{tProfile profile}}`);
      // The DB-canonical value contains a dash; the helper normalizes to
      // `profile_web_optimized` (underscore) for the i18next lookup.
      // de.jobs.profile_web_optimized === "Web-optimiert".
      expect(
        tmpl({ _locale: 'de' as SupportedLocale, profile: 'web-optimized' }),
      ).toBe('Web-optimiert');
      expect(
        tmpl({ _locale: 'en' as SupportedLocale, profile: 'web-optimized' }),
      ).toBe('Web optimized');
    });

    it('PFLICHT WC-i18n-task5-C1 (helper): tProfile on unknown profile returns the normalized bare key', async () => {
      resetI18n();
      const i18n = await initI18n();
      registerTProfileHelper(i18n);
      const tmpl = handlebars.compile(`{{tProfile profile}}`);
      // Unknown profile-strings still get dash->underscore normalized in
      // the lookup; the resulting bare key is what i18next emits on miss.
      expect(
        tmpl({ _locale: 'de' as SupportedLocale, profile: 'zzz-unknown' }),
      ).toBe('profile_zzz_unknown');
    });

    it('Plan 8e Task 1 PFLICHT: unknown key falls back to the key itself (i18next default)', async () => {
      // i18next's default missing-key handler returns the key string verbatim
      // — NOT empty, NOT undefined. Pflicht because templates rely on this:
      // a forgotten key renders as `does_not_exist_anywhere` in the page,
      // which is loud-broken (visible to QA) rather than silent-empty.
      resetI18n();
      const i18n = await initI18n();
      const result = i18n.t('does_not_exist_anywhere', { lng: 'en', ns: 'common' });
      expect(result).toBe('does_not_exist_anywhere');
      expect(result).not.toBe('');
    });
  });

  describe('req.t() decorator (Plan 8e Task 1, WC-i18n-13 + WC-i18n-15)', () => {
    /**
     * Builds a minimal Fastify app with just `@fastify/cookie` + `i18nFastifyPlugin`
     * registered. Avoids dragging the full `buildServer()` rig (Postgres + Redis
     * + auth plugins) into a pure i18n unit test — `req.t()` only depends on
     * the cookie-plugin (for `mc_locale` cookie parsing in `detectLocale`) and
     * the i18n plugin itself.
     */
    async function buildI18nApp() {
      resetI18n();
      const app = Fastify({ logger: false });
      // `@fastify/cookie` MUST register before `i18nFastifyPlugin` because the
      // latter's onRequest hook calls `detectLocale(req)` which reads
      // `req.cookies.mc_locale`. Without cookie-plugin first, `req.cookies`
      // is undefined and detectLocale crashes.
      await app.register(cookie, { secret: 'a'.repeat(64) });
      await app.register(i18nFastifyPlugin);
      return app;
    }

    it('req.t() returns translated string for explicit ns + locale-from-cookie', async () => {
      const app = await buildI18nApp();
      try {
        // Probe-route: returns the translated key. Uses the `admin` namespace
        // (only one with real keys at Task-1 stage); `nav_users` is "Benutzer"
        // in DE per Plan 8d's existing locale file.
        app.get('/__test_req_t', async (req) => req.t('nav_users', undefined, 'admin'));
        const res = await app.inject({
          method: 'GET',
          url: '/__test_req_t',
          headers: { cookie: 'mc_locale=de' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('Benutzer');
      } finally {
        await app.close();
      }
    });

    it('req.t() merges interpolation vars into the i18next options bag', async () => {
      // Sanity: `vars` reach i18next.t and feed `{{placeholder}}`-interpolation.
      // Uses the existing DE `welcome` key from admin.json: "Angemeldet als {{email}}".
      const app = await buildI18nApp();
      try {
        app.get('/__test_vars', async (req) =>
          req.t('welcome', { email: 'jane@example.invalid' }, 'admin'),
        );
        const res = await app.inject({
          method: 'GET',
          url: '/__test_vars',
          headers: { cookie: 'mc_locale=de' },
        });
        expect(res.body).toBe('Angemeldet als jane@example.invalid');
      } finally {
        await app.close();
      }
    });

    it('PFLICHT WC-i18n-15: req.t() falls back to DEFAULT_LOCALE when this.locale is undefined (no crash)', async () => {
      // Simulate the regression-scenario: the i18nFastifyPlugin onRequest hook
      // didn't run before this handler (e.g. a future plugin reorder, or a
      // synthesized request bypassing onRequest). The request object then has
      // no `locale` property, and `req.t()` must NOT crash — it must fall
      // back to DEFAULT_LOCALE deterministically.
      //
      // We construct this by registering a route that explicitly clears
      // req.locale BEFORE invoking req.t(). If the helper crashed, we'd see a
      // 500 response; the contract is that req.t() returns the EN string
      // ("Users" for nav_users in admin.json, since DEFAULT_LOCALE === 'en').
      const app = await buildI18nApp();
      try {
        app.get('/__test_locale_undef', async (req) => {
          // Cast away readonly typing to simulate the regression.
          (req as unknown as { locale: undefined }).locale = undefined;
          return req.t('nav_users', undefined, 'admin');
        });
        const res = await app.inject({
          method: 'GET',
          url: '/__test_locale_undef',
          // Even with mc_locale=de cookie, our handler explicitly nukes
          // req.locale, so the fallback path must engage.
          headers: { cookie: 'mc_locale=de' },
        });
        expect(res.statusCode).toBe(200);
        // DEFAULT_LOCALE is 'en', so nav_users -> "Users", not "Benutzer".
        expect(res.body).toBe('Users');
        expect(DEFAULT_LOCALE).toBe('en'); // sanity-anchor for future readers
      } finally {
        await app.close();
      }
    });
  });
});
