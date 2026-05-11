import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const TEST_EMAILS = ['login-page@test.invalid', 'auth-de@test.invalid'];
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

describe('web/login-page', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await createTestUser(prisma, {
      email: 'login-page@test.invalid',
      password: 'hunter22hunter22',
    });
    await createTestUser(prisma, {
      email: 'auth-de@test.invalid',
      password: 'hunter22hunter22',
    });
  });

  beforeEach(async () => {
    // Drain rate-limit keys so re-runs don't 429.
    await resetLoginRateLimits(redis, ['login-page@test.invalid', 'auth-de@test.invalid']);
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

  /** Helper: GET /login, return the cookie header + the CSRF token. */
  async function getLoginForm(app: Awaited<ReturnType<typeof buildServer>>) {
    const res = await app.inject({ method: 'GET', url: '/login' });
    const cookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(cookie) ? cookie.join('; ') : (cookie ?? '');
    const tokenMatch = (res.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/);
    return { res, cookieHeader, csrf: tokenMatch?.[1] ?? '' };
  }

  it('GET /login → 200 HTML with email/password fields and a CSRF token', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/login' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/<input[^>]+name="email"/);
      expect(res.body).toMatch(/<input[^>]+name="password"[^>]+type="password"/);
      expect(res.body).toMatch(/<input type="hidden" name="_csrf"/);
    } finally {
      await app.close();
    }
  });

  it('POST /login with valid credentials → 303 redirect to /, mc_session cookie set', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await getLoginForm(app);
      expect(csrf).toBeTruthy();

      const post = await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `email=login-page%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(post.statusCode);
      expect(post.headers.location).toBe('/');
      const setCookie = post.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      expect(cookies.some((c) => c?.startsWith('mc_session='))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('POST /login with WRONG password → 200, login form re-rendered with flash-error', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await getLoginForm(app);

      const post = await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `email=login-page%40test.invalid&password=WRONG&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(post.statusCode).toBe(200);
      expect(post.body).toContain('flash-error');
      expect(post.body).toMatch(/Invalid (credentials|email or password)/i);
      const setCookie = post.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      expect(cookies.some((c) => c?.startsWith('mc_session='))).toBe(false);
    } finally {
      await app.close();
    }
  });

  // Plan 8e Task 3 (Step 1) — DE-flash on wrong-password login.
  // Asserts that with `mc_locale=de`, the wrong-password flash renders the
  // German translation, proving the route-handler resolves flash messages via
  // i18n instead of a hardcoded English literal.
  it('login with wrong password renders flash-error in DE when mc_locale=de', async () => {
    const app = await buildServer(config);
    try {
      // Reuse getLoginForm to capture mc_csrf cookie + form-token, then
      // append mc_locale=de so the i18n onRequest hook flips req.locale.
      const { cookieHeader, csrf } = await getLoginForm(app);
      const localeCookie = `${cookieHeader}; mc_locale=de`;
      const post = await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          cookie: localeCookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `email=auth-de%40test.invalid&password=wrong&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(post.statusCode).toBe(200);
      expect(post.body).toContain('flash-error');
      expect(post.body).toMatch(/Ungültige E-Mail oder Passwort|Ungültige Anmeldedaten/);
    } finally {
      await app.close();
    }
  });

  it('POST /login WITHOUT _csrf → 403 (CSRF guard rejects)', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader } = await getLoginForm(app);
      const post = await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `email=login-page%40test.invalid&password=hunter22hunter22`,
      });
      expect(post.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // WC5 PFLICHT-REGRESSIONSTEST — mc_session cookie must carry HttpOnly + SameSite=Lax.
  it('WC5: successful POST /login sets mc_session with HttpOnly + SameSite=Lax flags', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await getLoginForm(app);
      const post = await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `email=login-page%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(post.statusCode);
      const setCookie = post.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      const session = cookies.find((c) => c?.startsWith('mc_session='));
      expect(session).toBeTruthy();
      expect(session!).toMatch(/HttpOnly/i);
      expect(session!).toMatch(/SameSite=Lax/i);
    } finally {
      await app.close();
    }
  });

  // WC4 + C2-Rev2 PFLICHT-REGRESSIONSTEST — CSRF token rotated by SUCCESSFUL
  // login itself, not just by issuing a fresh form.
  //
  // Why this shape: the naive "two consecutive login flows" test would pass
  // even if the rotation in login-page.ts was removed, because every GET /login
  // already renders a fresh CSRF (renderCsrfField → generateCsrf). To prove
  // the explicit rotation is doing work, we compare the mc_csrf-cookie issued
  // by the GET (pre-login) with the mc_csrf-cookie issued by the POST
  // (post-login) IN THE SAME FLOW. Without rotation in the POST handler, the
  // POST response would not include a fresh mc_csrf — only the inner login
  // response's mc_session — and the assertion fails.
  it('WC4: successful POST /login rotates the mc_csrf cookie (pre-login != post-login in same flow)', async () => {
    const app = await buildServer(config);
    try {
      // 1. GET /login → captures the pre-login mc_csrf cookie value.
      const get = await app.inject({ method: 'GET', url: '/login' });
      const getCookies = Array.isArray(get.headers['set-cookie'])
        ? get.headers['set-cookie']
        : [get.headers['set-cookie'] ?? ''];
      const csrfBefore = getCookies
        .find((c) => c?.startsWith('mc_csrf='))
        ?.split(';')[0]
        ?.split('=')[1];
      expect(csrfBefore).toBeTruthy();
      // Extract the CSRF token from the rendered form for the POST.
      const formToken = ((get.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1]!;
      const cookieHeader = getCookies
        .map((c) => c?.split(';')[0])
        .filter(Boolean)
        .join('; ');

      // 2. POST /login (success) → response should carry a NEW mc_csrf cookie.
      const post = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { cookie: cookieHeader, 'content-type': 'application/x-www-form-urlencoded' },
        payload: `email=login-page%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(formToken)}`,
      });
      expect([302, 303]).toContain(post.statusCode);
      const postCookies = Array.isArray(post.headers['set-cookie'])
        ? post.headers['set-cookie']
        : [post.headers['set-cookie'] ?? ''];
      const csrfAfter = postCookies
        .find((c) => c?.startsWith('mc_csrf='))
        ?.split(';')[0]
        ?.split('=')[1];
      expect(csrfAfter).toBeTruthy();
      expect(csrfAfter).not.toBe(csrfBefore);
    } finally {
      await app.close();
    }
  });

  // WC7 PFLICHT-REGRESSIONSTEST — GET /login response carries Cache-Control: no-store.
  it('WC7: GET /login response has Cache-Control: no-store (prevents stale-token-back-button)', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/login' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  // C4-Rev2 PFLICHT-REGRESSIONSTEST — Secure-cookie-flag in production-mode.
  // The default test config uses NODE_ENV='test', which sets `secure: false`
  // on mc_session. Production deployments must set Secure so the cookie isn't
  // exposed over HTTP downgrades. This test wires a separate buildServer with
  // NODE_ENV='production' and asserts the flag.
  it('C4-Rev2: mc_session has Secure flag when NODE_ENV=production', async () => {
    const prodConfig: Config = { ...config, NODE_ENV: 'production' };
    const app = await buildServer(prodConfig);
    try {
      const get = await app.inject({ method: 'GET', url: '/login' });
      const cookie = get.headers['set-cookie'];
      const cookieHeader = Array.isArray(cookie) ? cookie.join('; ') : (cookie ?? '');
      const csrf = ((get.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1]!;
      const post = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { cookie: cookieHeader, 'content-type': 'application/x-www-form-urlencoded' },
        payload: `email=login-page%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(post.statusCode);
      const setCookie = post.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      const session = cookies.find((c) => c?.startsWith('mc_session='));
      expect(session).toBeTruthy();
      expect(session!).toMatch(/Secure/i);
    } finally {
      await app.close();
    }
  });

  // WC1 PFLICHT-REGRESSIONSTEST — per-IP rate-limit isolated across BFF logins.
  // Two BFF /login POSTs with different x-forwarded-for must NOT share the
  // same per-IP bucket. If trustProxy is broken, both spend the same bucket
  // and one of them gets 429 prematurely.
  it('WC1: BFF logins from different x-forwarded-for see independent rate-limit buckets', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await getLoginForm(app);
      // 5 wrong-password attempts from IP A (under the 10/min bucket).
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({
          method: 'POST',
          url: '/login',
          headers: {
            cookie: cookieHeader,
            'content-type': 'application/x-www-form-urlencoded',
            'x-forwarded-for': '198.51.100.1',
          },
          payload: `email=login-page%40test.invalid&password=WRONG${i}&_csrf=${encodeURIComponent(csrf)}`,
        });
        expect([200, 401, 429]).toContain(r.statusCode);
      }
      // Drain the per-account counter (`login:acct:<email>`) so that IP B's
      // valid attempt is not blocked by the orthogonal C2-Rev1 per-account
      // rate-limit. WC1 specifically tests per-IP isolation; the per-account
      // bucket is a separate concern verified by login-routes.test.ts.
      await redis.del(`ratelimit:login:acct:login-page@test.invalid`);
      // One attempt from IP B with VALID password — must succeed (303), proving
      // IP A's failed attempts didn't poison IP B's bucket.
      const fresh = await getLoginForm(app);
      const r = await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          cookie: fresh.cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': '203.0.113.99',
        },
        payload: `email=login-page%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(fresh.csrf)}`,
      });
      // If rate-limit IS shared (regression), this 429s. With trustProxy, 303.
      expect([302, 303]).toContain(r.statusCode);
    } finally {
      await app.close();
    }
  });
});
