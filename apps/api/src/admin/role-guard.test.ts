import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import {
  generateApiKey,
  generateSessionToken,
  hashApiKey,
  hashSessionToken,
} from '@mediacompressor/auth';
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

const apiKeyPepper = Buffer.from(config.API_KEY_PEPPER);
const sessionPepper = Buffer.from(config.SESSION_SECRET);

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

function registerAdminProbe(app: Awaited<ReturnType<typeof buildServer>>): void {
  app.register(async (instance) => {
    instance.get('/__test__/admin-only', async (req, reply) => {
      const id = await instance.requireAdmin(req, reply);
      if (!id) return;
      return { ok: true, userId: id };
    });
  });
}

function registerAdminCsrfProbe(app: Awaited<ReturnType<typeof buildServer>>): void {
  app.register(async (instance) => {
    instance.post('/__test__/admin-state-change', async (req, reply) => {
      const id = await instance.requireAdminCsrf(req, reply);
      if (!id) return;
      return reply.send({ ok: true, userId: id });
    });
  });
}

const TEST_EMAILS_REQ_ADMIN = [
  'rg-user@test.invalid',
  'rg-admin@test.invalid',
  'rg-disabled-admin@test.invalid',
];

describe('admin role-guard: requireAdmin', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId_admin: string;
  let userId_disabledAdmin: string;
  let apiKey_admin: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await prisma.pepperCanary.deleteMany();
    await cleanupTestUsers(prisma, TEST_EMAILS_REQ_ADMIN);

    // Plain user (role='user', status='active').
    await createTestUser(prisma, { email: 'rg-user@test.invalid' });

    // Active admin (role='admin', status='active').
    const adm = await createTestUser(prisma, { email: 'rg-admin@test.invalid' });
    userId_admin = adm.id;
    await prisma.user.update({
      where: { id: userId_admin },
      data: { role: 'admin' },
    });

    // Disabled admin (role='admin', status='disabled'). Note: createTestUser
    // sets status, but the role still has to be patched in via update.
    const dis = await createTestUser(prisma, {
      email: 'rg-disabled-admin@test.invalid',
      status: 'disabled',
    });
    userId_disabledAdmin = dis.id;
    await prisma.user.update({
      where: { id: userId_disabledAdmin },
      data: { role: 'admin' },
    });

    // API key for the active admin (Bearer-path test).
    const adminKey = generateApiKey();
    apiKey_admin = adminKey.key;
    await prisma.apiKey.create({
      data: {
        userId: userId_admin,
        name: 'admin-key',
        keyHash: hashApiKey(adminKey.key, apiKeyPepper),
        keyPrefix: adminKey.prefix,
        scopes: [],
      },
    });
  });

  beforeEach(async () => {
    // Reset login rate-limit counters for each cookie-flow test.
    for (const email of TEST_EMAILS_REQ_ADMIN) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS_REQ_ADMIN);
    await prisma.$disconnect();
    await redis.quit();
  });

  // Test 1: Non-admin user → 403 FORBIDDEN.
  it('Non-admin user (role=user) → 403 FORBIDDEN', async () => {
    const app = await buildServer(config);
    registerAdminProbe(app);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'rg-user@test.invalid');
    const res = await app.inject({
      method: 'GET',
      url: '/__test__/admin-only',
      headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'FORBIDDEN', message: 'admin role required' },
    });
    await app.close();
  });

  // Test 2: Admin user → 200 + userId.
  it('Admin user (role=admin, status=active) → 200 returns userId', async () => {
    const app = await buildServer(config);
    registerAdminProbe(app);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'rg-admin@test.invalid');
    const res = await app.inject({
      method: 'GET',
      url: '/__test__/admin-only',
      headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, userId: userId_admin });
    await app.close();
  });

  // Test 3: Disabled admin → 403 FORBIDDEN.
  // We insert a session-row directly (bypassing POST /login's status-check)
  // because the role-guard is what should catch the disabled state for
  // session-based auth — exactly what we want to verify here.
  it('Disabled admin (role=admin, status=disabled) → 403 FORBIDDEN', async () => {
    const app = await buildServer(config);
    registerAdminProbe(app);
    await app.ready();

    const sessionToken = generateSessionToken();
    await prisma.session.create({
      data: {
        userId: userId_disabledAdmin,
        tokenHash: hashSessionToken(sessionToken, sessionPepper),
        userAgent: 'test-agent',
        ip: '127.0.0.1',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/__test__/admin-only',
      cookies: { mc_session: sessionToken },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'FORBIDDEN', message: 'admin role required' },
    });
    await app.close();
  });

  // Test 4: Unauth → 401 AUTH_REQUIRED (delegated through requireAuth).
  it('Unauth (no Authorization, no cookie) → 401 AUTH_REQUIRED', async () => {
    const app = await buildServer(config);
    registerAdminProbe(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/__test__/admin-only',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    await app.close();
  });

  // Test 5: Bearer with admin role → 200.
  it('Bearer with admin role → 200 returns userId (api-key path smoke-test)', async () => {
    const app = await buildServer(config);
    registerAdminProbe(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/__test__/admin-only',
      headers: { authorization: `Bearer ${apiKey_admin}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, userId: userId_admin });
    await app.close();
  });
});

describe('admin role-guard: requireAdminCsrf', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId_admin: string;
  let apiKey_admin: string;

  const TEST_EMAILS_REQ_ADMIN_CSRF = ['rg-csrf-admin@test.invalid'];

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await prisma.pepperCanary.deleteMany();
    await cleanupTestUsers(prisma, TEST_EMAILS_REQ_ADMIN_CSRF);

    const adm = await createTestUser(prisma, { email: 'rg-csrf-admin@test.invalid' });
    userId_admin = adm.id;
    await prisma.user.update({
      where: { id: userId_admin },
      data: { role: 'admin' },
    });

    const adminKey = generateApiKey();
    apiKey_admin = adminKey.key;
    await prisma.apiKey.create({
      data: {
        userId: userId_admin,
        name: 'admin-csrf-key',
        keyHash: hashApiKey(adminKey.key, apiKeyPepper),
        keyPrefix: adminKey.prefix,
        scopes: [],
      },
    });
  });

  beforeEach(async () => {
    for (const email of TEST_EMAILS_REQ_ADMIN_CSRF) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS_REQ_ADMIN_CSRF);
    await prisma.$disconnect();
    await redis.quit();
  });

  // Test 6: Bearer-admin → bypasses CSRF, returns 200.
  it('Bearer-admin → bypasses CSRF, returns 200', async () => {
    const app = await buildServer(config);
    registerAdminCsrfProbe(app);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/__test__/admin-state-change',
      headers: { authorization: `Bearer ${apiKey_admin}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, userId: userId_admin });
    await app.close();
  });

  // AP1 PFLICHT-REGRESSIONSTEST
  // Test 7: Cookie-admin without X-CSRF-Token → 403 AUTH_INVALID.
  // Verifies that state-changing admin routes still enforce CSRF for cookie-auth,
  // even after passing the role-check. Without this guard a logged-in admin
  // would be vulnerable to CSRF on every admin POST/PATCH/DELETE.
  it('AP1 PFLICHT-REGRESSIONSTEST: Cookie-admin WITHOUT X-CSRF-Token → 403 AUTH_INVALID', async () => {
    const app = await buildServer(config);
    registerAdminCsrfProbe(app);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'rg-csrf-admin@test.invalid');
    const res = await app.inject({
      method: 'POST',
      url: '/__test__/admin-state-change',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
    await app.close();
  });
});
