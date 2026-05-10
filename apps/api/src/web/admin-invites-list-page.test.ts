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

const TEST_EMAIL_USER = 'admin-invites-list-user@test.invalid';
const TEST_EMAIL_ADMIN = 'admin-invites-list@test.invalid';
const TEST_EMAIL_ADMIN_EMPTY = 'admin-invites-list-empty@test.invalid';
const TEST_EMAIL_ADMIN_FLASH = 'admin-invites-list-flash@test.invalid';
const TEST_EMAIL_ADMIN_DE = 'admin-invites-list-de@test.invalid';
const TEST_EMAILS = [
  TEST_EMAIL_USER,
  TEST_EMAIL_ADMIN,
  TEST_EMAIL_ADMIN_EMPTY,
  TEST_EMAIL_ADMIN_FLASH,
  TEST_EMAIL_ADMIN_DE,
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

describe('web/admin-invites-list-page', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let adminId: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);

    await createTestUser(prisma, { email: TEST_EMAIL_USER, password: 'hunter22hunter22' });
    await createTestUser(prisma, { email: TEST_EMAIL_ADMIN, password: 'hunter22hunter22' });
    await prisma.user.update({ where: { email: TEST_EMAIL_ADMIN }, data: { role: 'admin' } });
    await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_EMPTY,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_ADMIN_EMPTY },
      data: { role: 'admin' },
    });
    await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_FLASH,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_ADMIN_FLASH },
      data: { role: 'admin' },
    });
    await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_DE,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({
      where: { email: TEST_EMAIL_ADMIN_DE },
      data: { role: 'admin' },
    });

    const admin = await prisma.user.findUnique({
      where: { email: TEST_EMAIL_ADMIN },
      select: { id: true },
    });
    adminId = admin!.id;
  });

  async function getAdminIds(): Promise<string[]> {
    const admins = await prisma.user.findMany({
      where: { email: { in: TEST_EMAILS } },
      select: { id: true },
    });
    return admins.map((a) => a.id);
  }

  beforeEach(async () => {
    await resetLoginRateLimits(redis, TEST_EMAILS);
    // Clean invites between tests to ensure deterministic seeding. Includes
    // TEST_EMAIL_ADMIN_DE so the DE-format test can rely on beforeEach for
    // cleanup symmetrically with the other admin scopes (no per-test manual
    // teardown required).
    await prisma.invite.deleteMany({
      where: { createdById: { in: await getAdminIds() } },
    });
  });

  afterAll(async () => {
    await prisma.invite.deleteMany({
      where: { createdById: { in: await getAdminIds() } },
    });
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

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
  it('GET /admin/invites (no session) -> 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/invites',
        headers: { accept: 'text/html' },
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  // 2.
  it('GET /admin/invites (non-admin user) -> 403 HTML', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_USER);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/invites',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/Forbidden/);
    } finally {
      await app.close();
    }
  });

  // 3. Empty list -> 200 + empty-state copy.
  it('GET /admin/invites (admin, empty) -> 200 with empty-state', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_EMPTY);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/invites',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // Cache-Control: no-store on post-login HTML.
      expect(res.headers['cache-control']).toMatch(/no-store/);
      // Empty-state copy ("No invites yet.")
      expect(body).toMatch(/No invites yet/);
      // Create-form is always present (above the table).
      expect(body).toMatch(/<form[^>]+action="\/admin\/invites"/);
    } finally {
      await app.close();
    }
  });

  // 4. Active + consumed + expired invites -> 200, three rows w/ correct labels.
  it('GET /admin/invites (admin, active+consumed+expired) -> 200 with three rows', async () => {
    const app = await buildServer(config);
    try {
      // Seed three invites under TEST_EMAIL_ADMIN.
      const future = new Date(Date.now() + 24 * 3600_000);
      const past = new Date(Date.now() - 1 * 3600_000);
      await prisma.invite.create({
        data: {
          token: 'a'.repeat(64),
          email: 'active@test.invalid',
          createdById: adminId,
          expiresAt: future,
        },
      });
      await prisma.invite.create({
        data: {
          token: 'b'.repeat(64),
          email: 'consumed@test.invalid',
          createdById: adminId,
          expiresAt: future,
          consumedAt: new Date(),
        },
      });
      await prisma.invite.create({
        data: {
          token: 'c'.repeat(64),
          email: 'expired@test.invalid',
          createdById: adminId,
          expiresAt: past,
        },
      });

      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/invites',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;

      // Three emails appear.
      expect(body).toContain('active@test.invalid');
      expect(body).toContain('consumed@test.invalid');
      expect(body).toContain('expired@test.invalid');

      // Each status label appears (English locale via default fallback).
      expect(body).toMatch(/Active/);
      expect(body).toMatch(/Consumed/);
      expect(body).toMatch(/Expired/);

      // Active row has a Revoke form (URL contains UUID).
      expect(body).toMatch(
        /<form[^>]+action="\/admin\/invites\/[0-9a-f-]{36}\/revoke"/,
      );
    } finally {
      await app.close();
    }
  });

  // 5. Bonus: ?updateflash=created -> translated flash visible.
  it('GET /admin/invites?updateflash=created -> 200 with flash visible', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_FLASH);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/invites?updateflash=created',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      expect(body).toMatch(/flash flash-info/);
      expect(body).toMatch(/Invite created/);
    } finally {
      await app.close();
    }
  });

  // Plan 8d Task 7 regression PFLICHT (per CLAUDE.md "Pflicht-Regressions-
  // Test pro Sicherheits-/Race-Annahme"):
  //
  // Bug B: inside {{#each invites}} the {{> csrf}} partial saw the row as
  // its own context, so {{{_csrfField}}} resolved to undefined and the
  // per-row revoke-form shipped without an `_csrf` input. POST submit
  // 403'd. Fixed by passing @root explicitly: {{> csrf @root}}.
  //
  // Why earlier tests missed this: extractCsrfToken() above matches the
  // FIRST `<input name="_csrf">` on the page, which is always the create-
  // form's CSRF (top-level scope, has the field). The revoke-form's
  // missing CSRF inside the loop was never observed.
  //
  // This test seeds an active invite (=> exactly one revoke form),
  // extracts the CSRF input scoped to the revoke-form's HTML substring,
  // and asserts the value is non-empty (and >= 16 chars to match real
  // tokens, not stray empty `value=""`).
  it('PFLICHT regression Bug B: revoke-form inside {{#each}} carries a non-empty _csrf input', async () => {
    const app = await buildServer(config);
    try {
      // Seed exactly one active invite so the form-extractor cannot pick
      // a stale one from a previous test (beforeEach already wiped).
      const future = new Date(Date.now() + 24 * 3600_000);
      const created = await prisma.invite.create({
        data: {
          token: 'd'.repeat(64),
          email: 'csrf-regression@test.invalid',
          createdById: adminId,
          expiresAt: future,
        },
      });

      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/invites',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;

      // Scope CSRF extraction to the revoke-form's HTML substring (literal-
      // substring split on the action attribute, ReDoS-safe). If the form
      // is missing OR the _csrf input has empty value, this throws.
      const action = `/admin/invites/${created.id}/revoke`;
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

  // 6. Allowlist gate: arbitrary updateflash value rejected by Zod enum ->
  // 400 (no flash render path executed). Proves URL-supplied flash text
  // cannot be injected into the rendered banner. The Fastify validator
  // echoes the bad value in its JSON error message, so we assert the
  // marker is NOT rendered as flash HTML (no <div class="flash...">marker
  // </div>) and the response is NOT a 200 list-page that contains the
  // marker as flash text.
  it('GET /admin/invites?updateflash=evil-marker-list rejects the URL-injected flash text', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_FLASH);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/invites?updateflash=evil-marker-list',
        headers: { accept: 'text/html', cookie },
      });
      // Zod enum rejects the value -> 400; the marker is NOT rendered as
      // a flash banner.
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toMatch(/<div[^>]*class="flash[^"]*"[^>]*>[^<]*evil-marker-list/);
    } finally {
      await app.close();
    }
  });

  // Plan 8f Task 2 PFLICHT (WC-i18n-f-task2 / WC-i18n-f18 — Format-Style
  // Discipline): the table-row date-cell migrated from raw `{{expiresAt}}`
  // ISO-rendering to `{{formatDate expiresAt}}` (medium, default style). With
  // `mc_locale=de` the cell MUST render the DE numeric format `15.05.2026`
  // (not `2026-05-15` raw ISO, not `May 15, 2026` EN). The canonical ISO
  // remains in the surrounding `<time datetime="...">` machine-readable
  // attribute. Without a per-row `_locale` resolution against `@root`
  // (registerFormatDateHelper's 3-tier fallback), the render would default to
  // EN inside the `{{#each invites}}` block — this test pins the locale-flow.
  it('PFLICHT WC-i18n-f-task2: GET /admin/invites with mc_locale=de renders expiresAt in DE numeric format (formatDate medium)', async () => {
    const app = await buildServer(config);
    try {
      const admin = await prisma.user.findUnique({
        where: { email: TEST_EMAIL_ADMIN_DE },
        select: { id: true },
      });
      // Fixed-date invite (UTC midday — TZ-stable across `Intl.DateTimeFormat`
      // UTC formatter — the helper hardcodes timeZone:'UTC' per WC-i18n-f1).
      const fixedExpires = new Date('2026-05-15T10:00:00Z');
      await prisma.invite.create({
        data: {
          token: 'e'.repeat(64),
          email: 'de-format-test@test.invalid',
          createdById: admin!.id,
          expiresAt: fixedExpires,
        },
      });

      const sessionCookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_DE);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/invites',
        headers: {
          accept: 'text/html',
          cookie: `${sessionCookie}; mc_locale=de`,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // DE numeric: dd.mm.yyyy (Intl.DateTimeFormat 'de' + dateStyle:'medium').
      expect(body).toMatch(/15\.05\.2026/);
      // EN long-month-name MUST NOT leak into DE-rendered cell.
      expect(body).not.toMatch(/May 15, 2026/);
      // Canonical ISO MUST remain in the <time datetime="..."> attribute
      // (HTML5 machine-readable; locale-formatting is inner-text only).
      expect(body).toMatch(/<time[^>]+datetime="2026-05-15T10:00:00\.000Z"/);
    } finally {
      await app.close();
    }
  });
});
