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

const TEST_EMAIL_USER = 'admin-gate@test.invalid';
const TEST_EMAIL_ADMIN = 'admin-gate-admin@test.invalid';
const TEST_EMAIL_DISABLED_ADMIN = 'admin-gate-disabled@test.invalid';
const TEST_EMAILS = [TEST_EMAIL_USER, TEST_EMAIL_ADMIN, TEST_EMAIL_DISABLED_ADMIN];

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

describe('web/require-admin-session', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);

    // Plain user (role='user', status='active').
    await createTestUser(prisma, {
      email: TEST_EMAIL_USER,
      password: 'hunter22hunter22',
    });

    // Active admin (role='admin', status='active') — patched via update
    // because createTestUser doesn't set role.
    await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_ADMIN },
      data: { role: 'admin' },
    });

    // Admin who will be flipped to disabled inside test 4.
    await createTestUser(prisma, {
      email: TEST_EMAIL_DISABLED_ADMIN,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_DISABLED_ADMIN },
      data: { role: 'admin' },
    });
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
   * Logs in via /login and returns the merged cookie header (mc_session + mc_csrf).
   */
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

  /**
   * Registers a single inline-probe-route guarded by app.requireAdminSession.
   * Mirrors the pattern from require-session.test.ts so the probe doesn't
   * leak between tests.
   */
  async function appWithProbe(probePath = '/__test_admin') {
    const app = await buildServer(config);
    app.get(
      probePath,
      { preHandler: app.requireAdminSession },
      async () => ({ ok: true }),
    );
    return app;
  }

  it('GET /__test_admin (no session) → 303 to /login', async () => {
    const app = await appWithProbe();
    try {
      const res = await app.inject({ method: 'GET', url: '/__test_admin' });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  it('GET /__test_admin (valid session, role=user) → 403 HTML page with Forbidden + admin-privileges message', async () => {
    const app = await appWithProbe();
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_USER);
      const res = await app.inject({
        method: 'GET',
        url: '/__test_admin',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(403);
      const ct = res.headers['content-type'];
      expect(typeof ct === 'string' ? ct : '').toMatch(/text\/html/);
      const body = res.body as string;
      expect(body).toMatch(/Forbidden/);
      expect(body).toMatch(/admin privileges/);
      // Non-admin gets 403, NOT 303 — they ARE authenticated, just not admin.
      expect(res.headers.location).toBeUndefined();
      // Cache-Control: no-store on the 403 page.
      const cc = res.headers['cache-control'];
      expect(typeof cc === 'string' ? cc : '').toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  it('GET /__test_admin (valid session, role=admin, status=active) → 200 (route reached)', async () => {
    const app = await appWithProbe();
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: '/__test_admin',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('GET /__test_admin (admin role, status=disabled) → 303 to /login (delegated requireSession clears the disabled session)', async () => {
    // Login is refused for status=disabled, so we craft the session row
    // directly (mirrors Plan-8b require-session.test.ts test 4 pattern) AFTER
    // flipping the user to disabled.
    const app = await appWithProbe();
    try {
      await prisma.user.update({
        where: { email: TEST_EMAIL_DISABLED_ADMIN },
        data: { status: 'disabled' },
      });
      try {
        const user = await prisma.user.findUnique({
          where: { email: TEST_EMAIL_DISABLED_ADMIN },
        });
        const liveToken = 'live-admin-token-xxxxxxxxxxxxxxxxx';
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
          url: '/__test_admin',
          headers: { cookie: `mc_session=${liveToken}` },
        });
        // Delegated 303 from the wrapped requireSession (status !== 'active').
        expect([302, 303]).toContain(res.statusCode);
        expect(res.headers.location).toBe('/login');
        const setCookie = res.headers['set-cookie'];
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
        expect(
          cookies.some(
            (c) => c?.startsWith('mc_session=') && /Max-Age=0|Expires=/.test(c),
          ),
        ).toBe(true);
        // Crucial: this must NOT be a 403 — requireSession clears the cookie
        // BEFORE requireAdminSession's role-check runs.
        expect(res.statusCode).not.toBe(403);
      } finally {
        // Restore so subsequent runs / tests pass.
        await prisma.user.update({
          where: { email: TEST_EMAIL_DISABLED_ADMIN },
          data: { status: 'active' },
        });
      }
    } finally {
      await app.close();
    }
  });

  it('WC-AD1 PFLICHT: non-admin gets identical 403 page-shell on /admin, /admin/users, /admin/nonexistent (no admin-existence-leak)', async () => {
    // Three inline probe-routes representing different admin sub-paths.
    // For a non-admin user, all three MUST return identical 403 HTML
    // (same body, same status, same headers) so probing reveals nothing
    // about which admin-routes exist.
    const app = await buildServer(config);
    try {
      app.get(
        '/__test_admin_root',
        { preHandler: app.requireAdminSession },
        async () => ({ ok: true, route: 'root' }),
      );
      app.get(
        '/__test_admin_users',
        { preHandler: app.requireAdminSession },
        async () => ({ ok: true, route: 'users' }),
      );
      app.get(
        '/__test_admin_nonexistent',
        { preHandler: app.requireAdminSession },
        async () => ({ ok: true, route: 'nonexistent' }),
      );

      const cookie = await loginAndCookies(app, TEST_EMAIL_USER);

      const responses = await Promise.all([
        app.inject({ method: 'GET', url: '/__test_admin_root', headers: { cookie } }),
        app.inject({ method: 'GET', url: '/__test_admin_users', headers: { cookie } }),
        app.inject({ method: 'GET', url: '/__test_admin_nonexistent', headers: { cookie } }),
      ]);

      // Same status across all probes.
      for (const r of responses) {
        expect(r.statusCode).toBe(403);
      }

      // Same body across all probes — proves the 403 page-shell is identical
      // regardless of which admin-path was probed. Without this guarantee, a
      // non-admin user could enumerate which admin-routes exist by diffing
      // page-content (e.g. a route-specific 404 vs the generic 403).
      const [r0, r1, r2] = responses;
      expect(r1!.body).toBe(r0!.body);
      expect(r2!.body).toBe(r0!.body);

      // Same Cache-Control header on all three.
      expect(r1!.headers['cache-control']).toBe(r0!.headers['cache-control']);
      expect(r2!.headers['cache-control']).toBe(r0!.headers['cache-control']);
      expect(typeof r0!.headers['cache-control'] === 'string' ? r0!.headers['cache-control'] : '').toMatch(/no-store/);

      // Same content-type on all three.
      expect(r1!.headers['content-type']).toBe(r0!.headers['content-type']);
      expect(r2!.headers['content-type']).toBe(r0!.headers['content-type']);
    } finally {
      await app.close();
    }
  });
});
