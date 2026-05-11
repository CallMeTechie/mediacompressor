import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import IORedis from 'ioredis';
import { buildServer } from '../server.js';
import type { Config } from '../config.js';

const TEST_EMAIL_USER = 'admin-users-list-user@test.invalid';
const TEST_EMAIL_ADMIN = 'admin-users-list@test.invalid';
const TEST_EMAIL_TARGET_A = 'admin-users-list-target-a@test.invalid';
const TEST_EMAIL_TARGET_B = 'admin-users-list-target-b@test.invalid';
// Quoted-apostrophe email -- Citext-permitted, RFC-compliant, exercises
// Handlebars HTML-escape on user-controlled text. WC-AD4 PFLICHT.
const TEST_EMAIL_XSS = "o'brien-xss@test.invalid";
const TEST_EMAILS = [
  TEST_EMAIL_USER,
  TEST_EMAIL_ADMIN,
  TEST_EMAIL_TARGET_A,
  TEST_EMAIL_TARGET_B,
  TEST_EMAIL_XSS,
];

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

describe('web/admin-users-list-page', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);

    await createTestUser(prisma, { email: TEST_EMAIL_USER, password: 'hunter22hunter22' });
    await createTestUser(prisma, { email: TEST_EMAIL_ADMIN, password: 'hunter22hunter22' });
    await prisma.user.update({
      where: { email: TEST_EMAIL_ADMIN },
      data: { role: 'admin' },
    });
    await createTestUser(prisma, { email: TEST_EMAIL_TARGET_A, password: 'hunter22hunter22' });
    await createTestUser(prisma, { email: TEST_EMAIL_TARGET_B, password: 'hunter22hunter22' });
    await createTestUser(prisma, { email: TEST_EMAIL_XSS, password: 'hunter22hunter22' });
  });

  beforeEach(async () => {
    await resetLoginRateLimits(redis, TEST_EMAILS);
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

  async function loginAndCookies(
    app: Awaited<ReturnType<typeof buildServer>>,
    email: string,
  ): Promise<string> {
    const get = await app.inject({ method: 'GET', url: '/login' });
    const csrf = ((get.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1]!;
    const initialCookies = (
      Array.isArray(get.headers['set-cookie'])
        ? get.headers['set-cookie']
        : [get.headers['set-cookie'] ?? '']
    )
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
    return (
      Array.isArray(post.headers['set-cookie'])
        ? post.headers['set-cookie']
        : [post.headers['set-cookie'] ?? '']
    )
      .map((c) => c?.split(';')[0])
      .filter(Boolean)
      .join('; ');
  }

  // 1.
  it('GET /admin/users (no session) -> 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/users',
        headers: { accept: 'text/html' },
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  // 2.
  it('GET /admin/users (non-admin user) -> 403 HTML', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_USER);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/users',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/Forbidden/);
    } finally {
      await app.close();
    }
  });

  // 3.
  it('GET /admin/users (admin) -> 200 with table containing seeded user emails', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/users?limit=100',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // Table header (i18n).
      expect(body).toMatch(/<table[^>]*class="admin-table"/);
      // At least one of our seeded users appears.
      expect(body).toContain(TEST_EMAIL_TARGET_A);
      // Edit link points to /admin/users/<uuid>.
      expect(body).toMatch(/<a href="\/admin\/users\/[0-9a-f-]{36}"/);
      // Cache-Control: no-store on post-login HTML.
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  // 4. Cursor pagination -- limit=1 yields a nextCursor; following it returns
  // a different page body.
  it('GET /admin/users?limit=1 -> nextCursor link present; cursor= returns next page', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res1 = await app.inject({
        method: 'GET',
        url: '/admin/users?limit=1',
        headers: { accept: 'text/html', cookie },
      });
      expect(res1.statusCode).toBe(200);
      const body1 = res1.body as string;
      // We seeded 5+ users in this file's beforeAll PLUS others may exist;
      // limit=1 -> nextCursor link must be present.
      const cursorMatch = body1.match(/href="\/admin\/users\?cursor=([^"]+)"/);
      expect(cursorMatch).not.toBeNull();
      const cursor = cursorMatch![1]!;

      const res2 = await app.inject({
        method: 'GET',
        url: `/admin/users?cursor=${encodeURIComponent(cursor)}&limit=1`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res2.statusCode).toBe(200);
      // Different page body (sanity).
      expect(res2.body).not.toEqual(res1.body);
    } finally {
      await app.close();
    }
  });

  // 5. WC-AD4 PFLICHT -- XSS via email field. Citext allows a single quote.
  // Handlebars's escapeExpression turns it into &#x27; (Handlebars 4.x); the
  // raw apostrophe must NOT appear in the rendered HTML for this user.
  it('WC-AD4 PFLICHT: email containing apostrophe is HTML-escaped (no stored-XSS)', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/users?limit=100',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // The escaped form MUST appear (Handlebars's default escape).
      expect(body).toMatch(/o&#x27;brien-xss@test\.invalid|o&#39;brien-xss@test\.invalid/);
      // The literal raw apostrophe-form MUST NOT appear -- proves
      // auto-escape ran on this field.
      expect(body).not.toContain("o'brien-xss@test.invalid");
    } finally {
      await app.close();
    }
  });

  // 6. Plan 8f Task 3 PFLICHT (WC-i18n-f-task3 — DE-format-render):
  // The admin-users-list table renders storageQuota via {{formatBytes ...}}
  // (migrated in Task 3 Step 3). With `mc_locale=de` the cell MUST contain
  // the DE comma-decimal binary-format ("1,43 MB" for 1500000 bytes). The raw
  // byte-count MUST NOT leak into the visible display — that would mean the
  // template still renders `{{storageQuota}}` unwrapped (regression).
  // Mirrors WC-i18n-f-task2 from Plan 8f Task 2 (date-format-render PFLICHT).
  // Locale-resolution flows through @root._locale (formatBytes' 3-tier
  // C1-AD-PR fallback) so the helper picks up the cookie-set locale even
  // inside the {{#each users}} block where Handlebars rebinds `this` per row.
  it('PFLICHT WC-i18n-f-task3: GET /admin/users with mc_locale=de renders storageQuota in DE binary format (formatBytes)', async () => {
    const app = await buildServer(config);
    try {
      // Seed a deterministic quota on TARGET_A. 1500000 -> "1,43 MB" (DE) /
      // "1.43 MB" (EN) via the binary 1024-base helper.
      await prisma.user.update({
        where: { email: TEST_EMAIL_TARGET_A },
        data: { storageQuota: 1500000n },
      });

      const sessionCookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/users?limit=100',
        headers: {
          accept: 'text/html',
          cookie: `${sessionCookie}; mc_locale=de`,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // DE comma-decimal binary format must be present (Intl.NumberFormat
      // 'de' + 1024-base helper output).
      expect(body).toMatch(/1,43 MB/);
      // Raw byte-count MUST NOT appear in display (regression-guard against
      // `{{storageQuota}}` unwrapped). Word-boundaries pin against any
      // plumbing such as `<a href="/admin/users/<uuid>?cursor=...">` in case
      // the cursor is ever derived from the seeded quota.
      expect(body).not.toMatch(/\b1500000\b/);
    } finally {
      await app.close();
    }
  });
});
