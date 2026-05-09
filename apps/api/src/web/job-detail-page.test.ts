import fs from 'node:fs';
import path from 'node:path';
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
  'job-detail-own@test.invalid',
  'job-detail-foreign@test.invalid',
  'job-detail-other@test.invalid',
  'job-detail-xss@test.invalid',
  'job-detail-cache@test.invalid',
  'job-detail-terminal@test.invalid',
  'job-detail-redact@test.invalid',
  'job-detail-flash@test.invalid',
  'job-detail-sse@test.invalid',
  'job-detail-fragment@test.invalid',
  'job-detail-fragment-foreign@test.invalid',
  'job-detail-fragment-other@test.invalid',
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

describe('web/job-detail-page', () => {
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
    errorMessage?: string;
  }) {
    return prisma.job.create({
      data: {
        userId: opts.userId,
        status: opts.status ?? 'succeeded',
        kind: 'image',
        profile: 'web-optimized',
        overrides: {},
        inputFilename: opts.inputFilename,
        uploadId: `jobdet-${Math.random().toString(36).slice(2)}-${Date.now()}`,
        ...(opts.errorMessage !== undefined ? { errorMessage: opts.errorMessage } : {}),
      },
    });
  }

  it('GET /jobs/:id (no session) → 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-own@test.invalid' },
      });
      const job = await seedJob({ userId: user!.id, inputFilename: 'a.png' });
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}`,
        headers: { accept: 'text/html' },
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  it('GET /jobs/:id (session, own queued job) → 200 with status, profile, filename, cancel form', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-own@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'mine-queued.png',
        status: 'queued',
      });
      const cookie = await login(app, 'job-detail-own@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('mine-queued.png');
      expect(res.body).toMatch(/status-queued/);
      // Plan 8e Task 5 (review concern #1): the profile label is now
      // translated via the {{tProfile}} helper, so the canonical DB-string
      // `web-optimized` (with dash) is replaced by the locale-specific
      // label. Default locale === 'en', so en.jobs.profile_web_optimized
      // === "Web optimized" (with space, no dash). The test asserts the
      // translated label, NOT the raw enum-string.
      expect(res.body).toContain('Web optimized');
      // Cancel form present (job is not terminal).
      expect(res.body).toContain(`action="/jobs/${job.id}/cancel"`);
      expect(res.body).toContain('<form method="POST"');
      expect(res.body).toContain('name="_csrf"');
      // Not a download link (non-succeeded).
      expect(res.body).not.toContain(`/api/v1/jobs/${job.id}/download`);
    } finally {
      await app.close();
    }
  });

  it('GET /jobs/:id (session, foreign job) → 404 (no existence-leak)', async () => {
    const app = await buildServer(config);
    try {
      const otherUser = await prisma.user.findUnique({
        where: { email: 'job-detail-other@test.invalid' },
      });
      const foreignJob = await seedJob({
        userId: otherUser!.id,
        inputFilename: 'foreign.png',
      });
      const cookie = await login(app, 'job-detail-foreign@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${foreignJob.id}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('foreign.png');
    } finally {
      await app.close();
    }
  });

  it('GET /jobs/<nonexistent-uuid> → 404', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await login(app, 'job-detail-foreign@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/jobs/00000000-0000-0000-0000-000000000000',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET /jobs/not-a-uuid → 400', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await login(app, 'job-detail-foreign@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/jobs/not-a-uuid',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // WC-PL1 PFLICHT — Handlebars escapes user-controlled inputFilename.
  it('WC-PL1: filename containing <script> tag is HTML-escaped (no stored-XSS)', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-xss@test.invalid' },
      });
      const evilName = '<script>alert(1)</script>';
      const job = await seedJob({
        userId: user!.id,
        inputFilename: evilName,
        status: 'queued',
      });
      const cookie = await login(app, 'job-detail-xss@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(res.body).not.toContain(evilName);
    } finally {
      await app.close();
    }
  });

  it('GET /jobs/:id has Cache-Control: no-store', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-cache@test.invalid' },
      });
      const job = await seedJob({ userId: user!.id, inputFilename: 'cache.png' });
      const cookie = await login(app, 'job-detail-cache@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  it('GET /jobs/:id (terminal — succeeded) → no cancel form', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-terminal@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'done.png',
        status: 'succeeded',
      });
      const cookie = await login(app, 'job-detail-terminal@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(`action="/jobs/${job.id}/cancel"`);
    } finally {
      await app.close();
    }
  });

  it('GET /jobs/:id (terminal — succeeded) → has download link', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-terminal@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'done2.png',
        status: 'succeeded',
      });
      const cookie = await login(app, 'job-detail-terminal@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`/api/v1/jobs/${job.id}/download`);
    } finally {
      await app.close();
    }
  });

  // C1-LI PFLICHT — view-time errorMessage redaction. Worker may store raw
  // ffmpeg-stderr with server paths; the rendered page MUST collapse to the
  // generic "Job failed." message and never leak `/media/uploads/`.
  it('C1-LI: errorMessage with server path is redacted to "Job failed." (no path leak)', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-redact@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'leaky.png',
        status: 'failed',
        errorMessage: 'ffmpeg: Cannot open /media/uploads/abc/source.bin',
      });
      const cookie = await login(app, 'job-detail-redact@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Job failed.');
      expect(res.body).not.toContain('/media/uploads/');
      expect(res.body).not.toContain('ffmpeg:');
    } finally {
      await app.close();
    }
  });

  // C6-LI — cancelflash query renders a flash via the FLASH_MAP allowlist.
  it('C6-LI: GET /jobs/:id?cancelflash=csrf-stale → renders the FLASH_MAP message', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-flash@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'flash.png',
        status: 'queued',
      });
      const cookie = await login(app, 'job-detail-flash@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}?cancelflash=csrf-stale`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(
        'Your session token had to be refreshed. Please try again.',
      );
    } finally {
      await app.close();
    }
  });

  // C6-LI Allowlist gate — arbitrary cancelflash values must NOT be rendered.
  it('C6-LI Allowlist: GET /jobs/:id?cancelflash=arbitrary-not-in-allowlist → no flash, no leak', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-flash@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'flash-gate.png',
        status: 'queued',
      });
      const cookie = await login(app, 'job-detail-flash@test.invalid');
      const arbitrary = 'evil-pwned-marker-7c2a';
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}?cancelflash=${encodeURIComponent(arbitrary)}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      // Allowlist gate: arbitrary value must NEVER appear in the response.
      expect(res.body).not.toContain(arbitrary);
      // And no flash-error class for the unrecognised value.
      expect(res.body).not.toContain(
        'Your session token had to be refreshed. Please try again.',
      );
    } finally {
      await app.close();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Task 4: SSE-Integration (htmx-ext-sse) + Polling-Fallback
  // ────────────────────────────────────────────────────────────────────

  // Task 4 Test 1 — SSE-target div with correct attributes (full page).
  // C5-LI: stable id="job-detail-sse-target" so future Plan-8c admin SSE pages
  // can co-exist with their own targets.
  it('Task 4: GET /jobs/:id (no fragment) → page contains data-sse-target div with sse-url and fragment-url', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-sse@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'sse-target.png',
        status: 'queued',
      });
      const cookie = await login(app, 'job-detail-sse@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('data-sse-target');
      expect(res.body).toContain(`data-sse-url="/api/v1/jobs/${job.id}/events"`);
      expect(res.body).toContain(
        `data-fragment-url="/jobs/${job.id}?fragment=1"`,
      );
      // C5-LI stable ID for Plan-8c co-existence.
      expect(res.body).toContain('id="job-detail-sse-target"');
    } finally {
      await app.close();
    }
  });

  // FU1 PFLICHT-REGRESSIONSTEST — SSE swap pattern uses hx-trigger + hx-get,
  // NOT sse-swap. htmx-ext-sse's `sse-swap` would inject the raw JSON event-
  // payload into the DOM (e.g. {"status":"succeeded","outputBytes":340}),
  // clobbering the styled status-badge with raw text. Using `hx-trigger="sse:..."`
  // makes the SSE event trigger an HTMX GET to the fragment route, which re-
  // renders the server-side template with the styled <span class="status ...">
  // badge. This regression test pins the attribute set so a future "fix" that
  // re-introduces `sse-swap` fails LOUD instead of silent-broken UX.
  it('FU1: GET /jobs/:id contains hx-trigger="sse:..." + hx-get (NOT sse-swap)', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-sse@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'fu1-trigger.png',
        status: 'queued',
      });
      const cookie = await login(app, 'job-detail-sse@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      // Must contain the new hx-trigger + hx-get pattern.
      expect(res.body).toContain('hx-trigger="sse:status, sse:progress, sse:snapshot"');
      expect(res.body).toContain(`hx-get="/jobs/${job.id}?fragment=1"`);
      expect(res.body).toContain('hx-swap="innerHTML"');
      // Must NOT contain the legacy sse-swap attribute (which would inject raw JSON).
      expect(res.body).not.toContain('sse-swap=');
    } finally {
      await app.close();
    }
  });

  // Task 4 Test 2 — fragment route returns ONLY the partial (no shell).
  it('Task 4: GET /jobs/:id?fragment=1 → returns ONLY job-detail-status partial (no <html>/<head>/<body>)', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-fragment@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'fragment.png',
        status: 'processing',
      });
      const cookie = await login(app, 'job-detail-fragment@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}?fragment=1`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Fragment-only — NO shell tags from base.hbs.
      expect(res.body).not.toMatch(/<html/i);
      expect(res.body).not.toMatch(/<head>/i);
      expect(res.body).not.toMatch(/<body>/i);
      expect(res.body).not.toContain('<!doctype');
      // But the status badge IS present.
      expect(res.body).toContain('status-processing');
    } finally {
      await app.close();
    }
  });

  // Task 4 Test 3 — fragment route on foreign job → 404 (no existence-leak).
  it('Task 4: GET /jobs/:id?fragment=1 (foreign job) → 404', async () => {
    const app = await buildServer(config);
    try {
      const otherUser = await prisma.user.findUnique({
        where: { email: 'job-detail-fragment-other@test.invalid' },
      });
      const foreignJob = await seedJob({
        userId: otherUser!.id,
        inputFilename: 'fragment-foreign.png',
      });
      const cookie = await login(app, 'job-detail-fragment-foreign@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${foreignJob.id}?fragment=1`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('fragment-foreign.png');
    } finally {
      await app.close();
    }
  });

  // Task 4 Test 4 — base layout loads htmx-ext-sse.
  it('Task 4: GET /jobs/:id base layout includes htmx-ext-sse.min.js script tag', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-sse@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'has-ext-sse.png',
        status: 'queued',
      });
      const cookie = await login(app, 'job-detail-sse@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(
        '<script src="/static/vendor/htmx-ext-sse.min.js"',
      );
    } finally {
      await app.close();
    }
  });

  // Task 4 Test 5 — page loads the watchdog script.
  it('Task 4: GET /jobs/:id includes job-detail-watchdog.js script tag', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'job-detail-sse@test.invalid' },
      });
      const job = await seedJob({
        userId: user!.id,
        inputFilename: 'has-watchdog.png',
        status: 'queued',
      });
      const cookie = await login(app, 'job-detail-sse@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: `/jobs/${job.id}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(
        '<script src="/static/js/job-detail-watchdog.js"',
      );
    } finally {
      await app.close();
    }
  });

  // C3-LI PFLICHT — the committed watchdog script binds the literal
  // htmx-2.0.x event name `htmx:sseMessage` and discovers targets via the
  // `[data-sse-target]` selector. Read via fs and assert via REGEX (NOT
  // toContain) so tokens in code-comments don't false-positive: the regex
  // enforces that the strings appear in listener/selector-positions
  // (addEventListener('htmx:...'), querySelectorAll('[...]')). On future
  // htmx-3.0 bumps these patterns shift; the test fails LOUD instead of
  // silent-broken UX. Note: the C10-LI `shouldSwap=false` regression-test
  // for the session-redirect handler now lives in view-plugin.test.ts
  // (htmx-session-redirect.js), since Task 4 moved that logic OUT of the
  // watchdog.
  it('C3-LI: job-detail-watchdog.js binds htmx:sseMessage on [data-sse-target]', () => {
    const watchdogPath = path.resolve(
      __dirname,
      '../../public/js/job-detail-watchdog.js',
    );
    const watchdogJs = fs.readFileSync(watchdogPath, 'utf8');
    expect(watchdogJs).toMatch(/addEventListener\(['"]htmx:sseMessage['"]/);
    expect(watchdogJs).toMatch(
      /querySelectorAll\(['"]\[data-sse-target\]['"]\)/,
    );
  });
});
