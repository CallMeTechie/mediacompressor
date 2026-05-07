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

// Distinct test email so this suite is isolated from sibling suites that
// share the DB.
const TEST_EMAILS = ['hooksdispatch@b.com'];

const SHARED_SECRET = 'a'.repeat(64);

const config: Config = {
  DATABASE_URL: testDatabaseUrl(),
  REDIS_URL: testRedisUrl(),
  SESSION_SECRET: TEST_SESSION_SECRET,
  CSRF_SECRET: TEST_CSRF_SECRET,
  API_KEY_PEPPER: TEST_API_KEY_PEPPER,
  TUSD_SHARED_SECRET: SHARED_SECRET,
  TUSD_REQUIRE_SHARED_SECRET: true,
  TUSD_DATA_DIR: '/tmp/tusd-data',
  TUSD_FINAL_DIR: '/tmp/uploads',
  MEDIA_MOUNT_PATH: '/tmp',
  MIN_FREE_BYTES_RESERVE: 1n,
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  PORT: 0,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  ARGON2_MAX_CONCURRENCY: 8,
  ENABLE_LEGACY_JOB_STUB: false,
};

const apiKeyPepper = Buffer.from(config.API_KEY_PEPPER);

// tusd v2 single-URL hook body. The Type field selects the inner route.
function tusdBody(opts: {
  type: 'pre-create' | 'post-finish' | string;
  uploadLength: number;
  uploadId?: string;
  metadata?: Record<string, string>;
}) {
  return {
    Type: opts.type,
    Event: {
      Upload: {
        ID: opts.uploadId ?? '',
        Size: opts.uploadLength,
        MetaData: opts.metadata ?? {},
      },
    },
  };
}

describe('tusd hooks-dispatcher — POST /api/v1/internal/uploads/hooks', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);

    const u = await createTestUser(prisma, { email: 'hooksdispatch@b.com' });
    userId = u.id;
    await prisma.user.update({
      where: { id: userId },
      data: {
        storageQuota: 1_000_000n,
        parallelQuota: 100,
        hourlyQuota: 1000,
      },
    });

    const seeded = generateApiKey();
    apiKey = seeded.key;
    await prisma.apiKey.create({
      data: {
        userId,
        name: 'hooksdispatch-test',
        keyHash: hashApiKey(seeded.key, apiKeyPepper),
        keyPrefix: seeded.prefix,
        scopes: ['jobs:write'],
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

  it('Type=pre-create routes to pre-create-hook, returns 200 + ChangeFileInfo.ID', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks',
        headers: {
          'x-tusd-shared-secret': SHARED_SECRET,
          authorization: `Bearer ${apiKey}`,
        },
        payload: tusdBody({
          type: 'pre-create',
          uploadLength: 1000,
          metadata: {
            filename: 'foo.png',
            kind: 'image',
            profile: 'web-optimized',
          },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        ChangeFileInfo: { ID: string };
      };
      expect(body.ChangeFileInfo.ID).toMatch(/^[0-9a-f-]{36}$/);

      const job = await prisma.job.findUnique({
        where: { id: body.ChangeFileInfo.ID },
      });
      expect(job).not.toBeNull();
      expect(job!.status).toBe('uploading');
    } finally {
      await app.close();
    }
  });

  it('forwards error envelope: pre-create with bad extension → 400 UNSUPPORTED_INPUT_FORMAT', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks',
        headers: {
          'x-tusd-shared-secret': SHARED_SECRET,
          authorization: `Bearer ${apiKey}`,
        },
        payload: tusdBody({
          type: 'pre-create',
          uploadLength: 1000,
          metadata: {
            filename: 'evil.exe',
            kind: 'image',
            profile: 'web-optimized',
          },
        }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: { code: 'UNSUPPORTED_INPUT_FORMAT' },
      });
    } finally {
      await app.close();
    }
  });

  it('forwards 401 when shared-secret missing on pre-create dispatch', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: tusdBody({
          type: 'pre-create',
          uploadLength: 1000,
          metadata: {
            filename: 'foo.png',
            kind: 'image',
            profile: 'web-optimized',
          },
        }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    } finally {
      await app.close();
    }
  });

  it('unknown Type (e.g. post-create) → 200 no-op (tusd retries 5xx, must not retry unknown events)', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks',
        headers: { 'x-tusd-shared-secret': SHARED_SECRET },
        payload: tusdBody({
          type: 'post-create',
          uploadLength: 1000,
        }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
    } finally {
      await app.close();
    }
  });

  it('missing Type → 200 no-op (defensive — tusd v2 always sends Type, but be lenient)', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks',
        headers: { 'x-tusd-shared-secret': SHARED_SECRET },
        payload: { Event: { Upload: { ID: '', Size: 0, MetaData: {} } } },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
