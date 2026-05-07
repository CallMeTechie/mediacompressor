import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { generateApiKey, hashApiKey } from '@mediacompressor/auth';
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

const TEST_EMAILS = ['apikey@b.com'];

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
  ENABLE_LEGACY_JOB_STUB: false,
};

const apiKeyPepper = Buffer.from(config.API_KEY_PEPPER);

interface LoginCreds {
  session: string;
  csrfCookie: string;
  csrfToken: string;
}

async function loginAndGetCreds(
  app: Awaited<ReturnType<typeof buildServer>>,
): Promise<LoginCreds> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'apikey@b.com', password: 'hunter22hunter22' },
  });
  if (login.statusCode !== 200) {
    throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  }
  const session = login.cookies.find((c) => c.name === 'mc_session')!.value;
  const csrfCookie = login.cookies.find((c) => c.name === 'mc_csrf')!.value;
  const csrfToken = (login.json() as { csrfToken: string }).csrfToken;
  return { session, csrfCookie, csrfToken };
}

describe('api-key routes', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await prisma.pepperCanary.deleteMany();
    await cleanupTestUsers(prisma, TEST_EMAILS);
    const u = await createTestUser(prisma, { email: 'apikey@b.com' });
    userId = u.id;
  });

  beforeEach(async () => {
    // Clear login rate-limit counters so multiple tests can each log in fresh.
    await redis.del('ratelimit:login:ip:127.0.0.1');
    await redis.del('ratelimit:login:acct:apikey@b.com');
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

  it('POST without session → 401', async () => {
    const app = await buildServer(config);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/api-keys',
      payload: { name: 'no-auth' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('POST with session WITHOUT X-CSRF-Token → 403', async () => {
    const app = await buildServer(config);
    const creds = await loginAndGetCreds(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/api-keys',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
      },
      payload: { name: 'no-csrf' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
    await app.close();
  });

  it('POST with session + valid X-CSRF-Token → 201, returns full key with mc_ prefix', async () => {
    const app = await buildServer(config);
    const creds = await loginAndGetCreds(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/api-keys',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
      payload: { name: 'session-csrf' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      name: string;
      keyPrefix: string;
      key: string;
      createdAt: string;
    };
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('session-csrf');
    expect(body.key).toMatch(/^mc_/);
    expect(body.keyPrefix).toBeTruthy();
    expect(body.createdAt).toBeTruthy();
    await app.close();
  });

  it('POST with Bearer-API-Key (instead of session) → 201 without CSRF (Bearer is CSRF-immune)', async () => {
    const app = await buildServer(config);
    // Seed a Bearer key directly.
    const seeded = generateApiKey();
    await prisma.apiKey.create({
      data: {
        userId,
        name: 'bearer-seed',
        keyHash: hashApiKey(seeded.key, apiKeyPepper),
        keyPrefix: seeded.prefix,
        scopes: ['jobs:write', 'jobs:read'],
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/api-keys',
      headers: { authorization: `Bearer ${seeded.key}` },
      payload: { name: 'bearer-csrf-immune' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { key: string; name: string };
    expect(body.name).toBe('bearer-csrf-immune');
    expect(body.key).toMatch(/^mc_/);
    await app.close();
  });

  it('GET shows keyPrefix, NOT the plaintext key', async () => {
    const app = await buildServer(config);
    const creds = await loginAndGetCreds(app);

    // Ensure at least one key exists.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/api-keys',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
      payload: { name: 'list-test' },
    });
    expect(created.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/api-keys',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
      },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      items: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item).toHaveProperty('keyPrefix');
      expect(item).not.toHaveProperty('key');
      expect(item).not.toHaveProperty('keyHash');
    }
    await app.close();
  });

  it('DELETE → 204; subsequent GET shows revokedAt', async () => {
    const app = await buildServer(config);
    const creds = await loginAndGetCreds(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/api-keys',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
      payload: { name: 'to-revoke' },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/users/me/api-keys/${id}`,
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
        'x-csrf-token': creds.csrfToken,
      },
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/api-keys',
      headers: {
        cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}`,
      },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      items: Array<{ id: string; revokedAt: string | null }>;
    };
    const found = body.items.find((it) => it.id === id);
    expect(found).toBeDefined();
    expect(found!.revokedAt).not.toBeNull();
    await app.close();
  });
});
