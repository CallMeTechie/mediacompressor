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

const TEST_EMAILS = [
  'dashboard-empty@test.invalid',
  'dashboard-jobs@test.invalid',
  'dashboard-xss@test.invalid',
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

describe('web/dashboard-page', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await createTestUser(prisma, {
      email: 'dashboard-empty@test.invalid',
      password: 'hunter22hunter22',
    });
    await createTestUser(prisma, {
      email: 'dashboard-jobs@test.invalid',
      password: 'hunter22hunter22',
    });
    await createTestUser(prisma, {
      email: 'dashboard-xss@test.invalid',
      password: 'hunter22hunter22',
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

  async function seedJob(opts: {
    userId: string;
    inputFilename: string;
    status?: 'queued' | 'processing' | 'succeeded' | 'failed';
  }) {
    return prisma.job.create({
      data: {
        userId: opts.userId,
        status: opts.status ?? 'succeeded',
        kind: 'image',
        profile: 'web-optimized',
        overrides: {},
        inputFilename: opts.inputFilename,
        uploadId: `dashboard-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      },
    });
  }

  it('GET / (HTML, no session) → 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { accept: 'text/html' },
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  it('GET / (HTML, valid session, NO jobs) → 200, body contains empty-state', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await login(app, 'dashboard-empty@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/No jobs yet/i);
      expect(res.body).toContain('dashboard-empty@test.invalid');
    } finally {
      await app.close();
    }
  });

  it('GET / (HTML, valid session, 3 seeded jobs) → 200, body lists all 3 inputFilenames', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'dashboard-jobs@test.invalid' },
      });
      const filenames = ['alpha.png', 'beta.jpg', 'gamma.mp4'];
      for (const name of filenames) {
        await seedJob({ userId: user!.id, inputFilename: name });
      }
      const cookie = await login(app, 'dashboard-jobs@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      for (const name of filenames) {
        expect(res.body).toContain(name);
      }
      // Status badges from the partial.
      expect(res.body).toMatch(/status-succeeded/);
    } finally {
      await app.close();
    }
  });

  it('GET / (no Accept header) → 200 JSON {status:ok} (native-app health-check contract)', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  });

  // C5-Rev2 PFLICHT: post-login HTML must not be browser/proxy-cached.
  it('GET / (HTML, valid session) has Cache-Control: no-store', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await login(app, 'dashboard-empty@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  // WC-PL1 PFLICHT — Handlebars escapes user-controlled inputFilename.
  // A user could upload a file named `<script>alert(1)</script>`; the dashboard
  // must render it as &lt;script&gt;… NOT as raw HTML, otherwise stored XSS.
  it('WC-PL1: inputFilename containing <script> tag is HTML-escaped (no stored-XSS)', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'dashboard-xss@test.invalid' },
      });
      const evilName = '<script>alert(1)</script>';
      await seedJob({ userId: user!.id, inputFilename: evilName });
      const cookie = await login(app, 'dashboard-xss@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      // Escaped output must be present.
      expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      // Raw evil substring (literal `<script>alert(1)</script>`) must NOT
      // appear unescaped anywhere in the body. Other <script> tags from
      // base.hbs (e.g. /static/vendor/htmx.min.js) are fine because they
      // don't include the alert(1) payload.
      expect(res.body).not.toContain(evilName);
    } finally {
      await app.close();
    }
  });
});
