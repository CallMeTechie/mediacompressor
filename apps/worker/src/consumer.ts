import { Worker } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { compress } from '@mediacompressor/compression';
import type { CompressionOverrides, Profile } from '@mediacompressor/compression/types';

export interface CompressJobData {
  jobId: string;
  userId: string;
  inputPath: string;
  outputPath: string;
  profile: string;
  overrides?: Record<string, unknown>;
}

export interface ProcessJobDeps {
  redis: Redis;
  pub: Redis;
  prisma: PrismaClient;
  // Injected so tests can stub the heavy compression engine.
  compress?: typeof compress;
}

// Terminal states: jobs in einem dieser Status werden vom Worker NICHT mehr modifiziert
// (verhindert Race mit DELETE-Route und idempotente Stalled-Retries).
export const TERMINAL_STATUS = ['canceled', 'succeeded', 'failed', 'expired'] as const;

// C11-Rev2: Progress-DB-Update-Throttle. Pro Job lokales State (lastDbProgress
// + lastDbAt). Update bei +5 % ODER alle 5 s (was zuerst kommt).
const PROGRESS_DB_DELTA_PCT = 5;
const PROGRESS_DB_INTERVAL_MS = 5_000;

const VALID_PROFILES: ReadonlySet<Profile> = new Set([
  'web-optimized',
  'mobile-low',
  'archive-medium',
]);

function asProfile(p: string): Profile {
  if (!VALID_PROFILES.has(p as Profile)) {
    throw new Error(`VALIDATION_FAILED: unknown profile ${p}`);
  }
  return p as Profile;
}

/**
 * Process one compression job. Extracted from the BullMQ Worker handler so it
 * can be invoked directly in unit tests (e.g. C12-Rev2 stalled-retry idempotency).
 *
 * Side-effects:
 *   - DB transitions: queued|processing → processing → succeeded|failed|canceled
 *   - Pub/Sub: `job:status:{jobId}` for status + progress
 *   - Polls `cancel:{jobId}` once per second; aborts the underlying compress() if set
 */
export async function processJob(deps: ProcessJobDeps, data: CompressJobData): Promise<void> {
  const { redis, pub, prisma } = deps;
  const compressFn = deps.compress ?? compress;
  const { jobId, inputPath, outputPath, profile, overrides } = data;

  const ctrl = new AbortController();
  const cancelInterval = setInterval(() => {
    redis
      .get(`cancel:${jobId}`)
      .then((c) => {
        if (c) ctrl.abort();
      })
      .catch(() => {
        // Best-effort polling — a transient Redis hiccup must not crash the job.
      });
  }, 1000);

  // C12-Rev2: updateMany mit Idempotenz-Guard — falls Job schon canceled
  // (von DELETE-Route gesetzt, bevor Worker den Job pickte) NICHT auf
  // processing zurückwerfen. Bei stalled-retry läuft das hier potenziell
  // zum zweiten Mal — ebenfalls idempotent.
  await prisma.job.updateMany({
    where: { id: jobId, status: { notIn: [...TERMINAL_STATUS] } },
    data: { status: 'processing', startedAt: new Date() },
  });
  await pub.publish(`job:status:${jobId}`, JSON.stringify({ status: 'processing' }));

  // C11-Rev2: Per-Job-Throttle-State.
  let lastDbProgress = 0;
  let lastDbAt = 0;

  try {
    const result = await compressFn({
      inputPath,
      outputPath,
      profile: asProfile(profile),
      ...(overrides ? { overrides: overrides as CompressionOverrides } : {}),
      signal: ctrl.signal,
      onProgress: (p) => {
        // Pub/Sub: hot path — jeder Tick wird emittiert (live-UX).
        void pub.publish(`job:status:${jobId}`, JSON.stringify({ progress: p }));
        // C11-Rev2: DB-Persist gedrosselt — sonst hämmert ein 1000-Frame-Video
        // den DB-Pool. Snapshot-on-Reconnect liefert dann mind. den letzten
        // 5-%-Schwellenwert.
        const now = Date.now();
        if (p - lastDbProgress >= PROGRESS_DB_DELTA_PCT || now - lastDbAt >= PROGRESS_DB_INTERVAL_MS) {
          lastDbProgress = p;
          lastDbAt = now;
          void prisma.job
            .update({ where: { id: jobId }, data: { progress: p } })
            .catch(() => {
              // Best-effort persistence — progress UI must never block compression.
            });
        }
      },
    });
    // C12-Rev2: Final-Update via updateMany — wenn parallel canceled wurde,
    // NICHT auf succeeded überschreiben (Race-Schutz). Auch bei stalled-retry
    // sieht der zweite Lauf hier already-succeeded und überspringt das Publish.
    const updated = await prisma.job.updateMany({
      where: { id: jobId, status: { notIn: [...TERMINAL_STATUS] } },
      data: {
        status: 'succeeded',
        outputBytes: result.outputBytes,
        outputMime: 'application/octet-stream',
        outputFormat: result.outputFormat,
        outputStorageKey: outputPath,
        metadata: result.metadata as object,
        progress: 100,
        finishedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });
    if (updated.count > 0) {
      await pub.publish(
        `job:status:${jobId}`,
        JSON.stringify({ status: 'succeeded', outputBytes: result.outputBytes }),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.startsWith('ENGINE_INPUT_CORRUPT')
      ? 'ENGINE_INPUT_CORRUPT'
      : message.startsWith('CANCELED')
        ? 'CANCELED'
        : 'ENGINE_INTERNAL';
    const finalStatus = code === 'CANCELED' ? 'canceled' : 'failed';
    // C12-Rev2: idempotent — stalled-retry darf nicht doppelt publizieren.
    const updated = await prisma.job.updateMany({
      where: { id: jobId, status: { notIn: [...TERMINAL_STATUS] } },
      data: { status: finalStatus, errorCode: code, errorMessage: message, finishedAt: new Date() },
    });
    if (updated.count > 0) {
      await pub.publish(
        `job:status:${jobId}`,
        JSON.stringify({ status: finalStatus, errorCode: code }),
      );
    }
    throw err;
  } finally {
    clearInterval(cancelInterval);
  }
}

export interface StartWorkerHandle {
  worker: Worker<CompressJobData>;
  close: () => Promise<void>;
}

/**
 * Construct + start the BullMQ compression worker. Returns a handle whose
 * `close()` drains the worker, disconnects Prisma, and quits both Redis
 * connections — call it on SIGTERM.
 */
export function startWorker(redisUrl: string, databaseUrl: string): StartWorkerHandle {
  // BullMQ requires `maxRetriesPerRequest: null` on the connection used as the
  // blocking-fetch client; we keep the publish connection on defaults.
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const pub = new IORedis(redisUrl);
  const prisma: PrismaClient = createPrismaClient({ databaseUrl });

  const worker = new Worker<CompressJobData>(
    'compression',
    async (job) => {
      await processJob({ redis, pub, prisma }, job.data);
    },
    {
      connection: redis,
      // C12-Rev2: Explizite Worker-Options statt fragiler Defaults.
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
      removeOnComplete: { count: 1000 }, // last 1000 für Debug
      removeOnFail: { count: 5000 }, // failed länger behalten
      lockDuration: 5 * 60_000, // 5 min — Video-Compression kann lange brauchen
      stalledInterval: 30_000,
    },
  );

  return {
    worker,
    close: async () => {
      await worker.close();
      await prisma.$disconnect();
      // ioredis: quit() returns 'OK' or rejects if already disconnected.
      await Promise.allSettled([redis.quit(), pub.quit()]);
    },
  };
}
