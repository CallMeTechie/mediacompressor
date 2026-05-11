import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaClient, JobStatus, type PrismaClient } from '@mediacompressor/db';
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
const TEST_EMAIL_ADMIN_INNER401 = 'admin-stats-page-i401@test.invalid';
const TEST_EMAIL_ADMIN_INNER403 = 'admin-stats-page-i403@test.invalid';
const TEST_EMAIL_ADMIN_BADJSON = 'admin-stats-page-bjs@test.invalid';
const TEST_EMAILS = [
  TEST_EMAIL_USER,
  TEST_EMAIL_ADMIN,
  TEST_EMAIL_ADMIN_DRIFT,
  TEST_EMAIL_ADMIN_INNER500,
  TEST_EMAIL_ADMIN_UNKNOWN,
  TEST_EMAIL_ADMIN_INNER401,
  TEST_EMAIL_ADMIN_INNER403,
  TEST_EMAIL_ADMIN_BADJSON,
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
    await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_INNER401,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_ADMIN_INNER401 },
      data: { role: 'admin' },
    });
    await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_INNER403,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_ADMIN_INNER403 },
      data: { role: 'admin' },
    });
    await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_BADJSON,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_ADMIN_BADJSON },
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

  // Concern #3 (Plan 8d Task 6 review): centralised mock-restore. Replaces
  // inline injectSpy.mockRestore() / errorSpy.mockRestore() / warnSpy.
  // mockRestore() inside test bodies, which would leak if a test threw
  // BEFORE the restore line ran. vi.restoreAllMocks() runs after EVERY
  // test regardless of pass/fail, restoring all spies created in any test.
  afterEach(() => {
    vi.restoreAllMocks();
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

      // Storage section now renders formatted bytes via formatBytes helper
      // (Plan 8f Task 3 migration from raw `{{stats.storage.usedBytes}}`).
      // Positive assertion below verifies the EN default-locale output
      // ("1.00 KB" for 1024 bytes), scoped to the storage <dd>-element so
      // any future regression that leaks raw bytes back into the storage
      // section fails LOUD — without the scoped regex a substring like
      // "1024" appears in many unrelated contexts (CSS, JS, ids), which
      // would make a negative-assertion brittle. Form-VALUE-canonicality
      // + DE-format coverage live in admin-user-edit-page.test.ts (PFLICHT
      // WC-i18n-f3) and admin-users-list-page.test.ts (PFLICHT WC-i18n-
      // f-task3), so this test only needs the positive scoped check.
      expect(body).toMatch(/<dd>1\.00\s+KB<\/dd>/);

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
      vi.spyOn(app, 'inject').mockImplementation(fakeInject);
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
      vi.spyOn(app, 'inject').mockImplementation(fakeInject);
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
      vi.spyOn(app, 'inject').mockImplementation(fakeInject);

      const res = await originalInject({
        method: 'GET',
        url: '/admin/stats',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // Concern #5 (Plan 8d Task 6 review): the parens come from the i18n
      // value `"stats_jobs_unknown": "Unknown status ({{status}})"` rather
      // than template-glue. Assert the full interpolated string lands in
      // the rendered HTML.
      expect(body).toContain('Unknown status (weirdfuturestatus)');
      // Count column shows the value.
      expect(body).toContain('7');
    } finally {
      await app.close();
    }
  });

  // 7. Concern #2 (Plan 8d Task 6 review): inner-401 -> outer 500 + warn log.
  // requireAdminSession ALREADY authorised the outer request, so a 401 from
  // the inner Plan-7 endpoint is a session-race / drift signal, NOT user-
  // visible auth failure. Outer must be 500 + Cache-Control: no-store.
  it('GET /admin/stats inner-401 -> 500 + warn log', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_INNER401);

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
            statusCode: 401,
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
      vi.spyOn(app, 'inject').mockImplementation(fakeInject);
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
          obj.innerStatus === 401
        );
      });
      expect(sawWarn).toBe(true);
    } finally {
      await app.close();
    }
  });

  // 8. Concern #2 (Plan 8d Task 6 review): inner-403 -> outer 500 + warn log.
  // Mirror of test 7 — same reasoning: the outer admin guard already passed,
  // so an inner 403 means CSRF rotation / role-race / Plan-7 drift. Surface
  // as 500 + warn, never leak the inner 403 verbatim.
  it('GET /admin/stats inner-403 -> 500 + warn log', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_INNER403);

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
            statusCode: 403,
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
      vi.spyOn(app, 'inject').mockImplementation(fakeInject);
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
          obj.innerStatus === 403
        );
      });
      expect(sawWarn).toBe(true);
    } finally {
      await app.close();
    }
  });

  // 9. Concern #4 (Plan 8d Task 6 review): inner-200 with non-JSON body
  // (json() throws) -> outer 500 + Cache-Control: no-store + error log.
  // Without the try/catch around inner.json(), a sync throw bypasses the
  // 500 view and Fastify's default 500 (no Cache-Control: no-store).
  it('GET /admin/stats inner-200 non-JSON body -> 500 + no-store + error log', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_BADJSON);

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
          // Simulate a content-type drift where Plan-7 returns a 200 with a
          // non-JSON body (e.g. a proxy injected an HTML error page). The
          // synchronous .json() throw must NOT bypass our 500 + no-store.
          return Promise.resolve({
            statusCode: 200,
            headers: { 'content-type': 'text/html' },
            body: '<html>oops</html>',
            payload: '<html>oops</html>',
            rawPayload: Buffer.from('<html>oops</html>'),
            cookies: [],
            json: () => {
              throw new Error('Unexpected token < in JSON at position 0');
            },
            trailers: {},
          });
        }
        return (originalInject as (o: unknown) => unknown)(opts);
      }) as unknown as typeof app.inject;
      vi.spyOn(app, 'inject').mockImplementation(fakeInject);
      const errorSpy = vi.spyOn(app.log, 'error');

      const res = await originalInject({
        method: 'GET',
        url: '/admin/stats',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(500);
      expect(res.headers['cache-control']).toMatch(/no-store/);
      const sawError = errorSpy.mock.calls.some((call) => {
        const obj = call[0] as { action?: string; err?: unknown } | undefined;
        return (
          obj !== undefined &&
          typeof obj === 'object' &&
          obj.action === 'stats_view' &&
          typeof obj.err === 'string'
        );
      });
      expect(sawError).toBe(true);
    } finally {
      await app.close();
    }
  });

  // 10. Concern #1 (Plan 8d Task 6 review): drift-guard. KNOWN_JOB_STATUSES
  // is now derived from `Object.values(JobStatus)` so the Set updates auto-
  // matically when the Prisma enum grows. The locale files do NOT auto-
  // update though, so this test fires until BOTH locale files gain a
  // `stats_jobs_<status>` key for every JobStatus enum value.
  it('locale files cover every JobStatus enum value', async () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // From apps/api/src/web/ to apps/api/locales/ -- two parents up.
    const localesRoot = path.resolve(__dirname, '..', '..', 'locales');
    const enRaw = await fs.readFile(path.join(localesRoot, 'en', 'admin.json'), 'utf8');
    const deRaw = await fs.readFile(path.join(localesRoot, 'de', 'admin.json'), 'utf8');
    // Map-based lookup avoids dynamic property access on plain objects
    // (security/detect-object-injection) — safer than enKeys[runtimeKey].
    const enKeys = new Map<string, string>(
      Object.entries(JSON.parse(enRaw) as Record<string, string>),
    );
    const deKeys = new Map<string, string>(
      Object.entries(JSON.parse(deRaw) as Record<string, string>),
    );

    const enumValues = Object.values(JobStatus) as readonly string[];
    expect(enumValues.length).toBeGreaterThan(0);
    for (const status of enumValues) {
      const key = `stats_jobs_${status}`;
      expect(enKeys.get(key), `EN locale missing key ${key} for JobStatus enum value`).toBeTruthy();
      expect(deKeys.get(key), `DE locale missing key ${key} for JobStatus enum value`).toBeTruthy();
    }
  });
});
