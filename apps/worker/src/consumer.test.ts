import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import type { CompressionRequest, CompressionResult } from '@mediacompressor/compression/types';
import type { compress } from '@mediacompressor/compression';
import {
  testDatabaseUrl,
  testRedisUrl,
  createTestUser,
  cleanupTestUsers,
} from '@mediacompressor/test-helpers';
import { processJob, type CompressJobData } from './consumer.js';

const TEST_EMAILS = ['worker11@b.com'];
const DATABASE_URL = testDatabaseUrl();
const REDIS_URL = testRedisUrl();

const FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'compression',
  'test-fixtures',
);

// Subscribes to a pub/sub channel BEFORE the action runs and collects messages.
async function captureChannel(channel: string): Promise<{
  messages: string[];
  close: () => Promise<void>;
}> {
  const sub = new IORedis(REDIS_URL);
  const messages: string[] = [];
  await sub.subscribe(channel);
  sub.on('message', (_ch, raw) => messages.push(raw));
  return {
    messages,
    close: async () => {
      await sub.quit();
    },
  };
}

async function seedJob(
  prisma: PrismaClient,
  opts: { userId: string; status?: 'queued' | 'processing'; profile?: string },
): Promise<{ id: string }> {
  const j = await prisma.job.create({
    data: {
      userId: opts.userId,
      status: opts.status ?? 'queued',
      kind: 'image',
      profile: opts.profile ?? 'web-optimized',
      overrides: { targetFormat: 'webp' },
      inputFilename: 'in.bin',
      uploadId: `task11-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    },
  });
  return { id: j.id };
}

describe('worker consumer — processJob (Plan 4 Task 11)', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let pub: IORedis;
  let userId: string;
  let outDir: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: DATABASE_URL });
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    pub = new IORedis(REDIS_URL);

    // Cleanup leftovers from prior test runs of this suite.
    await cleanupTestUsers(prisma, TEST_EMAILS);
    const u = await createTestUser(prisma, { email: 'worker11@b.com' });
    userId = u.id;
    outDir = mkdtempSync(join(tmpdir(), 'mc-worker-test-'));
  });

  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { userId } });
    const cancelKeys = await redis.keys('cancel:*');
    if (cancelKeys.length > 0) await redis.del(...cancelKeys);
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    rmSync(outDir, { recursive: true, force: true });
    await prisma.$disconnect();
    await redis.quit();
    await pub.quit();
  });

  it('valid image input → status=succeeded, outputBytes > 0, succeeded event published', async () => {
    const job = await seedJob(prisma, { userId });
    const data: CompressJobData = {
      jobId: job.id,
      userId,
      inputPath: join(FIXTURES, 'tiny.png'),
      outputPath: join(outDir, `${job.id}.webp`),
      profile: 'web-optimized',
      overrides: { targetFormat: 'webp' },
    };

    const cap = await captureChannel(`job:status:${job.id}`);
    try {
      await processJob({ redis, pub, prisma }, data);

      const row = await prisma.job.findUnique({ where: { id: job.id } });
      expect(row?.status).toBe('succeeded');
      expect(row?.outputBytes).not.toBeNull();
      expect(Number(row?.outputBytes)).toBeGreaterThan(0);
      expect(row?.outputFormat).toBe('webp');
      expect(row?.progress).toBe(100);
      expect(row?.finishedAt).not.toBeNull();
      expect(row?.expiresAt).not.toBeNull();

      // Allow pub/sub messages to settle.
      await new Promise((r) => setTimeout(r, 30));
      const parsed = cap.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
      expect(parsed.some((m) => m.status === 'processing')).toBe(true);
      const succeeded = parsed.filter((m) => m.status === 'succeeded');
      expect(succeeded).toHaveLength(1);
      expect(typeof succeeded[0]!.outputBytes).toBe('number');
      expect(succeeded[0]!.outputBytes as number).toBeGreaterThan(0);
    } finally {
      await cap.close();
    }
  });

  // The corrupt-input → ENGINE_INPUT_CORRUPT mapping happens *inside* the
  // engines (compress.ts → video-engine.ts wraps VideoProbeError as
  // `ENGINE_INPUT_CORRUPT: ...`). The consumer's job is to map any error whose
  // message starts with `ENGINE_INPUT_CORRUPT` to that errorCode and status=
  // failed. Stubbing compress() throwing the engine-level error is the
  // cleanest way to assert the consumer's error-mapping contract without
  // pulling in ffmpeg/sharp from a test fixture (the engine-level mapping is
  // already covered by packages/compression/src/video-engine.test.ts).
  it('corrupt input → status=failed, errorCode=ENGINE_INPUT_CORRUPT', async () => {
    const job = await seedJob(prisma, { userId, profile: 'web-optimized' });
    const data: CompressJobData = {
      jobId: job.id,
      userId,
      inputPath: join(FIXTURES, 'tiny.png'),
      outputPath: join(outDir, `${job.id}.webp`),
      profile: 'web-optimized',
      overrides: { targetFormat: 'webp' },
    };

    const stubCompress = async (_req: CompressionRequest): Promise<CompressionResult> => {
      throw new Error('ENGINE_INPUT_CORRUPT: simulated decode failure');
    };

    const cap = await captureChannel(`job:status:${job.id}`);
    try {
      await expect(
        processJob({ redis, pub, prisma, compress: stubCompress as typeof compress }, data),
      ).rejects.toThrow(/ENGINE_INPUT_CORRUPT/);

      const row = await prisma.job.findUnique({ where: { id: job.id } });
      expect(row?.status).toBe('failed');
      expect(row?.errorCode).toBe('ENGINE_INPUT_CORRUPT');
      expect(row?.errorMessage).toMatch(/ENGINE_INPUT_CORRUPT/);
      expect(row?.finishedAt).not.toBeNull();

      await new Promise((r) => setTimeout(r, 30));
      const parsed = cap.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
      const failed = parsed.filter((m) => m.status === 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.errorCode).toBe('ENGINE_INPUT_CORRUPT');
    } finally {
      await cap.close();
    }
  });

  // Cancel-flow integration: set `cancel:{jobId}` while compress() is running,
  // verify the consumer's poll loop aborts the AbortSignal and the engine
  // throws CANCELED. We use a stub compress that parks on the signal so the
  // test stays deterministic — slow.mp4 finishes in ~1.5 s on fast machines,
  // shorter than the 1 s poll interval, so a real-engine race is flaky.
  it('cancel-key set mid-flight → status=canceled, errorCode=CANCELED', async () => {
    const job = await seedJob(prisma, { userId });
    const data: CompressJobData = {
      jobId: job.id,
      userId,
      inputPath: join(FIXTURES, 'tiny.png'),
      outputPath: join(outDir, `${job.id}.webp`),
      profile: 'web-optimized',
      overrides: { targetFormat: 'webp' },
    };

    const stubCompress = async (req: CompressionRequest): Promise<CompressionResult> => {
      // Wait until the signal aborts (cancel-key polled by consumer) or 10 s
      // safety bound elapses, then throw the engine-shaped CANCELED error.
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) return resolve();
        const timeout = setTimeout(resolve, 10_000);
        req.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
      throw new Error('CANCELED: aborted by signal');
    };

    // Set cancel-key shortly after processJob starts so the 1 s polling
    // interval reads it and aborts the AbortSignal on its first/second tick.
    const cancelTimer = setTimeout(() => {
      void redis.set(`cancel:${job.id}`, '1', 'EX', 60);
    }, 100);

    const cap = await captureChannel(`job:status:${job.id}`);
    try {
      await expect(
        processJob({ redis, pub, prisma, compress: stubCompress as typeof compress }, data),
      ).rejects.toThrow(/CANCELED/);

      const row = await prisma.job.findUnique({ where: { id: job.id } });
      expect(row?.status).toBe('canceled');
      expect(row?.errorCode).toBe('CANCELED');

      await new Promise((r) => setTimeout(r, 30));
      const parsed = cap.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
      const canceled = parsed.filter((m) => m.status === 'canceled');
      expect(canceled).toHaveLength(1);
      expect(canceled[0]!.errorCode).toBe('CANCELED');
    } finally {
      clearTimeout(cancelTimer);
      await cap.close();
    }
  }, 15_000);

  // C11-Rev2 PFLICHT-REGRESSIONSTEST: progress is persisted to DB while the
  // job runs (not only at the end). We use a stub `compress` that drives
  // onProgress through the throttle thresholds, then sleeps so we can sample
  // DB.progress mid-flight and observe a value strictly between 0 and 100.
  it('C11-Rev2: DB.progress is updated mid-flight (>0 && <100 sample observed)', async () => {
    const job = await seedJob(prisma, { userId });
    const data: CompressJobData = {
      jobId: job.id,
      userId,
      inputPath: join(FIXTURES, 'tiny.png'),
      outputPath: join(outDir, `${job.id}.webp`),
      profile: 'web-optimized',
      overrides: { targetFormat: 'webp' },
    };

    let releaseCompress!: () => void;
    const compressGate = new Promise<void>((resolve) => {
      releaseCompress = resolve;
    });

    const stubCompress = async (req: CompressionRequest): Promise<CompressionResult> => {
      // Drive several +5 % steps so the DB-throttle persists each one.
      const ticks = [10, 20, 30, 40, 50, 60, 70];
      for (const t of ticks) {
        req.onProgress?.(t);
        // Tiny await so the fire-and-forget prisma.update() in the throttle
        // gets scheduled and lands before we move on.
        await new Promise((r) => setTimeout(r, 20));
      }
      // Park inside compress so the test can sample DB.progress mid-flight.
      await compressGate;
      return {
        outputPath: req.outputPath,
        outputBytes: 1234,
        inputBytes: 1132,
        durationMs: 0,
        outputFormat: 'webp',
        metadata: { width: 256, height: 256 },
      };
    };

    const samples: number[] = [];
    const runP = processJob(
      {
        redis,
        pub,
        prisma,
        compress: stubCompress as typeof compress,
      },
      data,
    );

    // Sample the DB while compress is parked.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const row = await prisma.job.findUnique({ where: { id: job.id } });
      if (row?.progress !== undefined) samples.push(row.progress);
      if (samples.some((s) => s > 0 && s < 100)) break;
    }

    // Release compress and let processJob finalize.
    releaseCompress();
    await runP;

    expect(samples.some((s) => s > 0 && s < 100)).toBe(true);

    // Final state: succeeded with progress=100.
    const final = await prisma.job.findUnique({ where: { id: job.id } });
    expect(final?.status).toBe('succeeded');
    expect(final?.progress).toBe(100);
  });

  // C12-Rev2 PFLICHT-REGRESSIONSTEST: invoking processJob twice for the same
  // jobId (simulating a stalled-retry) must produce EXACTLY ONE succeeded
  // pub/sub event — the second call sees the row already in a terminal state
  // and skips the publish.
  it('C12-Rev2: stalled-retry — exactly ONE succeeded event when handler runs twice', async () => {
    const job = await seedJob(prisma, { userId });
    const data: CompressJobData = {
      jobId: job.id,
      userId,
      inputPath: join(FIXTURES, 'tiny.png'),
      outputPath: join(outDir, `${job.id}.webp`),
      profile: 'web-optimized',
      overrides: { targetFormat: 'webp' },
    };

    const cap = await captureChannel(`job:status:${job.id}`);
    try {
      await processJob({ redis, pub, prisma }, data);
      // Second invocation — same jobId, simulates a BullMQ stalled-retry.
      await processJob({ redis, pub, prisma }, data);

      // Allow pub/sub messages to settle.
      await new Promise((r) => setTimeout(r, 50));

      const parsed = cap.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
      const succeeded = parsed.filter((m) => m.status === 'succeeded');
      expect(succeeded).toHaveLength(1);

      // DB row is succeeded exactly once and untouched on the second pass.
      const row = await prisma.job.findUnique({ where: { id: job.id } });
      expect(row?.status).toBe('succeeded');
    } finally {
      await cap.close();
    }
  });
});
