import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { hashSessionToken } from '@mediacompressor/auth';
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
  'session-revoke@test.invalid',
  'session-revoke-other@test.invalid',
  'session-revoke-current@test.invalid',
  'session-revoke-foreign-owner@test.invalid',
  'session-revoke-nonexistent@test.invalid',
  'session-revoke-no-csrf@test.invalid',
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

describe('web/session-revoke-route', () => {
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

  /**
   * Login + return both the session cookie header and a fresh CSRF token
   * suitable for a state-changing form-POST. Mirrors the helper from
   * job-cancel-route.test.ts.
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

  /**
   * Seed a session row owned by `userId` with a fresh tokenHash. Returns the
   * created session (id + tokenHash) so tests can assert deletion/preservation.
   */
  async function seedSession(opts: { userId: string; tokenSeed: string; userAgent?: string }) {
    const tokenHash = hashSessionToken(opts.tokenSeed, Buffer.from(config.SESSION_SECRET));
    return prisma.session.create({
      data: {
        userId: opts.userId,
        tokenHash,
        userAgent: opts.userAgent ?? 'TestAgent/1.0',
        ip: '127.0.0.1',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  // 1.
  it('POST /profile/sessions/:id/revoke (no session) → 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      // Use any UUID — the auth-guard runs before existence-check.
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await app.inject({
        method: 'POST',
        url: `/profile/sessions/${fakeId}/revoke`,
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
  it('POST /profile/sessions/:id/revoke (session, no _csrf) → 403', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'session-revoke-no-csrf@test.invalid' },
      });
      const target = await seedSession({
        userId: user!.id,
        tokenSeed: 'no-csrf-target-token-xxxxxxxxxx',
      });
      const { cookieHeader } = await loginAndPrepareCsrf(
        app,
        'session-revoke-no-csrf@test.invalid',
      );
      const res = await app.inject({
        method: 'POST',
        url: `/profile/sessions/${target.id}/revoke`,
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

  // 3.
  it('POST /profile/sessions/:id/revoke (own non-current session) → 303 + DB row deleted', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'session-revoke@test.invalid' },
      });
      // Seed an extra (non-current) session for this user. The login-helper
      // creates the CURRENT session (tokenHash != this one).
      const target = await seedSession({
        userId: user!.id,
        tokenSeed: 'other-device-token-yyyyyyyyyyyy',
        userAgent: 'OtherBrowser/1.0',
      });
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, 'session-revoke@test.invalid');
      const res = await app.inject({
        method: 'POST',
        url: `/profile/sessions/${target.id}/revoke`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/profile?revokeflash=revoked');

      // DB row deleted.
      const deleted = await prisma.session.findUnique({ where: { id: target.id } });
      expect(deleted).toBeNull();
    } finally {
      await app.close();
    }
  });

  // 4.
  it("POST /profile/sessions/:id/revoke (another user's session) → 404 (no existence-leak)", async () => {
    const app = await buildServer(config);
    try {
      const otherUser = await prisma.user.findUnique({
        where: { email: 'session-revoke-other@test.invalid' },
      });
      // Seed a session owned by a DIFFERENT user.
      const foreignSession = await seedSession({
        userId: otherUser!.id,
        tokenSeed: 'foreign-owner-token-zzzzzzzzzzzz',
      });
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'session-revoke-foreign-owner@test.invalid',
      );
      const res = await app.inject({
        method: 'POST',
        url: `/profile/sessions/${foreignSession.id}/revoke`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(404);

      // Foreign session must remain untouched.
      const stillThere = await prisma.session.findUnique({
        where: { id: foreignSession.id },
      });
      expect(stillThere).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  // 5. WC-PR6 PFLICHT — current-session revoke attempt must be REFUSED via
  // crypto.timingSafeEqual (constant-time compare). Row PRESERVED.
  it('WC-PR6: POST CURRENT session → 303 to /profile?revokeflash=current-session, row PRESERVED', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'session-revoke-current@test.invalid',
      );
      // Find the CURRENT session row by hashing the cookie token.
      const cookieMap = Object.fromEntries(
        cookieHeader.split('; ').map((c) => {
          const [k, v] = c.split('=');
          return [k!, v ?? ''];
        }),
      );
      const cookieToken = cookieMap.mc_session;
      expect(cookieToken).toBeTruthy();
      const currentTokenHash = hashSessionToken(cookieToken!, Buffer.from(config.SESSION_SECRET));
      const currentSession = await prisma.session.findUnique({
        where: { tokenHash: currentTokenHash },
      });
      expect(currentSession).not.toBeNull();

      const res = await app.inject({
        method: 'POST',
        url: `/profile/sessions/${currentSession!.id}/revoke`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/profile?revokeflash=current-session');

      // Row PRESERVED — findUnique returns the unchanged row.
      const stillThere = await prisma.session.findUnique({
        where: { id: currentSession!.id },
      });
      expect(stillThere).not.toBeNull();
      expect(stillThere!.tokenHash).toBe(currentTokenHash);
    } finally {
      await app.close();
    }
  });

  // 6.
  it('POST /profile/sessions/:id/revoke (non-existent session-id) → 404', async () => {
    const app = await buildServer(config);
    try {
      const fakeId = '11111111-1111-1111-1111-111111111111';
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'session-revoke-nonexistent@test.invalid',
      );
      const res = await app.inject({
        method: 'POST',
        url: `/profile/sessions/${fakeId}/revoke`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
