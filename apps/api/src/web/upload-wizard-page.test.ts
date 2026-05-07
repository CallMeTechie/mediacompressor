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
import { PROFILES } from '@mediacompressor/compression/types';
import { buildServer } from '../server.js';
import type { Config } from '../config.js';

const TEST_EMAILS = ['upload-wizard@test.invalid'];

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

describe('web/upload-wizard-page', () => {
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

  /** Logs in via /login and returns the merged cookie header. */
  async function login(
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

  it('GET /upload (no session) → 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/upload',
        headers: { accept: 'text/html' },
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  it('GET /upload (session) → 200 HTML with file/kind/profile inputs and CSRF', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await login(app, 'upload-wizard@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/upload',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // file input
      expect(res.body).toMatch(/<input[^>]*type="file"[^>]*name="file"/);
      // kind radio buttons
      expect(res.body).toMatch(/<input[^>]*type="radio"[^>]*name="kind"[^>]*value="image"/);
      expect(res.body).toMatch(/<input[^>]*type="radio"[^>]*name="kind"[^>]*value="video"/);
      // profile select
      expect(res.body).toMatch(/<select[^>]*name="profile"/);
      // CSRF hidden field
      expect(res.body).toMatch(/<input[^>]*type="hidden"[^>]*name="_csrf"/);
    } finally {
      await app.close();
    }
  });

  it('GET /upload (session) → response references /static/vendor/tus.min.js AND /static/js/upload-wizard.js', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await login(app, 'upload-wizard@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/upload',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('/static/vendor/tus.min.js');
      expect(res.body).toContain('/static/js/upload-wizard.js');
    } finally {
      await app.close();
    }
  });

  it('PROFILES from compression/types are all rendered as <option> elements', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await login(app, 'upload-wizard@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/upload',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      for (const profile of PROFILES) {
        expect(res.body).toContain(`<option value="${profile}">${profile}</option>`);
      }
      // count match: number of <option ...> tags inside the profile <select> equals PROFILES.length
      const optionMatches = res.body.match(/<option\s+value="[^"]+">/g) ?? [];
      expect(optionMatches.length).toBe(PROFILES.length);
    } finally {
      await app.close();
    }
  });

  it('GET /upload (session) → Cache-Control: no-store', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await login(app, 'upload-wizard@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/upload',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  // C4-LI PFLICHT: graceful degradation for JS-disabled browsers — body must
  // contain a <noscript> block that mentions JavaScript-requirement and links
  // to API documentation as the alternative path.
  it('C4-LI: response body contains a <noscript> block referencing JavaScript and the API docs', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await login(app, 'upload-wizard@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/upload',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const noscriptMatch = res.body.match(/<noscript>[\s\S]*?<\/noscript>/);
      expect(noscriptMatch).not.toBeNull();
      const noscript = noscriptMatch![0];
      expect(noscript).toMatch(/JavaScript/i);
      expect(noscript).toContain('/api/v1/docs');
    } finally {
      await app.close();
    }
  });

  // C7-LI PFLICHT: <noscript> block contains a <style> tag with a `display: none`
  // selector targeting `#upload-form`. JS-disabled browsers MUST NOT see the
  // form — otherwise they'd submit a multipart/form-data POST to /upload that
  // doesn't exist (silent 404).
  it('C7-LI: <noscript> block contains <style> with display:none for #upload-form (JS-disabled cannot submit)', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await login(app, 'upload-wizard@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/upload',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const noscriptMatch = res.body.match(/<noscript>[\s\S]*?<\/noscript>/);
      expect(noscriptMatch).not.toBeNull();
      const noscript = noscriptMatch![0];
      // <style> tag inside <noscript>
      expect(noscript).toMatch(/<style[^>]*>[\s\S]*?<\/style>/);
      // display: none rule targeting #upload-form
      expect(noscript).toMatch(/#upload-form\s*\{[^}]*display:\s*none[^}]*\}/);
    } finally {
      await app.close();
    }
  });
});
