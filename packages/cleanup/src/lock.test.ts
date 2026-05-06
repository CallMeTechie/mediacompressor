import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import IORedis from 'ioredis';
import { testRedisUrl } from '@mediacompressor/test-helpers';
import { registerCleanupScripts } from './redis-scripts.js';
import { tryAcquireCleanupLock } from './lock.js';

describe('tryAcquireCleanupLock', () => {
  let redis: IORedis;
  const jobId = 'job-test-1';
  const lockKey = `cleanup-lock:${jobId}`;
  const dlKey = `downloads:${jobId}`;

  beforeAll(() => {
    redis = new IORedis(testRedisUrl());
    registerCleanupScripts(redis);
  });
  afterAll(async () => {
    await redis.quit();
  });
  beforeEach(async () => {
    await redis.del(lockKey, dlKey);
  });

  it('happy path: acquire, release, then re-acquire by other owner', async () => {
    const noop = (): void => {};
    const first = await tryAcquireCleanupLock(redis, jobId, noop);
    expect(first.acquired).not.toBeNull();
    expect(first.acquired?.ownerId).toBeTruthy();

    await first.acquired!.release();
    expect(await redis.exists(lockKey)).toBe(0);

    const second = await tryAcquireCleanupLock(redis, jobId, noop);
    expect(second.acquired).not.toBeNull();
    expect(second.acquired?.ownerId).not.toBe(first.acquired?.ownerId);

    await second.acquired!.release();
  });

  it('blocked by downloads-active', async () => {
    await redis.sadd(dlKey, 'handler-x');
    const result = await tryAcquireCleanupLock(redis, jobId, () => {});
    expect(result.acquired).toBeNull();
    expect(result.reason).toBe('downloads-active');
  });

  it('blocked by lock-held when other owner holds the lock', async () => {
    await redis.set(lockKey, 'other-owner', 'EX', 60);
    const result = await tryAcquireCleanupLock(redis, jobId, () => {});
    expect(result.acquired).toBeNull();
    expect(result.reason).toBe('lock-held');
    expect(await redis.get(lockKey)).toBe('other-owner');
  });

  it('two parallel acquires for same job: exactly one wins, other gets lock-held', async () => {
    const [a, b] = await Promise.all([
      tryAcquireCleanupLock(redis, jobId, () => {}),
      tryAcquireCleanupLock(redis, jobId, () => {}),
    ]);

    const winners = [a, b].filter((r) => r.acquired !== null);
    const losers = [a, b].filter((r) => r.acquired === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toBe('lock-held');

    await winners[0]!.acquired!.release();
  });

  it('C2-Rev3: refresh-failure callback fires after 2 missed refreshes', async () => {
    const onAbort = vi.fn();
    const result = await tryAcquireCleanupLock(redis, jobId, onAbort, {
      ttlSec: 60,
      refreshIntervalMs: 50,
      failuresBeforeAbort: 2,
    });
    expect(result.acquired).not.toBeNull();

    // Force refresh to fail by externally deleting the lock key.
    // Each subsequent safeRefresh sees GET == nil != ownerId => returns 0.
    await redis.del(lockKey);

    await vi.waitFor(
      () => {
        expect(onAbort).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000, interval: 25 },
    );

    // Timer must have been cleared by the abort path; explicit release is idempotent.
    await result.acquired!.release();
  });
});
