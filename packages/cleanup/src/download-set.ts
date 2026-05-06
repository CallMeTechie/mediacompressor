import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const DOWNLOAD_SET_TTL_SEC = 300;
const DOWNLOAD_REFRESH_INTERVAL_MS = 60_000;
const REFRESH_FAILURES_BEFORE_ABORT = 2;

export interface DownloadHandle {
  jobId: string;
  handlerId: string;
  release: () => Promise<void>;
  stopRefresh: () => void;
}

export interface StartDownloadOptions {
  ttlSec?: number;
  refreshIntervalMs?: number;
  failuresBeforeAbort?: number;
}

/**
 * Register a download handler in `downloads:{jobId}` Redis-Set.
 * Returns null if a cleanup-lock is held (download must be rejected with 410).
 *
 * Implements the C1-Rev4 + C2-Rev4 protocol:
 *   1. Pre-check: if cleanup-lock exists -> refuse immediately.
 *   2. SADD handler-id to downloads:{jobId} + EXPIRE ttl.
 *   3. Re-check: between EXISTS and SADD a cleanup may have started; if lock
 *      now exists, withdraw our handler (idempotent SREM) and return null.
 *   4. Start refresh-timer: every `refreshIntervalMs` EXPIRE downloads:{jobId} ttl.
 *      After `failuresBeforeAbort` consecutive failures, fire `onRefreshFailure`.
 *
 * Caller MUST call `release()` to remove the handler from the set; ideally
 * hooked into stream lifecycle (end/error/close) so a client disconnect
 * doesn't leak the handler.
 */
export async function startDownloadHandler(
  redis: Redis,
  jobId: string,
  onRefreshFailure: () => void,
  opts: StartDownloadOptions = {},
): Promise<DownloadHandle | null> {
  const ttl = opts.ttlSec ?? DOWNLOAD_SET_TTL_SEC;
  const intervalMs = opts.refreshIntervalMs ?? DOWNLOAD_REFRESH_INTERVAL_MS;
  const maxFailures = opts.failuresBeforeAbort ?? REFRESH_FAILURES_BEFORE_ABORT;

  const lockKey = `cleanup-lock:${jobId}`;
  const dlKey = `downloads:${jobId}`;

  // 1. Pre-check
  if ((await redis.exists(lockKey)) === 1) return null;

  const handlerId = randomUUID();
  // 2. Register handler + (re-)set TTL on the set
  await redis.sadd(dlKey, handlerId);
  await redis.expire(dlKey, ttl);

  // 3. Re-check: if cleanup-lock appeared between EXISTS and SADD, withdraw.
  if ((await redis.exists(lockKey)) === 1) {
    await redis.srem(dlKey, handlerId);
    return null;
  }

  // 4. Refresh-timer
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
      .expire(dlKey, ttl)
      .then((ok) => {
        if (ok === 0) {
          // Set was deleted (TTL expired or external DEL) -> EXPIRE returns 0.
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
    jobId,
    handlerId,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      await redis.srem(dlKey, handlerId);
    },
    stopRefresh: () => clearInterval(timer),
  };
}
