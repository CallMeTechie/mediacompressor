import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import IORedis from 'ioredis';
import { testRedisUrl } from '@mediacompressor/test-helpers';
import { registerCleanupScripts } from './redis-scripts.js';
import { startDownloadHandler } from './download-set.js';

describe('startDownloadHandler', () => {
  let redis: IORedis;
  const jobId = 'job-dl-test-1';
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

  it('happy path: registers handler in set and removes it on release', async () => {
    const handle = await startDownloadHandler(redis, jobId, () => {});
    expect(handle).not.toBeNull();
    expect(handle!.jobId).toBe(jobId);
    expect(handle!.handlerId).toBeTruthy();

    expect(await redis.sismember(dlKey, handle!.handlerId)).toBe(1);
    expect(await redis.scard(dlKey)).toBe(1);
    const ttl = await redis.ttl(dlKey);
    expect(ttl).toBeGreaterThan(0);

    await handle!.release();
    expect(await redis.sismember(dlKey, handle!.handlerId)).toBe(0);
  });

  it('pre-check: returns null when cleanup-lock is already held', async () => {
    await redis.set(lockKey, 'some-cleanup-owner', 'EX', 60);
    const handle = await startDownloadHandler(redis, jobId, () => {});
    expect(handle).toBeNull();
    // No handler should have been added.
    expect(await redis.scard(dlKey)).toBe(0);
  });

  it('re-check / withdrawal: SADD+EXPIRE applied, release removes the entry', async () => {
    // The actual race (lock appears between EXISTS and SADD) is hard to inject
    // without instrumentation. This regression test verifies the lifecycle the
    // re-check path relies on:
    //   - SADD adds the handler
    //   - EXPIRE sets TTL
    //   - SREM (used by the withdrawal path) removes the orphaned handler cleanly
    const handle = await startDownloadHandler(redis, jobId, () => {});
    expect(handle).not.toBeNull();
    expect(await redis.scard(dlKey)).toBe(1);
    expect(await redis.ttl(dlKey)).toBeGreaterThan(0);

    // Simulate the withdrawal SREM the helper would perform on re-check failure.
    await redis.srem(dlKey, handle!.handlerId);
    expect(await redis.sismember(dlKey, handle!.handlerId)).toBe(0);

    await handle!.release();
  });

  it('multiple parallel handlers: all members present, all removable', async () => {
    const [a, b, c] = await Promise.all([
      startDownloadHandler(redis, jobId, () => {}),
      startDownloadHandler(redis, jobId, () => {}),
      startDownloadHandler(redis, jobId, () => {}),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(await redis.scard(dlKey)).toBe(3);

    await a!.release();
    expect(await redis.scard(dlKey)).toBe(2);
    await b!.release();
    expect(await redis.scard(dlKey)).toBe(1);
    await c!.release();
    expect(await redis.exists(dlKey)).toBe(0);
  });

  it('idempotent release: calling release twice does not error or double-SREM', async () => {
    const handle = await startDownloadHandler(redis, jobId, () => {});
    expect(handle).not.toBeNull();
    expect(await redis.scard(dlKey)).toBe(1);

    await handle!.release();
    expect(await redis.scard(dlKey)).toBe(0);

    // Second release: must be a no-op (no throw, no SREM against deleted set).
    await expect(handle!.release()).resolves.toBeUndefined();
    expect(await redis.scard(dlKey)).toBe(0);
  });

  it('refresh-failure path fires onRefreshFailure after configured failures', async () => {
    const onRefreshFailure = vi.fn();
    const handle = await startDownloadHandler(redis, jobId, onRefreshFailure, {
      ttlSec: 60,
      refreshIntervalMs: 50,
      failuresBeforeAbort: 2,
    });
    expect(handle).not.toBeNull();

    // Force EXPIRE to return 0 by deleting the set; subsequent EXPIRE on a
    // missing key returns 0 → counts as refresh-failure.
    await redis.del(dlKey);

    await vi.waitFor(
      () => {
        expect(onRefreshFailure).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000, interval: 25 },
    );

    // Idempotent release after abort path is safe.
    await handle!.release();
  });
});
