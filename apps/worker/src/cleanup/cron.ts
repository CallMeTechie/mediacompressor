import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@mediacompressor/db';
import { registerCleanupScripts } from '@mediacompressor/cleanup';
import { sweepExpiredJobs } from './expired-sweep.js';
import { sweepOrphans } from './orphan-sweep.js';

const CLEANUP_QUEUE = 'cleanup-cron';

// Structurally compatible with pino's Logger (which has overloaded LogFn —
// `(obj: unknown, msg?: string, ...args: any[]): void`). We accept just the
// object-shape call-form here because that is all the cron emits.
export interface CleanupCronLogger {
  info: (obj: object) => void;
  warn: (obj: object) => void;
  error: (obj: object) => void;
}

export interface StartCleanupCronDeps {
  redis: Redis;
  prisma: PrismaClient;
  mediaMountPath: string;
  logger: CleanupCronLogger;
}

export interface CleanupCronHandle {
  queue: Queue;
  worker: Worker;
  close: () => Promise<void>;
}

const EXPIRED_SWEEP_INTERVAL_MS = 15 * 60_000;
const ORPHAN_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Start the cleanup-cron BullMQ worker. Schedules:
 *  - expired-sweep every 15 min
 *  - orphan-sweep every 6 h
 *
 * Multiple worker replicas safely call upsertJobScheduler — BullMQ stores a
 * single scheduler entry per name, and the cleanup-lock serializes overlapping
 * sweep ticks (DC2 operational note).
 *
 * Operational notes:
 *  - lockDuration: 5 min — if a sweep takes > 5 min BullMQ marks it stalled and
 *    re-queues. The cleanup-lock serializes the actual filesystem/DB ops, so a
 *    stalled-retry is safe but wasteful. (DC3)
 *  - concurrency: 1 — single-flight cleanup ticks per replica.
 *  - registerCleanupScripts is idempotent on the same Redis instance, so it is
 *    safe to call here in addition to the API's download-route.
 */
export function startCleanupCron(deps: StartCleanupCronDeps): CleanupCronHandle {
  registerCleanupScripts(deps.redis);

  const queue = new Queue(CLEANUP_QUEUE, { connection: deps.redis });

  // Schedulers — idempotent; multi-replica-safe.
  void queue.upsertJobScheduler(
    'expired-sweep',
    { every: EXPIRED_SWEEP_INTERVAL_MS },
    { name: 'expired-sweep', data: {} },
  );
  void queue.upsertJobScheduler(
    'orphan-sweep',
    { every: ORPHAN_SWEEP_INTERVAL_MS },
    { name: 'orphan-sweep', data: {} },
  );

  const log = (
    level: 'info' | 'warn' | 'error',
    msg: string,
    ctx?: Record<string, unknown>,
  ): void => {
    deps.logger[level]({ ...ctx, msg });
  };

  const worker = new Worker(
    CLEANUP_QUEUE,
    async (job) => {
      if (job.name === 'expired-sweep') {
        const r = await sweepExpiredJobs({
          prisma: deps.prisma,
          redis: deps.redis,
          mediaMountPath: deps.mediaMountPath,
          log,
        });
        log('info', 'expired-sweep.done', { ...r });
      } else if (job.name === 'orphan-sweep') {
        const r = await sweepOrphans({
          prisma: deps.prisma,
          mediaMountPath: deps.mediaMountPath,
          log,
        });
        log('info', 'orphan-sweep.done', { ...r });
      } else {
        log('warn', 'cleanup-cron.unknown-job', { name: job.name });
      }
    },
    {
      connection: deps.redis,
      concurrency: 1,
      lockDuration: 5 * 60_000,
    },
  );

  return {
    queue,
    worker,
    close: async () => {
      // Order matters: close the worker first so no jobs are in-flight before
      // the queue tears down, otherwise queue.close() can throw.
      await worker.close();
      await queue.close();
    },
  };
}
