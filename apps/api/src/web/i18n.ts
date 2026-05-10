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

/**
 * Plan 8e Task 1 (Rev. 2.1, code-review concern #4): const-tuple of all
 * registered i18next namespaces. Tasks 2-6 import this so the type-system
 * list and the runtime `i18next.init({ ns })` list stay in lockstep — adding
 * a namespace in one place forces the other to update at compile time.
 *
 * Used as the type for `req.t()`'s `ns` parameter so a typo like
 * `req.t('foo', undefined, 'admins')` is a compile-error, not a silent
 * runtime miss.
 */
export const NAMESPACES = ['common', 'auth', 'dashboard', 'jobs', 'profile', 'admin'] as const;
export type Namespace = (typeof NAMESPACES)[number];

declare module 'fastify' {
  interface FastifyRequest {
    locale: SupportedLocale;
    /**
     * Plan 8e Task 1 (Rev. 2.1, WC-i18n-13 + WC-i18n-15): per-request
     * `req.t(key, vars?, ns?)` helper to remove the
     * `app.i18n.t(key, {lng: req.locale, ns: 'foo'})` boilerplate.
     *
     * - `ns` is typed as `Namespace` (const-tuple union) so typos are
     *   compile-errors. Defaults to `'common'` (target post-Task-7
     *   defaultNS); for non-default namespaces pass it explicitly.
     * - If `req.locale` is not yet set (e.g. plugin-load-order regression
     *   places a handler BEFORE `i18nFastifyPlugin`'s onRequest hook), the
     *   helper falls back to `DEFAULT_LOCALE` rather than crashing — see the
     *   PFLICHT-Test for WC-i18n-15.
     */
    t(key: string, vars?: Record<string, unknown>, ns?: Namespace): string;
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
    // Plan 8e Task 7 (Rev. 2.1, WC-i18n-7): `defaultNS` flipped from
    // `'admin'` to `'common'` after the Task-7 audit verified every admin
    // handler + admin-*.hbs template carries an explicit `ns: 'admin'` /
    // `ns='admin'` annotation. The flip moves the implicit-default to the
    // namespace that holds shared layout/error/status strings, matching the
    // post-Plan-8e majority call-site shape. `req.t(...)` (decorateRequest
    // below) keeps `'common'` as its `ns?` default for the same reason.
    ns: [...NAMESPACES],
    defaultNS: 'common',
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
 * Plan 8e Task 2: `{{tStatus status}}` Handlebars helper for job-status
 * labels. Resolves `job_status_<status>` from the `common` namespace so
 * templates render translated labels while the canonical English status
 * value (e.g. `succeeded`) stays untouched in CSS classes and form values
 * (Translation Discipline — value-attributes never translated).
 *
 * `_locale` lookup mirrors registerI18nHelper (C1-AD-PR) with the full
 * 3-tier priority: `@root._locale` -> `this._locale` -> DEFAULT_LOCALE.
 * The middle tier (`this._locale`) covers plain top-level renders where the
 * helper is invoked outside any `{{#each}}` / partial scope; without it,
 * such call-sites would fall through to DEFAULT_LOCALE and silently render
 * English status labels for German users. The status string itself is the
 * canonical enum-value from `packages/db/prisma/schema.prisma::JobStatus`
 * (`pending|uploading|queued|processing|succeeded|failed|canceled|expired`).
 *
 * Idempotent — Handlebars overwrites the previous registration.
 */
export function registerTStatusHelper(i18n: i18n): void {
  handlebars.registerHelper(
    'tStatus',
    function (
      this: { _locale?: SupportedLocale } | null,
      status: string,
      opts: handlebars.HelperOptions,
    ) {
      const root = (opts?.data?.root ?? {}) as { _locale?: SupportedLocale };
      const thisLocale = this?._locale;
      const locale: SupportedLocale = root._locale ?? thisLocale ?? DEFAULT_LOCALE;
      const out = i18n.t(`job_status_${status}`, { lng: locale, ns: 'common' });
      // SafeString prevents Handlebars from re-escaping the (already-i18next-
      // returned) string; values come from translator-controlled JSON not
      // user input, so HTML-escape would just double-encode entities like
      // "&" in DE strings such as "Wird hochgeladen & verarbeitet" if added
      // in the future.
      return new handlebars.SafeString(out as string);
    },
  );
}

/**
 * Plan 8e Task 5 (review concern #1, WC-i18n-task5-C1): `{{tKind kind}}` and
 * `{{tProfile profile}}` Handlebars helpers — translate the `Job.kind`
 * (`image`|`video`) and `Job.profile` (`web-optimized`|`mobile-low`|
 * `archive-medium`) DB-values into locale-specific labels for display.
 *
 * Mirror of `registerTStatusHelper` (Task 2) — same `_locale` 3-tier priority
 * (`@root._locale` -> `this._locale` -> DEFAULT_LOCALE) so the helpers Just
 * Work inside `{{#each jobs}}` rows AND outside loops on plain top-level
 * renders (e.g. job-detail.hbs).
 *
 * Translation Discipline (Plan 8e Sektion "Translation Discipline"): the
 * helpers ONLY translate the visible LABEL — the canonical enum-string itself
 * never reaches a DB-write or form-VALUE through this path. Form-radio /
 * `<option>` values keep canonical English (see WC-i18n-8 PFLICHT in
 * upload-wizard-page.test.ts).
 *
 * `tProfile`: profile-keys in jobs.json use underscores (`profile_web_optimized`)
 * because the DB-canonical `web-optimized` contains a dash that is not a
 * legal i18next key character; the helper normalizes via
 * `replaceAll('-', '_')`. This mirrors the existing transformation in
 * `upload-wizard-page.ts` and is guarded by the enum-cross-link test
 * (concern #2).
 *
 * If the (kind|profile) value is unknown to the resource bundle, i18next's
 * default missing-key handler returns the raw key string (e.g.
 * `kind_zzzunknown`) — loud-broken, visible to QA, NOT silent-empty. This
 * contract is asserted by the unit-tests in i18n.test.ts.
 *
 * Idempotent — Handlebars overwrites the previous registration.
 */
export function registerTKindHelper(i18n: i18n): void {
  handlebars.registerHelper(
    'tKind',
    function (
      this: { _locale?: SupportedLocale } | null,
      kind: string,
      opts: handlebars.HelperOptions,
    ) {
      const root = (opts?.data?.root ?? {}) as { _locale?: SupportedLocale };
      const thisLocale = this?._locale;
      const locale: SupportedLocale = root._locale ?? thisLocale ?? DEFAULT_LOCALE;
      const out = i18n.t(`kind_${kind}`, { lng: locale, ns: 'jobs' });
      return new handlebars.SafeString(out as string);
    },
  );
}

export function registerTProfileHelper(i18n: i18n): void {
  handlebars.registerHelper(
    'tProfile',
    function (
      this: { _locale?: SupportedLocale } | null,
      profile: string,
      opts: handlebars.HelperOptions,
    ) {
      const root = (opts?.data?.root ?? {}) as { _locale?: SupportedLocale };
      const thisLocale = this?._locale;
      const locale: SupportedLocale = root._locale ?? thisLocale ?? DEFAULT_LOCALE;
      // Normalize `web-optimized` -> `web_optimized` so it composes with
      // `profile_` to form a valid i18next JSON key.
      const key = `profile_${String(profile).replaceAll('-', '_')}`;
      const out = i18n.t(key, { lng: locale, ns: 'jobs' });
      return new handlebars.SafeString(out as string);
    },
  );
}

/**
 * Plan 8f Task 1 (Rev. 2.1, WC-i18n-f1 + WC-i18n-f12 + WC-i18n-f18):
 * `{{formatDateTime value [style="short|medium|long"]}}` Handlebars helper —
 * locale-aware date+time rendering for detail-view contexts (`<dl>/<dd>` or
 * top-level page-content). Sibling `{{formatDate}}` (below) is the date-only
 * variant for table-row contexts (Rev. 2.1 WC-i18n-f18 split).
 *
 * Locale resolution mirrors registerTStatusHelper (3-tier, C1-AD-PR):
 *   1. `@root._locale` (priority — survives `{{#each}}` / partial scope rebind)
 *   2. `this._locale` (plain top-level renders outside loops)
 *   3. DEFAULT_LOCALE
 *
 * `style` defaults to `'medium'` (e.g. EN: "May 9, 2026, 2:32 PM" /
 * DE: "9. Mai 2026, 14:32"). Caller can pass `style="short"` (numeric date)
 * or `style="long"` (full month-name) via the Handlebars hash-arg.
 *
 * **Timezone (WC-i18n-f1):** hardcoded UTC. Server stores DB-timestamps as
 * UTC-ISO; rendering them in server-local TZ (host `TZ` env, Docker default
 * is UTC anyway) creates "Why is the time wrong?" confusion when the host TZ
 * shifts. UTC is unambiguous and DB-aligned.
 *
 * Returns empty string for null/undefined/empty-string/invalid-date inputs
 * — templates render an empty `<td>` rather than "Invalid Date" garbage.
 *
 * Idempotent — Handlebars overwrites the previous registration.
 */
// Allowed `dateStyle` / inferred-style values for formatDateTime + formatDate.
// The runtime Set is the validation-allowlist (Concern 1: typo-resilience —
// invalid `style="bogus"` from a template falls back to `'medium'` instead of
// crashing the page-render with `Intl.DateTimeFormat`'s `RangeError`).
// The type-alias is derived from the Set's element-type so the two stay in
// sync — no drift possible.
type DateTimeStyle = 'short' | 'medium' | 'long';
const ALLOWED_DATETIME_STYLES: ReadonlySet<DateTimeStyle> = new Set<DateTimeStyle>([
  'short',
  'medium',
  'long',
]);

function resolveDateTimeStyle(rawStyle: unknown): DateTimeStyle {
  return typeof rawStyle === 'string' && ALLOWED_DATETIME_STYLES.has(rawStyle as DateTimeStyle)
    ? (rawStyle as DateTimeStyle)
    : 'medium';
}

export function registerFormatDateTimeHelper(): void {
  handlebars.registerHelper(
    'formatDateTime',
    function (
      this: { _locale?: SupportedLocale } | null,
      value: unknown,
      options: handlebars.HelperOptions,
    ) {
      if (value === null || value === undefined || value === '') return '';
      const root = (options?.data?.root ?? {}) as { _locale?: SupportedLocale };
      const thisLocale = this?._locale;
      const locale: SupportedLocale = root._locale ?? thisLocale ?? DEFAULT_LOCALE;
      const style = resolveDateTimeStyle(options.hash?.style);
      const date = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(date.getTime())) return '';
      const formatter = new Intl.DateTimeFormat(locale, {
        dateStyle: style,
        timeStyle: 'short',
        timeZone: 'UTC',
      });
      return new handlebars.SafeString(formatter.format(date));
    },
  );
}

/**
 * Plan 8f Task 1 (Rev. 2.1, WC-i18n-f18 split):
 * `{{formatDate value [style="short|medium|long"]}}` Handlebars helper —
 * date-only locale-aware rendering for table-row contexts (`<td>`). Sibling
 * `{{formatDateTime}}` (above) is the date+time variant for detail-views.
 *
 * Same locale-resolution + UTC-timezone + invalid-input contract as
 * `formatDateTime`. Difference: `Intl.DateTimeFormat` is constructed with
 * `dateStyle` only, NO `timeStyle` — output omits the time-component.
 *
 * Idempotent — Handlebars overwrites the previous registration.
 */
export function registerFormatDateHelper(): void {
  handlebars.registerHelper(
    'formatDate',
    function (
      this: { _locale?: SupportedLocale } | null,
      value: unknown,
      options: handlebars.HelperOptions,
    ) {
      if (value === null || value === undefined || value === '') return '';
      const root = (options?.data?.root ?? {}) as { _locale?: SupportedLocale };
      const thisLocale = this?._locale;
      const locale: SupportedLocale = root._locale ?? thisLocale ?? DEFAULT_LOCALE;
      const style = resolveDateTimeStyle(options.hash?.style);
      const date = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(date.getTime())) return '';
      const formatter = new Intl.DateTimeFormat(locale, {
        dateStyle: style,
        // No timeStyle — date-only rendering for compact table-row cells.
        timeZone: 'UTC',
      });
      return new handlebars.SafeString(formatter.format(date));
    },
  );
}

/**
 * Plan 8f Task 1 (Rev. 2.1, WC-i18n-f2 + WC-i18n-f10 + WC-i18n-f16):
 * `{{formatBytes value}}` Handlebars helper — locale-aware binary-byte
 * formatting (1024-base, B/KB/MB/GB/TB/PB/EB).
 *
 * **Binary (WC-i18n-f2):** 1024-base. Storage-quotas in DB are byte-counts;
 * binary aligns with how OS file-managers display sizes. Decimal SI-prefixes
 * (1000-base) would mismatch the canonical OS-displayed file-size and confuse
 * the user when comparing dashboard-numbers against `ls -lh` / Finder output.
 *
 * **Bigint-aware (WC-i18n-f10):** unit-step performed in bigint-space so
 * `Job.inputBytes` / admin "unlimited"-sentinel (`2n ** 63n - 1n`) values
 * larger than 2^53 don't lose precision via Number-coercion. Number / string
 * inputs are normalized to bigint via `BigInt(Math.floor(n))` (numbers) or
 * `BigInt(s)` for integer-strings; decimal/scientific-notation strings fall
 * back to Number-coercion + floor.
 *
 * **Round-half-up (WC-i18n-f16):** the 2-decimal fractional value is
 * computed via integer-bigint-math `(big * 100n + unitDivisor / 2n) /
 * unitDivisor`. Adding `unitDivisor/2n` before the integer-divide rounds
 * half-up rather than truncating, matching the Number-version's
 * `Intl.NumberFormat` rounding for unit-boundary edge-cases. Without this
 * patch, bigint `1500000n` and Number `1500000` would render different
 * output ("1.42 MB" vs "1.43 MB") at certain magnitudes.
 *
 * Locale-resolution: same 3-tier as registerTStatusHelper (C1-AD-PR).
 *
 * Returns empty string for null/undefined/empty-string/negative/non-finite
 * inputs — templates render an empty cell rather than "NaN B" garbage.
 *
 * Idempotent — Handlebars overwrites the previous registration.
 */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const;

export function registerFormatBytesHelper(): void {
  handlebars.registerHelper(
    'formatBytes',
    function (
      this: { _locale?: SupportedLocale } | null,
      value: unknown,
      options: handlebars.HelperOptions,
    ) {
      if (value === null || value === undefined || value === '') return '';
      const root = (options?.data?.root ?? {}) as { _locale?: SupportedLocale };
      const thisLocale = this?._locale;
      const locale: SupportedLocale = root._locale ?? thisLocale ?? DEFAULT_LOCALE;

      // Bigint-space normalization (WC-i18n-f10): preserves precision for
      // values > 2^53 (admin-set "unlimited" sentinel `2n**63n - 1n`).
      let big: bigint;
      if (typeof value === 'bigint') {
        big = value;
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) return '';
        big = BigInt(Math.floor(value));
      } else {
        const s = String(value).trim();
        if (s === '') return '';
        // Integer-string fast-path keeps full precision; decimal/scientific
        // fall back to Number-coercion (precision-loss is acceptable here
        // because the caller chose a Number-shaped serialization).
        if (/^\d+$/.test(s)) {
          big = BigInt(s);
        } else {
          const n = Number(s);
          if (!Number.isFinite(n) || n < 0) return '';
          big = BigInt(Math.floor(n));
        }
      }
      if (big < 0n) return '';
      if (big < 1024n) {
        return new handlebars.SafeString(
          `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number(big))} B`,
        );
      }
      // Find unit-index via repeated bigint-division. Cap at length-2 so the
      // top-loop-exit lands on EB (index = BYTE_UNITS.length - 1). After the
      // loop, `unitDivisor` corresponds to index `u + 1` (B = 1n is the
      // implicit u=-1).
      let u = 0;
      let unitDivisor = 1024n;
      while (big >= unitDivisor * 1024n && u < BYTE_UNITS.length - 2) {
        unitDivisor *= 1024n;
        u += 1;
      }
      // Round-half-up (WC-i18n-f16): add half-divisor before integer-divide
      // so bigint-math rounds rather than truncates, matching Number-version.
      const scaledHundredths = (big * 100n + unitDivisor / 2n) / unitDivisor;
      const fractional = Number(scaledHundredths) / 100;
      return new handlebars.SafeString(
        `${new Intl.NumberFormat(locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(fractional)} ${BYTE_UNITS[u + 1]}`,
      );
    },
  );
}

/**
 * Plan 8f Task 4 (Rev. 2 WC-i18n-f4 + WC-i18n-f11 + Rev. 2.1 WC-i18n-f15):
 * `{{{json value}}}` Handlebars helper — emits a JSON-encoded payload that
 * is ALSO HTML-attribute-safe (for `<meta name="mc-i18n" content='{{{json
 * _clientI18n}}}'>`).
 *
 * **CRITICAL: order matters.** `&` MUST be escaped FIRST so subsequent
 * entity-replacements (`&quot;` / `&#39;`) don't double-encode the prefix.
 * Reordering would produce e.g. `&amp;quot;` for a real `"` instead of
 * `&quot;`. The escape-set is therefore:
 *   1. `&`  → `&amp;`     (FIRST — prevents double-encoding of #2/#3)
 *   2. `"`  → `&quot;`    (HTML-attribute double-quote-context)
 *   3. `'`  → `&#39;`     (HTML-attribute single-quote-context — needed
 *                          because the layout uses `content='...'`)
 *   4. `<`  → `<`    (`</script>` defense; harmless in attr-context,
 *                          required if a future Plan 9/10 migrates to a
 *                          nonce-inline-script bootstrap)
 *   5. ` ` / ` ` → JS-escape  (defense-in-depth for the same
 *                                        future inline-script migration —
 *                                        these chars are valid in JSON
 *                                        but illegal in JS-string-literals)
 *
 * The `<meta>`-attribute strategy (Rev. 2 WC-i18n-f8) means the JSON lands
 * in HTML-attribute-context, NOT JS-string-literal-context, so the U+2028
 * /U+2029 escapes are not strictly necessary today — but cheap to keep, and
 * they future-proof the helper if/when Plan 9/10 migrates to a CSP-nonce
 * inline-script bootstrap.
 *
 * Idempotent — Handlebars overwrites the previous registration.
 */
export function registerJsonHelper(): void {
  handlebars.registerHelper('json', function (value: unknown) {
    return new handlebars.SafeString(
      JSON.stringify(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029'),
    );
  });
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
  // Plan 8e Task 2: tStatus helper for job-status labels.
  registerTStatusHelper(i18n);
  // Plan 8e Task 5 (review concern #1): tKind + tProfile helpers translate
  // Job.kind / Job.profile DB-values to locale-specific labels for display.
  // Wired alongside tStatus so all three job-enum helpers are registered in
  // the same plugin scope.
  registerTKindHelper(i18n);
  registerTProfileHelper(i18n);
  // Plan 8f Task 1 (Rev. 2.1): format-helpers for dynamic values —
  // formatDateTime (detail-views), formatDate (table-rows, WC-i18n-f18 split),
  // formatBytes (binary 1024-base, bigint-aware per WC-i18n-f10 + round-half-up
  // per WC-i18n-f16). All three resolve `_locale` via the same 3-tier
  // priority as registerTStatusHelper (C1-AD-PR).
  registerFormatDateTimeHelper();
  registerFormatDateHelper();
  registerFormatBytesHelper();
  // Plan 8f Task 4 (Rev. 2 WC-i18n-f4 + Rev. 2.1 WC-i18n-f15): `{{{json}}}`
  // helper for the `<meta name="mc-i18n">` client-i18n bootstrap. Registered
  // alongside the format-helpers so a single i18nFastifyPlugin load wires up
  // every Handlebars helper this plan introduces.
  registerJsonHelper();

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
      ns?: Namespace,
    ): string {
      const lng: SupportedLocale = this.locale ?? DEFAULT_LOCALE;
      // Code-review concern #1: spread `vars` FIRST so any caller-supplied
      // `lng`/`ns` keys are overridden by the canonical per-request locale +
      // per-call namespace below. Reverse-order (Object.assign(opts, vars))
      // would silently let `req.t('key', { lng: 'fr' })` break the locked
      // locale.
      const opts: Record<string, unknown> = {
        ...(vars ?? {}),
        lng,
        ns: ns ?? 'common',
      };
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
