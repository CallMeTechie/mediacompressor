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
  'apikeys-list@test.invalid',
  'apikeys-list-empty@test.invalid',
  'apikeys-list-many@test.invalid',
  'apikeys-list-leak@test.invalid',
  'apikeys-list-flash@test.invalid',
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

describe('web/api-keys-list-page', () => {
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
    // Wipe any apiKey rows from previous tests for these users so
    // assertions about "no keys" / "exactly N keys" are deterministic.
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
   * Logs in via /login and returns the merged cookie header
   * (mc_session + mc_csrf). Mirrors the loginAndCookies helper from
   * profile-page.test.ts.
   */
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

  // 1.
  it('GET /profile/api-keys (no session) → 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/profile/api-keys' });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  // 2.
  it('GET /profile/api-keys (session, no keys) → 200 empty-state with "Create your first one" link', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, 'apikeys-list-empty@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile/api-keys',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Empty-state copy.
      expect(res.body).toMatch(/No API keys yet/);
      expect(res.body).toMatch(/Create your first one/);
      // No table rows.
      expect(res.body).not.toMatch(/<table class="profile-table">/);
      // Page-header links present.
      expect(res.body).toMatch(/href="\/profile"/);
      expect(res.body).toMatch(/href="\/profile\/api-keys\/new"/);
    } finally {
      await app.close();
    }
  });

  // 3.
  it('GET /profile/api-keys (session, 3 keys) → 200 table with all 3 rows', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'apikeys-list-many@test.invalid' },
      });
      // Seed 3 active keys with distinct names + prefixes.
      const seed = [
        { name: 'key-alpha', keyPrefix: 'aaaaaaaa', keyHash: 'a'.repeat(64) },
        { name: 'key-beta', keyPrefix: 'bbbbbbbb', keyHash: 'b'.repeat(64) },
        { name: 'key-gamma', keyPrefix: 'cccccccc', keyHash: 'c'.repeat(64) },
      ];
      for (const k of seed) {
        await prisma.apiKey.create({
          data: {
            userId: user!.id,
            name: k.name,
            keyHash: k.keyHash,
            keyPrefix: k.keyPrefix,
            scopes: ['jobs:read'],
          },
        });
      }
      // Also seed one REVOKED key to confirm it's NOT shown.
      await prisma.apiKey.create({
        data: {
          userId: user!.id,
          name: 'key-revoked',
          keyHash: 'd'.repeat(64),
          keyPrefix: 'dddddddd',
          scopes: ['jobs:read'],
          revokedAt: new Date(),
        },
      });

      const cookie = await loginAndCookies(app, 'apikeys-list-many@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile/api-keys',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/<table class="profile-table">/);
      // All 3 active key names visible.
      expect(res.body).toContain('key-alpha');
      expect(res.body).toContain('key-beta');
      expect(res.body).toContain('key-gamma');
      // Revoked key NOT shown.
      expect(res.body).not.toContain('key-revoked');
      // Each row has a revoke form.
      const revokeFormMatches = res.body.match(/action="\/profile\/api-keys\/[^"]+\/revoke"/g) ?? [];
      expect(revokeFormMatches.length).toBe(3);
    } finally {
      await app.close();
    }
  });

  // 4. WC-PR2 PFLICHT — no raw-key-leak. Body must contain ONLY the 8-char
  // prefix, NEVER the full `mc_<8>_<32>` format and NEVER the random 32-char
  // suffix. The DB schema only stores keyPrefix + keyHash, but we synthesize
  // the full string to test that it doesn't accidentally appear.
  it('WC-PR2: response body contains ONLY the 8-char prefix, NEVER the full key format or 32-char suffix', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'apikeys-list-leak@test.invalid' },
      });
      const prefix = 'abc12def';
      const suffix = 'x'.repeat(32);
      const fullKey = `mc_${prefix}_${suffix}`;
      await prisma.apiKey.create({
        data: {
          userId: user!.id,
          name: 'leak-test-key',
          keyHash: 'e'.repeat(64),
          keyPrefix: prefix,
          scopes: ['jobs:read'],
        },
      });

      const cookie = await loginAndCookies(app, 'apikeys-list-leak@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile/api-keys',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      // Prefix IS visible (rendered as `<code>abc12def&hellip;</code>`).
      expect(res.body).toContain(prefix);
      // Full key format MUST NOT appear.
      expect(res.body).not.toContain(fullKey);
      // 32-char suffix MUST NOT appear (defensive — DB doesn't store it,
      // but this catches future accidental leaks like rendering keyHash).
      expect(res.body).not.toContain(suffix);
      // Pattern-level guard — no full mc_<8>_<32> token should ever render.
      expect(res.body).not.toMatch(/mc_[a-z0-9]{8}_[A-Za-z0-9_-]{32,}/);
    } finally {
      await app.close();
    }
  });

  // 5.
  it('GET /profile/api-keys response Cache-Control: no-store', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, 'apikeys-list-empty@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile/api-keys',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  // Plan 8d Task 7 regression PFLICHT (per CLAUDE.md "Pflicht-Regressions-
  // Test pro Sicherheits-/Race-Annahme"):
  //
  // Bug B (mirror): inside {{#each keys}} the {{> csrf}} partial saw the
  // row as its own context, so the per-row revoke-form shipped without a
  // populated `_csrf` input. Fixed by passing @root explicitly.
  // This test seeds one active API key, then asserts -- scoped to the
  // revoke-form's HTML substring -- that the CSRF input has a non-empty
  // value (>= 16 chars to match real tokens).
  it('PFLICHT regression Bug B: revoke-form inside {{#each keys}} carries a non-empty _csrf input', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'apikeys-list@test.invalid' },
      });
      const created = await prisma.apiKey.create({
        data: {
          userId: user!.id,
          name: 'csrf-regression',
          keyHash: 'f'.repeat(64),
          keyPrefix: 'ffffffff',
          scopes: ['jobs:read'],
        },
      });

      const cookie = await loginAndCookies(app, 'apikeys-list@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile/api-keys',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;

      // Scope CSRF extraction to the revoke-form's HTML substring (literal-
      // substring split on the action attribute, ReDoS-safe).
      const action = `/profile/api-keys/${created.id}/revoke`;
      const needle = `action="${action}"`;
      const start = body.indexOf(needle);
      expect(start).toBeGreaterThanOrEqual(0);
      const formOpen = body.lastIndexOf('<form', start);
      const formClose = body.indexOf('</form>', start);
      expect(formOpen).toBeGreaterThanOrEqual(0);
      expect(formClose).toBeGreaterThan(formOpen);
      const formBody = body.slice(formOpen, formClose);
      const csrfMatch = formBody.match(
        /<input[^>]*name="_csrf"[^>]*value="([^"]+)"/,
      );
      expect(csrfMatch).not.toBeNull();
      expect(csrfMatch![1]!.length).toBeGreaterThanOrEqual(16);
    } finally {
      await app.close();
    }
  });

  // 6. C3-PR PFLICHT — revokeflash allowlist gate.
  it('C3-PR: GET /profile/api-keys?revokeflash=evil-marker-list does NOT render the marker', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, 'apikeys-list-flash@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile/api-keys?revokeflash=evil-marker-list',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('evil-marker-list');
    } finally {
      await app.close();
    }
  });
});
