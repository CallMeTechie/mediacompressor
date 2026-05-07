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
  'job-list-empty@test.invalid',
  'job-list-jobs@test.invalid',
  'job-list-filter@test.invalid',
  'job-list-cursor@test.invalid',
  'job-list-fragment@test.invalid',
  'job-list-xss@test.invalid',
  'job-list-cache@test.invalid',
  'job-list-inflight@test.invalid',
  'job-list-terminal@test.invalid',
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

type SeedStatus =
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'expired';

describe('web/job-list-page', () => {
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
    status?: SeedStatus;
    createdAt?: Date;
  }) {
    return prisma.job.create({
      data: {
        userId: opts.userId,
        status: opts.status ?? 'succeeded',
        kind: 'image',
        profile: 'web-optimized',
        overrides: {},
        inputFilename: opts.inputFilename,
        uploadId: `joblist-${Math.random().toString(36).slice(2)}-${Date.now()}`,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
  }

  it('GET /jobs (no session) → 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/jobs',
        headers: { accept: 'text/html' },
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  it('GET /jobs (session, no jobs) → 200 with empty-state HTML', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await login(app, 'job-list-empty@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/jobs',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/No jobs yet/i);
    } finally {
      await app.close();
    }
  });

  it('GET /jobs (session, 5 seeded jobs) → 200 with all 5 rows', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-list-jobs@test.invalid' },
      });
      const filenames = ['one.png', 'two.jpg', 'three.mp4', 'four.webm', 'five.gif'];
      for (const name of filenames) {
        await seedJob({ userId: user!.id, inputFilename: name });
      }
      const cookie = await login(app, 'job-list-jobs@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/jobs',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<tbody');
      for (const name of filenames) {
        expect(res.body).toContain(name);
      }
    } finally {
      await app.close();
    }
  });

  it('GET /jobs?status=succeeded → 200 with only succeeded rows', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-list-filter@test.invalid' },
      });
      await seedJob({ userId: user!.id, inputFilename: 'ok-1.png', status: 'succeeded' });
      await seedJob({ userId: user!.id, inputFilename: 'ok-2.png', status: 'succeeded' });
      await seedJob({ userId: user!.id, inputFilename: 'fail-1.png', status: 'failed' });
      await seedJob({ userId: user!.id, inputFilename: 'queued-1.png', status: 'queued' });
      const cookie = await login(app, 'job-list-filter@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/jobs?status=succeeded',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('ok-1.png');
      expect(res.body).toContain('ok-2.png');
      expect(res.body).not.toContain('fail-1.png');
      expect(res.body).not.toContain('queued-1.png');
    } finally {
      await app.close();
    }
  });

  it('GET /jobs?cursor=<...> → 200 second page (no overlap)', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-list-cursor@test.invalid' },
      });
      const base = Date.now();
      for (let i = 0; i < 25; i++) {
        const name = `cursor-${String(i).padStart(2, '0')}.png`;
        await seedJob({
          userId: user!.id,
          inputFilename: name,
          createdAt: new Date(base - i * 1000),
        });
      }
      const cookie = await login(app, 'job-list-cursor@test.invalid');
      const page1 = await app.inject({
        method: 'GET',
        url: '/jobs',
        headers: { accept: 'text/html', cookie },
      });
      expect(page1.statusCode).toBe(200);
      expect(page1.body).toContain('cursor-00.png');
      expect(page1.body).toContain('cursor-19.png');
      expect(page1.body).not.toContain('cursor-20.png');
      const cursorMatch = page1.body.match(/href="\/jobs\?cursor=([^"&]+)/);
      expect(cursorMatch).not.toBeNull();
      const cursor = decodeURIComponent(cursorMatch![1]!);
      const page2 = await app.inject({
        method: 'GET',
        url: `/jobs?cursor=${encodeURIComponent(cursor)}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(page2.statusCode).toBe(200);
      expect(page2.body).toContain('cursor-20.png');
      expect(page2.body).toContain('cursor-24.png');
      expect(page2.body).not.toContain('cursor-00.png');
      expect(page2.body).not.toContain('cursor-19.png');
    } finally {
      await app.close();
    }
  });

  it('GET /jobs?fragment=1 → 200 with ONLY the tbody partial (no <html>)', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-list-fragment@test.invalid' },
      });
      await seedJob({ userId: user!.id, inputFilename: 'frag-1.png' });
      const cookie = await login(app, 'job-list-fragment@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/jobs?fragment=1',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toMatch(/<html\b/i);
      expect(res.body).not.toMatch(/<head\b/i);
      expect(res.body).not.toMatch(/<body\b/i);
      expect(res.body).toContain('<tbody');
      expect(res.body).toContain('frag-1.png');
    } finally {
      await app.close();
    }
  });

  // WC-PL1 PFLICHT — Handlebars escapes user-controlled inputFilename.
  it('WC-PL1: filename containing <script> tag is HTML-escaped (no stored-XSS)', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-list-xss@test.invalid' },
      });
      const evilName = '<script>alert(1)</script>';
      await seedJob({ userId: user!.id, inputFilename: evilName });
      const cookie = await login(app, 'job-list-xss@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/jobs',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(res.body).not.toContain(evilName);
    } finally {
      await app.close();
    }
  });

  it('GET /jobs has Cache-Control: no-store', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await login(app, 'job-list-cache@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/jobs',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  it('GET /jobs (in-flight job) → response contains polling attrs', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-list-inflight@test.invalid' },
      });
      await seedJob({
        userId: user!.id,
        inputFilename: 'inflight-1.png',
        status: 'processing',
      });
      const cookie = await login(app, 'job-list-inflight@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/jobs',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('hx-trigger="every 3s"');
      expect(res.body).toMatch(/hx-get="\/jobs\?fragment=1[^"]*"/);
      expect(res.body).toContain('hx-swap="outerHTML"');
    } finally {
      await app.close();
    }
  });

  // WC-PL4 PFLICHT — when all jobs are terminal, polling-attrs MUST NOT be
  // present, so HTMX naturally stops re-polling.
  it('WC-PL4: GET /jobs (only terminal jobs) → does NOT contain hx-trigger="every 3s"', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-list-terminal@test.invalid' },
      });
      await seedJob({ userId: user!.id, inputFilename: 'term-1.png', status: 'succeeded' });
      await seedJob({ userId: user!.id, inputFilename: 'term-2.png', status: 'failed' });
      await seedJob({ userId: user!.id, inputFilename: 'term-3.png', status: 'canceled' });
      await seedJob({ userId: user!.id, inputFilename: 'term-4.png', status: 'expired' });
      const cookie = await login(app, 'job-list-terminal@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/jobs',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('hx-trigger="every 3s"');
    } finally {
      await app.close();
    }
  });
});
