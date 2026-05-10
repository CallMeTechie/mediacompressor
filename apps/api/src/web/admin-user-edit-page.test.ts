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

const TEST_EMAIL_USER = 'admin-user-edit-user@test.invalid';
const TEST_EMAIL_ADMIN = 'admin-user-edit@test.invalid';
const TEST_EMAIL_TARGET = 'admin-user-edit-target@test.invalid';
const TEST_EMAILS = [TEST_EMAIL_USER, TEST_EMAIL_ADMIN, TEST_EMAIL_TARGET];

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

describe('web/admin-user-edit-page', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let targetUserId: string;

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
    await createTestUser(prisma, {
      email: TEST_EMAIL_TARGET,
      password: 'hunter22hunter22',
    });
    // Custom quotas so we can assert pre-fill against fixed values.
    await prisma.user.update({
      where: { email: TEST_EMAIL_TARGET },
      data: {
        storageQuota: 1073741824n, // 1 GiB
        parallelQuota: 7,
        hourlyQuota: 42,
      },
    });
    const target = await prisma.user.findUnique({
      where: { email: TEST_EMAIL_TARGET },
      select: { id: true },
    });
    targetUserId = target!.id;
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

  // 1.
  it('GET /admin/users/:id (no session) -> 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/users/${targetUserId}`,
        headers: { accept: 'text/html' },
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  // 2.
  it('GET /admin/users/:id (non-admin) -> 403 HTML', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_USER);
      const res = await app.inject({
        method: 'GET',
        url: `/admin/users/${targetUserId}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/Forbidden/);
    } finally {
      await app.close();
    }
  });

  // 3.
  it('GET /admin/users/:id (admin, valid id) -> 200 with form pre-filled (status, quotas)', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: `/admin/users/${targetUserId}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // Form posts back to /admin/users/<id>.
      expect(body).toMatch(
        new RegExp(`<form[^>]*action="/admin/users/${targetUserId}"`),
      );
      // CSRF hidden field.
      expect(body).toMatch(/<input[^>]+type="hidden"[^>]*name="_csrf"/);
      // Email visible in form.
      expect(body).toContain(TEST_EMAIL_TARGET);
      // Status select pre-selected to 'active'.
      expect(body).toMatch(/<option value="active"[^>]*selected/);
      // BigInt storageQuota rendered as decimal string in input value.
      expect(body).toMatch(/<input[^>]*name="storageQuota"[^>]*value="1073741824"/);
      // Parallel + hourly numeric fields pre-filled.
      expect(body).toMatch(/<input[^>]*name="parallelQuota"[^>]*value="7"/);
      expect(body).toMatch(/<input[^>]*name="hourlyQuota"[^>]*value="42"/);
      // Cache-Control: no-store on post-login HTML.
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  // 4.
  it('GET /admin/users/<nonexistent-uuid> -> 404 HTML', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      // Valid UUID-format but no row in DB.
      const res = await app.inject({
        method: 'GET',
        url: '/admin/users/00000000-0000-0000-0000-000000000000',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // 5. Concern #2 -- ?updateflash=csrf-stale renders the translated banner
  // so the inner-403 redirect from POST /admin/users/:id back to GET
  // /admin/users/:id?updateflash=csrf-stale shows the user the CSRF-stale
  // message. Unknown ?updateflash values fall through silently (allowlist).
  it('Concern #2: GET /admin/users/:id?updateflash=csrf-stale renders translated flash banner', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: `/admin/users/${targetUserId}?updateflash=csrf-stale`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // Flash banner present with the translated csrf-stale message
      // (English locale by default in tests).
      expect(body).toMatch(/<div[^>]*class="flash flash-error"/);
      expect(body).toMatch(/session token had to be refreshed/i);
    } finally {
      await app.close();
    }
  });

  // 6. Concern #2 -- unknown ?updateflash value is allowlist-gated to null,
  // so no flash banner renders (no XSS / message-injection vector).
  it('Concern #2: GET /admin/users/:id?updateflash=evil renders NO flash banner', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: `/admin/users/${targetUserId}?updateflash=evil%3Cscript%3E`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // No flash banner element at all.
      expect(body).not.toMatch(/<div[^>]*class="flash /);
    } finally {
      await app.close();
    }
  });

  // 7. Plan 8f Task 3 PFLICHT (WC-i18n-f3 — form-VALUE-leak prevention):
  // The storage-quota INPUT field is a backend form-VALUE (POST /admin/users/:id
  // re-validates against the canonical allowlist of integer byte-counts).
  // Translation Discipline (Plan 8e Sektion "Translation Discipline" carry-
  // forward via Plan 8f Task 3) requires that user-facing DISPLAY strings
  // ({{formatBytes ...}}) NEVER leak into <input value="..."> attributes —
  // backend would 400-reject "1,43 MB" / "1.43 MB" since those are not
  // integer byte-counts. This regression-protection test asserts the form-
  // value stays canonical raw bytes EVEN when the user has `mc_locale=de`
  // active (i.e. the locale-switch ONLY affects display labels in
  // admin-users-list.hbs / admin-stats.hbs etc., not form-input values).
  // Fires LOUD if anyone wraps {{user.storageQuota}} inside a `value="..."`
  // attribute with formatBytes.
  it('PFLICHT WC-i18n-f3: GET /admin/users/:id with mc_locale=de keeps form-input value as raw bytes (canonical)', async () => {
    const app = await buildServer(config);
    // Plan 8f Task 3 review (Concern #2): capture the original quota BEFORE
    // the try-block so the `finally` reset always runs even if assertions
    // throw mid-test. Otherwise a failed assertion would leave the target
    // user at the test-quota (1500000n) and pollute downstream tests that
    // assume the seeded 1 GiB pre-fill (test 3 above).
    const originalUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { storageQuota: true },
    });
    const originalQuota = originalUser!.storageQuota;
    // Reseed the target user to a fresh quota that, when formatted with
    // the binary 1024-base helper, yields a value containing both a
    // decimal-separator AND a unit suffix — so the negative-assertions
    // below catch any accidental formatBytes-wrap of the input value.
    // 1500000 bytes -> "1,43 MB" (DE) / "1.43 MB" (EN).
    await prisma.user.update({
      where: { id: targetUserId },
      data: { storageQuota: 1500000n },
    });
    try {
      const sessionCookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: `/admin/users/${targetUserId}`,
        headers: {
          accept: 'text/html',
          cookie: `${sessionCookie}; mc_locale=de`,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // Form-input MUST contain raw byte-count (canonical value-attribute).
      expect(body).toMatch(/<input[^>]*name="storageQuota"[^>]*value="1500000"/);
      // Must NOT contain DE/EN formatBytes output in the value-attribute.
      expect(body).not.toMatch(/<input[^>]*name="storageQuota"[^>]*value="1,43 MB"/);
      expect(body).not.toMatch(/<input[^>]*name="storageQuota"[^>]*value="1\.43 MB"/);
    } finally {
      // Always reset the quota, even on assertion failure, so downstream
      // tests stay deterministic across re-runs / interleaved execution.
      await prisma.user
        .update({
          where: { id: targetUserId },
          data: { storageQuota: originalQuota },
        })
        .catch((e: { code?: string }) => {
          if (e?.code !== 'P2025') throw e;
        });
      await app.close();
    }
  });
});
