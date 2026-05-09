import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import i18next, { type i18n } from 'i18next';
import Backend from 'i18next-fs-backend';
import handlebars from 'handlebars';

// __dirname-shim for ESM. The plugin file lives at apps/api/src/web/i18n.ts;
// locales/ is at apps/api/locales/, so we go ../.. from src/web/ to reach the
// apps/api/ root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_ROOT = path.join(__dirname, '..', '..', 'locales');

export const SUPPORTED_LOCALES = ['en', 'de'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'en';

declare module 'fastify' {
  interface FastifyRequest {
    locale: SupportedLocale;
    /**
     * Plan 8e Task 1 (Rev. 2.1, WC-i18n-13 + WC-i18n-15): per-request
     * `req.t(key, vars?, ns?)` helper to remove the
     * `app.i18n.t(key, {lng: req.locale, ns: 'foo'})` boilerplate.
     *
     * - `ns` defaults to `'common'` (target post-Task-7 defaultNS); for
     *   non-default namespaces pass it explicitly.
     * - If `req.locale` is not yet set (e.g. plugin-load-order regression
     *   places a handler BEFORE `i18nFastifyPlugin`'s onRequest hook), the
     *   helper falls back to `DEFAULT_LOCALE` rather than crashing — see the
     *   PFLICHT-Test for WC-i18n-15.
     */
    t(key: string, vars?: Record<string, unknown>, ns?: string): string;
  }
  interface FastifyInstance {
    i18n: i18n;
  }
}

/**
 * Pure header-only locale detection. Splits the Accept-Language list, takes
 * the first preference's primary subtag (e.g. `de-DE` -> `de`), and returns
 * it iff it's in the supported set; otherwise DEFAULT_LOCALE.
 *
 * Q-weights are NOT respected -- clients almost always list locales in
 * preference order, and full RFC-4647 lookup adds complexity for negligible
 * UX gain at this scale.
 */
export function detectLocaleFromHeader(header: string | undefined): SupportedLocale {
  if (!header) return DEFAULT_LOCALE;
  const first = header.split(',')[0]?.trim().toLowerCase().split('-')[0];
  if (!first) return DEFAULT_LOCALE;
  return (SUPPORTED_LOCALES as readonly string[]).includes(first)
    ? (first as SupportedLocale)
    : DEFAULT_LOCALE;
}

/**
 * Full locale detection: priority cookie -> Accept-Language -> DEFAULT_LOCALE.
 *
 * WC-AD7: cookie value is allowlist-validated against SUPPORTED_LOCALES so a
 * forged `mc_locale=evil-marker` cookie cannot break i18n loading or be used
 * as an injection vector into the loadPath template.
 */
export function detectLocale(req: FastifyRequest): SupportedLocale {
  const cookieValue = req.cookies.mc_locale;
  if (cookieValue && (SUPPORTED_LOCALES as readonly string[]).includes(cookieValue)) {
    return cookieValue as SupportedLocale;
  }
  return detectLocaleFromHeader(req.headers['accept-language']);
}

let i18nInstance: i18n | null = null;

/**
 * C8-AD-PR: test-isolation helper. Tests can call resetI18n() in
 * afterAll/afterEach to drop the singleton; subsequent initI18n() rebuilds
 * from disk. No effect in production code (initI18n is called once at boot).
 */
export function resetI18n(): void {
  i18nInstance = null;
}

export async function initI18n(): Promise<i18n> {
  if (i18nInstance) return i18nInstance;
  const inst = i18next.createInstance();
  await inst.use(Backend).init({
    // `preload` forces i18next-fs-backend to load EVERY supported language at
    // boot. Without this, only `lng` (the default) is loaded, and the first
    // request that asks for the other locale silently falls back to
    // DEFAULT_LOCALE because the resource bundle is missing — every German
    // user would see English strings. preload + initImmediate:false make
    // initI18n a single async load with no per-request lazy-load races.
    lng: DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    preload: [...SUPPORTED_LOCALES],
    initImmediate: false,
    // Plan 8e Task 1 (Rev. 2.1): expanded from ['admin'] to all 6 namespaces
    // so i18next-fs-backend preloads each `apps/api/locales/{lng}/{ns}.json`
    // bundle at boot. Tasks 2-6 fill in real translation keys; Task 1 creates
    // sentinel-only files (`{"_namespace": "<ns>"}`).
    //
    // `defaultNS` stays at `'admin'` because the Pre-Task-1 audit (Plan 8e
    // Step 0, Rev. 2.1) found Plan-8d admin handlers + admin-*.hbs templates
    // that rely on the implicit default-namespace lookup. Switching the
    // default before those sites are migrated would silently render raw key
    // strings. The defaultNS flip to `'common'` is deferred to Task 7
    // (cleanup), after Tasks 2-6 have made every admin call-site explicit.
    ns: ['common', 'auth', 'dashboard', 'jobs', 'profile', 'admin'],
    defaultNS: 'admin',
    backend: {
      loadPath: path.join(LOCALES_ROOT, '{{lng}}/{{ns}}.json'),
    },
    // Handlebars escapes downstream; i18next interpolation must NOT escape.
    interpolation: { escapeValue: false },
  });
  i18nInstance = inst;
  return inst;
}

/**
 * C7-AD-PR: ifEq block-helper for conditional class/attribute rendering
 * (e.g. `{{#ifEq _locale 'en'}}active{{/ifEq}}`). Used by the locale-switcher
 * to mark the current-locale button as disabled.
 *
 * Idempotent -- Handlebars overwrites the previous registration if called
 * twice (e.g. across test reloads).
 */
export function registerIfEqHelper(): void {
  handlebars.registerHelper(
    'ifEq',
    function (this: unknown, a: unknown, b: unknown, opts: handlebars.HelperOptions) {
      return a === b ? opts.fn(this) : opts.inverse(this);
    },
  );
}

/**
 * Registers the `{{t 'key'}}` Handlebars helper. Lookup of `_locale`:
 *   1. `@root._locale` (priority -- see C1-AD-PR below)
 *   2. `this._locale` (fallback for plain top-level renders)
 *   3. DEFAULT_LOCALE
 *
 * C1-AD-PR rationale: inside `{{#each items}}...{{/each}}` blocks and inside
 * partials, Handlebars rebinds `this` to the inner-context (the each-iter
 * item or the partial's data). Reading `_locale` only from `this` would
 * mean every `{{t}}` invocation inside a loop falls through to the
 * DEFAULT_LOCALE, regardless of the user's actual locale, producing a
 * mixed-language UI. `@root` always points at the original render-data, so
 * checking it first preserves locale across nesting.
 */
export function registerI18nHelper(i18n: i18n): void {
  handlebars.registerHelper(
    't',
    function (
      this: { _locale?: SupportedLocale },
      key: string,
      opts: handlebars.HelperOptions,
    ) {
      const root = (opts?.data?.root ?? {}) as { _locale?: SupportedLocale };
      const locale: SupportedLocale = root._locale ?? this._locale ?? DEFAULT_LOCALE;
      const interpol = opts?.hash ?? {};
      return i18n.t(key, { lng: locale, ...interpol });
    },
  );
}

const i18nFastifyPluginImpl = async (app: FastifyInstance) => {
  const i18n = await initI18n();
  registerI18nHelper(i18n);
  // C7-AD-PR: ifEq block-helper for conditional rendering.
  registerIfEqHelper();

  app.addHook('onRequest', async (req) => {
    req.locale = detectLocale(req);
  });

  app.decorate('i18n', i18n);

  // Plan 8e Task 1 (Rev. 2.1, WC-i18n-13 + WC-i18n-15):
  // `req.t(key, vars?, ns?)` decorator — per-request shorthand for
  // `app.i18n.t(key, {lng: req.locale, ns: '<X>'})`.
  //
  // Three load-order/this-binding requirements (WC-i18n-15):
  //
  //   1. **Order:** decorateRequest('t', ...) MUST run AFTER
  //      `app.decorate('i18n', ...)` in the same plugin body — the closure
  //      captures `app.i18n`, so the decorate-call must already have
  //      attached it.
  //   2. **`function`-form, NOT arrow:** decorator must use
  //      `function (this: FastifyRequest, ...)` so `this` binds to the
  //      per-request FastifyRequest. An arrow function would silently
  //      capture the lexical `this` (= the plugin scope) and read the wrong
  //      object for `this.locale`, surfacing as wrong-locale renders, not a
  //      compile error.
  //   3. **Locale-fallback:** if `this.locale` is undefined (the
  //      `i18nFastifyPlugin`'s onRequest hook somehow didn't run before this
  //      handler — e.g. a future plugin re-order regression), fall back to
  //      `DEFAULT_LOCALE` rather than crash. `i18next.t` with `lng:
  //      undefined` would silently use the i18next-default language, which
  //      happens to coincide with DEFAULT_LOCALE today but isn't guaranteed.
  //      Explicit fallback makes the contract clear and is asserted by the
  //      WC-i18n-15 PFLICHT-Test.
  //
  // `ns` defaults to `'common'` to match the target post-Task-7 default
  // namespace; admin/auth/dashboard/jobs/profile call-sites pass `ns`
  // explicitly. `vars` (e.g. `{count: 3, path: '/foo'}`) are merged into the
  // i18next options bag so interpolation (`{{count}}`, `{{path}}`) and
  // pluralization (`count` triggers `_one`/`_other` lookup) both work.
  app.decorateRequest(
    't',
    function (
      this: FastifyRequest,
      key: string,
      vars?: Record<string, unknown>,
      ns?: string,
    ): string {
      const lng: SupportedLocale = this.locale ?? DEFAULT_LOCALE;
      const opts: Record<string, unknown> = { lng, ns: ns ?? 'common' };
      if (vars) Object.assign(opts, vars);
      return app.i18n.t(key, opts) as string;
    },
  );
};

// fp-wrap so the `req.locale` onRequest hook AND the `app.i18n` decorator
// bubble up to the parent FastifyInstance. Without fp(), they're encapsulated
// in the inner plugin scope and routes registered outside that scope cannot
// read req.locale or app.i18n.
export const i18nFastifyPlugin = fp(i18nFastifyPluginImpl, {
  name: 'web-i18n',
  fastify: '5.x',
});
