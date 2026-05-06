import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@mediacompressor/db';
import { tryAcquireCleanupLock } from '@mediacompressor/cleanup';

export interface ExpiredSweepDeps {
  prisma: PrismaClient;
  redis: Redis;
  mediaMountPath: string;
  log: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    ctx?: Record<string, unknown>,
  ) => void;
}

export interface SweepResult {
  processed: number;
  skipped: number;
  errors: number;
}

const BATCH_SIZE = 100;

/**
 * Sweep one batch of expired jobs. Per job:
 *   1. tryAcquireCleanupLock — skip when downloads-active or another worker
 *      already holds the lock (C5: parallel downloads must not see vanishing
 *      files; C2-Rev3: at-most-one-worker-per-job semantics).
 *   2. Mark `Job.status='expired'` (idempotent updateMany so a concurrent
 *      stalled-retry / second sweep doesn't double-write).
 *   3. unlink BOTH `inputStorageKey` AND `outputStorageKey` files
 *      (DC24-Pflicht: forgetting one leaks storage-quota silently).
 *   4. release lock.
 *
 * UC1: also catches `uploading` jobs whose `uploadExpiresAt` is past — orphan
 * recovery for tusd crashes between pre-create and post-finish hooks.
 */
export async function sweepExpiredJobs(
  deps: ExpiredSweepDeps,
): Promise<SweepResult> {
  const expired = await deps.prisma.job.findMany({
    where: {
      OR: [
        {
          status: { in: ['succeeded', 'failed', 'canceled'] },
          expiresAt: { lt: new Date() },
        },
        {
          status: 'uploading',
          uploadExpiresAt: { lt: new Date() },
        },
      ],
    },
    take: BATCH_SIZE,
  });

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const job of expired) {
    try {
      let aborted = false;
      const lockResult = await tryAcquireCleanupLock(
        deps.redis,
        job.id,
        () => {
          aborted = true;
          deps.log('error', 'cleanup.aborted_redis_unavailable', {
            jobId: job.id,
          });
        },
      );

      if (!lockResult.acquired) {
        skipped++;
        continue;
      }

      try {
        await deps.prisma.job.updateMany({
          where: { id: job.id, status: { notIn: ['expired'] } },
          data: { status: 'expired' },
        });

        // DC24: unlink BOTH input + output files (best-effort — missing file
        // is fine, e.g. orphan-uploading job that never finalized).
        for (const key of [job.inputStorageKey, job.outputStorageKey]) {
          if (key) {
            const abs = join(deps.mediaMountPath, key);
            await fsp.unlink(abs).catch(() => {});
          }
        }

        if (aborted) {
          deps.log('warn', 'cleanup.aborted_mid_op', { jobId: job.id });
        }
        processed++;
      } finally {
        await lockResult.acquired.release();
      }
    } catch (err) {
      errors++;
      deps.log('error', 'cleanup.error', {
        jobId: job.id,
        err: String(err),
      });
    }
  }

  return { processed, skipped, errors };
}
