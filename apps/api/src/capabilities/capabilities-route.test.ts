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

// Per-describe scoped emails for parallel-test isolation (H2-Fix-Pattern).
const TEST_EMAILS = ['capabilities@b.com'];

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

describe('capabilities route — GET /api/v1/capabilities (Plan 7 Task 1)', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);

    const u = await createTestUser(prisma, { email: 'capabilities@b.com' });
    userId = u.id;

    const seeded = generateApiKey();
    apiKey = seeded.key;
    await prisma.apiKey.create({
      data: {
        userId,
        name: 'capabilities-test',
        keyHash: hashApiKey(seeded.key, apiKeyPepper),
        keyPrefix: seeded.prefix,
        scopes: ['jobs:read'],
      },
    });
  });

  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { userId } });
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

  /**
   * Seed a Job row directly via Prisma. Mirrors `seedJob` in jobs-routes.test.ts —
   * sets all required fields on the Job row so the row is valid for aggregations.
   */
  async function seedJob(opts: {
    status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'expired' | 'uploading';
    reservedBytes?: bigint;
    outputBytes?: bigint;
    expiresAt?: Date | null;
  }) {
    return prisma.job.create({
      data: {
        userId,
        status: opts.status,
        kind: 'image',
        profile: 'web-optimized',
        overrides: {},
        inputFilename: 'in.bin',
        uploadId: `cap-${Math.random().toString(36).slice(2)}-${Date.now()}`,
        ...(opts.reservedBytes !== undefined ? { reservedBytes: opts.reservedBytes } : {}),
        ...(opts.outputBytes !== undefined ? { outputBytes: opts.outputBytes } : {}),
        ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      },
    });
  }

  // AP2 PFLICHT-REGRESSIONSTEST: Without Authorization header → 200 with anonymous
  // subset (no `quota` field). Supports Plan-8 pre-login UI: discovery is best-effort
  // and MUST work without auth so the SPA can render profile-pickers / format-pickers
  // before the user logs in.
  it('AP2: without Authorization header → 200 with anonymous subset (no quota field)', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('imageProfiles');
      expect(body).toHaveProperty('videoProfiles');
      expect(body).toHaveProperty('allowedInputMimes');
      expect(body).toHaveProperty('allowedOutputFormats');
      expect(body).toHaveProperty('limits');
      // Critical: anonymous responses MUST NOT carry quota.
      expect(body).not.toHaveProperty('quota');
    } finally {
      await app.close();
    }
  });

  it('with invalid Bearer token → 200 anonymous subset (NOT 401)', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/capabilities',
        headers: { authorization: 'Bearer not-a-real-key' },
      });
      // Capabilities is best-effort discovery — invalid auth must not 401.
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('quota');
    } finally {
      await app.close();
    }
  });

  it('with valid Bearer-API-Key → 200 with quota subset', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/capabilities',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        imageProfiles: string[];
        videoProfiles: string[];
        allowedInputMimes: string[];
        allowedOutputFormats: string[];
        limits: { maxUploadBytes: string };
        quota: {
          limits: { storageBytes: string; parallel: number; hourly: number };
          used: { storageBytes: string; parallel: number; hourly: number };
        };
      };
      expect(body.imageProfiles).toBeDefined();
      expect(body.videoProfiles).toBeDefined();
      expect(body.allowedInputMimes).toBeDefined();
      expect(body.allowedOutputFormats).toBeDefined();
      expect(body.limits).toBeDefined();
      expect(body.quota).toBeDefined();
      // BigInt-as-string convention (mirrors toPublicJob in jobs-routes.ts).
      expect(typeof body.quota.limits.storageBytes).toBe('string');
      expect(typeof body.quota.used.storageBytes).toBe('string');
    } finally {
      await app.close();
    }
  });

  it('limits.maxUploadBytes === "2147483648" (2 GiB as String)', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { limits: { maxUploadBytes: string } };
      expect(body.limits.maxUploadBytes).toBe('2147483648');
    } finally {
      await app.close();
    }
  });

  it('quota.used.storageBytes reflects sum of in-flight reservedBytes + succeeded outputBytes', async () => {
    const app = await buildServer(config);
    try {
      // One queued job with reservedBytes=1000n
      await seedJob({ status: 'queued', reservedBytes: 1000n });
      // One succeeded non-expired job with outputBytes=2000n
      await seedJob({
        status: 'succeeded',
        outputBytes: 2000n,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/capabilities',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        quota: { used: { storageBytes: string } };
      };
      expect(body.quota.used.storageBytes).toBe('3000');
    } finally {
      await app.close();
    }
  });

  it('quota.limits matches the seeded user row defaults', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/capabilities',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        quota: { limits: { storageBytes: string; parallel: number; hourly: number } };
      };
      // User defaults from prisma schema: storageQuota=21474836480, parallelQuota=3, hourlyQuota=30.
      expect(body.quota.limits.storageBytes).toBe('21474836480');
      expect(body.quota.limits.parallel).toBe(3);
      expect(body.quota.limits.hourly).toBe(30);
    } finally {
      await app.close();
    }
  });
});
