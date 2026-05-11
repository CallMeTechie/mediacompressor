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
import { recordAuditEvent } from '@mediacompressor/audit';
import { buildServer } from '../server.js';
import type { Config } from '../config.js';

/**
 * Plan 10 Task 4: GET /admin/audit-events -- paginated audit-trail list.
 *
 * Coverage matrix (Plan §Task 4 Step 6):
 *  1. no session                 -> 303 to /login
 *  2. non-admin user             -> 403 HTML
 *  3. admin, empty               -> 200 with empty-state
 *  4. admin, 3 seeded events     -> 200 with 3 rows
 *  5. PFLICHT WC-audit-4 (XSS)   -> `<script>` in payload escaped
 *  6. PFLICHT WC-audit-5 (cursor tie-break) -> >50 seeded, paginate, no duplicate
 *  7. filter by actorId          -> only matching events
 *  8. PFLICHT WC-i18n-f3 carry-forward -> mc_locale=de renders DE labels
 *
 * Plus Rev. 2.1 patches:
 *  - PFLICHT WC-audit-12: filter-buttons MUST NOT include cursor (force-reset)
 *  - PFLICHT WC-audit-17: action-filter preserves actorId; pagination keeps both
 */

const TEST_EMAIL_USER = 'admin-audit-events-user@test.invalid';
const TEST_EMAIL_ADMIN = 'admin-audit-events-admin@test.invalid';
const TEST_EMAIL_ADMIN_EMPTY = 'admin-audit-events-empty@test.invalid';
const TEST_EMAIL_ADMIN_FILTER = 'admin-audit-events-filter@test.invalid';
const TEST_EMAIL_ADMIN_CURSOR = 'admin-audit-events-cursor@test.invalid';
const TEST_EMAIL_ADMIN_XSS = 'admin-audit-events-xss@test.invalid';
const TEST_EMAIL_ADMIN_DE = 'admin-audit-events-de@test.invalid';
const TEST_EMAIL_ADMIN_COMPOSE = 'admin-audit-events-compose@test.invalid';
const TEST_EMAIL_TARGET = 'admin-audit-events-target@test.invalid';

const TEST_EMAILS = [
  TEST_EMAIL_USER,
  TEST_EMAIL_ADMIN,
  TEST_EMAIL_ADMIN_EMPTY,
  TEST_EMAIL_ADMIN_FILTER,
  TEST_EMAIL_ADMIN_CURSOR,
  TEST_EMAIL_ADMIN_XSS,
  TEST_EMAIL_ADMIN_DE,
  TEST_EMAIL_ADMIN_COMPOSE,
  TEST_EMAIL_TARGET,
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

describe('web/admin-audit-events-page', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let adminId: string;
  let adminEmptyId: string;
  let adminFilterId: string;
  let adminCursorId: string;
  let adminXssId: string;
  let adminDeId: string;
  let adminComposeId: string;
  let targetId: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);

    await createTestUser(prisma, { email: TEST_EMAIL_USER, password: 'hunter22hunter22' });
    const admin = await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'admin' } });
    adminId = admin.id;
    const adminEmpty = await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_EMPTY,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({ where: { id: adminEmpty.id }, data: { role: 'admin' } });
    adminEmptyId = adminEmpty.id;
    const adminFilter = await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_FILTER,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({ where: { id: adminFilter.id }, data: { role: 'admin' } });
    adminFilterId = adminFilter.id;
    const adminCursor = await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_CURSOR,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({ where: { id: adminCursor.id }, data: { role: 'admin' } });
    adminCursorId = adminCursor.id;
    const adminXss = await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_XSS,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({ where: { id: adminXss.id }, data: { role: 'admin' } });
    adminXssId = adminXss.id;
    const adminDe = await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_DE,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({ where: { id: adminDe.id }, data: { role: 'admin' } });
    adminDeId = adminDe.id;
    const adminCompose = await createTestUser(prisma, {
      email: TEST_EMAIL_ADMIN_COMPOSE,
      password: 'hunter22hunter22',
    });
    await prisma.user.update({ where: { id: adminCompose.id }, data: { role: 'admin' } });
    adminComposeId = adminCompose.id;
    const target = await createTestUser(prisma, {
      email: TEST_EMAIL_TARGET,
      password: 'hunter22hunter22',
    });
    targetId = target.id;
  });

  beforeEach(async () => {
    await resetLoginRateLimits(redis, TEST_EMAILS);
    // Per-test isolation: each test seeds its OWN events scoped to its own
    // admin/target users; clean them so accumulated events from prior runs
    // don't cause cross-test bleed.
    const allActorIds = [
      adminId,
      adminEmptyId,
      adminFilterId,
      adminCursorId,
      adminXssId,
      adminDeId,
      adminComposeId,
    ];
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: allActorIds } } });
  });

  afterAll(async () => {
    const allActorIds = [
      adminId,
      adminEmptyId,
      adminFilterId,
      adminCursorId,
      adminXssId,
      adminDeId,
      adminComposeId,
    ];
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: allActorIds } } });
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

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

  // 1.
  it('GET /admin/audit-events (no session) -> 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/audit-events',
        headers: { accept: 'text/html' },
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  // 2.
  it('GET /admin/audit-events (non-admin user) -> 403 HTML', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_USER);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/audit-events',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/Forbidden/);
    } finally {
      await app.close();
    }
  });

  // 3. Empty state -- admin with NO events sees the empty-state message.
  it('GET /admin/audit-events (admin, empty) -> 200 with empty-state', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_EMPTY);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/audit-events',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // Empty-state message (EN locale).
      expect(body).toMatch(/No audit events recorded yet\./);
      // Cache-Control: no-store on post-login HTML.
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  // 4. Admin with 3 seeded events sees them rendered.
  it('GET /admin/audit-events (admin, 3 seeded events) -> 200 with 3 rows', async () => {
    await recordAuditEvent(prisma, {
      actorUserId: adminId,
      action: 'invite_create',
      targetType: 'invite',
      targetId,
      payload: { expiresAt: '2026-12-31T00:00:00Z' },
    });
    await recordAuditEvent(prisma, {
      actorUserId: adminId,
      action: 'invite_revoke',
      targetType: 'invite',
      targetId,
    });
    await recordAuditEvent(prisma, {
      actorUserId: adminId,
      action: 'user_update',
      targetType: 'user',
      targetId,
      payload: { status: 'disabled' },
    });

    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: `/admin/audit-events?actorId=${adminId}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // Table present.
      expect(body).toMatch(/<table[^>]*class="admin-table"/);
      // All 3 i18n-translated action labels (EN default locale) present.
      expect(body).toContain('Invite created');
      expect(body).toContain('Invite revoked');
      expect(body).toContain('User updated');
      // The actor email column shows the admin's email.
      expect(body).toContain(TEST_EMAIL_ADMIN);
      // `<time datetime="...">` attribute MUST be HTML-spec-compliant
      // ISO-8601 (YYYY-MM-DDTHH:MM:SS.sssZ), not a JS-Date.toString().
      // Guards against view-model regression where createdAt is serialized
      // via default `toString()` (e.g. "Mon May 11 2026 ..."), which breaks
      // assistive-tech parsing per HTML <time> spec. `.toISOString()` always
      // emits exactly 3 millisecond digits, so the regex pins that shape
      // without an optional quantifier (which would trip detect-unsafe-regex).
      expect(body).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/);
    } finally {
      await app.close();
    }
  });

  // 5. PFLICHT WC-audit-4 (XSS-via-payload). The handler renders payload as
  // JSON-stringified text; Handlebars `{{ }}` default-escape MUST escape any
  // `<script>` tags so the audit-trail never becomes an XSS sink.
  it('PFLICHT WC-audit-4: <script> in payload is HTML-escaped (no stored-XSS)', async () => {
    await recordAuditEvent(prisma, {
      actorUserId: adminXssId,
      action: 'user_update',
      targetType: 'user',
      targetId,
      payload: { note: '<script>alert(1)</script>' },
    });

    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_XSS);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/audit-events',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // Escaped form MUST appear (Handlebars's default escape -> `&lt;script&gt;`).
      expect(body).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      // The literal raw `<script>alert(1)</script>` MUST NOT appear -- proves
      // auto-escape ran on the payload field.
      expect(body).not.toContain('<script>alert(1)</script>');
    } finally {
      await app.close();
    }
  });

  // 6. PFLICHT WC-audit-5 (cursor tie-break). Seed >50 events; paginate via
  // cursor. The full union of page-1 + page-2 ids must contain NO duplicates,
  // proving the (createdAt, id) tie-break works even when many events share
  // the same created-at-second.
  it('PFLICHT WC-audit-5: cursor pagination yields no duplicate events across pages', async () => {
    // Seed 52 events back-to-back so several land on the same createdAt-ms.
    const seededIds: string[] = [];
    for (let i = 0; i < 52; i++) {
      const r = await recordAuditEvent(prisma, {
        actorUserId: adminCursorId,
        action: 'user_update',
        targetType: 'user',
        targetId,
        payload: { i },
      });
      seededIds.push(r.id);
    }

    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_CURSOR);
      // Filter by actorId so unrelated events from other concurrent tests
      // don't leak in.
      const res1 = await app.inject({
        method: 'GET',
        url: `/admin/audit-events?actorId=${adminCursorId}&limit=50`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res1.statusCode).toBe(200);
      const body1 = res1.body as string;
      // Next-page cursor link must be present (52 > 50).
      const cursorMatch = body1.match(/href="\/admin\/audit-events\?cursor=([^"&]+)[^"]*"/);
      expect(cursorMatch).not.toBeNull();
      const cursor = cursorMatch![1]!;

      const res2 = await app.inject({
        method: 'GET',
        url: `/admin/audit-events?actorId=${adminCursorId}&cursor=${encodeURIComponent(cursor)}&limit=50`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res2.statusCode).toBe(200);
      const body2 = res2.body as string;

      // Extract event-ids (rendered in data-event-id attrs) from both pages
      // and assert NO overlap.
      const extractIds = (html: string): string[] => {
        const out: string[] = [];
        const re = /data-event-id="([0-9a-f-]{36})"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) out.push(m[1]!);
        return out;
      };
      const page1 = extractIds(body1);
      const page2 = extractIds(body2);
      expect(page1.length).toBe(50);
      expect(page2.length).toBe(2);
      const overlap = page1.filter((id) => page2.includes(id));
      expect(overlap).toEqual([]);
      // Union covers every seeded event (no drops).
      const union = new Set([...page1, ...page2]);
      for (const id of seededIds) expect(union.has(id)).toBe(true);
    } finally {
      await app.close();
    }
  });

  // 7. Filter by actorId -- seed events under TWO different admins; query
  // ?actorId=<first> must return ONLY first-admin's events.
  it('GET /admin/audit-events?actorId=<id> returns only matching events', async () => {
    // Event under adminFilterId.
    const matchedEvent = await recordAuditEvent(prisma, {
      actorUserId: adminFilterId,
      action: 'invite_create',
      targetType: 'invite',
      targetId,
      payload: { expiresAt: '2026-01-01T00:00:00Z' },
    });
    // Event under adminId (different actor) -- must NOT appear in the
    // filtered response.
    const unmatchedEvent = await recordAuditEvent(prisma, {
      actorUserId: adminId,
      action: 'invite_revoke',
      targetType: 'invite',
      targetId,
    });

    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_FILTER);
      const res = await app.inject({
        method: 'GET',
        url: `/admin/audit-events?actorId=${adminFilterId}`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      expect(body).toContain(matchedEvent.id);
      expect(body).not.toContain(unmatchedEvent.id);
    } finally {
      await app.close();
    }
  });

  // 8. PFLICHT WC-i18n-f3 carry-forward: mc_locale=de cookie renders DE labels.
  it('PFLICHT WC-i18n-f3: mc_locale=de renders DE labels (Einladung erstellt)', async () => {
    await recordAuditEvent(prisma, {
      actorUserId: adminDeId,
      action: 'invite_create',
      targetType: 'invite',
      targetId,
      payload: { expiresAt: '2026-06-01T00:00:00Z' },
    });

    const app = await buildServer(config);
    try {
      const sessionCookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_DE);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/audit-events',
        headers: {
          accept: 'text/html',
          cookie: `${sessionCookie}; mc_locale=de`,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;
      // DE label MUST appear.
      expect(body).toContain('Einladung erstellt');
      // EN label MUST NOT appear in audit-action context (regression-guard).
      // Note: we scope to `<td>` to avoid false positives from page-nav links.
      expect(body).not.toMatch(/<td[^>]*>Invite created<\/td>/);
    } finally {
      await app.close();
    }
  });

  // 9. PFLICHT WC-audit-12: filter-button links MUST NOT include cursor
  // (force-reset on filter-change so the new filter starts at page 1).
  it('PFLICHT WC-audit-12: filter-button links DO NOT include cursor (force-reset on filter-change)', async () => {
    // Seed an event so the page renders something (filter-links are always
    // emitted regardless, but a populated table mirrors real usage).
    await recordAuditEvent(prisma, {
      actorUserId: adminComposeId,
      action: 'invite_create',
      targetType: 'invite',
      targetId,
    });

    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_COMPOSE);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/audit-events?action=invite_create',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;

      // The filter-link to switch action MUST NOT contain `cursor=` in any
      // form -- proves the cursor is dropped on filter-toggle.
      expect(body).toMatch(/href="\/admin\/audit-events\?action=invite_revoke"/);
      expect(body).not.toMatch(/cursor=[^"]*&action=invite_revoke/);
      expect(body).not.toMatch(/action=invite_revoke[^"]*&cursor=/);
    } finally {
      await app.close();
    }
  });

  // 10. PFLICHT WC-audit-17 (Rev. 2.1): action-filter button preserves
  // actorId-filter and drops cursor; pagination link preserves BOTH filters
  // AND the cursor.
  it('PFLICHT WC-audit-17: action-filter preserves actorId, drops cursor; pagination keeps both', async () => {
    // Seed >50 events so pagination next-cursor is present.
    for (let i = 0; i < 51; i++) {
      await recordAuditEvent(prisma, {
        actorUserId: adminComposeId,
        action: 'invite_create',
        targetType: 'invite',
        targetId,
        payload: { seq: i },
      });
    }

    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_COMPOSE);
      const res = await app.inject({
        method: 'GET',
        url: `/admin/audit-events?actorId=${adminComposeId}&action=invite_create`,
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body as string;

      // Action-filter button to SWITCH to invite_revoke: includes actorId,
      // does NOT include cursor. Use plain substring (.toContain) to avoid
      // dynamic-RegExp lint warning -- the seeded actorId interpolates
      // safely into a string-literal match.
      const expectedSwitchHref = `href="/admin/audit-events?action=invite_revoke&actorId=${adminComposeId}"`;
      expect(body).toContain(expectedSwitchHref);
      expect(body).not.toMatch(/cursor=[^"]*&action=invite_revoke/);

      // Pagination link: includes BOTH filters AND cursor. The cursor is
      // opaque (base64url), so we assert the prefix + suffix as substrings
      // bracketing the cursor-token.
      const paginationPrefix = `href="/admin/audit-events?cursor=`;
      const paginationSuffix = `&action=invite_create&actorId=${adminComposeId}"`;
      const prefixIdx = body.indexOf(paginationPrefix);
      expect(prefixIdx).toBeGreaterThanOrEqual(0);
      // Suffix must appear AFTER the prefix, with the (non-empty) cursor in between.
      const suffixIdx = body.indexOf(paginationSuffix, prefixIdx + paginationPrefix.length);
      expect(suffixIdx).toBeGreaterThan(prefixIdx + paginationPrefix.length);
    } finally {
      await app.close();
    }
  });

  // 11. Pins Zod-coercion behaviour for the `limit` querystring: non-numeric
  // values (e.g. `?limit=abc`) MUST 400-fail at the validation boundary,
  // NOT silently fall back to the default 50. Guards against a future
  // schema-change accidentally weakening the validator (e.g. dropping
  // `.int()` or adding `.catch(50)`).
  it('GET /admin/audit-events?limit=abc -> 400 (zod rejects non-numeric)', async () => {
    const app = await buildServer(config);
    try {
      const cookie = await loginAndCookies(app, TEST_EMAIL_ADMIN_EMPTY);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/audit-events?limit=abc',
        headers: { accept: 'text/html', cookie },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
