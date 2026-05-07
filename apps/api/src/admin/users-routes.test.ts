import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
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
const TEST_EMAILS_LIST = [
  'au-list-admin@test.invalid',
  'au-list-user@test.invalid',
  'au-list-u1@test.invalid',
  'au-list-u2@test.invalid',
];
const TEST_EMAILS_PATCH = [
  'au-patch-admin@test.invalid',
  'au-patch-target@test.invalid',
];
const TEST_EMAILS_CSRF = [
  'au-csrf-admin@test.invalid',
  'au-csrf-target@test.invalid',
];

describe('admin users routes — GET /api/v1/admin/users', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId_admin: string;
  let userId_u1: string;
  let userId_u2: string;
  let userId_user: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS_LIST);

    const adm = await createTestUser(prisma, { email: 'au-list-admin@test.invalid' });
    userId_admin = adm.id;
    await prisma.user.update({
      where: { id: userId_admin },
      data: { role: 'admin' },
    });

    const u = await createTestUser(prisma, { email: 'au-list-user@test.invalid' });
    userId_user = u.id;

    const u1 = await createTestUser(prisma, { email: 'au-list-u1@test.invalid' });
    userId_u1 = u1.id;
    const u2 = await createTestUser(prisma, { email: 'au-list-u2@test.invalid' });
    userId_u2 = u2.id;
  });

  beforeEach(async () => {
    for (const email of TEST_EMAILS_LIST) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS_LIST);
    await prisma.$disconnect();
    await redis.quit();
  });

  // Test 1: Non-admin user → 403 FORBIDDEN.
  it('GET as non-admin user → 403 FORBIDDEN', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'au-list-user@test.invalid');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    await app.close();
  });

  // Test 2: GET happy — paginate with limit=2.
  it('GET happy path — admin lists users with limit=2 paginates with nextCursor', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'au-list-admin@test.invalid');

    // Filter to only the seeded users so unrelated users in the DB don't break the assertion.
    const seededIds = new Set([userId_admin, userId_u1, userId_u2, userId_user]);

    // First page: limit=2.
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users?limit=2',
      headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json() as {
      items: Array<{ id: string; email: string; storageQuota: string }>;
      nextCursor: string | null;
    };
    expect(Array.isArray(body1.items)).toBe(true);
    expect(body1.items.length).toBe(2);
    // BigInt-as-string in response.
    expect(typeof body1.items[0]!.storageQuota).toBe('string');
    // nextCursor must be present since there are more users than 2 in DB.
    expect(body1.nextCursor).not.toBeNull();
    expect(typeof body1.nextCursor).toBe('string');

    // Walk pages until we've found all four seeded users.
    const collected = new Set<string>();
    for (const item of body1.items) {
      if (seededIds.has(item.id)) collected.add(item.id);
    }

    let cursor: string | null = body1.nextCursor;
    let safety = 50;
    while (cursor && collected.size < seededIds.size && safety-- > 0) {
      const next = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/users?limit=2&cursor=${encodeURIComponent(cursor)}`,
        headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
      });
      expect(next.statusCode).toBe(200);
      const body = next.json() as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      for (const item of body.items) {
        if (seededIds.has(item.id)) collected.add(item.id);
      }
      cursor = body.nextCursor;
    }

    expect(collected.size).toBe(seededIds.size);
    await app.close();
  });

  // Test 3: GET with cursor — second page omits the first item.
  it('GET with cursor — second page omits the first-page items; final page has nextCursor=null', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'au-list-admin@test.invalid');

    const res1 = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users?limit=2',
      headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json() as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(body1.nextCursor).not.toBeNull();
    const firstPageIds = body1.items.map((i) => i.id);

    const res2 = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users?limit=2&cursor=${encodeURIComponent(body1.nextCursor!)}`,
      headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json() as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    // Second page must not include any first-page ids (cursor is exclusive via skip:1).
    for (const item of body2.items) {
      expect(firstPageIds).not.toContain(item.id);
    }

    // Walk to the final page using a large limit to ensure nextCursor=null.
    const resAll = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users?limit=100',
      headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
    });
    expect(resAll.statusCode).toBe(200);
    const bodyAll = resAll.json() as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(bodyAll.nextCursor).toBeNull();
    await app.close();
  });
});

describe('admin users routes — PATCH /api/v1/admin/users/:id', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId_admin: string;
  let userId_target: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS_PATCH);

    const adm = await createTestUser(prisma, { email: 'au-patch-admin@test.invalid' });
    userId_admin = adm.id;
    await prisma.user.update({
      where: { id: userId_admin },
      data: { role: 'admin' },
    });

    const t = await createTestUser(prisma, { email: 'au-patch-target@test.invalid' });
    userId_target = t.id;
  });

  beforeEach(async () => {
    for (const email of TEST_EMAILS_PATCH) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
    // Reset target user to known state between tests.
    await prisma.user.update({
      where: { id: userId_target },
      data: {
        status: 'active',
        storageQuota: 21474836480n,
        parallelQuota: 3,
        hourlyQuota: 30,
      },
    });
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS_PATCH);
    await prisma.$disconnect();
    await redis.quit();
  });

  // Test 4: PATCH status='disabled' — verify GET reflects.
  it('PATCH status=disabled — subsequent DB read shows status=disabled', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'au-patch-admin@test.invalid');
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${userId_target}`,
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
      payload: { status: 'disabled' },
    });
    expect(patch.statusCode).toBe(200);
    const patchBody = patch.json() as { id: string; status: string };
    expect(patchBody.status).toBe('disabled');

    const fromDb = await prisma.user.findUnique({
      where: { id: userId_target },
      select: { status: true },
    });
    expect(fromDb?.status).toBe('disabled');
    await app.close();
  });

  // Test 5: PATCH storageQuota — BigInt round-trip as string.
  it('PATCH storageQuota=1073741824 — response returns updated value as string', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'au-patch-admin@test.invalid');
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${userId_target}`,
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
      payload: { storageQuota: '1073741824' },
    });
    expect(patch.statusCode).toBe(200);
    const patchBody = patch.json() as { storageQuota: string };
    expect(typeof patchBody.storageQuota).toBe('string');
    expect(patchBody.storageQuota).toBe('1073741824');

    const fromDb = await prisma.user.findUnique({
      where: { id: userId_target },
      select: { storageQuota: true },
    });
    expect(fromDb?.storageQuota).toBe(1073741824n);
    await app.close();
  });

  // Test 6: PATCH on non-existent user-id → 404 NOT_FOUND.
  it('PATCH on non-existent user-id → 404 NOT_FOUND', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'au-patch-admin@test.invalid');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/00000000-0000-4000-8000-000000000000`,
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await app.close();
  });

  // Test 8: PATCH unauth → 401.
  it('PATCH unauth (no Bearer, no cookie) → 401', async () => {
    const app = await buildServer(config);
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${userId_target}`,
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    await app.close();
  });
});

describe('admin users routes — AP1 CSRF guard', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId_target: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS_CSRF);

    const adm = await createTestUser(prisma, { email: 'au-csrf-admin@test.invalid' });
    await prisma.user.update({
      where: { id: adm.id },
      data: { role: 'admin' },
    });

    const t = await createTestUser(prisma, { email: 'au-csrf-target@test.invalid' });
    userId_target = t.id;
  });

  beforeEach(async () => {
    for (const email of TEST_EMAILS_CSRF) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS_CSRF);
    await prisma.$disconnect();
    await redis.quit();
  });

  // AP1 PFLICHT-REGRESSIONSTEST
  // Test 7: Cookie-Admin sends PATCH WITHOUT X-CSRF-Token → 403 AUTH_INVALID.
  // Verifies that state-changing admin routes still enforce CSRF for cookie-auth,
  // even after passing the role-check. Without this guard a logged-in admin
  // would be vulnerable to CSRF on every admin PATCH.
  it('AP1 PFLICHT-REGRESSIONSTEST: Cookie-admin PATCH WITHOUT X-CSRF-Token → 403 AUTH_INVALID', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'au-csrf-admin@test.invalid');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${userId_target}`,
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        // INTENTIONAL: no x-csrf-token header.
      },
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
    await app.close();
  });
});
