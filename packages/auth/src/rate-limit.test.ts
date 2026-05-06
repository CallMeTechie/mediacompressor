import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import IORedis from 'ioredis';
import { testRedisUrl } from '@mediacompressor/test-helpers';
import { checkAndIncrementRateLimit, defineRateLimitCommand } from './rate-limit.js';

let redis: IORedis;
const REDIS_URL = testRedisUrl();

beforeAll(() => {
  redis = new IORedis(REDIS_URL);
  defineRateLimitCommand(redis);
});
afterAll(async () => {
  await redis.quit();
});
beforeEach(async () => {
  await redis.flushdb();
});

describe('checkAndIncrementRateLimit', () => {
  it('allows up to limit requests in window', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await checkAndIncrementRateLimit(redis, 'k1', 5, 60_000);
      expect(r.allowed).toBe(true);
    }
  });

  it('rejects after limit reached', async () => {
    for (let i = 0; i < 5; i++) await checkAndIncrementRateLimit(redis, 'k2', 5, 60_000);
    const r = await checkAndIncrementRateLimit(redis, 'k2', 5, 60_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it('isolates keys', async () => {
    for (let i = 0; i < 5; i++) await checkAndIncrementRateLimit(redis, 'a', 5, 60_000);
    const r = await checkAndIncrementRateLimit(redis, 'b', 5, 60_000);
    expect(r.allowed).toBe(true);
  });

  it('expires window — old entries drop off', async () => {
    await checkAndIncrementRateLimit(redis, 'k3', 1, 50);
    await new Promise((r) => setTimeout(r, 60));
    const r = await checkAndIncrementRateLimit(redis, 'k3', 1, 50);
    expect(r.allowed).toBe(true);
  });

  it('is atomic under 100 parallel requests (C1-Rev1 race-safety)', async () => {
    const promises = Array.from({ length: 100 }, () =>
      checkAndIncrementRateLimit(redis, 'parallel-key', 5, 60_000),
    );
    const results = await Promise.all(promises);
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(5);
  });
});
