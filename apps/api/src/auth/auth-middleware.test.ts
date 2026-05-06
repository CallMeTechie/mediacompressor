import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPrismaClient,
  type PrismaClient,
} from '@mediacompressor/db';
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

const TEST_EMAILS_REQ_AUTH = ['mw@test.invalid'];
const TEST_EMAILS_REQ_AUTH_CSRF = ['csrf@test.invalid'];

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

const sessionPepper = Buffer.from(config.SESSION_SECRET);
const apiKeyPepper = Buffer.from(config.API_KEY_PEPPER);

describe('auth middleware: requireAuth', () => {
  let prisma: PrismaClient;
  let userId: string;
  let validApiKey: string;
  let revokedApiKey: string;
  let validSessionToken: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    await prisma.pepperCanary.deleteMany();
    await cleanupTestUsers(prisma, TEST_EMAILS_REQ_AUTH);

    const u = await createTestUser(prisma, { email: 'mw@test.invalid' });
    userId = u.id;

    // Active key.
    const active = generateApiKey();
    validApiKey = active.key;
    await prisma.apiKey.create({
      data: {
        userId,
        name: 'active',
        keyHash: hashApiKey(active.key, apiKeyPepper),
        keyPrefix: active.prefix,
        scopes: [],
      },
    });

    // Revoked key.
    const revoked = generateApiKey();
    revokedApiKey = revoked.key;
    await prisma.apiKey.create({
      data: {
        userId,
        name: 'revoked',
        keyHash: hashApiKey(revoked.key, apiKeyPepper),
        keyPrefix: revoked.prefix,
        scopes: [],
        revokedAt: new Date(),
      },
    });

    // Active session.
    validSessionToken = generateSessionToken();
    await prisma.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(validSessionToken, sessionPepper),
        userAgent: 'test-agent',
        ip: '127.0.0.1',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS_REQ_AUTH);
    await prisma.$disconnect();
  });

  it('Bearer with valid API key resolves to userId with method=api-key', async () => {
    const app = await buildServer(config);
    app.get('/__test__/whoami', async (req, reply) => {
      const uid = await app.requireAuth(req, reply);
      if (!uid) return;
      return { userId: uid, method: req.auth?.method };
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/__test__/whoami',
      headers: { authorization: `Bearer ${validApiKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId, method: 'api-key' });
    await app.close();
  });

  it('Bearer with revoked key returns 401 AUTH_INVALID', async () => {
    const app = await buildServer(config);
    app.get('/__test__/whoami', async (req, reply) => {
      const uid = await app.requireAuth(req, reply);
      if (!uid) return;
      return { userId: uid };
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/__test__/whoami',
      headers: { authorization: `Bearer ${revokedApiKey}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
    await app.close();
  });

  it('Bearer with malformed key returns 401 AUTH_INVALID (constant-time miss path)', async () => {
    const app = await buildServer(config);
    app.get('/__test__/whoami', async (req, reply) => {
      const uid = await app.requireAuth(req, reply);
      if (!uid) return;
      return { userId: uid };
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/__test__/whoami',
      headers: { authorization: 'Bearer not-a-real-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
    await app.close();
  });

  it('Cookie session valid resolves to userId with method=session', async () => {
    const app = await buildServer(config);
    app.get('/__test__/whoami', async (req, reply) => {
      const uid = await app.requireAuth(req, reply);
      if (!uid) return;
      return { userId: uid, method: req.auth?.method };
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/__test__/whoami',
      cookies: { mc_session: validSessionToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId, method: 'session' });
    await app.close();
  });

  it('No auth → 401 AUTH_REQUIRED', async () => {
    const app = await buildServer(config);
    app.get('/__test__/whoami', async (req, reply) => {
      const uid = await app.requireAuth(req, reply);
      if (!uid) return;
      return { userId: uid };
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/__test__/whoami' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    await app.close();
  });
});

// C9-Rev2 PFLICHT-REGRESSIONSTEST: CSRF-Bypass-Schutz für state-changing Routes.
// requireAuthCsrf MUSS für Cookie-Sessions ohne X-CSRF-Token blocken (403),
// und Bearer-API-Key-Requests via skipCsrf durchlassen (200).
describe('auth middleware: requireAuthCsrf (C9-Rev2)', () => {
  let prisma: PrismaClient;
  let userId: string;
  let validApiKey: string;
  let validSessionToken: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    await prisma.pepperCanary.deleteMany();
    await cleanupTestUsers(prisma, TEST_EMAILS_REQ_AUTH_CSRF);

    const u = await createTestUser(prisma, { email: 'csrf@test.invalid' });
    userId = u.id;

    const active = generateApiKey();
    validApiKey = active.key;
    await prisma.apiKey.create({
      data: {
        userId,
        name: 'csrf-active',
        keyHash: hashApiKey(active.key, apiKeyPepper),
        keyPrefix: active.prefix,
        scopes: [],
      },
    });

    validSessionToken = generateSessionToken();
    await prisma.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(validSessionToken, sessionPepper),
        userAgent: 'test-agent',
        ip: '127.0.0.1',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS_REQ_AUTH_CSRF);
    await prisma.$disconnect();
  });

  it('Cookie session WITHOUT X-CSRF-Token → 403 AUTH_INVALID', async () => {
    const app = await buildServer(config);
    app.post('/__test__/state-change', async (req, reply) => {
      const uid = await app.requireAuthCsrf(req, reply);
      if (!uid) return;
      return reply.send({ ok: true, userId: uid });
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/__test__/state-change',
      cookies: { mc_session: validSessionToken },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
    await app.close();
  });

  it('Bearer API-Key WITHOUT X-CSRF-Token → 200 (skipCsrf bypass)', async () => {
    const app = await buildServer(config);
    app.post('/__test__/state-change', async (req, reply) => {
      const uid = await app.requireAuthCsrf(req, reply);
      if (!uid) return;
      return reply.send({ ok: true, userId: uid });
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/__test__/state-change',
      headers: { authorization: `Bearer ${validApiKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, userId });
    await app.close();
  });
});
