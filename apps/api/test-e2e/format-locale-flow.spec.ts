import { test, expect } from '@playwright/test';
import { Redis } from 'ioredis';
import { createPrismaClient } from '@mediacompressor/db';
import {
  createTestUser,
  cleanupTestUsers,
  testDatabaseUrl,
  testRedisUrl,
} from '@mediacompressor/test-helpers';

/**
 * Plan 8f Task 5: Playwright E2E for locale-aware Intl-formatting +
 * client-side i18n bridge.
 *
 * Coverage:
 *  1. DE locale: dates rendered in DE numeric format on /profile session-row.
 *     Asserts `DD.MM.YYYY` (default `medium`-style for table-rows per
 *     Format-Style-Discipline Rev. 2.1) and denies EN month-names
 *     (locale-bleed protection per WC-i18n-f21).
 *  2. EN locale: dates rendered in EN format (e.g. `May 9, 2026`) on /profile
 *     and denies DE month-names (locale-bleed protection per WC-i18n-f21).
 *  3. window.MC.t injection: /upload page loads i18n-bridge.js which reads
 *     <meta name="mc-i18n"> and exposes pre-resolved DE strings via
 *     window.MC.t for upload-wizard.js consumption.
 *
 * The login itself creates a session-row, so /profile renders at least one
 * <tr class="session-row"> with both `lastUsedAt` and `expiresAt` dates →
 * sufficient seed-data for the date-format assertions without extra setup.
 */

const TEST_EMAIL = 'e2e-format@test.invalid';
const PASSWORD = 'hunter22hunter22';

test.beforeAll(async () => {
  const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
  try {
    await cleanupTestUsers(prisma, [TEST_EMAIL]);
    await createTestUser(prisma, { email: TEST_EMAIL, password: PASSWORD });
  } finally {
    await prisma.$disconnect();
  }

  // The login-route enforces an IP-rate-limit of 10/min. With 7 specs in the
  // suite each performing 1-2 logins from the same docker-bridge IP, the full
  // suite can exceed the budget. Clear all login-IP-rate-limit zsets here so
  // this spec doesn't push the cumulative count over the edge for the next
  // spec in alpha-order. (resetLoginRateLimits in test-helpers only handles
  // 127.0.0.1/::1 — Playwright traffic from outside the docker network hits
  // the gateway-IP, which differs per environment, so we wildcard-scan.)
  const redis = new Redis(testRedisUrl(), { lazyConnect: true });
  try {
    await redis.connect();
    const ipKeys = await redis.keys('ratelimit:login:ip:*');
    if (ipKeys.length > 0) await redis.del(...ipKeys);
    await redis.del(`ratelimit:login:acct:${TEST_EMAIL.toLowerCase()}`);
  } finally {
    redis.disconnect();
  }
});

test.afterAll(async () => {
  const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
  try {
    await cleanupTestUsers(prisma, [TEST_EMAIL]);
  } finally {
    await prisma.$disconnect();
  }

  // Counter-balance the 3 logins this spec performs: clear the IP-rate-limit
  // zsets so downstream specs in the cumulative window have a fresh budget.
  // Without this, the suite-total can exceed login-route's 10/min IP cap.
  const redis = new Redis(testRedisUrl(), { lazyConnect: true });
  try {
    await redis.connect();
    const ipKeys = await redis.keys('ratelimit:login:ip:*');
    if (ipKeys.length > 0) await redis.del(...ipKeys);
    await redis.del(`ratelimit:login:acct:${TEST_EMAIL.toLowerCase()}`);
  } finally {
    redis.disconnect();
  }
});

test('DE locale: dates rendered in DE numeric format on /profile session-row', async ({
  page,
  context,
}) => {
  // Login (default EN, since no mc_locale cookie yet). The login page is
  // unauthenticated so layout-nav has no logout-form, but we scope to
  // `form.login-form` anyway for explicit selector-stability against any
  // future layout-nav addition. (The actual form-element on login.hbs has
  // `class="login-form"`, not `id="login-form"`.)
  await page.goto('/login');
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL('**/'),
    page.click('form.login-form button[type="submit"]'),
  ]);

  // Switch locale to DE via cookie (allowlist-validated by detectLocale).
  await context.addCookies([
    { name: 'mc_locale', value: 'de', domain: 'localhost', path: '/' },
  ]);

  await page.goto('/profile');
  const html = await page.content();

  // PFLICHT WC-i18n-f18 (FINAL): table-rows use formatDate default-medium →
  // DE renders as numeric `DD.MM.YYYY` (e.g. `09.05.2026`). The session-row
  // contains both `lastUsedAt` and `expiresAt` rendered via formatDate.
  expect(html).toMatch(/\d{2}\.\d{2}\.\d{4}/);

  // PFLICHT WC-i18n-f21 (denial-assertion): DE-locale must NOT contain EN
  // month-names. "May" is excluded because DE "Mai" partial-matches it under
  // \b boundaries; the remaining months provide unambiguous EN-locale
  // detection. (DE "März" / "Juni" etc. share no English-month substring.)
  expect(html).not.toMatch(
    /\b(January|February|April|July|August|September|October|November|December)\b/,
  );
});

test('EN locale: dates rendered in EN format on /profile session-row', async ({
  page,
}) => {
  // Login — no locale cookie set, so detectLocale falls back to DEFAULT_LOCALE
  // ('en') per the Accept-Language → DEFAULT_LOCALE chain.
  await page.goto('/login');
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL('**/'),
    page.click('form.login-form button[type="submit"]'),
  ]);

  await page.goto('/profile');
  const html = await page.content();

  // PFLICHT WC-i18n-f18 (FINAL): table-rows use formatDate default-medium →
  // EN renders as `Mon D, YYYY` (e.g. `May 9, 2026`).
  expect(html).toMatch(
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/,
  );

  // PFLICHT WC-i18n-f21 (denial-assertion): EN-locale must NOT contain DE
  // month-names. "Mai" / "März" / "Juni" etc. would only appear if the
  // helper-locale-resolution leaked the request-locale into Intl.format.
  expect(html).not.toMatch(
    /\b(Januar|Februar|März|Juni|Juli|August|Oktober|Dezember)\b/,
  );
});

test('window.MC.t is populated from <meta name="mc-i18n"> on /upload (DE strings)', async ({
  page,
  context,
}) => {
  await page.goto('/login');
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL('**/'),
    page.click('form.login-form button[type="submit"]'),
  ]);

  // DE-locale via cookie so the bridge-script resolves DE upload-failure
  // strings on the /upload render.
  await context.addCookies([
    { name: 'mc_locale', value: 'de', domain: 'localhost', path: '/' },
  ]);

  await page.goto('/upload');

  // i18n-bridge.js is `defer`-loaded; wait until it has populated window.MC.t.
  // Plan 8f Task 4 spec: the bridge reads `<meta name="mc-i18n">`, JSON.parses
  // the content-attribute, and assigns window.MC.t = (key, vars) => resolved.
  await page.waitForFunction(() =>
    Boolean((window as { MC?: { t?: unknown } }).MC?.t),
  );

  const t = await page.evaluate(() => {
    const w = window as unknown as { MC: { t: (k: string) => string } };
    return {
      prefix: w.MC.t('upload_failed_prefix'),
      unknownErr: w.MC.t('upload_failed_unknown_error'),
    };
  });

  // Both strings are pre-resolved server-side via i18next + req.locale → the
  // browser receives DE values regardless of its Accept-Language, proving
  // the cookie-driven server-side resolve and not a client-side fallback.
  expect(t).toEqual({
    prefix: 'Upload fehlgeschlagen: ',
    unknownErr: 'Unbekannter Fehler',
  });
});
