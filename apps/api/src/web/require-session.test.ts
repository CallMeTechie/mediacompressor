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

const TEST_EMAILS = ['req-session@test.invalid'];
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

describe('web/require-session', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await createTestUser(prisma, {
      email: 'req-session@test.invalid',
      password: 'hunter22hunter22',
    });
  });

  beforeEach(async () => {
    // Drain rate-limit buckets so re-runs of loginAndCookies don't 429.
    await resetLoginRateLimits(redis, ['req-session@test.invalid']);
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

  /**
   * Logs in via /login and returns the merged cookie header (mc_session + mc_csrf).
   */
  async function loginAndCookies(
    app: Awaited<ReturnType<typeof buildServer>>,
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
      payload: `email=req-session%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf)}`,
    });
    return (Array.isArray(post.headers['set-cookie'])
      ? post.headers['set-cookie']
      : [post.headers['set-cookie'] ?? ''])
      .map((c) => c?.split(';')[0])
      .filter(Boolean)
      .join('; ');
  }

  /**
   * Registers a probe-route guarded by app.requireSession. Pattern mirrors
   * apps/api/src/admin/role-guard.test.ts: each test gets its own buildServer
   * so the probe doesn't leak between tests.
   */
  async function appWithProbe() {
    const app = await buildServer(config);
    app.get(
      '/__test_protected',
      { preHandler: app.requireSession },
      async () => ({ ok: true }),
    );
    return app;
  }

  it('GET /__test_protected (no session) → 303 to /login', async () => {
    const app = await appWithProbe();
    try {
      const res = await app.inject({ method: 'GET', url: '/__test_protected' });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  it('GET /__test_protected (valid session) → 200 ok', async () => {
    const app = await appWithProbe();
    try {
      const cookie = await loginAndCookies(app);
      const res = await app.inject({
        method: 'GET',
        url: '/__test_protected',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('GET /__test_protected (EXPIRED session) → 303 to /login + clears mc_session', async () => {
    const app = await appWithProbe();
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'req-session@test.invalid' },
      });
      const expiredToken = 'expired-token-xxxxxxxxxxxxxxxxxxxx';
      const tokenHash = hashSessionToken(expiredToken, Buffer.from(config.SESSION_SECRET));
      await prisma.session.create({
        data: {
          userId: user!.id,
          tokenHash,
          userAgent: 'test',
          ip: '127.0.0.1',
          expiresAt: new Date(Date.now() - 60_000),
        },
      });
      const res = await app.inject({
        method: 'GET',
        url: '/__test_protected',
        headers: { cookie: `mc_session=${expiredToken}` },
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      expect(
        cookies.some(
          (c) => c?.startsWith('mc_session=') && /Max-Age=0|Expires=/.test(c),
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /__test_protected (session for DISABLED user) → 303 to /login + clears mc_session', async () => {
    const app = await appWithProbe();
    try {
      // Disable the user, then try to use a manually-crafted live session.
      // Login itself refuses disabled users so we cannot reuse loginAndCookies
      // here — we craft the session row directly.
      await prisma.user.update({
        where: { email: 'req-session@test.invalid' },
        data: { status: 'disabled' },
      });
      try {
        const user = await prisma.user.findUnique({
          where: { email: 'req-session@test.invalid' },
        });
        const liveToken = 'live-token-xxxxxxxxxxxxxxxxxxxx';
        const tokenHash = hashSessionToken(liveToken, Buffer.from(config.SESSION_SECRET));
        await prisma.session.create({
          data: {
            userId: user!.id,
            tokenHash,
            userAgent: 'test',
            ip: '127.0.0.1',
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        const res = await app.inject({
          method: 'GET',
          url: '/__test_protected',
          headers: { cookie: `mc_session=${liveToken}` },
        });
        expect([302, 303]).toContain(res.statusCode);
        expect(res.headers.location).toBe('/login');
        const setCookie = res.headers['set-cookie'];
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
        expect(
          cookies.some(
            (c) => c?.startsWith('mc_session=') && /Max-Age=0|Expires=/.test(c),
          ),
        ).toBe(true);
      } finally {
        // Restore so subsequent tests in this file pass.
        await prisma.user.update({
          where: { email: 'req-session@test.invalid' },
          data: { status: 'active' },
        });
      }
    } finally {
      await app.close();
    }
  });
});
