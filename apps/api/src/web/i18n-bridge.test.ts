import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import {
  TEST_API_KEY_PEPPER,
  TEST_SESSION_SECRET,
  TEST_CSRF_SECRET,
  testDatabaseUrl,
  testRedisUrl,
  createTestUser,
  cleanupTestUsers,
  resetLoginRateLimits,
} from '@mediacompressor/test-helpers';
import { buildServer } from '../server.js';
import type { Config } from '../config.js';

/**
 * Plan 8f Task 4 (Rev. 2 WC-i18n-f4 + WC-i18n-f8 + Rev. 2.1 WC-i18n-f15):
 * server-render PFLICHT-tests for the client-side i18n bridge.
 *
 * Three concerns:
 *
 *   1. **WC-i18n-f8 (CSP-discipline):** the bootstrap-payload MUST be shipped
 *      via `<meta name="mc-i18n" content='...'>`, NOT via an inline-<script>
 *      that would require `'unsafe-inline'` in `script-src`. Asserts the
 *      response-body contains the meta-tag AND does NOT contain
 *      `<script>window.MC_I18N = …`.
 *
 *   2. **WC-i18n-f4 (DE bootstrap-strings):** when the request carries
 *      `mc_locale=de`, the meta-payload MUST resolve to the DE upload-failure
 *      strings (`Upload fehlgeschlagen: ` / `Unbekannter Fehler`) — proves
 *      `req.locale` propagates from cookie → `app.i18n.t` → `_clientI18n` →
 *      `<meta>`-attribute correctly.
 *
 *   3. **WC-i18n-f15 (encode/decode roundtrip):** the JSON+HTML-attr-encode
 *      ordering in the `json`-helper MUST roundtrip cleanly for tricky
 *      strings (apostrophe, ampersand, double-quote, less-than, U+2028/9).
 */

const TEST_EMAILS = ['bridge-de@test.invalid'];

const config: Config = {
  DATABASE_URL: testDatabaseUrl(),
  REDIS_URL: testRedisUrl(),
  SESSION_SECRET: TEST_SESSION_SECRET,
  CSRF_SECRET: TEST_CSRF_SECRET,
  API_KEY_PEPPER: TEST_API_KEY_PEPPER,
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  PORT: 0,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  ARGON2_MAX_CONCURRENCY: 8,
  TUSD_SHARED_SECRET: 'a'.repeat(64),
  TUSD_REQUIRE_SHARED_SECRET: true,
  TUSD_DATA_DIR: '/media/tusd-data',
  TUSD_FINAL_DIR: '/media/uploads',
  MEDIA_MOUNT_PATH: '/media',
  MIN_FREE_BYTES_RESERVE: 1n,
  TRUSTED_PROXY_CIDR: 'loopback',
  ENABLE_LEGACY_JOB_STUB: false,
};

describe('Plan 8f Task 4: client-side i18n bridge (server-render PFLICHT)', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);
    for (const email of TEST_EMAILS) {
      await createTestUser(prisma, { email, password: 'hunter22hunter22' });
    }
  });

  beforeEach(async () => {
    await resetLoginRateLimits(redis, TEST_EMAILS);
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

  /** Logs in via /login and returns the merged cookie header. */
  async function login(
    app: Awaited<ReturnType<typeof buildServer>>,
    email: string,
  ): Promise<string> {
    const get = await app.inject({ method: 'GET', url: '/login' });
    const csrf = ((get.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1]!;
    const initialCookies = (Array.isArray(get.headers['set-cookie'])
      ? get.headers['set-cookie']
      : [get.headers['set-cookie'] ?? ''])
      .map((c) => c?.split(';')[0])
      .filter(Boolean)
      .join('; ');
    const post = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        cookie: initialCookies,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `email=${encodeURIComponent(email)}&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf)}`,
    });
    return (Array.isArray(post.headers['set-cookie'])
      ? post.headers['set-cookie']
      : [post.headers['set-cookie'] ?? ''])
      .map((c) => c?.split(';')[0])
      .filter(Boolean)
      .join('; ');
  }

  /**
   * Inverse of the `json`-helper's HTML-attr-encode step. Order is the
   * inverse of the encode-set; `&amp;` decodes LAST so we don't double-decode
   * an `&amp;quot;` substring.
   */
  function htmlAttrDecode(s: string): string {
    return s
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  it('PFLICHT WC-i18n-f8: rendered HTML carries <meta name="mc-i18n"> and NOT inline-<script>', async () => {
    const app = await buildServer(config);
    try {
      const sessionCookie = await login(app, 'bridge-de@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/upload',
        headers: { accept: 'text/html', cookie: `${sessionCookie}; mc_locale=de` },
      });
      expect(res.statusCode).toBe(200);
      // Positive: meta-tag present.
      expect(res.body).toMatch(/<meta name="mc-i18n" content=/);
      // Positive: bridge-script loaded.
      expect(res.body).toMatch(
        /<script src="\/static\/js\/i18n-bridge\.js"[^>]*defer/,
      );
      // Negative (CSP-regression-guard): NO inline-<script> with the legacy
      // `window.MC_I18N = ...` bootstrap-pattern. Production CSP would block
      // such a script (script-src 'self' without 'unsafe-inline'), causing
      // window.MC.t to silently fall back to key-strings.
      expect(res.body).not.toMatch(/<script[^>]*>\s*window\.MC_I18N\s*=/);
    } finally {
      await app.close();
    }
  });

  it('PFLICHT WC-i18n-f4: <meta> content carries DE upload-failure strings under mc_locale=de', async () => {
    const app = await buildServer(config);
    try {
      const sessionCookie = await login(app, 'bridge-de@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/upload',
        headers: { accept: 'text/html', cookie: `${sessionCookie}; mc_locale=de` },
      });
      expect(res.statusCode).toBe(200);
      // The layout uses single-quoted attribute, so the regex anchors `'…'`.
      const match = res.body.match(/<meta name="mc-i18n" content='([^']*)'/);
      expect(match, '<meta name="mc-i18n" not found in response body').toBeTruthy();
      const decoded = htmlAttrDecode(match![1]!);
      const parsed = JSON.parse(decoded) as Record<string, string>;
      expect(parsed).toMatchObject({
        upload_failed_prefix: 'Upload fehlgeschlagen: ',
        upload_failed_unknown_error: 'Unbekannter Fehler',
      });
    } finally {
      await app.close();
    }
  });

  it('PFLICHT WC-i18n-f4: <meta> content carries EN upload-failure strings under mc_locale=en', async () => {
    const app = await buildServer(config);
    try {
      const sessionCookie = await login(app, 'bridge-de@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/upload',
        headers: { accept: 'text/html', cookie: `${sessionCookie}; mc_locale=en` },
      });
      expect(res.statusCode).toBe(200);
      const match = res.body.match(/<meta name="mc-i18n" content='([^']*)'/);
      expect(match).toBeTruthy();
      const decoded = htmlAttrDecode(match![1]!);
      const parsed = JSON.parse(decoded) as Record<string, string>;
      expect(parsed).toMatchObject({
        upload_failed_prefix: 'Upload failed: ',
        upload_failed_unknown_error: 'Unknown error',
      });
    } finally {
      await app.close();
    }
  });

  it('PFLICHT WC-i18n-f15: json-helper roundtrips tricky strings (apostrophe, double-quote, ampersand, less-than)', async () => {
    // Direct test of the json-helper's encode-step + the inverse decode here.
    // Pins the ordering-invariant of the helper: & FIRST, then " and ',
    // then <. A regression that swaps the order (e.g. & after ") would
    // silently double-encode `"` to `&amp;quot;`, and the round-trip below
    // would fail.
    const { default: Handlebars } = await import('handlebars');
    const { registerJsonHelper } = await import('./i18n.js');
    registerJsonHelper();
    const tmpl = Handlebars.compile("<x a='{{{json v}}}'>");
    const tricky = {
      apostrophe: "Don't",
      doubleQuote: 'Say "hi"',
      ampersand: 'Cats & Dogs',
      backslash: 'C:\\path',
      lessThan: '</script>',
      lineSep: 'a\u2028b',
      paraSep: 'c\u2029d',
    };
    const rendered = tmpl({ v: tricky });
    const match = rendered.match(/<x a='([^']*)'>/);
    expect(match).toBeTruthy();
    const decoded = htmlAttrDecode(match![1]!);
    // The json-helper additionally JS-escapes < and U+2028/U+2029, so JSON.parse
    // sees `\\u003c` / `\\u2028` / `\\u2029` (which JSON.parse decodes back).
    const parsed = JSON.parse(decoded);
    expect(parsed).toEqual(tricky);
  });

  it('PFLICHT WC-i18n-f15: json-helper escape-set includes < and U+2028/U+2029 (defense-in-depth)', async () => {
    const { default: Handlebars } = await import('handlebars');
    const { registerJsonHelper } = await import('./i18n.js');
    registerJsonHelper();
    const tmpl = Handlebars.compile("<x a='{{{json v}}}'>");
    const rendered = tmpl({ v: { sneak: '</script>\u2028\u2029' } });
    // The serialized form must NOT contain a raw `</script>`, U+2028 or
    // U+2029 — these are JS-escaped (`\\u003c`, `\\u2028`, `\\u2029`) so a
    // future migration to a CSP-nonce inline-<script> bootstrap stays safe.
    // The raw `</script>` must NOT survive (it would let an attacker break
    // out of a future inline-<script> bootstrap-context). `<` is escaped to
    // `<`; `/` does NOT need escaping in JSON or HTML attributes.
    expect(rendered).not.toMatch(/<script/i);
    expect(rendered).not.toMatch(/<\/script/i);
    expect(rendered).not.toContain('\u2028');
    expect(rendered).not.toContain('\u2029');
    expect(rendered).toMatch(/\\u003c\/script/);
    expect(rendered).toMatch(/\\u2028/);
    expect(rendered).toMatch(/\\u2029/);
  });
});
