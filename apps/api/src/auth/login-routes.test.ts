import IORedis from 'ioredis';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
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
import { buildServer } from '../server.js';
import type { Config } from '../config.js';

const TEST_EMAILS = ['login@b.com', 'nonexistent@nowhere.invalid'];

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
};

describe('login flow', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await prisma.pepperCanary.deleteMany();
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await createTestUser(prisma, { email: 'login@b.com' });
  });

  beforeEach(async () => {
    await resetLoginRateLimits(redis, TEST_EMAILS);
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await redis.quit();
    await prisma.$disconnect();
  });

  it('login + me + logout flow', async () => {
    const app = await buildServer(config);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'login@b.com', password: 'hunter22hunter22' },
    });
    expect(login.statusCode).toBe(200);
    const cookieHeader = login.cookies.find((c) => c.name === 'mc_session');
    expect(cookieHeader).toBeDefined();
    const token = cookieHeader!.value;

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { mc_session: token },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'login@b.com' });

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { mc_session: token },
    });
    expect(out.statusCode).toBe(204);

    const meAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { mc_session: token },
    });
    expect(meAfter.statusCode).toBe(401);

    await app.close();
  });

  it('login fails with wrong password', async () => {
    const app = await buildServer(config);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'login@b.com', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // C8-Rev2 PFLICHT-REGRESSIONSTEST — Self-DoS-Schutz
  it('C8-Rev2: 6 erfolgreiche Logins in Serie locken den Account NICHT', async () => {
    const app = await buildServer(config);
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'login@b.com', password: 'hunter22hunter22' },
      });
      expect(res.statusCode).toBe(200); // KEIN 429 nach dem 5. Versuch
    }
    await app.close();
  });

  // C8-Rev2 — Negativ-Test: Failures locken weiter wie spezifiziert
  it('C8-Rev2: 6 fehlerhafte Logins → 6. ist 429 (Counter NICHT zurückgesetzt)', async () => {
    const app = await buildServer(config);
    let last = 200;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'login@b.com', password: 'wrong-pw' },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429); // 6. Failure muss locked sein
    await app.close();
  });

  // C13-Rev2 PFLICHT-REGRESSIONSTEST — Dummy-Hash-Parseability
  it('C13-Rev2: Login mit nicht existentem User wirft NICHT (Dummy-Hash ist parseable)', async () => {
    const app = await buildServer(config);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nonexistent@nowhere.invalid', password: 'whatever123' },
    });
    expect(res.statusCode).toBe(401); // Nicht 500 — kein Format-Error im verify
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
    await app.close();
  });
});
