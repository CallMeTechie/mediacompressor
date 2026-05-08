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
    ns: ['admin'],
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
};

// fp-wrap so the `req.locale` onRequest hook AND the `app.i18n` decorator
// bubble up to the parent FastifyInstance. Without fp(), they're encapsulated
// in the inner plugin scope and routes registered outside that scope cannot
// read req.locale or app.i18n.
export const i18nFastifyPlugin = fp(i18nFastifyPluginImpl, {
  name: 'web-i18n',
  fastify: '5.x',
});
