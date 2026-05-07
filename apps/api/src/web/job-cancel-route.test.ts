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
  'job-cancel@test.invalid',
  'job-cancel-foreign@test.invalid',
  'job-cancel-other@test.invalid',
  'job-cancel-terminal@test.invalid',
  'job-cancel-body@test.invalid',
  'job-cancel-race-401@test.invalid',
  'job-cancel-race-403@test.invalid',
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

type SeedStatus =
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'expired';

describe('web/job-cancel-route', () => {
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
   * suitable for a state-changing form-POST.
   */
  async function loginAndPrepareCsrf(
    app: Awaited<ReturnType<typeof buildServer>>,
    email: string,
  ): Promise<{ cookieHeader: string; csrf: string }> {
    const get = await app.inject({ method: 'GET', url: '/login' });
    const csrf1 = ((get.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1]!;
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
      payload: `email=${encodeURIComponent(email)}&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf1)}`,
    });
    const sessCookieHeader = (Array.isArray(post.headers['set-cookie'])
      ? post.headers['set-cookie']
      : [post.headers['set-cookie'] ?? ''])
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
    const get2Cookies = (Array.isArray(get2.headers['set-cookie'])
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

  async function seedJob(opts: {
    userId: string;
    inputFilename: string;
    status?: SeedStatus;
  }) {
    return prisma.job.create({
      data: {
        userId: opts.userId,
        status: opts.status ?? 'queued',
        kind: 'image',
        profile: 'web-optimized',
        overrides: {},
        inputFilename: opts.inputFilename,
        uploadId: `jobcancel-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      },
    });
  }

  it('POST /jobs/:id/cancel (no session) → 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-cancel@test.invalid' },
      });
      const job = await seedJob({ userId: user!.id, inputFilename: 'no-sess.png' });
      const res = await app.inject({
        method: 'POST',
        url: `/jobs/${job.id}/cancel`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  it('POST /jobs/:id/cancel (session, no _csrf) → 403', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-cancel@test.invalid' },
      });
      const job = await seedJob({ userId: user!.id, inputFilename: 'no-csrf.png' });
      const { cookieHeader } = await loginAndPrepareCsrf(app, 'job-cancel@test.invalid');
      const res = await app.inject({
        method: 'POST',
        url: `/jobs/${job.id}/cancel`,
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

  it('POST /jobs/:id/cancel (valid CSRF, own queued job) → 303 + DB canceled + Redis key', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-cancel@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'queued-cancel.png',
        status: 'queued',
      });
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'job-cancel@test.invalid',
      );
      const res = await app.inject({
        method: 'POST',
        url: `/jobs/${job.id}/cancel`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe(`/jobs/${job.id}`);

      const updated = await prisma.job.findUnique({ where: { id: job.id } });
      expect(updated?.status).toBe('canceled');

      const cancelKey = await redis.get(`cancel:${job.id}`);
      expect(cancelKey).toBe('1');
    } finally {
      await app.close();
    }
  });

  it('POST /jobs/:id/cancel (foreign job) → 404 HTML', async () => {
    const app = await buildServer(config);
    try {
      const otherUser = await prisma.user.findUnique({
        where: { email: 'job-cancel-other@test.invalid' },
      });
      const foreignJob = await seedJob({
        userId: otherUser!.id,
        inputFilename: 'foreign-cancel.png',
      });
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'job-cancel-foreign@test.invalid',
      );
      const res = await app.inject({
        method: 'POST',
        url: `/jobs/${foreignJob.id}/cancel`,
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

  it('POST /jobs/:id/cancel (already-terminal job) → 303 to /jobs/:id (idempotent)', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-cancel-terminal@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'already-done.png',
        status: 'succeeded',
      });
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'job-cancel-terminal@test.invalid',
      );
      const res = await app.inject({
        method: 'POST',
        url: `/jobs/${job.id}/cancel`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe(`/jobs/${job.id}`);

      // Idempotent — status unchanged.
      const updated = await prisma.job.findUnique({ where: { id: job.id } });
      expect(updated?.status).toBe('succeeded');
    } finally {
      await app.close();
    }
  });

  // WC-PL3 PFLICHT — _csrf in form body (NOT x-csrf-token header) is forwarded
  // to the inner DELETE /api/v1/jobs/:id correctly.
  it('WC-PL3: POST with _csrf in body (no x-csrf-token header) → 303 success', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-cancel-body@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'body-csrf.png',
        status: 'queued',
      });
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'job-cancel-body@test.invalid',
      );
      const res = await app.inject({
        method: 'POST',
        url: `/jobs/${job.id}/cancel`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          // intentionally NO x-csrf-token header
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe(`/jobs/${job.id}`);

      const updated = await prisma.job.findUnique({ where: { id: job.id } });
      expect(updated?.status).toBe('canceled');
    } finally {
      await app.close();
    }
  });

  // C2-LI PFLICHT — Multi-tab logout race. Outer requireSession passes (preHandler
  // runs first), then the inner DELETE returns 401 (simulated via mock-inject
  // because a real prisma.session.deleteMany() between the two would also make
  // the outer requireSession 303 to /login before the inner call runs).
  // Assert: 303 to /login + mc_session cookie cleared (Max-Age=0).
  it('C2-LI: inner DELETE 401 (session race) → 303 to /login + mc_session cleared', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-cancel-race-401@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'race-401.png',
        status: 'queued',
      });
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'job-cancel-race-401@test.invalid',
      );

      // Mock app.inject to return a fake 401 ONLY for the inner DELETE call
      // made by the cancel-route handler. The outer test's app.inject call
      // (POST /jobs/:id/cancel) hits the original implementation.
      const originalInject = app.inject.bind(app);
      // app.inject has 3 overloads (callback, promise, chain). The
      // mockImplementation callback does not satisfy all of them at the
      // type-level, so cast to a permissive any-shape signature; runtime
      // behaviour is correct (we always call it with InjectOptions).
      const fakeInject = ((opts: unknown) => {
        const isInnerDelete =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'DELETE' &&
          (opts as { url?: string }).url === `/api/v1/jobs/${job.id}`;
        if (isInnerDelete) {
          return Promise.resolve({
            statusCode: 401,
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
        url: `/jobs/${job.id}/cancel`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
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

      injectSpy.mockRestore();
    } finally {
      await app.close();
    }
  });

  // C6-LI PFLICHT — CSRF-stale race: inner DELETE 403 → 303 to
  // /jobs/:id?cancelflash=csrf-stale, mc_session PRESERVED.
  it('C6-LI: inner DELETE 403 (CSRF stale) → 303 to /jobs/:id?cancelflash=csrf-stale, mc_session preserved', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-cancel-race-403@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'race-403.png',
        status: 'queued',
      });
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'job-cancel-race-403@test.invalid',
      );

      const originalInject = app.inject.bind(app);
      const fakeInject = ((opts: unknown) => {
        const isInnerDelete =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'DELETE' &&
          (opts as { url?: string }).url === `/api/v1/jobs/${job.id}`;
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
        url: `/jobs/${job.id}/cancel`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });

      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe(`/jobs/${job.id}?cancelflash=csrf-stale`);
      // mc_session must NOT have been cleared.
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      expect(
        cookies.some(
          (c) => c?.startsWith('mc_session=') && /Max-Age=0|Expires=/.test(c),
        ),
      ).toBe(false);

      injectSpy.mockRestore();
    } finally {
      await app.close();
    }
  });
});
