import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@mediacompressor/db';

export interface OrphanSweepDeps {
  prisma: PrismaClient;
  mediaMountPath: string;
  log: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    ctx?: Record<string, unknown>,
  ) => void;
}

export interface OrphanSweepResult {
  scanned: number;
  deleted: number;
  kept: number;
}

const TOP_DIRS = ['uploads', 'results'] as const;
const ORPHAN_GRACE_MS = 24 * 60 * 60_000; // expired-jobs older than 24h
const MTIME_GRACE_MS = 60 * 60_000; // DC5: dirs younger than 1h are NEVER deleted

/**
 * Scan media-data filesystem for orphan job-directories. Considers a directory
 * orphan when:
 *  - no Job-row exists with matching jobId, OR
 *  - Job-row is in 'expired' state and finishedAt > 24h ago.
 *
 * DC5-Fix: dirs whose mtime is within the last 1h are NEVER deleted, even if
 * the DB says orphan — protects against race with active compress() writing
 * mid-job (e.g. DB-row temporarily missing or just renamed).
 */
export async function sweepOrphans(
  deps: OrphanSweepDeps,
): Promise<OrphanSweepResult> {
  let scanned = 0;
  let deleted = 0;
  let kept = 0;
  const now = Date.now();

  for (const top of TOP_DIRS) {
    const topAbs = join(deps.mediaMountPath, top);
    const userDirs = await fsp.readdir(topAbs).catch(() => []);

    for (const userDir of userDirs) {
      const userAbs = join(topAbs, userDir);
      const jobDirs = await fsp.readdir(userAbs).catch(() => []);

      for (const jobId of jobDirs) {
        scanned++;
        const target = join(userAbs, jobId);

        // DC5: mtime-grace defends against race with active compress().
        const dirStat = await fsp.stat(target).catch(() => null);
        if (dirStat && dirStat.mtimeMs > now - MTIME_GRACE_MS) {
          kept++;
          continue;
        }

        const job = await deps.prisma.job.findUnique({ where: { id: jobId } });
        const isOrphan =
          !job ||
          (job.status === 'expired' &&
            job.finishedAt !== null &&
            job.finishedAt !== undefined &&
            job.finishedAt < new Date(now - ORPHAN_GRACE_MS));

        if (isOrphan) {
          await fsp.rm(target, { recursive: true, force: true });
          deleted++;
          deps.log('info', 'orphan.deleted', { path: target });
        } else {
          kept++;
        }
      }
    }
  }

  return { scanned, deleted, kept };
}
