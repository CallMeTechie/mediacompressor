import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { hashSessionToken } from '@mediacompressor/auth';
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
  'profile@test.invalid',
  'profile-multi@test.invalid',
  'profile-xss@test.invalid',
  'profile-flash@test.invalid',
  'profile-de-format@test.invalid',
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

describe('web/profile-page', () => {
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

  /**
   * Logs in via /login and returns the merged cookie header
   * (mc_session + mc_csrf). Mirrors the loginAndCookies helper from
   * require-session.test.ts.
   */
  async function loginAndCookies(
    app: Awaited<ReturnType<typeof buildServer>>,
    email: string,
  ): Promise<string> {
    const get = await app.inject({ method: 'GET', url: '/login' });
    const csrf = ((get.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1]!;
    const initialCookies = (
      Array.isArray(get.headers['set-cookie'])
        ? get.headers['set-cookie']
        : [get.headers['set-cookie'] ?? '']
    )
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
    return (
      Array.isArray(post.headers['set-cookie'])
        ? post.headers['set-cookie']
        : [post.headers['set-cookie'] ?? '']
    )
      .map((c) => c?.split(';')[0])
      .filter(Boolean)
      .join('; ');
  }

  it('GET /profile (no session) → 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/profile' });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  it('GET /profile (session) → 200 with email + quota summary + sessions table', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, 'profile@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('profile@test.invalid');
      // Quota summary
      expect(res.body).toMatch(/bytes storage/);
      expect(res.body).toMatch(/parallel/);
      // Sessions table header
      expect(res.body).toMatch(/<table class="profile-table">/);
      expect(res.body).toMatch(/User-Agent/);
      // Nav to API Keys + Sign out
      expect(res.body).toMatch(/href="\/profile\/api-keys"/);
      expect(res.body).toMatch(/action="\/logout"/);
    } finally {
      await app.close();
    }
  });

  it('GET /profile (session) → CURRENT session row carries class="session-row current"', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, 'profile@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/class="session-row current"/);
      // and "(this device)" muted text on the current row
      expect(res.body).toMatch(/\(this device\)/);
    } finally {
      await app.close();
    }
  });

  it('GET /profile (multi-session) → both visible; only the cookie-matching one is current', async () => {
    const app = await buildServer(config);
    try {
      // Seed an extra non-current session for this user.
      const user = await prisma.user.findUnique({
        where: { email: 'profile-multi@test.invalid' },
      });
      const otherToken = 'other-device-token-xxxxxxxxxxxxxx';
      const otherTokenHash = hashSessionToken(otherToken, Buffer.from(config.SESSION_SECRET));
      await prisma.session.create({
        data: {
          userId: user!.id,
          tokenHash: otherTokenHash,
          userAgent: 'OtherBrowser/1.0',
          ip: '10.20.30.40',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const cookie = await loginAndCookies(app, 'profile-multi@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      // Both sessions visible.
      expect(res.body).toContain('OtherBrowser/1.0');
      // Exactly one row marked current.
      const currentMatches = res.body.match(/class="session-row current"/g) ?? [];
      expect(currentMatches.length).toBe(1);
      // The non-current row carries a revoke form (no "this device" on it).
      expect(res.body).toMatch(/action="\/profile\/sessions\/[^"]+\/revoke"/);
    } finally {
      await app.close();
    }
  });

  it('GET /profile response Cache-Control: no-store', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, 'profile@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  // WC-PR1 PFLICHT — XSS via session.userAgent: Handlebars must escape the raw
  // <script>…</script> string. Without escape, a malicious user-agent could
  // inject stored XSS into the profile page.
  it('WC-PR1: session.userAgent containing <script> tag is HTML-escaped (no stored-XSS)', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'profile-xss@test.invalid' },
      });
      // Seed a session with a malicious user-agent FIRST. Then we log in,
      // which creates a SECOND (current) session for the same user. Both
      // are returned by the listing query.
      const evilUA = '<script>alert(1)</script>';
      const evilToken = 'evil-ua-token-xxxxxxxxxxxxxxxxxxxx';
      const evilHash = hashSessionToken(evilToken, Buffer.from(config.SESSION_SECRET));
      await prisma.session.create({
        data: {
          userId: user!.id,
          tokenHash: evilHash,
          userAgent: evilUA,
          ip: '127.0.0.1',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const cookie = await loginAndCookies(app, 'profile-xss@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      // Escape-presence: rendered HTML-escaped form.
      expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      // Raw-absence: must not contain the literal evil substring anywhere.
      expect(res.body).not.toContain(evilUA);
    } finally {
      await app.close();
    }
  });

  // Plan 8d Task 7 regression PFLICHT (per CLAUDE.md "Pflicht-Regressions-
  // Test pro Sicherheits-/Race-Annahme"):
  //
  // Bug B (mirror): inside {{#each sessions}} the {{> csrf}} partial saw
  // the row as its own context, so the per-row session-revoke form shipped
  // without a populated `_csrf` input. Fixed by passing @root explicitly.
  // This test seeds an extra non-current session, then asserts -- scoped
  // to the revoke-form's HTML substring -- that the CSRF input is non-empty.
  it('PFLICHT regression Bug B: session-revoke form inside {{#each sessions}} carries a non-empty _csrf input', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'profile-multi@test.invalid' },
      });
      // Seed an extra non-current session (not matching our cookie token)
      // so the loop renders at least one revoke-form row.
      const otherToken = 'csrf-regression-token-yyyyyyyyyy';
      const otherTokenHash = hashSessionToken(otherToken, Buffer.from(config.SESSION_SECRET));
      const created = await prisma.session.create({
        data: {
          userId: user!.id,
          tokenHash: otherTokenHash,
          userAgent: 'CsrfRegressionBrowser/1.0',
          ip: '127.0.0.1',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const cookie = await loginAndCookies(app, 'profile-multi@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;

      // Scope CSRF extraction to the revoke-form's HTML substring (literal-
      // substring split on the action attribute, ReDoS-safe).
      const action = `/profile/sessions/${created.id}/revoke`;
      const needle = `action="${action}"`;
      const start = body.indexOf(needle);
      expect(start).toBeGreaterThanOrEqual(0);
      const formOpen = body.lastIndexOf('<form', start);
      const formClose = body.indexOf('</form>', start);
      expect(formOpen).toBeGreaterThanOrEqual(0);
      expect(formClose).toBeGreaterThan(formOpen);
      const formBody = body.slice(formOpen, formClose);
      const csrfMatch = formBody.match(/<input[^>]*name="_csrf"[^>]*value="([^"]+)"/);
      expect(csrfMatch).not.toBeNull();
      expect(csrfMatch![1]!.length).toBeGreaterThanOrEqual(16);

      // Cleanup: the seeded session would otherwise pollute later tests.
      await prisma.session.delete({ where: { id: created.id } });
    } finally {
      await app.close();
    }
  });

  // Plan 8e Task 6 Step 3 — WC-i18n-5 PFLICHT: post-i18n-migration regression
  // target. The Plan 8d Task 7 fix (commit c835163) wired `{{> csrf @root}}`
  // inside `{{#each sessions}}` so each per-row revoke-form ships a populated
  // `_csrf` input. The Plan 8e i18n template-migration MUST NOT regress this
  // (a subagent re-writing the template could accidentally drop `@root` or
  // restructure the `{{#each}}` block in a way that loses the parent context
  // when the partial is invoked). This test extracts EVERY revoke-form action
  // URL on the rendered page and asserts each one carries a non-empty
  // _csrf input — catches the regression even on a single-session render.
  it('PFLICHT WC-i18n-5: session-revoke form inside {{#each sessions}} carries _csrf even after i18n migration', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'profile-multi@test.invalid' },
      });
      // Seed two extra non-current sessions so the loop renders >= 2 forms
      // — multi-form is the harder case (one row's CSRF could still be there
      // while the next row's silently empties out under context-rebind bugs).
      const seedTokens = ['wci18n5-token-aaaaaaaaaaaaaaaa', 'wci18n5-token-bbbbbbbbbbbbbbbb'];
      const seededIds: string[] = [];
      for (const tok of seedTokens) {
        const hash = hashSessionToken(tok, Buffer.from(config.SESSION_SECRET));
        const s = await prisma.session.create({
          data: {
            userId: user!.id,
            tokenHash: hash,
            userAgent: `WCi18n5Browser/${tok.slice(-4)}`,
            ip: '10.0.0.1',
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        });
        seededIds.push(s.id);
      }

      try {
        const cookie = await loginAndCookies(app, 'profile-multi@test.invalid');
        const res = await app.inject({
          method: 'GET',
          url: '/profile',
          headers: { cookie, accept: 'text/html' },
        });
        expect(res.statusCode).toBe(200);
        const body = res.body as string;

        // Greedy form-extraction over EVERY session-revoke form on the page.
        // The `[\s\S]*?` makes the match non-greedy so each `<form>...</form>`
        // pair is captured separately.
        const sessionsRevokeMatches = body.match(
          /<form[^>]*action="\/profile\/sessions\/[a-f0-9-]+\/revoke"[\s\S]*?<\/form>/g,
        );
        expect(sessionsRevokeMatches?.length ?? 0).toBeGreaterThanOrEqual(1);
        for (const formHtml of sessionsRevokeMatches!) {
          // Each form MUST carry a populated `_csrf` input. The i18n migration
          // re-writes the template; this test is the Plan 8d -> 8e bridge
          // regression-guard.
          expect(
            formHtml,
            `WC-i18n-5 regression: form ${formHtml.slice(0, 80)} missing _csrf input`,
          ).toMatch(/<input[^>]*name="_csrf"[^>]*value="[^"]+"/);
        }
      } finally {
        // Cleanup the seeded sessions so subsequent tests start clean.
        for (const sid of seededIds) {
          await prisma.session.delete({ where: { id: sid } }).catch(() => undefined);
        }
      }
    } finally {
      await app.close();
    }
  });

  // C3-PR PFLICHT — revokeflash allowlist gate: arbitrary query values must
  // NOT be rendered as flash text (URL-injection phishing vector).
  it('C3-PR: GET /profile?revokeflash=evil-marker-profile does NOT render the marker', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, 'profile-flash@test.invalid');
      const res = await app.inject({
        method: 'GET',
        url: '/profile?revokeflash=evil-marker-profile',
        headers: { cookie, accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('evil-marker-profile');
    } finally {
      await app.close();
    }
  });

  // Plan 8f Task 2 PFLICHT (WC-i18n-f-task2 / WC-i18n-f18 — Format-Style
  // Discipline): the sessions-table date-cells migrated from raw
  // `{{lastUsedAt}}` / `{{expiresAt}}` ISO-rendering to
  // `{{formatDate ...}}` (medium, default style). With `mc_locale=de` the
  // cell MUST render the DE numeric format `15.05.2026` (not raw ISO, not
  // `May 15, 2026` EN). Seeds an extra non-current session with a fixed
  // future expiresAt so the assertion is deterministic regardless of the
  // login-fresh session's auto-generated expiresAt.
  it('PFLICHT WC-i18n-f-task2: GET /profile with mc_locale=de renders sessions expiresAt in DE numeric format (formatDate medium)', async () => {
    const app = await buildServer(config);
    try {
      const user = await prisma.user.findUnique({
        where: { email: 'profile-de-format@test.invalid' },
      });
      // Seed a non-current session with a fixed expiresAt — the formatter
      // hardcodes timeZone:'UTC' (WC-i18n-f1) so noon-UTC is TZ-stable.
      const fixedExpires = new Date('2026-05-15T10:00:00Z');
      const seedToken = 'profile-de-format-token-zzzzzzzzz';
      const seedHash = hashSessionToken(seedToken, Buffer.from(config.SESSION_SECRET));
      const seeded = await prisma.session.create({
        data: {
          userId: user!.id,
          tokenHash: seedHash,
          userAgent: 'DEFormatBrowser/1.0',
          ip: '10.0.0.99',
          expiresAt: fixedExpires,
        },
      });

      try {
        const sessionCookie = await loginAndCookies(app, 'profile-de-format@test.invalid');
        const res = await app.inject({
          method: 'GET',
          url: '/profile',
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
        // Canonical ISO MUST remain in the <time datetime="..."> attribute.
        expect(body).toMatch(/<time[^>]+datetime="2026-05-15T10:00:00\.000Z"/);
      } finally {
        // Cleanup — seeded session would otherwise pollute later runs.
        await prisma.session.delete({ where: { id: seeded.id } }).catch((e: { code?: string }) => {
          if (e?.code !== 'P2025') throw e;
        });
      }
    } finally {
      await app.close();
    }
  });
});
