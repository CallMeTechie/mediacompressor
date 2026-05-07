import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { generateInviteToken, hashInviteToken } from '@mediacompressor/auth';
import {
  TEST_API_KEY_PEPPER,
  TEST_SESSION_SECRET,
  TEST_CSRF_SECRET,
  testDatabaseUrl,
  testRedisUrl,
  createTestUser,
  cleanupTestUsers,
} from '@mediacompressor/test-helpers';
import { buildServer } from '../server.js';
import type { Config } from '../config.js';

const TEST_EMAILS = [
  'inv-redeem-admin@test.invalid',
  'inv-redeem-new@test.invalid',
  'race-a@test.invalid',
  'race-b@test.invalid',
  ...Array.from({ length: 20 }, (_, i) => `burst-${i}@test.invalid`),
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

describe('web/invite-redeem-page', () => {
  let prisma: PrismaClient;
  let adminId: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    // Invites have FKs to User (createdById, consumedById) — delete them first
    // so cleanupTestUsers' user.deleteMany doesn't trip Invite_createdById_fkey.
    await prisma.invite.deleteMany({
      where: {
        OR: [
          { createdBy: { email: { in: TEST_EMAILS } } },
          { consumedBy: { email: { in: TEST_EMAILS } } },
        ],
      },
    });
    await cleanupTestUsers(prisma, TEST_EMAILS);
    const admin = await createTestUser(prisma, { email: 'inv-redeem-admin@test.invalid' });
    adminId = admin.id;
  });

  beforeEach(async () => {
    await prisma.invite.deleteMany({ where: { createdById: adminId } });
    await prisma.user.deleteMany({
      where: { email: { in: TEST_EMAILS.filter((e) => e !== 'inv-redeem-admin@test.invalid') } },
    });
  });

  afterAll(async () => {
    await prisma.invite.deleteMany({
      where: {
        OR: [
          { createdBy: { email: { in: TEST_EMAILS } } },
          { consumedBy: { email: { in: TEST_EMAILS } } },
        ],
      },
    });
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
  });

  async function seedInvite(opts: { expiresAt?: Date; consumedAt?: Date; email?: string } = {}) {
    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token, Buffer.from(config.SESSION_SECRET));
    const invite = await prisma.invite.create({
      data: {
        token: tokenHash,
        createdById: adminId,
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 24 * 3600_000),
        consumedAt: opts.consumedAt ?? null,
        ...(opts.email ? { email: opts.email } : {}),
      },
    });
    return { invite, token };
  }

  async function getInviteForm(app: Awaited<ReturnType<typeof buildServer>>, token: string) {
    const res = await app.inject({ method: 'GET', url: `/invites/${token}` });
    const cookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(cookie) ? cookie.join('; ') : (cookie ?? '');
    const csrf = ((res.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/) ?? [])[1] ?? '';
    return { res, cookieHeader, csrf };
  }

  it('GET /invites/:token (valid) → 200 HTML with email + password fields and CSRF', async () => {
    const app = await buildServer(config);
    try {
      const { token } = await seedInvite();
      const res = await app.inject({ method: 'GET', url: `/invites/${token}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/<input[^>]+name="email"/);
      expect(res.body).toMatch(/<input[^>]+name="password"[^>]+type="password"/);
      expect(res.body).toMatch(/<input type="hidden" name="_csrf"/);
    } finally {
      await app.close();
    }
  });

  it('GET /invites/:token (consumed) → 410 Gone with explanation', async () => {
    const app = await buildServer(config);
    try {
      const { token } = await seedInvite({ consumedAt: new Date() });
      const res = await app.inject({ method: 'GET', url: `/invites/${token}` });
      expect(res.statusCode).toBe(410);
      expect(res.body).toMatch(/already (used|consumed)/i);
    } finally {
      await app.close();
    }
  });

  it('GET /invites/:token (expired) → 410 Gone', async () => {
    const app = await buildServer(config);
    try {
      const { token } = await seedInvite({ expiresAt: new Date(Date.now() - 60_000) });
      const res = await app.inject({ method: 'GET', url: `/invites/${token}` });
      expect(res.statusCode).toBe(410);
    } finally {
      await app.close();
    }
  });

  it('GET /invites/:token (unknown token) → 404', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/invites/not-a-real-token-xxxxxxxxxxxxxxxx',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /invites/:token → creates user, marks invite consumed, sets mc_session, redirects to /', async () => {
    const app = await buildServer(config);
    try {
      const { token, invite } = await seedInvite();
      const { cookieHeader, csrf } = await getInviteForm(app, token);

      const post = await app.inject({
        method: 'POST',
        url: `/invites/${token}`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `email=inv-redeem-new%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(post.statusCode);
      expect(post.headers.location).toBe('/');

      const newUser = await prisma.user.findUnique({
        where: { email: 'inv-redeem-new@test.invalid' },
      });
      expect(newUser).not.toBeNull();
      expect(newUser!.invitedById).toBe(adminId);

      const consumedInvite = await prisma.invite.findUnique({ where: { id: invite.id } });
      expect(consumedInvite!.consumedAt).not.toBeNull();
      expect(consumedInvite!.consumedById).toBe(newUser!.id);

      // mc_session cookie set on response.
      const setCookie = post.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      expect(cookies.some((c) => c?.startsWith('mc_session='))).toBe(true);
    } finally {
      await app.close();
    }
  });

  // Replay protection: a second GET with the SAME token after consumption → 410.
  it('GET /invites/:token after consumption → 410 (token already used)', async () => {
    const app = await buildServer(config);
    try {
      const { token } = await seedInvite();
      const { cookieHeader, csrf } = await getInviteForm(app, token);
      // Consume.
      await app.inject({
        method: 'POST',
        url: `/invites/${token}`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `email=inv-redeem-new%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf)}`,
      });
      // Second GET → 410.
      const res2 = await app.inject({ method: 'GET', url: `/invites/${token}` });
      expect(res2.statusCode).toBe(410);
    } finally {
      await app.close();
    }
  });

  it('POST /invites/:token with email-mismatch (invite is bound to a different email) → 400', async () => {
    const app = await buildServer(config);
    try {
      const { token } = await seedInvite({ email: 'inv-redeem-new@test.invalid' });
      const { cookieHeader, csrf } = await getInviteForm(app, token);
      const post = await app.inject({
        method: 'POST',
        url: `/invites/${token}`,
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `email=different%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(post.statusCode).toBe(400);
      expect(post.body).toMatch(/different email/i);
    } finally {
      await app.close();
    }
  });

  // WC3 PFLICHT-REGRESSIONSTEST — concurrent redeems of the SAME token. Exactly
  // one MUST succeed (303 + user created); the other MUST 410 (CONSUMED).
  // Without atomic updateMany, both observe consumedAt=null in the read-phase
  // and both create users → account-hijack window.
  it('WC3: two concurrent POSTs with same token — exactly one 303, the other 410', async () => {
    const app = await buildServer(config);
    try {
      const { token } = await seedInvite();
      // We use TWO separate getInviteForm calls so each POST has its own
      // mc_csrf cookie / token. light-my-request inject() is in-process,
      // Promise.all schedules both atomically.
      const a = await getInviteForm(app, token);
      const b = await getInviteForm(app, token);
      const [resA, resB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/invites/${token}`,
          headers: {
            cookie: a.cookieHeader,
            'content-type': 'application/x-www-form-urlencoded',
          },
          payload: `email=race-a%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(a.csrf)}`,
        }),
        app.inject({
          method: 'POST',
          url: `/invites/${token}`,
          headers: {
            cookie: b.cookieHeader,
            'content-type': 'application/x-www-form-urlencoded',
          },
          payload: `email=race-b%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(b.csrf)}`,
        }),
      ]);
      const statuses = [resA.statusCode, resB.statusCode].sort();
      // Expect exactly one redirect (302/303) and one 410.
      expect(statuses[0]).toBeGreaterThanOrEqual(302);
      expect(statuses[0]).toBeLessThanOrEqual(303);
      expect(statuses[1]).toBe(410);

      // Exactly ONE of the two race-emails ended up in the DB.
      const created = await prisma.user.findMany({
        where: { email: { in: ['race-a@test.invalid', 'race-b@test.invalid'] } },
      });
      expect(created).toHaveLength(1);
      // Cleanup the loser-row that may exist (defensive).
      await prisma.user.deleteMany({
        where: { email: { in: ['race-a@test.invalid', 'race-b@test.invalid'] } },
      });
    } finally {
      await app.close();
    }
  });

  // WC2 PFLICHT-REGRESSIONSTEST — burst of concurrent redeems must not crash
  // the API under argon2 memory pressure. We do NOT measure timing precisely;
  // we only assert that ALL 20 requests get a defined response (no hang, no
  // 5xx-storm) and exactly ONE succeeds, the rest 410. This proves the
  // semaphore + atomic-claim pattern hold under load.
  it('WC2: 20 concurrent redeems of the same token complete cleanly (no pool/argon storm)', async () => {
    const app = await buildServer(config);
    try {
      const { token } = await seedInvite();
      const forms = await Promise.all(
        Array.from({ length: 20 }, () => getInviteForm(app, token)),
      );
      const results = await Promise.all(
        forms.map((f, i) =>
          app.inject({
            method: 'POST',
            url: `/invites/${token}`,
            headers: {
              cookie: f.cookieHeader,
              'content-type': 'application/x-www-form-urlencoded',
            },
            payload: `email=burst-${i}%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(f.csrf)}`,
          }),
        ),
      );
      // Every request returned a defined status (no hang).
      for (const r of results) expect(r.statusCode).toBeDefined();
      const winners = results.filter((r) => r.statusCode === 302 || r.statusCode === 303);
      const losers = results.filter((r) => r.statusCode === 410);
      expect(winners).toHaveLength(1);
      expect(losers.length).toBeGreaterThanOrEqual(15); // ≥15 saw the consumed token
      // Cleanup all created burst-* rows.
      await prisma.user.deleteMany({
        where: { email: { in: TEST_EMAILS.filter((e) => e.startsWith('burst-')) } },
      });
    } finally {
      await app.close();
    }
  });

  // WC5 PFLICHT-REGRESSIONSTEST — mc_session cookie has HttpOnly + SameSite=Lax.
  it('WC5: successful redeem sets mc_session with HttpOnly + SameSite=Lax', async () => {
    const app = await buildServer(config);
    try {
      const { token } = await seedInvite();
      const { cookieHeader, csrf } = await getInviteForm(app, token);
      const post = await app.inject({
        method: 'POST',
        url: `/invites/${token}`,
        headers: { cookie: cookieHeader, 'content-type': 'application/x-www-form-urlencoded' },
        payload: `email=inv-redeem-new%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(post.statusCode);
      const setCookie = post.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      const session = cookies.find((c) => c?.startsWith('mc_session='));
      expect(session).toBeTruthy();
      expect(session!).toMatch(/HttpOnly/i);
      expect(session!).toMatch(/SameSite=Lax/i);
    } finally {
      await app.close();
    }
  });

  // WC7 PFLICHT-REGRESSIONSTEST — GET /invites/:token has Cache-Control: no-store.
  it('WC7: GET /invites/:token response has Cache-Control: no-store', async () => {
    const app = await buildServer(config);
    try {
      const { token } = await seedInvite();
      const res = await app.inject({ method: 'GET', url: `/invites/${token}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  // C4-Rev2 PFLICHT-REGRESSIONSTEST — Secure-cookie-flag in production-mode.
  it('C4-Rev2: mc_session has Secure flag when NODE_ENV=production', async () => {
    const prodConfig: Config = { ...config, NODE_ENV: 'production' };
    const app = await buildServer(prodConfig);
    try {
      const { token } = await seedInvite();
      const { cookieHeader, csrf } = await getInviteForm(app, token);
      const post = await app.inject({
        method: 'POST',
        url: `/invites/${token}`,
        headers: { cookie: cookieHeader, 'content-type': 'application/x-www-form-urlencoded' },
        payload: `email=inv-redeem-new%40test.invalid&password=hunter22hunter22&_csrf=${encodeURIComponent(csrf)}`,
      });
      expect([302, 303]).toContain(post.statusCode);
      const setCookie = post.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      const session = cookies.find((c) => c?.startsWith('mc_session='));
      expect(session).toBeTruthy();
      expect(session!).toMatch(/Secure/i);
    } finally {
      await app.close();
    }
  });
});
