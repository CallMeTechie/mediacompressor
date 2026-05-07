import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
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

// Distinct test email so this suite is isolated from sibling suites that
// share the DB.
const TEST_EMAILS = ['postfinish@b.com'];

const SHARED_SECRET = 'a'.repeat(64);

// Minimal-1x1-PNG (valid magic header + IHDR + IDAT + IEND), base64-decoded.
// `file-type` reads the first ~4 KB and recognises the PNG signature.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';
const PNG_BUFFER = Buffer.from(PNG_BASE64, 'base64');

let tusdDataDir: string;
let tusdFinalDir: string;

function makeConfig(): Config {
  return {
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    SESSION_SECRET: TEST_SESSION_SECRET,
    CSRF_SECRET: TEST_CSRF_SECRET,
    API_KEY_PEPPER: TEST_API_KEY_PEPPER,
    TUSD_SHARED_SECRET: SHARED_SECRET,
  TUSD_REQUIRE_SHARED_SECRET: true,
    TUSD_DATA_DIR: tusdDataDir,
    TUSD_FINAL_DIR: tusdFinalDir,
    MEDIA_MOUNT_PATH: '/tmp',
    MIN_FREE_BYTES_RESERVE: 1n,
    TRUSTED_PROXY_CIDR: 'loopback',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    PORT: 0,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    ARGON2_MAX_CONCURRENCY: 8,
    ENABLE_LEGACY_JOB_STUB: false,
  };
}

// Build the JSON tusd v2 sends to the post-finish hook.
function tusdHookBody(opts: {
  uploadId: string;
  size: number;
  storagePath?: string;
  metadata?: Record<string, string>;
}) {
  return {
    Type: 'post-finish',
    Event: {
      Upload: {
        ID: opts.uploadId,
        Size: opts.size,
        Storage: opts.storagePath
          ? { Type: 'filestore', Path: opts.storagePath }
          : undefined,
        MetaData: opts.metadata ?? {},
      },
    },
  };
}

async function seedUploadingJob(
  prisma: PrismaClient,
  opts: { userId: string; reservedBytes?: bigint; profile?: string },
): Promise<{ id: string }> {
  const job = await prisma.job.create({
    data: {
      userId: opts.userId,
      status: 'uploading',
      kind: 'image',
      profile: opts.profile ?? 'web-optimized',
      overrides: {},
      inputFilename: 'foo.png',
      reservedBytes: opts.reservedBytes ?? 1000n,
      uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      // Placeholder uploadId — must be unique. Replace with id afterwards.
      uploadId: `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    select: { id: true },
  });
  // uploadId === id (Plan 5 Task 5 invariant).
  await prisma.job.update({
    where: { id: job.id },
    data: { uploadId: job.id },
  });
  return job;
}

describe('post-finish-hook — POST /api/v1/internal/uploads/hooks/post-finish', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId: string;

  beforeAll(async () => {
    tusdDataDir = mkdtempSync(join(tmpdir(), 'tusd-data-'));
    tusdFinalDir = mkdtempSync(join(tmpdir(), 'tusd-final-'));

    prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
    redis = new IORedis(testRedisUrl(), { maxRetriesPerRequest: null });
    await cleanupTestUsers(prisma, TEST_EMAILS);

    const u = await createTestUser(prisma, { email: 'postfinish@b.com' });
    userId = u.id;
    await prisma.user.update({
      where: { id: userId },
      data: {
        storageQuota: 100_000_000n,
        parallelQuota: 100,
        hourlyQuota: 1000,
      },
    });

  });

  beforeEach(async () => {
    // Scoped cleanup — DB rows for this user, AND any BullMQ-jobs whose id
    // points at one of those Job-rows. We DO NOT obliterate the whole queue:
    // sibling test files (jobs-routes.test.ts) run in parallel and use the
    // same `compression` queue; obliterate would race-delete their jobs.
    const oldJobIds = (
      await prisma.job.findMany({ where: { userId }, select: { id: true } })
    ).map((j) => j.id);
    await prisma.job.deleteMany({ where: { userId } });
    const q = new Queue('compression', { connection: redis });
    try {
      for (const id of oldJobIds) {
        const j = await q.getJob(id);
        if (j) await j.remove().catch(() => {});
      }
    } finally {
      await q.close();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
    rmSync(tusdDataDir, { recursive: true, force: true });
    rmSync(tusdFinalDir, { recursive: true, force: true });
  });

  it('without shared-secret → 401 AUTH_REQUIRED', async () => {
    const app = await buildServer(makeConfig());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/post-finish',
        payload: tusdHookBody({
          uploadId: '00000000-0000-0000-0000-000000000000',
          size: 100,
        }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    } finally {
      await app.close();
    }
  });

  it('uploadId not found → 404 NOT_FOUND', async () => {
    const app = await buildServer(makeConfig());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/post-finish',
        headers: { 'x-tusd-shared-secret': SHARED_SECRET },
        payload: tusdHookBody({
          uploadId: '00000000-0000-0000-0000-000000000000',
          size: 100,
        }),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    } finally {
      await app.close();
    }
  });

  it('Job already-completed (status=succeeded) → 200 idempotent (no move, no queue.add)', async () => {
    const job = await seedUploadingJob(prisma, { userId });
    // Flip the seeded job out of 'uploading' to simulate already-processed.
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'succeeded', uploadExpiresAt: null },
    });

    const tusdSrc = join(tusdDataDir, `${job.id}.bin`);
    writeFileSync(tusdSrc, PNG_BUFFER);

    const queueAddSpy = vi.spyOn(Queue.prototype, 'add');

    const app = await buildServer(makeConfig());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/post-finish',
        headers: { 'x-tusd-shared-secret': SHARED_SECRET },
        payload: tusdHookBody({
          uploadId: job.id,
          size: PNG_BUFFER.length,
          storagePath: tusdSrc,
        }),
      });
      expect(res.statusCode).toBe(200);

      // Source file untouched (no move).
      expect(existsSync(tusdSrc)).toBe(true);
      // No final file created.
      const finalPath = join(tusdFinalDir, userId, job.id, 'source.bin');
      expect(existsSync(finalPath)).toBe(false);
      // Queue.add NOT called.
      expect(queueAddSpy).not.toHaveBeenCalled();

      const after = await prisma.job.findUnique({ where: { id: job.id } });
      expect(after!.status).toBe('succeeded');
    } finally {
      await app.close();
    }
  });

  it('happy path → 200, file moved, Job updated to queued, BullMQ has 1 job', async () => {
    const job = await seedUploadingJob(prisma, { userId });
    const tusdSrc = join(tusdDataDir, `${job.id}.bin`);
    writeFileSync(tusdSrc, PNG_BUFFER);

    const app = await buildServer(makeConfig());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/post-finish',
        headers: { 'x-tusd-shared-secret': SHARED_SECRET },
        payload: tusdHookBody({
          uploadId: job.id,
          size: PNG_BUFFER.length,
          storagePath: tusdSrc,
        }),
      });
      expect(res.statusCode).toBe(200);

      // File moved.
      expect(existsSync(tusdSrc)).toBe(false);
      const finalPath = join(tusdFinalDir, userId, job.id, 'source.bin');
      expect(existsSync(finalPath)).toBe(true);
      expect(readFileSync(finalPath)).toEqual(PNG_BUFFER);

      // DB row transitioned.
      const after = await prisma.job.findUnique({ where: { id: job.id } });
      expect(after!.status).toBe('queued');
      expect(after!.inputBytes).toBe(BigInt(PNG_BUFFER.length));
      expect(after!.inputMime).toBe('image/png');
      expect(after!.inputStorageKey).toBe(`uploads/${userId}/${job.id}/source.bin`);
      expect(after!.uploadExpiresAt).toBeNull();

      // BullMQ-Queue has the job for this jobId. Scoped lookup — sibling
      // suites (jobs-routes.test.ts) share the `compression` queue, so we
      // don't assert on global counts.
      const q = new Queue('compression', { connection: redis });
      try {
        const jobInQueue = await q.getJob(job.id);
        expect(jobInQueue).toBeDefined();
        expect(jobInQueue?.id).toBe(job.id);
        expect(jobInQueue?.data).toMatchObject({
          jobId: job.id,
          userId,
          // Plan-5-Followup: queue-payload paths are absolute (rooted at
          // MEDIA_MOUNT_PATH) so the worker's compress() can fs.statSync directly.
          // Test config hardcodes MEDIA_MOUNT_PATH='/tmp' (see buildConfig).
          inputPath: `/tmp/uploads/${userId}/${job.id}/source.bin`,
          outputPath: `/tmp/results/${userId}/${job.id}/output`,
          profile: 'web-optimized',
        });
      } finally {
        await q.close();
      }
    } finally {
      await app.close();
    }
  });

  // UC6 PFLICHT-REGRESSIONSTEST: doppelter Hook-Call mit gleichem uploadId →
  // genau 1 BullMQ-Job, kein Doppel-Move.
  it('UC6: duplicate hook call same uploadId → exactly 1 BullMQ job, no double-move', async () => {
    const job = await seedUploadingJob(prisma, { userId });
    const tusdSrc = join(tusdDataDir, `${job.id}.bin`);
    writeFileSync(tusdSrc, PNG_BUFFER);

    const queueAddSpy = vi.spyOn(Queue.prototype, 'add');

    const app = await buildServer(makeConfig());
    try {
      const payload = tusdHookBody({
        uploadId: job.id,
        size: PNG_BUFFER.length,
        storagePath: tusdSrc,
      });
      const headers = { 'x-tusd-shared-secret': SHARED_SECRET };

      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/post-finish',
        headers,
        payload,
      });
      expect(res1.statusCode).toBe(200);

      // After first call, source is gone (already moved).
      expect(existsSync(tusdSrc)).toBe(false);

      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/post-finish',
        headers,
        payload,
      });
      // Second call must be idempotent — 200, no error from missing source.
      expect(res2.statusCode).toBe(200);

      // BullMQ-Queue has exactly one job for THIS jobId. Scoped check —
      // sibling suites share the `compression` queue.
      const q = new Queue('compression', { connection: redis });
      try {
        const jobInQueue = await q.getJob(job.id);
        expect(jobInQueue?.id).toBe(job.id);
      } finally {
        await q.close();
      }

      // queue.add invoked at most once with this jobId. The second call
      // early-returned at the status-check (`job.status !== 'uploading'`), so
      // queue.add was never called for it — belt-and-suspenders to BullMQ's
      // own jobId-dedup.
      const addCallsForThisJob = queueAddSpy.mock.calls.filter((c) => {
        const opts = c[2] as { jobId?: string } | undefined;
        return opts?.jobId === job.id;
      });
      expect(addCallsForThisJob.length).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('MIME magic-number not detectable → status=failed, errorCode=ENGINE_INPUT_CORRUPT', async () => {
    const job = await seedUploadingJob(prisma, { userId });
    const tusdSrc = join(tusdDataDir, `${job.id}.bin`);
    // 16 bytes of zeros — `file-type` returns undefined.
    writeFileSync(tusdSrc, Buffer.alloc(16, 0));

    const queueAddSpy = vi.spyOn(Queue.prototype, 'add');

    const app = await buildServer(makeConfig());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/uploads/hooks/post-finish',
        headers: { 'x-tusd-shared-secret': SHARED_SECRET },
        payload: tusdHookBody({
          uploadId: job.id,
          size: 16,
          storagePath: tusdSrc,
        }),
      });
      expect(res.statusCode).toBe(200);

      const after = await prisma.job.findUnique({ where: { id: job.id } });
      expect(after!.status).toBe('failed');
      expect(after!.errorCode).toBe('ENGINE_INPUT_CORRUPT');
      expect(after!.uploadExpiresAt).toBeNull();
      expect(queueAddSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
