import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import {
  TEST_API_KEY_PEPPER, TEST_SESSION_SECRET, TEST_CSRF_SECRET,
  testDatabaseUrl, testRedisUrl, createTestUser, cleanupTestUsers,
  resetLoginRateLimits,
} from '@mediacompressor/test-helpers';
import IORedis from 'ioredis';
import { buildServer } from '../server.js';
import type { Config } from '../config.js';

const TEST_EMAILS = ['logout@test.invalid'];
const config: Config = {
  DATABASE_URL: testDatabaseUrl(),
  REDIS_URL: testRedisUrl(),
  SESSION_SECRET: TEST_SESSION_SECRET,
  CSRF_SECRET: TEST_CSRF_SECRET,
  API_KEY_PEPPER: TEST_API_KEY_PEPPER,
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  PORT: 0, NODE_ENV: 'test', LOG_LEVEL: 'error', ARGON2_MAX_CONCURRENCY: 8,
  TUSD_SHARED_SECRET: 'a'.repeat(64), TUSD_REQUIRE_SHARED_SECRET: true,
  TUSD_DATA_DIR: '/media/tusd-data', TUSD_FINAL_DIR: '/media/uploads',
  MEDIA_MOUNT_PATH: '/media', MIN_FREE_BYTES_RESERVE: 1n,
  TRUSTED_PROXY_CIDR: 'loopback',
  ENABLE_LEGACY_JOB_STUB: false,
};

describe('web/logout-route', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await createTestUser(prisma, { email: 'logout@test.invalid', password: 'hunter22hunter22' });
  });

  beforeEach(async () => {
    await resetLoginRateLimits(redis, ['logout@test.invalid']);
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

  /**
   * Logs in via /login and returns the cookie header (mc_session + mc_csrf)
   * + a fresh CSRF token suitable for the next form-POST.
   */
  async function loginAndExtract(app: Awaited<ReturnType<typeof buildServer>>) {
    const get = await app.inject({ method: 'GET', url: '/login' });
    const csrf = ((get.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1]!;
    const initialCookie = get.headers['set-cookie'];
    const initialCookieHeader = Array.isArray(initialCookie)
      ? initialCookie.join('; ')
      : initialCookie!;
    const post = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        cookie: initialCookieHeader,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `email=logout%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf)}`,
    });
    const sessCookies = post.headers['set-cookie'];
    const cookieHeader = (Array.isArray(sessCookies) ? sessCookies : [sessCookies ?? ''])
      .map((c) => c?.split(';')[0])
      .filter(Boolean)
      .join('; ');
    // Re-issue a CSRF token on a GET so we have a fresh _csrf for the logout POST.
    const get2 = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { cookie: cookieHeader },
    });
    const csrf2 = ((get2.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1]!;
    const merged = [
      cookieHeader,
      ...(Array.isArray(get2.headers['set-cookie'])
        ? get2.headers['set-cookie']
        : get2.headers['set-cookie']
        ? [get2.headers['set-cookie']!]
        : []
      ).map((c) => c?.split(';')[0]).filter(Boolean),
    ].join('; ');
    return { cookieHeader: merged, csrf: csrf2 };
  }

  it('POST /logout (with valid session + CSRF) -> 303 to /login, mc_session cleared', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndExtract(app);
      const res = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      // mc_session cleared (Max-Age=0 or Expires in the past).
      expect(cookies.some((c) => c?.startsWith('mc_session=') && /Max-Age=0|Expires=/.test(c))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('POST /logout WITHOUT _csrf -> 403', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader } = await loginAndExtract(app);
      const res = await app.inject({
        method: 'POST',
        url: '/logout',
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

  it('POST /logout WITHOUT session cookie but WITH CSRF -> still 303 to /login (idempotent)', async () => {
    const app = await buildServer(config);
    try {
      // GET to obtain a CSRF cookie + token without a session.
      const get = await app.inject({ method: 'GET', url: '/login' });
      const cookie = get.headers['set-cookie'];
      const cookieHeader = Array.isArray(cookie) ? cookie.join('; ') : cookie!;
      const csrf = ((get.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1]!;
      const res = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });
});
