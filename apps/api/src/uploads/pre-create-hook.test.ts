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

// Distinct test email to keep these tests isolated from other suites that
// share the DB (jobs-routes.test.ts, pepper-canary-hook.test.ts, etc.).
const TEST_EMAILS = ['precreate@b.com'];

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
  // 1n effectively disables the disk-free check in tests.
  MIN_FREE_BYTES_RESERVE: 1n,
  TRUSTED_PROXY_CIDR: 'loopback',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  PORT: 0,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  ARGON2_MAX_CONCURRENCY: 8,
  ENABLE_LEGACY_JOB_STUB: false,
};

const apiKeyPepper = Buffer.from(config.API_KEY_PEPPER);

// Helper that builds the JSON body tusd v2 sends to the pre-create-hook.
function tusdHookBody(opts: { uploadLength: number; metadata?: Record<string, string> }) {
  return {
    Type: 'pre-create',
    Event: {
      Upload: {
        ID: '',
        Size: opts.uploadLength,
        MetaData: opts.metadata ?? {},
      },
    },
  };
}

describe('pre-create-hook — POST /api/v1/internal/uploads/hooks/pre-create', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);

    const u = await createTestUser(prisma, { email: 'precreate@b.com' });
    userId = u.id;
    // Modest storage quota so we can test QUOTA_STORAGE_EXCEEDED with a small
    // upload size. 1 MB quota; upload of 10 MB will exceed.
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
        name: 'precreate-test',
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

  it('without shared-secret → 401 AUTH_REQUIRED', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/pre-create',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: tusdHookBody({
          uploadLength: 1000,
          metadata: { filename: 'foo.png', kind: 'image', profile: 'web-optimized' },
        }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    } finally {
      await app.close();
    }
  });

  // UC5 PFLICHT-REGRESSIONSTEST — Bearer-API-Key required even with shared-secret.
  it('UC5: shared-secret OK, missing Authorization → 401 AUTH_REQUIRED', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/pre-create',
        headers: { 'x-tusd-shared-secret': SHARED_SECRET },
        payload: tusdHookBody({
          uploadLength: 1000,
          metadata: { filename: 'foo.png', kind: 'image', profile: 'web-optimized' },
        }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    } finally {
      await app.close();
    }
  });

  it('UC5: shared-secret OK, forged/revoked Authorization → 401 AUTH_INVALID', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/pre-create',
        headers: {
          'x-tusd-shared-secret': SHARED_SECRET,
          // Properly-shaped but unknown key — parseApiKey accepts the prefix
          // format but the hash lookup will miss → AUTH_INVALID.
          authorization: 'Bearer mc_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        payload: tusdHookBody({
          uploadLength: 1000,
          metadata: { filename: 'foo.png', kind: 'image', profile: 'web-optimized' },
        }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
    } finally {
      await app.close();
    }
  });

  it('happy path → 200 with ChangeFileInfo.ID, Job in DB with status=uploading', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/pre-create',
        headers: {
          'x-tusd-shared-secret': SHARED_SECRET,
          authorization: `Bearer ${apiKey}`,
        },
        payload: tusdHookBody({
          uploadLength: 1000,
          metadata: { filename: 'foo.png', kind: 'image', profile: 'web-optimized' },
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        ChangeFileInfo: { ID: string; MetaData: Record<string, string> };
      };
      expect(body.ChangeFileInfo.ID).toBeTruthy();
      expect(body.ChangeFileInfo.ID).toMatch(/^[0-9a-f-]{36}$/);

      const job = await prisma.job.findUnique({ where: { id: body.ChangeFileInfo.ID } });
      expect(job).not.toBeNull();
      expect(job!.status).toBe('uploading');
      expect(job!.userId).toBe(userId);
      expect(job!.uploadId).toBe(body.ChangeFileInfo.ID);
      expect(job!.kind).toBe('image');
      expect(job!.profile).toBe('web-optimized');
      expect(job!.inputFilename).toBe('foo.png');
      expect(job!.reservedBytes).toBe(1000n);
      expect(job!.precreateIdempotencyKey).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  // UC7 PFLICHT-REGRESSIONSTEST — MIME/Filename allowlist.
  it('UC7: filename evil.exe → 400 UNSUPPORTED_INPUT_FORMAT', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/pre-create',
        headers: {
          'x-tusd-shared-secret': SHARED_SECRET,
          authorization: `Bearer ${apiKey}`,
        },
        payload: tusdHookBody({
          uploadLength: 1000,
          metadata: { filename: 'evil.exe', kind: 'image', profile: 'web-optimized' },
        }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: { code: 'UNSUPPORTED_INPUT_FORMAT' },
      });
      // No Job written.
      const jobs = await prisma.job.findMany({ where: { userId } });
      expect(jobs).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('UC7: filename without extension → 400 UNSUPPORTED_INPUT_FORMAT', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/pre-create',
        headers: {
          'x-tusd-shared-secret': SHARED_SECRET,
          authorization: `Bearer ${apiKey}`,
        },
        payload: tusdHookBody({
          uploadLength: 1000,
          metadata: { filename: 'noextension', kind: 'image', profile: 'web-optimized' },
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

  it('oversized upload (over user storageQuota) → 413 QUOTA_STORAGE_EXCEEDED', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/pre-create',
        headers: {
          'x-tusd-shared-secret': SHARED_SECRET,
          authorization: `Bearer ${apiKey}`,
        },
        payload: tusdHookBody({
          // 10 MB > 1 MB quota.
          uploadLength: 10_000_000,
          metadata: { filename: 'big.png', kind: 'image', profile: 'web-optimized' },
        }),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({
        error: { code: 'QUOTA_STORAGE_EXCEEDED' },
      });
    } finally {
      await app.close();
    }
  });

  // UC12 PFLICHT-REGRESSIONSTEST — Hook-Retry idempotency.
  it('UC12: same hook body twice → same Job ID, exactly 1 row in DB', async () => {
    const app = await buildServer(config);
    try {
      const payload = tusdHookBody({
        uploadLength: 2000,
        metadata: { filename: 'idempotent.png', kind: 'image', profile: 'web-optimized' },
      });
      const headers = {
        'x-tusd-shared-secret': SHARED_SECRET,
        authorization: `Bearer ${apiKey}`,
      };

      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/pre-create',
        headers,
        payload,
      });
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/pre-create',
        headers,
        payload,
      });

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);
      const id1 = (res1.json() as { ChangeFileInfo: { ID: string } }).ChangeFileInfo.ID;
      const id2 = (res2.json() as { ChangeFileInfo: { ID: string } }).ChangeFileInfo.ID;
      expect(id1).toBe(id2);

      const jobs = await prisma.job.findMany({ where: { userId } });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.id).toBe(id1);
    } finally {
      await app.close();
    }
  });
});
