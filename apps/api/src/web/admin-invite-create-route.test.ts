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

const TEST_EMAIL_USER = 'admin-invite-create-user@test.invalid';
const TEST_EMAIL_ADMIN = 'admin-invite-create@test.invalid';
const TEST_EMAIL_ADMIN_NOEMAIL = 'admin-invite-create-noemail@test.invalid';
const TEST_EMAIL_ADMIN_WITHEMAIL = 'admin-invite-create-withemail@test.invalid';
const TEST_EMAIL_ADMIN_ONETIME = 'admin-invite-create-onetime@test.invalid';
const TEST_EMAIL_ADMIN_NOSTORE = 'admin-invite-create-nostore@test.invalid';
const TEST_EMAIL_ADMIN_STDOUT = 'admin-invite-create-stdout@test.invalid';
const TEST_EMAIL_ADMIN_INVALIDMAIL = 'admin-invite-create-invalidmail@test.invalid';
const TEST_EMAIL_ADMIN_401 = 'admin-invite-create-401@test.invalid';
const TEST_EMAIL_ADMIN_403 = 'admin-invite-create-403@test.invalid';
const TEST_EMAIL_ADMIN_BOUNDS = 'admin-invite-create-bounds@test.invalid';
const TEST_EMAIL_ADMIN_SHAPE = 'admin-invite-create-shape@test.invalid';
const TEST_EMAIL_ADMIN_AUDIT = 'admin-invite-create-audit@test.invalid';
const TEST_EMAILS = [
  TEST_EMAIL_USER,
  TEST_EMAIL_ADMIN,
  TEST_EMAIL_ADMIN_NOEMAIL,
  TEST_EMAIL_ADMIN_WITHEMAIL,
  TEST_EMAIL_ADMIN_ONETIME,
  TEST_EMAIL_ADMIN_NOSTORE,
  TEST_EMAIL_ADMIN_STDOUT,
  TEST_EMAIL_ADMIN_INVALIDMAIL,
  TEST_EMAIL_ADMIN_401,
  TEST_EMAIL_ADMIN_403,
  TEST_EMAIL_ADMIN_BOUNDS,
  TEST_EMAIL_ADMIN_SHAPE,
  TEST_EMAIL_ADMIN_AUDIT,
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

/**
 * Anchored CSRF-token extractor — matches the `_csrf` hidden input directly
 * rather than the first `value="..."` of length >= 16. Future templates may
 * add other attributes that match a loose regex before the CSRF input;
 * anchoring on `name="_csrf"` keeps the test deterministic.
 */
function extractCsrfToken(html: string): string {
  const match = html.match(/<input\s+[^>]*name="_csrf"[^>]*value="([^"]+)"/);
  if (!match) throw new Error('No CSRF token in HTML');
  return match[1]!;
}

describe('web/admin-invite-create-route', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);

    await createTestUser(prisma, { email: TEST_EMAIL_USER, password: 'hunter22hunter22' });
    for (const email of [
      TEST_EMAIL_ADMIN,
      TEST_EMAIL_ADMIN_NOEMAIL,
      TEST_EMAIL_ADMIN_WITHEMAIL,
      TEST_EMAIL_ADMIN_ONETIME,
      TEST_EMAIL_ADMIN_NOSTORE,
      TEST_EMAIL_ADMIN_STDOUT,
      TEST_EMAIL_ADMIN_INVALIDMAIL,
      TEST_EMAIL_ADMIN_401,
      TEST_EMAIL_ADMIN_403,
      TEST_EMAIL_ADMIN_BOUNDS,
      TEST_EMAIL_ADMIN_SHAPE,
      TEST_EMAIL_ADMIN_AUDIT,
    ]) {
      await createTestUser(prisma, { email, password: 'hunter22hunter22' });
      await prisma.user.update({ where: { email }, data: { role: 'admin' } });
    }
  });

  beforeEach(async () => {
    await resetLoginRateLimits(redis, TEST_EMAILS);
    const ids = await getAdminIds();
    if (ids.length > 0) {
      await prisma.invite.deleteMany({ where: { createdById: { in: ids } } });
    }
  });

  async function getAdminIds(): Promise<string[]> {
    const admins = await prisma.user.findMany({
      where: { email: { in: TEST_EMAILS } },
      select: { id: true },
    });
    return admins.map((a) => a.id);
  }

  afterAll(async () => {
    const ids = await getAdminIds();
    if (ids.length > 0) {
      // Plan 10 Task 3: delete AuditEvent rows for test-admin actors BEFORE
      // cleanupTestUsers (FK onDelete: Restrict). cleanupTestUsers also
      // deletes audit-events (WC-audit-7 fix); explicit deletion is
      // defense-in-depth.
      await prisma.auditEvent.deleteMany({
        where: { actorUserId: { in: ids } },
      });
      await prisma.invite.deleteMany({ where: { createdById: { in: ids } } });
    }
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

  /** Login + return merged cookies + a fresh CSRF token. */
  async function loginAndPrepareCsrf(
    app: Awaited<ReturnType<typeof buildServer>>,
    email: string,
  ): Promise<{ cookieHeader: string; csrf: string }> {
    const get = await app.inject({ method: 'GET', url: '/login' });
    const csrf1 = extractCsrfToken(get.body as string);
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
    // GET /admin/invites to obtain a fresh CSRF token.
    const get2 = await app.inject({
      method: 'GET',
      url: '/admin/invites',
      headers: { cookie: sessCookieHeader, accept: 'text/html' },
    });
    const csrf2 = extractCsrfToken(get2.body as string);
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

  /** Login only (no CSRF token fetch). */
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
  it('POST /admin/invites (no session) -> 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/invites',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '_csrf=irrelevant',
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  // 2.
  it('POST /admin/invites (non-admin) -> 403', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_USER);
      const res = await app.inject({
        method: 'POST',
        url: '/admin/invites',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/html',
        },
        payload: '_csrf=irrelevant',
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // 3. WC-AD8 / C4-AD-PR PFLICHT: valid admin session + missing _csrf -> 403.
  it('WC-AD8 / C4-AD-PR PFLICHT: valid admin session + missing _csrf -> 403', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'POST',
        url: '/admin/invites',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        // No _csrf body, no x-csrf-token header.
        payload: 'expiresInHours=24',
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // 4. POST valid (no email, default 24h) -> 200 admin-invite-created.hbs +
  // raw token in body.
  it('POST valid (no email, default 24h) -> 200 with raw token rendered', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, TEST_EMAIL_ADMIN_NOEMAIL);
      const res = await app.inject({
        method: 'POST',
        url: '/admin/invites',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      expect(body).toMatch(/Invite link|Einladungs-Link/);
      // Raw token rendered into <code class="invite-token-secret">.
      const match = body.match(/<code class="invite-token-secret">([^<]+)<\/code>/);
      expect(match).not.toBeNull();
      expect(match![1]!.length).toBeGreaterThanOrEqual(20);
    } finally {
      await app.close();
    }
  });

  // 5. POST valid with email -> 200 + email pre-filled.
  it('POST valid with email -> 200 with email rendered on created-page', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, TEST_EMAIL_ADMIN_WITHEMAIL);
      const inviteEmail = 'invitee-1@test.invalid';
      const res = await app.inject({
        method: 'POST',
        url: '/admin/invites',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `email=${encodeURIComponent(inviteEmail)}&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(inviteEmail);
    } finally {
      await app.close();
    }
  });

  // 6. WC-AD6 PFLICHT (one-time-reveal): subsequent GET /admin/invites does
  // NOT contain the raw token.
  it('WC-AD6 PFLICHT: POST renders raw token; subsequent GET /admin/invites does NOT contain it', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, TEST_EMAIL_ADMIN_ONETIME);
      const post = await app.inject({
        method: 'POST',
        url: '/admin/invites',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(post.statusCode).toBe(200);
      const match = (post.body as string).match(
        /<code class="invite-token-secret">([^<]+)<\/code>/,
      );
      expect(match).not.toBeNull();
      const rawToken = match![1]!;
      expect(rawToken.length).toBeGreaterThanOrEqual(20);

      // Subsequent GET must NOT contain the raw token.
      const list = await app.inject({
        method: 'GET',
        url: '/admin/invites',
        headers: { cookie: cookieHeader, accept: 'text/html' },
      });
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(rawToken);
    } finally {
      await app.close();
    }
  });

  // 7. WC-AD7-eqv: Cache-Control no-store on created-page.
  it('WC-AD7-eqv: POST success -> response cache-control matches /no-store/', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, TEST_EMAIL_ADMIN_NOSTORE);
      const res = await app.inject({
        method: 'POST',
        url: '/admin/invites',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  // 8. WC-AD8-eqv (no raw-token in stdout) PFLICHT.
  it('WC-AD8-eqv PFLICHT: raw invite token never appears in stdout (LOG_LEVEL=info)', async () => {
    const captured: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: unknown,
      ...rest: unknown[]
    ) => {
      captured.push(typeof chunk === 'string' ? chunk : String(chunk));
      return (origWrite as unknown as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);
    const app = await buildServer({ ...config, LOG_LEVEL: 'info' });
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, TEST_EMAIL_ADMIN_STDOUT);
      const post = await app.inject({
        method: 'POST',
        url: '/admin/invites',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(post.statusCode).toBe(200);
      const match = (post.body as string).match(
        /<code class="invite-token-secret">([^<]+)<\/code>/,
      );
      expect(match).not.toBeNull();
      const rawToken = match![1]!;

      const allStdout = captured.join('');
      // C5-PR: audit-log markers PRESENT.
      expect(allStdout).toMatch(/"action":"invite_create"/);
      expect(allStdout).toMatch(/"adminId":"[^"]+"/);
      expect(allStdout).toMatch(/"inviteId":"[^"]+"/);
      // C2-PR: raw token NOT in stdout.
      expect(allStdout).not.toContain(rawToken);
    } finally {
      stdoutSpy.mockRestore();
      await app.close();
    }
  });

  // 9. POST invalid email format -> 400 + list-page re-render with error flash.
  // Concern #6: rerendered list must NOT be empty (list is re-fetched via
  // inner GET /api/v1/admin/invites). We seed an active invite first and
  // assert it appears in the rerendered HTML — proving re-fetch happened.
  it('POST invalid email format -> 400 + list re-render with error flash + re-fetched rows visible', async () => {
    const app = await buildServer(config);
    try {
      // Seed an active invite under TEST_EMAIL_ADMIN_INVALIDMAIL so the
      // rerendered list is not empty.
      const adminUser = await prisma.user.findUnique({
        where: { email: TEST_EMAIL_ADMIN_INVALIDMAIL },
        select: { id: true },
      });
      const seededEmail = 'rerender-row@test.invalid';
      const future = new Date(Date.now() + 24 * 3600_000);
      await prisma.invite.create({
        data: {
          token: 'e'.repeat(64),
          email: seededEmail,
          createdById: adminUser!.id,
          expiresAt: future,
        },
      });

      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, TEST_EMAIL_ADMIN_INVALIDMAIL);
      const res = await app.inject({
        method: 'POST',
        url: '/admin/invites',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `email=not-an-email&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/flash flash-error/);
      // Form is re-rendered in the list page.
      expect(res.body).toMatch(/<form[^>]+action="\/admin\/invites"/);
      // Concern #6: seeded row appears in the rerendered list (not empty).
      expect(res.body).toContain(seededEmail);
    } finally {
      await app.close();
    }
  });

  // Concern #1: BFF expiresInHours bounds match Plan-7 inner PostBody (drift
  // detection). If Plan-7's inner schema changes, update both sides + this
  // test. The BFF MUST NOT be more permissive than Plan-7's inner PostBody.
  // BFF rejects with 400 BEFORE the inner is reached.
  it('expiresInHours bounds match Plan-7 inner PostBody (drift detection)', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, TEST_EMAIL_ADMIN_BOUNDS);
      for (const bad of ['0', '169', '-1']) {
        const res = await app.inject({
          method: 'POST',
          url: '/admin/invites',
          headers: {
            cookie: cookieHeader,
            'content-type': 'application/x-www-form-urlencoded',
            'x-csrf-token': csrf,
          },
          payload: `_csrf=${encodeURIComponent(csrf)}&expiresInHours=${bad}`,
        });
        expect(res.statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  // Concern #2: inner-201 response shape mismatch -> 500 + error log.
  // Mocks app.inject to return a 201 WITHOUT the `token` field. The BFF must
  // detect contract drift via Zod, log app.log.error, and return 500 rather
  // than rendering an empty <code> element.
  it('inner POST 201 with missing token -> 500 + error log (contract-drift detection)', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, TEST_EMAIL_ADMIN_SHAPE);

      const errorLogSpy = vi.spyOn(app.log, 'error');
      const originalInject = app.inject.bind(app);
      const fakeInject = ((opts: unknown) => {
        const isInnerPost =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'POST' &&
          (opts as { url?: string }).url === '/api/v1/admin/invites';
        if (isInnerPost) {
          // 201 WITHOUT token field -- simulates contract drift.
          return Promise.resolve({
            statusCode: 201,
            headers: {},
            body: '',
            payload: '',
            rawPayload: Buffer.alloc(0),
            cookies: [],
            json: () => ({
              id: '11111111-1111-4111-8111-111111111111',
              email: null,
              expiresAt: new Date().toISOString(),
              // token: MISSING
            }),
            trailers: {},
          });
        }
        return (originalInject as (o: unknown) => unknown)(opts);
      }) as unknown as typeof app.inject;
      const injectSpy = vi.spyOn(app, 'inject').mockImplementation(fakeInject);

      const res = await originalInject({
        method: 'POST',
        url: '/admin/invites',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(500);
      // app.log.error called with action: 'invite_create' + innerError marker.
      expect(errorLogSpy).toHaveBeenCalled();
      const errorCalls = errorLogSpy.mock.calls;
      const found = errorCalls.some((args) => {
        const meta = args[0] as { action?: unknown; innerError?: unknown } | undefined;
        return meta?.action === 'invite_create' && typeof meta?.innerError === 'string';
      });
      expect(found).toBe(true);

      injectSpy.mockRestore();
      errorLogSpy.mockRestore();
    } finally {
      await app.close();
    }
  });

  // 10. Inner-401 (mock) -> 303 to /login + clearCookie.
  it('inner POST 401 -> 303 to /login + mc_session cleared', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, TEST_EMAIL_ADMIN_401);

      const originalInject = app.inject.bind(app);
      const fakeInject = ((opts: unknown) => {
        const isInnerPost =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'POST' &&
          (opts as { url?: string }).url === '/api/v1/admin/invites';
        if (isInnerPost) {
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
        url: '/admin/invites',
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
        cookies.some((c) => c?.startsWith('mc_session=') && /Max-Age=0|Expires=/.test(c)),
      ).toBe(true);

      injectSpy.mockRestore();
    } finally {
      await app.close();
    }
  });

  // 11. Inner-403 (mock) -> 303 csrf-stale.
  it('inner POST 403 -> 303 /admin/invites?updateflash=csrf-stale', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, TEST_EMAIL_ADMIN_403);

      const originalInject = app.inject.bind(app);
      const fakeInject = ((opts: unknown) => {
        const isInnerPost =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'POST' &&
          (opts as { url?: string }).url === '/api/v1/admin/invites';
        if (isInnerPost) {
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
        url: '/admin/invites',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/admin/invites?updateflash=csrf-stale');
      // mc_session NOT cleared (CSRF rotation race; session valid).
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

  // Plan 8f Task 2 PFLICHT (WC-i18n-f-task2 / WC-i18n-f18 — Format-Style
  // Discipline, detail-view variant): the admin-invite-created.hbs <dd>
  // expiresAt cell migrated from raw `{{invite.expiresAt}}` ISO-rendering to
  // `{{formatDateTime invite.expiresAt style="long"}}`. With `mc_locale=de`
  // the cell MUST render a DE long-month-name format like
  // `15. Mai 2026 um 10:00` (D. Monat YYYY um HH:MM), NOT raw ISO and NOT
  // the EN format `at 10:00 AM`. The assertion is pattern-based (matches any
  // DE month-name) because expiresAt = now+expiresInHours is non-deterministic
  // by exact date; the FORMAT-shape is the contract under test.
  it('PFLICHT WC-i18n-f-task2: POST /admin/invites with mc_locale=de renders expiresAt in DE long format on admin-invite-created (formatDateTime style="long")', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, TEST_EMAIL_ADMIN_NOEMAIL);
      // Append mc_locale=de to the cookie-header for this request so the
      // detail-view rendering resolves DE locale through @root._locale.
      const cookieWithLocale = `${cookieHeader}; mc_locale=de`;
      const res = await app.inject({
        method: 'POST',
        url: '/admin/invites',
        headers: {
          cookie: cookieWithLocale,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // DE long-month-name format: e.g. "15. Mai 2026 um 10:00".
      // Pattern-assert any DE month name (Intl.DateTimeFormat 'de' +
      // dateStyle:'long' + timeStyle:'short' output).
      expect(body).toMatch(
        /\d{1,2}\. (Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember) \d{4} um \d{2}:\d{2}/,
      );
      // EN long format MUST NOT leak (would indicate locale-fallback bug).
      // Note: \s also matches U+202F (NARROW NO-BREAK SPACE) used by
      // Intl.DateTimeFormat for the AM/PM separator in Node 18+/ICU 73+.
      // Don't replace \s with a literal space — newer Node would slip past.
      expect(body).not.toMatch(
        /(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4} at \d{1,2}:\d{2}\s*(AM|PM)/,
      );
      // Canonical ISO MUST remain in the <time datetime="..."> attribute.
      expect(body).toMatch(/<time[^>]+datetime="[0-9T:.\-Z]+">/);
    } finally {
      await app.close();
    }
  });

  // PFLICHT Plan-10 Task-3: AuditEvent row written on successful invite_create.
  // Defense-in-depth: assert payload contains expiresAt AND lacks `token`
  // (FORBIDDEN_PAYLOAD_KEYS would already throw, but the route's whitelist
  // payload (`{ expiresAt }`) is the primary defense — proven here).
  it('PFLICHT Plan-10 Task-3: writes AuditEvent row on successful invite_create with whitelisted payload (no token)', async () => {
    const app = await buildServer(config);
    let adminId: string | undefined;
    try {
      const adminUser = await prisma.user.findUnique({
        where: { email: TEST_EMAIL_ADMIN_AUDIT },
        select: { id: true },
      });
      adminId = adminUser!.id;
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(app, TEST_EMAIL_ADMIN_AUDIT);
      const post = await app.inject({
        method: 'POST',
        url: '/admin/invites',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(post.statusCode).toBe(200);
      // Invite has no createdAt column; find via createdById. beforeEach
      // deletes prior invites so we explicitly assert exactly ONE row exists
      // for this admin — guards against future drift where the cleanup
      // invariant weakens and `findFirst` would silently pick an arbitrary
      // row.
      const inviteCount = await prisma.invite.count({
        where: { createdById: adminId },
      });
      expect(inviteCount).toBe(1);
      const newest = await prisma.invite.findFirstOrThrow({
        where: { createdById: adminId },
        select: { id: true },
      });

      // No `take: 1` here — `toHaveLength(1)` surfaces accidental duplicate
      // audit-writes loudly instead of silently masking them via a limit.
      const events = await prisma.auditEvent.findMany({
        where: {
          actorUserId: adminId,
          action: 'invite_create',
          targetId: newest.id,
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'invite_create',
        targetType: 'invite',
        targetId: newest.id,
      });
      // Whitelist enforcement: payload has `expiresAt`, NO `token`.
      expect(events[0]!.payload).not.toHaveProperty('token');
      expect(events[0]!.payload).toMatchObject({
        expiresAt: expect.any(String),
      });
    } finally {
      if (adminId) {
        await prisma.auditEvent.deleteMany({
          where: { actorUserId: adminId },
        });
        await prisma.invite.deleteMany({ where: { createdById: adminId } });
      }
      await app.close();
    }
  });
});
