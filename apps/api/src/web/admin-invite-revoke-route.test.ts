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

const TEST_EMAIL_USER = 'admin-invite-revoke-user@test.invalid';
const TEST_EMAIL_ADMIN_NOCSRF = 'admin-invite-revoke-nocsrf@test.invalid';
const TEST_EMAIL_ADMIN_OK = 'admin-invite-revoke-ok@test.invalid';
const TEST_EMAIL_ADMIN_404 = 'admin-invite-revoke-404@test.invalid';
const TEST_EMAIL_ADMIN_403 = 'admin-invite-revoke-403@test.invalid';
const TEST_EMAILS = [
  TEST_EMAIL_USER,
  TEST_EMAIL_ADMIN_NOCSRF,
  TEST_EMAIL_ADMIN_OK,
  TEST_EMAIL_ADMIN_404,
  TEST_EMAIL_ADMIN_403,
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

describe('web/admin-invite-revoke-route', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);

    await createTestUser(prisma, { email: TEST_EMAIL_USER, password: 'hunter22hunter22' });
    for (const email of [
      TEST_EMAIL_ADMIN_NOCSRF,
      TEST_EMAIL_ADMIN_OK,
      TEST_EMAIL_ADMIN_404,
      TEST_EMAIL_ADMIN_403,
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
    const get2 = await app.inject({
      method: 'GET',
      url: '/admin/invites',
      headers: { cookie: sessCookieHeader, accept: 'text/html' },
    });
    const csrf2 = extractCsrfToken(get2.body as string);
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

  /** Login only -- no CSRF token. */
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
  it('POST /admin/invites/:id/revoke (no session) -> 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await app.inject({
        method: 'POST',
        url: `/admin/invites/${fakeId}/revoke`,
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
  it('POST /admin/invites/:id/revoke (non-admin) -> 403', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_USER);
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await app.inject({
        method: 'POST',
        url: `/admin/invites/${fakeId}/revoke`,
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

  // 3. WC-AD8 / C4-AD-PR PFLICHT.
  it('WC-AD8 / C4-AD-PR PFLICHT: valid admin session + missing _csrf -> 403', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_NOCSRF);
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await app.inject({
        method: 'POST',
        url: `/admin/invites/${fakeId}/revoke`,
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        // No _csrf, no x-csrf-token.
        payload: '',
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // 4. POST valid (existing active invite) -> 303 + invite gone.
  it('POST valid -> 303 to /admin/invites?updateflash=revoked + invite removed from DB', async () => {
    const app = await buildServer(config);
    try {
      const adminUser = await prisma.user.findUnique({
        where: { email: TEST_EMAIL_ADMIN_OK },
        select: { id: true },
      });
      const future = new Date(Date.now() + 24 * 3600_000);
      const created = await prisma.invite.create({
        data: {
          token: 'd'.repeat(64),
          email: 'invitee-revoke@test.invalid',
          createdById: adminUser!.id,
          expiresAt: future,
        },
      });

      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        TEST_EMAIL_ADMIN_OK,
      );
      const res = await app.inject({
        method: 'POST',
        url: `/admin/invites/${created.id}/revoke`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/admin/invites?updateflash=revoked');

      const remaining = await prisma.invite.findUnique({
        where: { id: created.id },
        select: { id: true },
      });
      expect(remaining).toBeNull();
    } finally {
      await app.close();
    }
  });

  // 5. POST nonexistent invite -> 404 page rendered.
  it('POST nonexistent invite -> 404 page', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        TEST_EMAIL_ADMIN_404,
      );
      const fakeId = '11111111-1111-4111-8111-111111111111';
      const res = await app.inject({
        method: 'POST',
        url: `/admin/invites/${fakeId}/revoke`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
          accept: 'text/html',
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // 6. (optional) inner-403 -> 303 csrf-stale.
  it('inner DELETE 403 -> 303 /admin/invites?updateflash=csrf-stale', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        TEST_EMAIL_ADMIN_403,
      );

      const originalInject = app.inject.bind(app);
      const fakeInject = ((opts: unknown) => {
        const isInnerDelete =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'DELETE' &&
          typeof (opts as { url?: string }).url === 'string' &&
          (opts as { url: string }).url.startsWith('/api/v1/admin/invites/');
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

      const fakeId = '22222222-2222-4222-8222-222222222222';
      const res = await originalInject({
        method: 'POST',
        url: `/admin/invites/${fakeId}/revoke`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/admin/invites?updateflash=csrf-stale');
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
