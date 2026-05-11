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

const TEST_EMAIL_USER = 'admin-user-update-user@test.invalid';
const TEST_EMAIL_ADMIN = 'admin-user-update@test.invalid';
const TEST_EMAIL_ADMIN_SELF = 'admin-user-update-self@test.invalid';
const TEST_EMAIL_ADMIN_BIG = 'admin-user-update-big@test.invalid';
const TEST_EMAIL_ADMIN_401 = 'admin-user-update-401@test.invalid';
const TEST_EMAIL_ADMIN_403 = 'admin-user-update-403@test.invalid';
const TEST_EMAIL_ADMIN_400 = 'admin-user-update-400@test.invalid';
const TEST_EMAIL_ADMIN_AUDIT = 'admin-user-update-audit@test.invalid';
const TEST_EMAIL_TARGET = 'admin-user-update-target@test.invalid';

const TEST_EMAILS = [
  TEST_EMAIL_USER,
  TEST_EMAIL_ADMIN,
  TEST_EMAIL_ADMIN_SELF,
  TEST_EMAIL_ADMIN_BIG,
  TEST_EMAIL_ADMIN_401,
  TEST_EMAIL_ADMIN_403,
  TEST_EMAIL_ADMIN_400,
  TEST_EMAIL_ADMIN_AUDIT,
  TEST_EMAIL_TARGET,
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
  LOG_LEVEL: 'info', // C5/C6-AD-PR test reads pino stdout.
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

describe('web/admin-user-update-route', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let targetUserId: string;
  let adminSelfId: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);

    // Plain (non-admin) user.
    await createTestUser(prisma, { email: TEST_EMAIL_USER, password: 'hunter22hunter22' });

    // Admin variants -- separate accounts so test ordering doesn't interact
    // (e.g. self-disable tests don't break other tests).
    for (const email of [
      TEST_EMAIL_ADMIN,
      TEST_EMAIL_ADMIN_SELF,
      TEST_EMAIL_ADMIN_BIG,
      TEST_EMAIL_ADMIN_401,
      TEST_EMAIL_ADMIN_403,
      TEST_EMAIL_ADMIN_400,
      TEST_EMAIL_ADMIN_AUDIT,
    ]) {
      await createTestUser(prisma, { email, password: 'hunter22hunter22' });
      await prisma.user.update({ where: { email }, data: { role: 'admin' } });
    }

    // Target plain user that admins will edit.
    await createTestUser(prisma, {
      email: TEST_EMAIL_TARGET,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_TARGET },
      data: {
        storageQuota: 1073741824n,
        parallelQuota: 5,
        hourlyQuota: 25,
      },
    });

    const target = await prisma.user.findUnique({
      where: { email: TEST_EMAIL_TARGET },
      select: { id: true },
    });
    targetUserId = target!.id;

    const adminSelf = await prisma.user.findUnique({
      where: { email: TEST_EMAIL_ADMIN_SELF },
      select: { id: true },
    });
    adminSelfId = adminSelf!.id;
  });

  beforeEach(async () => {
    await resetLoginRateLimits(redis, TEST_EMAILS);
  });

  afterAll(async () => {
    // Plan 10 Task 3 cleanup: delete AuditEvent rows for any test-admin
    // actor BEFORE cleanupTestUsers (FK onDelete: Restrict). cleanupTestUsers
    // also deletes audit-events (WC-audit-7 fix); explicit deletion here is
    // defense-in-depth + makes test-data-leakage visible if the helper drifts.
    const actorIds = (
      await prisma.user.findMany({
        where: { email: { in: TEST_EMAILS } },
        select: { id: true },
      })
    ).map((u) => u.id);
    if (actorIds.length > 0) {
      await prisma.auditEvent.deleteMany({
        where: { actorUserId: { in: actorIds } },
      });
    }
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

  /** Logs in + returns merged cookie header AND a fresh CSRF token. */
  async function loginAndPrepareCsrf(
    app: Awaited<ReturnType<typeof buildServer>>,
    email: string,
    targetId: string,
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
    // GET the edit page to get a fresh CSRF token.
    const get2 = await app.inject({
      method: 'GET',
      url: `/admin/users/${targetId}`,
      headers: { cookie: sessCookieHeader, accept: 'text/html' },
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

  /** Login only -- returns merged cookie header (no CSRF token fetch). */
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
  it('POST /admin/users/:id (no session) -> 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/users/${targetUserId}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'status=disabled&_csrf=irrelevant',
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  // 2.
  it('POST /admin/users/:id (non-admin) -> 403 HTML', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_USER);
      const res = await app.inject({
        method: 'POST',
        url: `/admin/users/${targetUserId}`,
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/html',
        },
        payload: 'status=disabled&_csrf=irrelevant',
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/Forbidden/);
    } finally {
      await app.close();
    }
  });

  // 3. WC-AD8 / C4-AD-PR PFLICHT -- valid admin session + missing _csrf body
  // field -> 403 (proves csrfProtection runs AFTER requireAdminSession).
  it('WC-AD8 / C4-AD-PR PFLICHT: valid admin session + missing _csrf -> 403', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'POST',
        url: `/admin/users/${targetUserId}`,
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        // Body has no _csrf field at all.
        payload: 'status=disabled',
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // 4. WC-AD9 -- admin self-disable: backend allows it (Plan-7's PATCH does
  // not refuse self-status-change). Documented behavior: admins CAN disable
  // themselves; subsequent requests would 303 to /login because requireSession
  // sees status='disabled'. Test asserts the request reaches the inner route
  // (NOT 403) and gets a 303 success or other non-csrf-error code.
  it('WC-AD9: POST own-admin-id status=disabled reaches inner route', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        TEST_EMAIL_ADMIN_SELF,
        adminSelfId,
      );
      const res = await app.inject({
        method: 'POST',
        url: `/admin/users/${adminSelfId}`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `status=disabled&_csrf=${encodeURIComponent(csrf)}`,
      });
      // Either 303 (success) or 4xx if Plan-7 starts refusing self-disable.
      // The test asserts the request reaches the inner route + does NOT 403
      // before reaching it (csrf passed).
      expect([200, 204, 302, 303, 400, 401, 404]).toContain(res.statusCode);
      if (res.statusCode === 303 || res.statusCode === 302) {
        expect(res.headers.location).toBe('/admin/users?updateflash=updated');
      }
    } finally {
      await app.close();
    }
  });

  // 5. C5-AD-PR + C6-AD-PR PFLICHT -- audit-log BigInt-safe.
  // POST with storageQuota=1073741824. Spy process.stdout.write. Assert
  // log line emitted (no Pino crash on BigInt). Log line contains
  // "action":"user_update", "targetUserId":"<id>", and the storageQuota as
  // a JSON STRING ("1073741824"), NOT as a BigInt-literal.
  it('C5-AD-PR + C6-AD-PR PFLICHT: audit-log BigInt-safe + carries adminId/action/targetUserId', async () => {
    const captured: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(
      ((chunk: unknown, ...rest: unknown[]) => {
        captured.push(typeof chunk === 'string' ? chunk : String(chunk));
        return (origWrite as unknown as (...args: unknown[]) => boolean)(
          chunk,
          ...rest,
        );
      }) as typeof process.stdout.write,
    );
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        TEST_EMAIL_ADMIN_BIG,
        targetUserId,
      );
      // 1 GiB as a numeric body field; the route's z.coerce.bigint() converts.
      const res = await app.inject({
        method: 'POST',
        url: `/admin/users/${targetUserId}`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `storageQuota=1073741824&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/admin/users?updateflash=updated');

      const allStdout = captured.join('');
      // C5-AD-PR -- audit-log markers present.
      expect(allStdout).toMatch(/"action":"user_update"/);
      expect(allStdout).toContain(`"targetUserId":"${targetUserId}"`);
      expect(allStdout).toMatch(/"adminId":"[^"]+"/);
      // C6-AD-PR -- storageQuota stringified, not BigInt-literal. The JSON
      // string form "1073741824" must appear as a quoted JSON string.
      expect(allStdout).toContain('"storageQuota":"1073741824"');
      // Extra safety: BigInt serialization-error message MUST NOT appear.
      expect(allStdout).not.toMatch(/Do not know how to serialize a BigInt/);
    } finally {
      stdoutSpy.mockRestore();
      await app.close();
    }
  });

  // 6. Inner status mapping -- 401 -> 303 /login + clearCookie; 403 -> 303
  // /admin/users?updateflash=csrf-stale.
  it('Inner 401 -> 303 /login + clearCookie; inner 403 -> 303 csrf-stale', async () => {
    // --- 401 path ---
    {
      const app = await buildServer(config);
      try {
        const { cookieHeader, csrf } = await loginAndPrepareCsrf(
          app,
          TEST_EMAIL_ADMIN_401,
          targetUserId,
        );
        const originalInject = app.inject.bind(app);
        const fakeInject = ((opts: unknown) => {
          const isInnerPatch =
            typeof opts === 'object' &&
            opts !== null &&
            'method' in opts &&
            'url' in opts &&
            (opts as { method?: string }).method === 'PATCH' &&
            typeof (opts as { url?: string }).url === 'string' &&
            (opts as { url: string }).url.startsWith('/api/v1/admin/users/');
          if (isInnerPatch) {
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
          url: `/admin/users/${targetUserId}`,
          headers: {
            cookie: cookieHeader,
            'content-type': 'application/x-www-form-urlencoded',
            'x-csrf-token': csrf,
          },
          payload: `status=active&_csrf=${encodeURIComponent(csrf)}`,
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
    }

    // --- 403 path ---
    {
      const app = await buildServer(config);
      try {
        const { cookieHeader, csrf } = await loginAndPrepareCsrf(
          app,
          TEST_EMAIL_ADMIN_403,
          targetUserId,
        );
        const originalInject = app.inject.bind(app);
        const fakeInject = ((opts: unknown) => {
          const isInnerPatch =
            typeof opts === 'object' &&
            opts !== null &&
            'method' in opts &&
            'url' in opts &&
            (opts as { method?: string }).method === 'PATCH' &&
            typeof (opts as { url?: string }).url === 'string' &&
            (opts as { url: string }).url.startsWith('/api/v1/admin/users/');
          if (isInnerPatch) {
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
          url: `/admin/users/${targetUserId}`,
          headers: {
            cookie: cookieHeader,
            'content-type': 'application/x-www-form-urlencoded',
            'x-csrf-token': csrf,
          },
          payload: `status=active&_csrf=${encodeURIComponent(csrf)}`,
        });
        expect([302, 303]).toContain(res.statusCode);
        // Concern #2: redirect goes to the EDIT-form for retry, not the list.
        expect(res.headers.location).toBe(
          `/admin/users/${targetUserId}?updateflash=csrf-stale`,
        );
        // mc_session NOT cleared (CSRF rotation race, session valid).
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
    }
  });

  // 7. Concern #1 PFLICHT -- inner 400 (BFF/inner schema drift). Mock the
  // inner PATCH to return 400 with a JSON error body. The route must:
  //  - respond 400 (NOT 500)
  //  - re-render the edit-form with the inner's error message
  //  - preserve the admin's submitted form values in the inputs
  it('Concern #1: inner 400 -> 400 HTML edit-form re-render with inner error message', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        TEST_EMAIL_ADMIN_400,
        targetUserId,
      );
      const innerErrorMsg = 'storageQuota must be a multiple of 1024';
      const innerErrorBody = JSON.stringify({
        error: { code: 'INVALID_INPUT', message: innerErrorMsg },
      });
      const originalInject = app.inject.bind(app);
      const fakeInject = ((opts: unknown) => {
        const isInnerPatch =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'PATCH' &&
          typeof (opts as { url?: string }).url === 'string' &&
          (opts as { url: string }).url.startsWith('/api/v1/admin/users/');
        if (isInnerPatch) {
          return Promise.resolve({
            statusCode: 400,
            headers: { 'content-type': 'application/json' },
            body: innerErrorBody,
            payload: innerErrorBody,
            rawPayload: Buffer.from(innerErrorBody),
            cookies: [],
            json: () => JSON.parse(innerErrorBody),
            trailers: {},
          });
        }
        return (originalInject as (o: unknown) => unknown)(opts);
      }) as unknown as typeof app.inject;
      const injectSpy = vi.spyOn(app, 'inject').mockImplementation(fakeInject);

      // Submit a value that the BFF UpdateForm accepts but pretend the inner
      // rejects (mocked above). Use a non-default storageQuota so we can
      // assert it round-trips into the re-rendered form.
      const submittedQuota = '999999';
      const res = await originalInject({
        method: 'POST',
        url: `/admin/users/${targetUserId}`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
          accept: 'text/html',
        },
        payload: `storageQuota=${submittedQuota}&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(400);
      const body = res.body as string;
      // Edit form re-rendered (form action targets the same edit-URL).
      // Plain substring assertion avoids the dynamic-regex lint warning.
      expect(body).toContain(`action="/admin/users/${targetUserId}"`);
      // Inner's error message surfaces in the flash banner.
      expect(body).toContain(innerErrorMsg);
      // Submitted storageQuota value is preserved in the input. Plain
      // substring assertion avoids the dynamic-regex lint warning.
      expect(body).toContain(`name="storageQuota"`);
      expect(body).toContain(`value="${submittedQuota}"`);

      injectSpy.mockRestore();
    } finally {
      await app.close();
    }
  });

  // 8. PFLICHT Plan-10 Task-3: AuditEvent row written on successful
  // user_update. Mirrors the C5/C6-AD-PR log-shape assertion but instead of
  // grepping stdout we read the persisted DB row.
  it('PFLICHT Plan-10 Task-3: writes AuditEvent row on successful user_update', async () => {
    const app = await buildServer(config);
    let adminId: string | undefined;
    try {
      const adminUser = await prisma.user.findUnique({
        where: { email: TEST_EMAIL_ADMIN_AUDIT },
        select: { id: true },
      });
      adminId = adminUser!.id;
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        TEST_EMAIL_ADMIN_AUDIT,
        targetUserId,
      );
      const res = await app.inject({
        method: 'POST',
        url: `/admin/users/${targetUserId}`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `status=disabled&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/admin/users?updateflash=updated');

      // No `take: 1` — `toHaveLength(1)` surfaces accidental duplicate
      // audit-writes loudly instead of silently masking them via a limit.
      const events = await prisma.auditEvent.findMany({
        where: {
          actorUserId: adminId,
          action: 'user_update',
          targetId: targetUserId,
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'user_update',
        targetType: 'user',
        targetId: targetUserId,
      });
      // payload reflects the patch (status=disabled). The route forwards
      // patchForJson which is already BigInt-coerced; recordAuditEvent
      // re-validates.
      expect(events[0]!.payload).toMatchObject({ status: 'disabled' });
    } finally {
      if (adminId) {
        await prisma.auditEvent.deleteMany({
          where: { actorUserId: adminId },
        });
      }
      await app.close();
    }
  });
});
