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
  'apikey-create@test.invalid',
  'apikey-create-flash@test.invalid',
  'apikey-create-stdout@test.invalid',
  'apikey-create-csrf-stale@test.invalid',
  'apikey-create-401@test.invalid',
  'apikey-create-empty@test.invalid',
  'apikey-create-toolong@test.invalid',
  'apikey-create-c5@test.invalid',
  'apikey-create-wcpr3@test.invalid',
  'apikey-create-de@test.invalid',
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

describe('web/api-key-create-route', () => {
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
    const users = await prisma.user.findMany({
      where: { email: { in: TEST_EMAILS } },
      select: { id: true },
    });
    if (users.length > 0) {
      await prisma.apiKey.deleteMany({
        where: { userId: { in: users.map((u) => u.id) } },
      });
    }
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { in: TEST_EMAILS } },
      select: { id: true },
    });
    if (users.length > 0) {
      await prisma.apiKey.deleteMany({
        where: { userId: { in: users.map((u) => u.id) } },
      });
    }
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
    // GET /profile/api-keys/new again to obtain a fresh CSRF token.
    const get2 = await app.inject({
      method: 'GET',
      url: '/profile/api-keys/new',
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

  // 1.
  it('GET /profile/api-keys/new (no session) → 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/profile/api-keys/new' });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  // 2.
  it('GET /profile/api-keys/new (session) → 200 with form + name input + scopes hint', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader } = await loginAndPrepareCsrf(app, 'apikey-create@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile/api-keys/new',
        headers: { cookie: cookieHeader, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/<input[^>]+name="name"/);
      // Pre-Flight: scopes are server-side hardcoded; the form just hints them.
      expect(res.body).toContain('jobs:read');
      expect(res.body).toContain('jobs:write');
      // Form posts to /profile/api-keys.
      expect(res.body).toMatch(/action="\/profile\/api-keys"/);
    } finally {
      await app.close();
    }
  });

  // 3.
  it('POST /profile/api-keys (valid) → 200 with api-key-created page containing the FULL key', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'apikey-create@test.invalid',
      );
      const res = await app.inject({
        method: 'POST',
        url: '/profile/api-keys',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `name=test-key&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/API key created/);
      // Raw key rendered.
      const match = (res.body as string).match(
        /<code class="api-key-secret">([^<]+)<\/code>/,
      );
      expect(match).not.toBeNull();
      expect(match![1]!.length).toBeGreaterThanOrEqual(30);
    } finally {
      await app.close();
    }
  });

  // 4. WC-PR3 PFLICHT — one-time-reveal: POST contains the raw key, but
  // subsequent GET /profile/api-keys does NOT contain its suffix.
  it('WC-PR3: POST renders raw key; subsequent GET /profile/api-keys does NOT contain the suffix', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'apikey-create-wcpr3@test.invalid',
      );
      const post = await app.inject({
        method: 'POST',
        url: '/profile/api-keys',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `name=wcpr3-key&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(post.statusCode).toBe(200);
      const match = (post.body as string).match(
        /<code class="api-key-secret">([^<]+)<\/code>/,
      );
      expect(match).not.toBeNull();
      const rawKey = match![1]!;
      // Plan-4 format: mc_<prefix-8>_<random-32>. Suffix is the random tail.
      const suffix = rawKey.split('_').slice(2).join('_');
      expect(suffix.length).toBeGreaterThanOrEqual(20);

      // Now GET /profile/api-keys — list page must NOT contain the suffix.
      const list = await app.inject({
        method: 'GET',
        url: '/profile/api-keys',
        headers: { cookie: cookieHeader, accept: 'text/html' },
      });
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(suffix);
      expect(list.body).not.toContain(rawKey);
    } finally {
      await app.close();
    }
  });

  // 5.
  it('POST /profile/api-keys (no _csrf) → 403', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader } = await loginAndPrepareCsrf(app, 'apikey-create@test.invalid');
      const res = await app.inject({
        method: 'POST',
        url: '/profile/api-keys',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `name=no-csrf-key`,
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // 6. Empty name → 400 + form re-rendered with flash.
  it('POST /profile/api-keys (empty name) → 400 + flash matching /Name is required/', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'apikey-create-empty@test.invalid',
      );
      const res = await app.inject({
        method: 'POST',
        url: '/profile/api-keys',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `name=&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/Name is required/);
      expect(res.body).toMatch(/<input[^>]+name="name"/);
    } finally {
      await app.close();
    }
  });

  // 7. Name > 64 chars → 400 + flash (replaces C4-PR scopes-test per Pre-Flight).
  it('POST /profile/api-keys (name > 64 chars) → 400 + flash matching /Name is required/', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'apikey-create-toolong@test.invalid',
      );
      const longName = 'x'.repeat(65);
      const res = await app.inject({
        method: 'POST',
        url: '/profile/api-keys',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `name=${longName}&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/Name is required/);
    } finally {
      await app.close();
    }
  });

  // 8. C6-LI-equivalent — inner POST 403 (CSRF stale) → 303 to
  // /profile/api-keys/new?createflash=csrf-stale, mc_session preserved.
  it('C6-LI-equivalent: inner POST 403 → 303 createflash=csrf-stale, mc_session preserved', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'apikey-create-csrf-stale@test.invalid',
      );

      const originalInject = app.inject.bind(app);
      const fakeInject = ((opts: unknown) => {
        const isInnerPost =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'POST' &&
          (opts as { url?: string }).url === '/api/v1/users/me/api-keys';
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
        url: '/profile/api-keys',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `name=stale-csrf-key&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/profile/api-keys/new?createflash=csrf-stale');

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

  // 9. Session-race — inner POST 401 → 303 to /login + clearCookie.
  it('Session-race: inner POST 401 → 303 to /login + mc_session cleared', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'apikey-create-401@test.invalid',
      );

      const originalInject = app.inject.bind(app);
      const fakeInject = ((opts: unknown) => {
        const isInnerPost =
          typeof opts === 'object' &&
          opts !== null &&
          'method' in opts &&
          'url' in opts &&
          (opts as { method?: string }).method === 'POST' &&
          (opts as { url?: string }).url === '/api/v1/users/me/api-keys';
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
        url: '/profile/api-keys',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `name=session-race-key&_csrf=${encodeURIComponent(csrf)}`,
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

  // 10. C1-PR PFLICHT — anti-cache on one-time-reveal page.
  it('C1-PR: POST success → response cache-control matches /no-store/', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'apikey-create@test.invalid',
      );
      const res = await app.inject({
        method: 'POST',
        url: '/profile/api-keys',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `name=cache-test-key&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  // 11. C2-PR PFLICHT — raw API key never appears in stdout (LOG_LEVEL=info,
  // production-realistic). C6-PR Round-2: spy on process.stdout.write directly
  // (catches Pino's internal serializer paths that bypass app.log.X-method
  // spies).
  it('C2-PR: raw API key never appears in stdout (LOG_LEVEL=info, production-realistic)', async () => {
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
    const app = await buildServer({ ...config, LOG_LEVEL: 'info' });
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'apikey-create-stdout@test.invalid',
      );
      const post = await app.inject({
        method: 'POST',
        url: '/profile/api-keys',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `name=stdout-key&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(post.statusCode).toBe(200);
      const match = (post.body as string).match(
        /<code class="api-key-secret">([^<]+)<\/code>/,
      );
      expect(match).not.toBeNull();
      const rawKey = match![1]!;
      const allStdout = captured.join('');
      expect(allStdout).not.toContain(rawKey);
      expect(allStdout).not.toMatch(/mc_[a-z0-9]{8}_[A-Za-z0-9_-]{32,}/);
    } finally {
      stdoutSpy.mockRestore();
      await app.close();
    }
  });

  // 12. C3-PR PFLICHT — createflash allowlist gate.
  it('C3-PR: GET /profile/api-keys/new?createflash=evil-marker-create does NOT render the marker', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader } = await loginAndPrepareCsrf(
        app,
        'apikey-create-flash@test.invalid',
      );
      const res = await app.inject({
        method: 'GET',
        url: '/profile/api-keys/new?createflash=evil-marker-create',
        headers: { cookie: cookieHeader, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('evil-marker-create');
    } finally {
      await app.close();
    }
  });

  // 13. C5-PR PFLICHT — rendered key non-empty (loose regex per C8-PR).
  it('C5-PR: POST success → body contains <code class="api-key-secret">[A-Za-z0-9_-]{30,}</code>', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'apikey-create-c5@test.invalid',
      );
      const res = await app.inject({
        method: 'POST',
        url: '/profile/api-keys',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `name=c5-key&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(
        /<code class="api-key-secret">[A-Za-z0-9_-]{30,}<\/code>/,
      );
    } finally {
      await app.close();
    }
  });

  // 14. Plan 8e Task 6 Step 1: DE-render PFLICHT — POST with mc_locale=de
  // renders the api-key-created (one-time-reveal) page in German. Asserts
  // the full create-flow respects the locale cookie end-to-end (template
  // migration + req.t in the handler must both be wired up).
  it('POST /profile/api-keys with mc_locale=de renders DE one-time-reveal page', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await loginAndPrepareCsrf(
        app,
        'apikey-create-de@test.invalid',
      );
      // Append mc_locale=de to the cookie header — detectLocale() reads the
      // mc_locale cookie before falling back to Accept-Language.
      const cookieWithLocale = `${cookieHeader}; mc_locale=de`;
      const res = await app.inject({
        method: 'POST',
        url: '/profile/api-keys',
        headers: {
          cookie: cookieWithLocale,
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        payload: `name=de-test-key&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(200);
      // DE strings from apps/api/locales/de/profile.json: heading
      // "API-Schlüssel erstellt" and warning "Schlüssel jetzt kopieren".
      expect(res.body).toMatch(/API-Schlüssel erstellt|Schlüssel jetzt kopieren/);
      // Sanity: the EN heading must NOT appear (would mean locale-fallback to EN).
      expect(res.body).not.toMatch(/<h1>API key created<\/h1>/);
    } finally {
      await app.close();
    }
  });
});
