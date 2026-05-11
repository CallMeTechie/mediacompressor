import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const TEST_EMAILS = [
  'apikey-revoke@test.invalid',
  'apikey-revoke-foreign@test.invalid',
  'apikey-revoke-other@test.invalid',
  'apikey-revoke-no-csrf@test.invalid',
  'apikey-revoke-csrf-stale@test.invalid',
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

describe('web/api-key-revoke-route', () => {
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
    const users = await prisma.user.findMany({
      where: { email: { in: TEST_EMAILS } },
      select: { id: true },
    });
    if (users.length > 0) {
      await prisma.apiKey.deleteMany({
        where: { userId: { in: users.map((u) => u.id) } },
      });
    }
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { in: TEST_EMAILS } },
      select: { id: true },
    });
    if (users.length > 0) {
      await prisma.apiKey.deleteMany({
        where: { userId: { in: users.map((u) => u.id) } },
      });
    }
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

  /**
   * Login + return both the session cookie header and a fresh CSRF token
   * suitable for a state-changing form-POST.
   */
  async function loginAndPrepareCsrf(
    app: Awaited<ReturnType<typeof buildServer>>,
    email: string,
  ): Promise<{ cookieHeader: string; csrf: string }> {
    const get = await app.inject({ method: 'GET', url: '/login' });
    const csrf1 = ((get.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1]!;
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
      payload: `email=${encodeURIComponent(email)}&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf1)}`,
    });
    const sessCookieHeader = (
      Array.isArray(post.headers['set-cookie'])
        ? post.headers['set-cookie']
        : [post.headers['set-cookie'] ?? '']
    )
      .map((c) => c?.split(';')[0])
      .filter(Boolean)
      .join('; ');
    // GET /login again to obtain a fresh CSRF token + (re-rotated) cookie.
    // We can't fetch from /profile/api-keys here because the empty-state
    // branch (zero keys) renders no per-row revoke form → no CSRF input
    // would be present in the body.
    const get2 = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { cookie: sessCookieHeader },
    });
    const csrf2 = ((get2.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1]!;
    const get2Cookies = (
      Array.isArray(get2.headers['set-cookie'])
        ? get2.headers['set-cookie']
        : get2.headers['set-cookie']
          ? [get2.headers['set-cookie']]
          : []
    )
      .map((c) => c?.split(';')[0])
      .filter(Boolean);
    const merged = [sessCookieHeader, ...get2Cookies].join('; ');
    return { cookieHeader: merged, csrf: csrf2 };
  }

  async function seedApiKey(opts: {
    userId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
  }) {
    return prisma.apiKey.create({
      data: {
        userId: opts.userId,
        name: opts.name,
        keyHash: opts.keyHash,
        keyPrefix: opts.keyPrefix,
        scopes: ['jobs:read', 'jobs:write'],
      },
    });
  }

  // 1.
  it('POST /profile/api-keys/:id/revoke (no session) → 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await app.inject({
        method: 'POST',
        url: `/profile/api-keys/${fakeId}/revoke`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  // 2.
  it('POST /profile/api-keys/:id/revoke (session, no _csrf) → 403', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'apikey-revoke-no-csrf@test.invalid' },
      });
      const seeded = await seedApiKey({
        userId: user!.id,
        name: 'no-csrf-key',
        keyPrefix: 'aaaaaaaa',
        keyHash: 'a'.repeat(64),
      });
      const { cookieHeader } = await loginAndPrepareCsrf(app, 'apikey-revoke-no-csrf@test.invalid');
      const res = await app.inject({
        method: 'POST',
        url: `/profile/api-keys/${seeded.id}/revoke`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: '',
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // 3. POST own key → 303 to /profile/api-keys?revokeflash=revoked + DB row revoked.
  it('POST /profile/api-keys/:id/revoke (own key) → 303 + DB row revoked', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'apikey-revoke@test.invalid' },
      });
      const seeded = await seedApiKey({
        userId: user!.id,
        name: 'own-key',
        keyPrefix: 'bbbbbbbb',
        keyHash: 'b'.repeat(64),
      });
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, 'apikey-revoke@test.invalid');
      const res = await app.inject({
        method: 'POST',
        url: `/profile/api-keys/${seeded.id}/revoke`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/profile/api-keys?revokeflash=revoked');

      const after = await prisma.apiKey.findUnique({ where: { id: seeded.id } });
      expect(after).not.toBeNull();
      expect(after!.revokedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  // 4. POST another user's key → 404 (no existence-leak).
  it("POST /profile/api-keys/:id/revoke (another user's key) → 404", async () => {
    const app = await buildServer(config);
    try {
      const otherUser = await prisma.user.findUnique({
        where: { email: 'apikey-revoke-other@test.invalid' },
      });
      const foreignKey = await seedApiKey({
        userId: otherUser!.id,
        name: 'foreign-key',
        keyPrefix: 'cccccccc',
        keyHash: 'c'.repeat(64),
      });
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'apikey-revoke-foreign@test.invalid',
      );
      const res = await app.inject({
        method: 'POST',
        url: `/profile/api-keys/${foreignKey.id}/revoke`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(404);

      // Foreign key remains untouched.
      const stillThere = await prisma.apiKey.findUnique({
        where: { id: foreignKey.id },
      });
      expect(stillThere).not.toBeNull();
      expect(stillThere!.revokedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  // 5. C6-LI — inner DELETE 403 (CSRF stale) → 303 to
  // /profile/api-keys?revokeflash=csrf-stale, mc_session preserved.
  it('C6-LI: inner DELETE 403 (CSRF stale) → 303 revokeflash=csrf-stale, mc_session preserved', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'apikey-revoke-csrf-stale@test.invalid' },
      });
      const seeded = await seedApiKey({
        userId: user!.id,
        name: 'csrf-stale-key',
        keyPrefix: 'dddddddd',
        keyHash: 'd'.repeat(64),
      });
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'apikey-revoke-csrf-stale@test.invalid',
      );

      const originalInject = app.inject.bind(app);
      const fakeInject = ((opts: unknown) => {
        const isInnerDelete =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'DELETE' &&
          (opts as { url?: string }).url === `/api/v1/users/me/api-keys/${seeded.id}`;
        if (isInnerDelete) {
          return Promise.resolve({
            statusCode: 403,
            headers: {},
            body: '',
            payload: '',
            rawPayload: Buffer.alloc(0),
            cookies: [],
            json: () => ({}),
            trailers: {},
          });
        }
        return (originalInject as (o: unknown) => unknown)(opts);
      }) as unknown as typeof app.inject;
      const injectSpy = vi.spyOn(app, 'inject').mockImplementation(fakeInject);

      const res = await originalInject({
        method: 'POST',
        url: `/profile/api-keys/${seeded.id}/revoke`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });

      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/profile/api-keys?revokeflash=csrf-stale');

      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      expect(
        cookies.some((c) => c?.startsWith('mc_session=') && /Max-Age=0|Expires=/.test(c)),
      ).toBe(false);

      injectSpy.mockRestore();
    } finally {
      await app.close();
    }
  });
});
