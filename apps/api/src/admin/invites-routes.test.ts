import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { hashInviteToken } from '@mediacompressor/auth';
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

interface LoginCreds {
  session: string;
  csrfCookie: string;
  csrfToken: string;
}

async function loginAndGetCreds(
  app: Awaited<ReturnType<typeof buildServer>>,
  email: string,
  password = 'hunter22hunter22',
): Promise<LoginCreds> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (login.statusCode !== 200) {
    throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  }
  const session = login.cookies.find((c) => c.name === 'mc_session')!.value;
  const csrfCookie = login.cookies.find((c) => c.name === 'mc_csrf')!.value;
  const csrfToken = (login.json() as { csrfToken: string }).csrfToken;
  return { session, csrfCookie, csrfToken };
}

// Per-describe scoped emails for parallel-test isolation.
const TEST_EMAILS_POST = [
  'inv-post-admin@test.invalid',
  'inv-post-user@test.invalid',
];
const TEST_EMAILS_GET = [
  'inv-get-admin@test.invalid',
  'inv-get-consumer@test.invalid',
];
const TEST_EMAILS_DELETE = [
  'inv-del-admin@test.invalid',
  'inv-del-consumer@test.invalid',
];
const TEST_EMAILS_CSRF = ['inv-csrf-admin@test.invalid'];

describe('admin invites routes — POST /api/v1/admin/invites', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId_admin: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await prisma.invite.deleteMany({
      where: { createdBy: { email: { in: TEST_EMAILS_POST } } },
    });
    await cleanupTestUsers(prisma, TEST_EMAILS_POST);

    const adm = await createTestUser(prisma, { email: 'inv-post-admin@test.invalid' });
    userId_admin = adm.id;
    await prisma.user.update({
      where: { id: userId_admin },
      data: { role: 'admin' },
    });

    await createTestUser(prisma, { email: 'inv-post-user@test.invalid' });
  });

  beforeEach(async () => {
    for (const email of TEST_EMAILS_POST) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
  });

  afterAll(async () => {
    await prisma.invite.deleteMany({
      where: { createdById: { in: [userId_admin] } },
    });
    await cleanupTestUsers(prisma, TEST_EMAILS_POST);
    await prisma.$disconnect();
    await redis.quit();
  });

  // Test 1: POST happy → 201 + token visible only on creation; hash chain verified.
  it('POST happy — admin creates invite → 201 with id, expiresAt, token; token hashes to stored hash', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'inv-post-admin@test.invalid');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/invites',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      email: string | null;
      expiresAt: string;
      token: string;
    };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.email).toBeNull();
    expect(typeof body.expiresAt).toBe('string');
    expect(body.token).toBeTruthy();
    // base64url charset (no padding).
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);

    // Verify the token-hash chain: stored hash equals hashInviteToken(token, pepper).
    const stored = await prisma.invite.findUnique({
      where: { id: body.id },
      select: { token: true },
    });
    expect(stored).not.toBeNull();
    expect(stored!.token).toBe(
      hashInviteToken(body.token, Buffer.from(config.SESSION_SECRET)),
    );
    await app.close();
  });

  // Test 2: POST with email → invite is email-bound.
  it('POST with email — response shows the bound email', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'inv-post-admin@test.invalid');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/invites',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
      payload: { email: 'invitee-bound@test.invalid' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { email: string };
    expect(body.email).toBe('invitee-bound@test.invalid');
    await app.close();
  });

  // Test 3: POST with expiresInHours=48 → expiresAt ~ now+48h (±1 minute slack).
  it('POST with expiresInHours=48 — expiresAt is approximately now+48h', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'inv-post-admin@test.invalid');
    const beforeMs = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/invites',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
      payload: { expiresInHours: 48 },
    });
    const afterMs = Date.now();
    expect(res.statusCode).toBe(201);
    const body = res.json() as { expiresAt: string };
    const expiresMs = new Date(body.expiresAt).getTime();
    const fortyEightHoursMs = 48 * 3600_000;
    // Allow ±1 minute slack around now+48h, computed against the
    // [beforeMs, afterMs] capture window.
    const lower = beforeMs + fortyEightHoursMs - 60_000;
    const upper = afterMs + fortyEightHoursMs + 60_000;
    expect(expiresMs).toBeGreaterThanOrEqual(lower);
    expect(expiresMs).toBeLessThanOrEqual(upper);
    await app.close();
  });

  // Test 4: POST as non-admin → 403 FORBIDDEN.
  it('POST as non-admin → 403 FORBIDDEN', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'inv-post-user@test.invalid');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/invites',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await app.close();
  });

  // Test 5: POST without auth → 401.
  it('POST without auth → 401', async () => {
    const app = await buildServer(config);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/invites',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    await app.close();
  });
});

describe('admin invites routes — GET /api/v1/admin/invites', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId_admin: string;
  let userId_consumer: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await prisma.invite.deleteMany({
      where: { createdBy: { email: { in: TEST_EMAILS_GET } } },
    });
    await cleanupTestUsers(prisma, TEST_EMAILS_GET);

    const adm = await createTestUser(prisma, { email: 'inv-get-admin@test.invalid' });
    userId_admin = adm.id;
    await prisma.user.update({
      where: { id: userId_admin },
      data: { role: 'admin' },
    });

    const c = await createTestUser(prisma, { email: 'inv-get-consumer@test.invalid' });
    userId_consumer = c.id;
  });

  beforeEach(async () => {
    for (const email of TEST_EMAILS_GET) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
    // Reset invites between tests for predictable assertions.
    await prisma.invite.deleteMany({
      where: { createdById: { in: [userId_admin] } },
    });
  });

  afterAll(async () => {
    await prisma.invite.deleteMany({
      where: { createdById: { in: [userId_admin] } },
    });
    await cleanupTestUsers(prisma, TEST_EMAILS_GET);
    await prisma.$disconnect();
    await redis.quit();
  });

  // Test 6: GET happy — lists active + consumed invites; raw token NOT in response.
  it('GET happy — lists active + consumed invites without exposing the raw token', async () => {
    // Seed two invites: one active, one consumed.
    const activeInvite = await prisma.invite.create({
      data: {
        token: 'a'.repeat(64), // dummy hash hex
        createdById: userId_admin,
        expiresAt: new Date(Date.now() + 3600_000),
      },
      select: { id: true },
    });
    const consumedInvite = await prisma.invite.create({
      data: {
        token: 'b'.repeat(64),
        createdById: userId_admin,
        expiresAt: new Date(Date.now() + 7200_000),
        consumedAt: new Date(),
        consumedById: userId_consumer,
      },
      select: { id: true },
    });

    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'inv-get-admin@test.invalid');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/invites',
      headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        id: string;
        email: string | null;
        expiresAt: string;
        consumedAt: string | null;
        token?: unknown;
      }>;
    };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(activeInvite.id);
    expect(ids).toContain(consumedInvite.id);

    // None of the items must expose the raw token (or even the stored hash).
    for (const item of body.items) {
      expect(item).not.toHaveProperty('token');
    }

    // Active item: consumedAt=null. Consumed item: consumedAt set.
    const activeItem = body.items.find((i) => i.id === activeInvite.id)!;
    const consumedItem = body.items.find((i) => i.id === consumedInvite.id)!;
    expect(activeItem.consumedAt).toBeNull();
    expect(consumedItem.consumedAt).not.toBeNull();
    await app.close();
  });
});

describe('admin invites routes — DELETE /api/v1/admin/invites/:id', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId_admin: string;
  let userId_consumer: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await prisma.invite.deleteMany({
      where: { createdBy: { email: { in: TEST_EMAILS_DELETE } } },
    });
    await cleanupTestUsers(prisma, TEST_EMAILS_DELETE);

    const adm = await createTestUser(prisma, { email: 'inv-del-admin@test.invalid' });
    userId_admin = adm.id;
    await prisma.user.update({
      where: { id: userId_admin },
      data: { role: 'admin' },
    });

    const c = await createTestUser(prisma, { email: 'inv-del-consumer@test.invalid' });
    userId_consumer = c.id;
  });

  beforeEach(async () => {
    for (const email of TEST_EMAILS_DELETE) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
    await prisma.invite.deleteMany({
      where: { createdById: { in: [userId_admin] } },
    });
  });

  afterAll(async () => {
    await prisma.invite.deleteMany({
      where: { createdById: { in: [userId_admin] } },
    });
    await cleanupTestUsers(prisma, TEST_EMAILS_DELETE);
    await prisma.$disconnect();
    await redis.quit();
  });

  // Test 7: DELETE consumed invite → 404 NOT_FOUND.
  it('DELETE consumed invite → 404 NOT_FOUND (cannot revoke a consumed invite)', async () => {
    const consumed = await prisma.invite.create({
      data: {
        token: 'c'.repeat(64),
        createdById: userId_admin,
        expiresAt: new Date(Date.now() + 3600_000),
        consumedAt: new Date(),
        consumedById: userId_consumer,
      },
      select: { id: true },
    });

    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'inv-del-admin@test.invalid');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/invites/${consumed.id}`,
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    // Sanity: row is still there (consumed invites must not be silently deleted).
    const stillThere = await prisma.invite.findUnique({
      where: { id: consumed.id },
      select: { id: true },
    });
    expect(stillThere).not.toBeNull();
    await app.close();
  });

  // Test 8: DELETE active invite → 204; row gone afterwards.
  it('DELETE active invite → 204; row is removed', async () => {
    const active = await prisma.invite.create({
      data: {
        token: 'd'.repeat(64),
        createdById: userId_admin,
        expiresAt: new Date(Date.now() + 3600_000),
      },
      select: { id: true },
    });

    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'inv-del-admin@test.invalid');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/invites/${active.id}`,
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
    });
    expect(res.statusCode).toBe(204);

    const fromDb = await prisma.invite.findUnique({
      where: { id: active.id },
      select: { id: true },
    });
    expect(fromDb).toBeNull();
    await app.close();
  });

  // Test 9: DELETE non-existent invite-id → 404.
  it('DELETE non-existent invite-id (valid UUID, no row) → 404 NOT_FOUND', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'inv-del-admin@test.invalid');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/invites/00000000-0000-4000-8000-000000000000',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await app.close();
  });
});

describe('admin invites routes — AP1 CSRF guard', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId_admin: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await prisma.invite.deleteMany({
      where: { createdBy: { email: { in: TEST_EMAILS_CSRF } } },
    });
    await cleanupTestUsers(prisma, TEST_EMAILS_CSRF);

    const adm = await createTestUser(prisma, { email: 'inv-csrf-admin@test.invalid' });
    userId_admin = adm.id;
    await prisma.user.update({
      where: { id: userId_admin },
      data: { role: 'admin' },
    });
  });

  beforeEach(async () => {
    for (const email of TEST_EMAILS_CSRF) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
  });

  afterAll(async () => {
    await prisma.invite.deleteMany({
      where: { createdById: { in: [userId_admin] } },
    });
    await cleanupTestUsers(prisma, TEST_EMAILS_CSRF);
    await prisma.$disconnect();
    await redis.quit();
  });

  // AP1 PFLICHT-REGRESSIONSTEST
  // Test 10: Cookie-Admin POST WITHOUT X-CSRF-Token → 403 AUTH_INVALID.
  // Verifies that the state-changing POST /admin/invites still enforces CSRF
  // for cookie-auth, even after passing the role-check. Without this guard a
  // logged-in admin would be vulnerable to CSRF on every invite-create.
  it('AP1 PFLICHT-REGRESSIONSTEST: Cookie-admin POST WITHOUT X-CSRF-Token → 403 AUTH_INVALID', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'inv-csrf-admin@test.invalid');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/invites',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        // INTENTIONAL: no x-csrf-token header.
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
    await app.close();
  });

  // AP1 PFLICHT-REGRESSIONSTEST (supplemental)
  // Test 11: Cookie-Admin DELETE WITHOUT X-CSRF-Token → 403 AUTH_INVALID.
  // DELETE is also state-changing and must enforce CSRF for cookie-auth.
  it('AP1 PFLICHT-REGRESSIONSTEST: Cookie-admin DELETE WITHOUT X-CSRF-Token → 403 AUTH_INVALID', async () => {
    // Seed one invite so the route reaches the CSRF check (the route would
    // also CSRF-fail on a non-existent id, but seeding is more honest about
    // the intent: "active invite, missing CSRF, NOT a 404").
    const active = await prisma.invite.create({
      data: {
        token: 'e'.repeat(64),
        createdById: userId_admin,
        expiresAt: new Date(Date.now() + 3600_000),
      },
      select: { id: true },
    });

    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'inv-csrf-admin@test.invalid');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/invites/${active.id}`,
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        // INTENTIONAL: no x-csrf-token header.
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });

    // Sanity: invite still exists since CSRF blocked the delete.
    const stillThere = await prisma.invite.findUnique({
      where: { id: active.id },
      select: { id: true },
    });
    expect(stillThere).not.toBeNull();
    await app.close();
  });
});
