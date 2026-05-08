import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import {
  TEST_API_KEY_PEPPER,
  TEST_SESSION_SECRET,
  TEST_CSRF_SECRET,
  testDatabaseUrl,
  testRedisUrl,
} from '@mediacompressor/test-helpers';
import IORedis from 'ioredis';
import { buildServer } from '../server.js';
import type { Config } from '../config.js';
import { pickRedirectTarget } from './locale-route.js';

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

describe('web/locale-route', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  /**
   * Issues a GET /login to obtain an mc_csrf cookie and a CSRF token suitable
   * for the next POST. POST /locale does NOT require an authenticated session
   * (the locale-switcher is also reachable from /login itself), so a session
   * cookie is intentionally omitted here.
   */
  async function getCsrfPair(
    app: Awaited<ReturnType<typeof buildServer>>,
  ): Promise<{ cookieHeader: string; csrf: string }> {
    const get = await app.inject({ method: 'GET', url: '/login' });
    const csrf = ((get.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1]!;
    const setCookie = get.headers['set-cookie'];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
      .map((c) => c?.split(';')[0])
      .filter(Boolean)
      .join('; ');
    return { cookieHeader, csrf };
  }

  it('POST /locale WITHOUT _csrf -> 403', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader } = await getCsrfPair(app);
      const res = await app.inject({
        method: 'POST',
        url: '/locale',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: 'locale=de',
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('POST /locale {locale: "de"} -> 303 to /, mc_locale=de cookie set with correct flags', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await getCsrfPair(app);
      const res = await app.inject({
        method: 'POST',
        url: '/locale',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `locale=de&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/');
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      const localeCookie = cookies.find((c) => c?.startsWith('mc_locale='));
      expect(localeCookie).toBeTruthy();
      expect(localeCookie).toMatch(/^mc_locale=de\b/);
      expect(localeCookie).toMatch(/Path=\//);
      expect(localeCookie).toMatch(/SameSite=Lax/i);
      expect(localeCookie).toMatch(/Max-Age=\d+/i);
      // NODE_ENV=test → cookie MUST NOT carry the Secure flag (would break in
      // dev over plain http).
      expect(localeCookie).not.toMatch(/;\s*Secure/i);
      // httpOnly: false (a future client-side i18n layer needs to read it).
      expect(localeCookie).not.toMatch(/HttpOnly/i);
    } finally {
      await app.close();
    }
  });

  it('POST /locale {locale: "fr"} -> 400 (Zod-rejected, not in SUPPORTED_LOCALES)', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await getCsrfPair(app);
      const res = await app.inject({
        method: 'POST',
        url: '/locale',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `locale=fr&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /locale {locale: "de", redirectTo: "/profile"} -> 303 to /profile (allowlist hit)', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await getCsrfPair(app);
      const res = await app.inject({
        method: 'POST',
        url: '/locale',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `locale=de&redirectTo=${encodeURIComponent('/profile')}&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/profile');
    } finally {
      await app.close();
    }
  });

  // WC-AD2 PFLICHT: open-redirect protection for the `redirectTo` body field.
  // Three attack vectors that MUST all fall back to the safe default `/`:
  //   1. Absolute URL with scheme        → `https://evil.example.com/phish`
  //   2. Protocol-relative URL           → `//evil.example.com/`
  //   3. Path-traversal                  → `/admin/../etc/passwd`
  // If any of these were echoed back into the Location header, the locale-
  // switcher would become a phishing pivot. The implementation uses
  // pickRedirectTarget() which returns one of six string-literal allowlist
  // members, so static taint-analysis can verify the property without
  // running the test — but the integration test belt-and-braces it.
  it('WC-AD2 PFLICHT: redirectTo "https://evil.example.com/phish" -> falls back to /', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await getCsrfPair(app);
      const res = await app.inject({
        method: 'POST',
        url: '/locale',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `locale=de&redirectTo=${encodeURIComponent('https://evil.example.com/phish')}&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/');
      // Sanity: location is NEVER the attacker host or any substring of it.
      expect(res.headers.location).not.toMatch(/evil\.example\.com/);
    } finally {
      await app.close();
    }
  });

  it('WC-AD2 PFLICHT: redirectTo "//evil.example.com/" (protocol-relative) -> falls back to /', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await getCsrfPair(app);
      const res = await app.inject({
        method: 'POST',
        url: '/locale',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `locale=de&redirectTo=${encodeURIComponent('//evil.example.com/')}&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/');
      expect(res.headers.location).not.toMatch(/evil\.example\.com/);
    } finally {
      await app.close();
    }
  });

  it('WC-AD2 PFLICHT: redirectTo "/admin/../etc/passwd" (path-traversal) -> falls back to /', async () => {
    const app = await buildServer(config);
    try {
      const { cookieHeader, csrf } = await getCsrfPair(app);
      const res = await app.inject({
        method: 'POST',
        url: '/locale',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `locale=de&redirectTo=${encodeURIComponent('/admin/../etc/passwd')}&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/');
      expect(res.headers.location).not.toMatch(/passwd|\.\./);
    } finally {
      await app.close();
    }
  });

  // Pure-function unit test for pickRedirectTarget: catches regressions where
  // the function is refactored without going through the integration
  // round-trip (faster feedback loop on CI).
  describe('pickRedirectTarget (pure unit)', () => {
    it('returns the literal allowlist member for exact-match own-origin paths', () => {
      expect(pickRedirectTarget('/')).toBe('/');
      expect(pickRedirectTarget('/admin')).toBe('/admin');
      expect(pickRedirectTarget('/profile')).toBe('/profile');
      expect(pickRedirectTarget('/jobs')).toBe('/jobs');
      expect(pickRedirectTarget('/upload')).toBe('/upload');
      expect(pickRedirectTarget('/login')).toBe('/login');
    });

    it('returns "/" for undefined / empty / non-matching paths', () => {
      expect(pickRedirectTarget(undefined)).toBe('/');
      expect(pickRedirectTarget('')).toBe('/');
      expect(pickRedirectTarget('/some-other-page')).toBe('/');
    });

    it('rejects absolute URLs, protocol-relative URLs, and path-traversal', () => {
      expect(pickRedirectTarget('https://evil.example.com/')).toBe('/');
      expect(pickRedirectTarget('http://evil.example.com/')).toBe('/');
      expect(pickRedirectTarget('//evil.example.com/')).toBe('/');
      expect(pickRedirectTarget('/admin/../etc/passwd')).toBe('/');
      expect(pickRedirectTarget('/admin/./extra')).toBe('/');
    });
  });
});
