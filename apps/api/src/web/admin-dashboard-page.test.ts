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

const TEST_EMAIL_USER = 'admin-dashboard-user@test.invalid';
const TEST_EMAIL_ADMIN = 'admin-dashboard@test.invalid';
const TEST_EMAILS = [TEST_EMAIL_USER, TEST_EMAIL_ADMIN];

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

describe('web/admin-dashboard-page', () => {
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

    // Active admin (role='admin', status='active') -- patched via update
    // because createTestUser doesn't set role.
    await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_ADMIN },
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

  /** Logs in via /login and returns the merged cookie header (mc_session + mc_csrf). */
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

  it('GET /admin (no session) -> 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { accept: 'text/html' },
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  it('GET /admin (non-admin user) -> 403 HTML', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_USER);
      const res = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(403);
      const ct = res.headers['content-type'];
      expect(typeof ct === 'string' ? ct : '').toMatch(/text\/html/);
      expect(res.body).toMatch(/Forbidden/);
    } finally {
      await app.close();
    }
  });

  it('GET /admin (admin) -> 200 with welcome line + nav-links to users/invites/stats', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      const body = res.body as string;
      // Welcome line carries the admin's email (Signed in as ...).
      expect(body).toContain(TEST_EMAIL_ADMIN);
      // Nav-links to the three admin sub-pages.
      expect(body).toContain('href="/admin/users"');
      expect(body).toContain('href="/admin/invites"');
      expect(body).toContain('href="/admin/stats"');
    } finally {
      await app.close();
    }
  });

  // WC-AD3-bonus PFLICHT: i18n end-to-end -- a German cookie flips the
  // rendered nav-text from "Users" -> "Benutzer". Proves the {{t}} helper
  // resolves req.locale through the view-plugin's _locale injection.
  it('WC-AD3-bonus PFLICHT: GET /admin with mc_locale=de cookie -> body contains "Benutzer"', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: {
          accept: 'text/html',
          cookie: `${cookie}; mc_locale=de`,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // German nav-label for "Users" comes from de/admin.json's nav_users.
      expect(body).toContain('Benutzer');
      // Sanity: English nav-label MUST NOT appear as a standalone link-text
      // when the locale switched to de. (We allow "Users" inside attribute
      // values like href="/admin/users".)
      expect(body).not.toMatch(/>Users</);
    } finally {
      await app.close();
    }
  });

  // C5-Rev2-style: post-login HTML must not be browser/proxy-cached.
  it('Cache-Control: no-store on GET /admin', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  // C3-AD-PR PFLICHT (locale-switcher UI present + C7-AD-PR current-locale-
  // indicator). Without UI the POST /locale route is dead code; without the
  // active-class the user has no visual cue which locale is currently set.
  it('C3-AD-PR + C7-AD-PR PFLICHT: locale-switcher form + current-locale button is disabled and .active', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);

      // Default locale -> 'en' (no mc_locale cookie, no Accept-Language).
      const resEn = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { accept: 'text/html', cookie },
      });
      expect(resEn.statusCode).toBe(200);
      const bodyEn = resEn.body as string;
      // Form posts to /locale with the redirectTo=/admin hidden field.
      expect(bodyEn).toMatch(
        /<form[^>]*method="POST"[^>]*action="\/locale"|<form[^>]*action="\/locale"[^>]*method="POST"/i,
      );
      expect(bodyEn).toMatch(
        /<input[^>]*type="hidden"[^>]*name="redirectTo"[^>]*value="\/admin"/,
      );
      // Both locale-buttons are present.
      expect(bodyEn).toMatch(/<button[^>]*type="submit"[^>]*name="locale"[^>]*value="en"/);
      expect(bodyEn).toMatch(/<button[^>]*type="submit"[^>]*name="locale"[^>]*value="de"/);
      // C7-AD-PR: current locale ('en') -> en-button has BOTH `disabled` AND
      // `active` class. de-button has neither.
      const enButtonEn =
        bodyEn.match(/<button[^>]*name="locale"[^>]*value="en"[^>]*>[^<]*<\/button>/)?.[0] ?? '';
      const deButtonEn =
        bodyEn.match(/<button[^>]*name="locale"[^>]*value="de"[^>]*>[^<]*<\/button>/)?.[0] ?? '';
      expect(enButtonEn).toMatch(/disabled/);
      expect(enButtonEn).toMatch(/class="[^"]*active/);
      expect(deButtonEn).not.toMatch(/disabled/);
      expect(deButtonEn).not.toMatch(/class="[^"]*active/);

      // C7-AD-PR with mc_locale=de: de-button has BOTH `disabled` AND `active`,
      // en-button does NOT have `disabled`.
      const resDe = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: {
          accept: 'text/html',
          cookie: `${cookie}; mc_locale=de`,
        },
      });
      expect(resDe.statusCode).toBe(200);
      const bodyDe = resDe.body as string;
      const enButtonDe =
        bodyDe.match(/<button[^>]*name="locale"[^>]*value="en"[^>]*>[^<]*<\/button>/)?.[0] ?? '';
      const deButtonDe =
        bodyDe.match(/<button[^>]*name="locale"[^>]*value="de"[^>]*>[^<]*<\/button>/)?.[0] ?? '';
      expect(deButtonDe).toMatch(/disabled/);
      expect(deButtonDe).toMatch(/class="[^"]*active/);
      expect(enButtonDe).not.toMatch(/disabled/);
      expect(enButtonDe).not.toMatch(/class="[^"]*active/);
    } finally {
      await app.close();
    }
  });
});
