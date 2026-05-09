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

const TEST_EMAIL_USER = 'admin-stats-page-user@test.invalid';
const TEST_EMAIL_ADMIN = 'admin-stats-page-admin@test.invalid';
const TEST_EMAIL_ADMIN_DRIFT = 'admin-stats-page-drift@test.invalid';
const TEST_EMAIL_ADMIN_INNER500 = 'admin-stats-page-i500@test.invalid';
const TEST_EMAIL_ADMIN_UNKNOWN = 'admin-stats-page-unk@test.invalid';
const TEST_EMAILS = [
  TEST_EMAIL_USER,
  TEST_EMAIL_ADMIN,
  TEST_EMAIL_ADMIN_DRIFT,
  TEST_EMAIL_ADMIN_INNER500,
  TEST_EMAIL_ADMIN_UNKNOWN,
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

function extractCsrfToken(html: string): string {
  const match = html.match(/<input\s+[^>]*name="_csrf"[^>]*value="([^"]+)"/);
  if (!match) throw new Error('No CSRF token in HTML');
  return match[1]!;
}

describe('web/admin-stats-page', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let adminId: string;

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
      email: TEST_EMAIL_ADMIN_DRIFT,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_ADMIN_DRIFT },
      data: { role: 'admin' },
    });
    await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_INNER500,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_ADMIN_INNER500 },
      data: { role: 'admin' },
    });
    await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_UNKNOWN,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_ADMIN_UNKNOWN },
      data: { role: 'admin' },
    });

    const admin = await prisma.user.findUnique({
      where: { email: TEST_EMAIL_ADMIN },
      select: { id: true },
    });
    adminId = admin!.id;
  });

  beforeEach(async () => {
    await resetLoginRateLimits(redis, TEST_EMAILS);
    // Clean per-test job state under the happy-path admin user so seeded
    // counts are deterministic.
    await prisma.job.deleteMany({ where: { userId: adminId } });
  });

  afterAll(async () => {
    await prisma.job.deleteMany({ where: { userId: adminId } });
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

  async function loginAndCookies(
    app: Awaited<ReturnType<typeof buildServer>>,
    email: string,
  ): Promise<string> {
    const get = await app.inject({ method: 'GET', url: '/login' });
    const csrf = extractCsrfToken(get.body as string);
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
  it('GET /admin/stats (no session) -> 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/stats',
        headers: { accept: 'text/html' },
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  // 2.
  it('GET /admin/stats (non-admin user) -> 403 HTML', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_USER);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/stats',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/Forbidden/);
    } finally {
      await app.close();
    }
  });

  // 3. Happy path: 200 + Cache-Control no-store + section headings + values.
  it('GET /admin/stats (admin, happy) -> 200 with sections + Cache-Control no-store', async () => {
    // Seed at least one succeeded job under the admin user so the jobs table
    // has a row + storage.usedBytes is non-zero.
    const baseUploadId = `stats-page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await prisma.job.create({
      data: {
        userId: adminId,
        uploadId: `${baseUploadId}-s1`,
        status: 'succeeded',
        kind: 'image',
        profile: 'web-optimized',
        overrides: {},
        inputFilename: 's1.bin',
        outputBytes: 1024n,
        expiresAt: null,
      },
    });

    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/stats',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;

      // Cache-Control: no-store on post-login HTML.
      expect(res.headers['cache-control']).toMatch(/no-store/);

      // Section headings (English fallback locale) must appear.
      expect(body).toMatch(/Users/);
      expect(body).toMatch(/Jobs/);
      expect(body).toMatch(/Storage/);
      expect(body).toMatch(/Queue/);

      // Succeeded-job count >= 1 visible (we seeded one). Translation is
      // "Succeeded" in English.
      expect(body).toMatch(/Succeeded/);

      // storage.usedBytes -- numeric value rendered as text.
      expect(body).toContain('1024');

      // Queue heading rendered.
      expect(body).toMatch(/Compression waiting/);
    } finally {
      await app.close();
    }
  });

  // 4. Inner-200 with shape-mismatch (drift detection) -> 500 + error log.
  it('GET /admin/stats inner-200 with bad shape -> 500 + error log', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_DRIFT);

      const originalInject = app.inject.bind(app);
      const fakeInject = ((opts: unknown) => {
        const isInnerStats =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'GET' &&
          (opts as { url?: string }).url === '/api/v1/admin/stats';
        if (isInnerStats) {
          // Missing `users` key -> Zod shape mismatch.
          const bogusBody = JSON.stringify({
            jobs: {},
            storage: { usedBytes: '0', diskFree: null },
            queue: { compressionWaiting: 0, compressionActive: 0 },
          });
          return Promise.resolve({
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: bogusBody,
            payload: bogusBody,
            rawPayload: Buffer.from(bogusBody),
            cookies: [],
            json: () => JSON.parse(bogusBody),
            trailers: {},
          });
        }
        return (originalInject as (o: unknown) => unknown)(opts);
      }) as unknown as typeof app.inject;
      const injectSpy = vi.spyOn(app, 'inject').mockImplementation(fakeInject);
      const errorSpy = vi.spyOn(app.log, 'error');

      const res = await originalInject({
        method: 'GET',
        url: '/admin/stats',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(500);
      // Cache-Control: no-store stays on the error-path response.
      expect(res.headers['cache-control']).toMatch(/no-store/);
      // Error log emitted for drift detection.
      expect(errorSpy).toHaveBeenCalled();
      const sawDriftLog = errorSpy.mock.calls.some((call) => {
        const obj = call[0] as { action?: string; innerError?: unknown } | undefined;
        return (
          obj !== undefined &&
          typeof obj === 'object' &&
          obj.action === 'stats_view' &&
          typeof obj.innerError === 'string'
        );
      });
      expect(sawDriftLog).toBe(true);

      injectSpy.mockRestore();
      errorSpy.mockRestore();
    } finally {
      await app.close();
    }
  });

  // 5. Inner non-200 (unexpected status) -> outer 500 + warn log.
  it('GET /admin/stats inner-500 -> 500 + warn log', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_INNER500);

      const originalInject = app.inject.bind(app);
      const fakeInject = ((opts: unknown) => {
        const isInnerStats =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'GET' &&
          (opts as { url?: string }).url === '/api/v1/admin/stats';
        if (isInnerStats) {
          return Promise.resolve({
            statusCode: 500,
            headers: { 'content-type': 'application/json' },
            body: '{}',
            payload: '{}',
            rawPayload: Buffer.from('{}'),
            cookies: [],
            json: () => ({}),
            trailers: {},
          });
        }
        return (originalInject as (o: unknown) => unknown)(opts);
      }) as unknown as typeof app.inject;
      const injectSpy = vi.spyOn(app, 'inject').mockImplementation(fakeInject);
      const warnSpy = vi.spyOn(app.log, 'warn');

      const res = await originalInject({
        method: 'GET',
        url: '/admin/stats',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(500);
      expect(res.headers['cache-control']).toMatch(/no-store/);
      const sawWarn = warnSpy.mock.calls.some((call) => {
        const obj = call[0] as { action?: string; innerStatus?: unknown } | undefined;
        return (
          obj !== undefined &&
          typeof obj === 'object' &&
          obj.action === 'stats_view' &&
          obj.innerStatus === 500
        );
      });
      expect(sawWarn).toBe(true);

      injectSpy.mockRestore();
      warnSpy.mockRestore();
    } finally {
      await app.close();
    }
  });

  // 6. Unknown job-status falls back to stats_jobs_unknown label + raw status.
  it('GET /admin/stats unknown job status -> falls back to "Unknown status (...)" label', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_UNKNOWN);

      const originalInject = app.inject.bind(app);
      const fakeInject = ((opts: unknown) => {
        const isInnerStats =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'GET' &&
          (opts as { url?: string }).url === '/api/v1/admin/stats';
        if (isInnerStats) {
          const body = JSON.stringify({
            users: { total: 1 },
            jobs: { weirdfuturestatus: 7 },
            storage: { usedBytes: '0', diskFree: null },
            queue: { compressionWaiting: 0, compressionActive: 0 },
          });
          return Promise.resolve({
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body,
            payload: body,
            rawPayload: Buffer.from(body),
            cookies: [],
            json: () => JSON.parse(body),
            trailers: {},
          });
        }
        return (originalInject as (o: unknown) => unknown)(opts);
      }) as unknown as typeof app.inject;
      const injectSpy = vi.spyOn(app, 'inject').mockImplementation(fakeInject);

      const res = await originalInject({
        method: 'GET',
        url: '/admin/stats',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      expect(body).toMatch(/Unknown status/);
      expect(body).toContain('weirdfuturestatus');
      // Count column shows the value.
      expect(body).toContain('7');

      injectSpy.mockRestore();
    } finally {
      await app.close();
    }
  });
});
