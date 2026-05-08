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
});
