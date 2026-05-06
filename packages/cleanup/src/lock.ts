import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const CLEANUP_LOCK_TTL_SEC = 60;
const CLEANUP_REFRESH_INTERVAL_MS = 30_000;
const REFRESH_FAILURES_BEFORE_ABORT = 2;

export interface CleanupLock {
  jobId: string;
  ownerId: string;
  release: () => Promise<void>;
  stopRefresh: () => void;
}

export interface CleanupLockResult {
  acquired: CleanupLock | null;
  reason?: 'downloads-active' | 'lock-held';
}

export interface AcquireOptions {
  ttlSec?: number;
  refreshIntervalMs?: number;
  failuresBeforeAbort?: number;
}

/**
 * Try to acquire exclusive cleanup-lock for a job. Returns null if downloads
 * are active or another worker holds the lock. If acquired, starts a refresh-
 * timer; after `failuresBeforeAbort` consecutive refresh failures, calls
 * `onRefreshFailure` (caller decides what to do — typically: abort current
 * cleanup operation).
 *
 * The refresh-timer is cleared on `release()` and on the abort path so it
 * never keeps ticking past the lock's lifetime.
 */
export async function tryAcquireCleanupLock(
  redis: Redis,
  jobId: string,
  onRefreshFailure: () => void,
  opts: AcquireOptions = {},
): Promise<CleanupLockResult> {
  const ttl = opts.ttlSec ?? CLEANUP_LOCK_TTL_SEC;
  const intervalMs = opts.refreshIntervalMs ?? CLEANUP_REFRESH_INTERVAL_MS;
  const maxFailures = opts.failuresBeforeAbort ?? REFRESH_FAILURES_BEFORE_ABORT;

  const ownerId = randomUUID();
  const lockKey = `cleanup-lock:${jobId}`;
  const dlKey = `downloads:${jobId}`;

  const result = await redis.tryCleanupAcquire(lockKey, dlKey, ownerId, ttl);
  if (result === 0) {
    const downloadsCount = await redis.scard(dlKey);
    return {
      acquired: null,
      reason: downloadsCount > 0 ? 'downloads-active' : 'lock-held',
    };
  }

  let refreshFailures = 0;
  let aborted = false;

  const onFailure = (): void => {
    refreshFailures += 1;
    if (refreshFailures >= maxFailures && !aborted) {
      aborted = true;
      clearInterval(timer);
      onRefreshFailure();
    }
  };

  const timer = setInterval(() => {
    redis
      .safeRefresh(lockKey, ownerId, ttl)
      .then((ok) => {
        if (ok === 0) {
          onFailure();
        } else {
          refreshFailures = 0;
        }
      })
      .catch(() => {
        onFailure();
      });
  }, intervalMs);

  // Don't keep the event-loop alive solely because of the refresh-timer.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  let released = false;
  return {
    acquired: {
      jobId,
      ownerId,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        await redis.safeUnlock(lockKey, ownerId);
      },
      stopRefresh: () => clearInterval(timer),
    },
  };
}
