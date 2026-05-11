import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import IORedis from 'ioredis';
import { testRedisUrl } from '@mediacompressor/test-helpers';
import { registerCleanupScripts } from './redis-scripts.js';

describe('redis-scripts', () => {
  let redis: IORedis;

  beforeAll(() => {
    redis = new IORedis(testRedisUrl());
    registerCleanupScripts(redis);
  });
  afterAll(async () => {
    await redis.quit();
  });
  beforeEach(async () => {
    await redis.del('test:lock:1', 'test:downloads:1');
  });

  it('safeUnlock removes key only if owner matches', async () => {
    await redis.set('test:lock:1', 'ownerA');
    expect(await redis.safeUnlock('test:lock:1', 'ownerB')).toBe(0);
    expect(await redis.exists('test:lock:1')).toBe(1);
    expect(await redis.safeUnlock('test:lock:1', 'ownerA')).toBe(1);
    expect(await redis.exists('test:lock:1')).toBe(0);
  });

  it('safeRefresh extends TTL only if owner matches', async () => {
    await redis.set('test:lock:1', 'ownerA', 'EX', 60);
    expect(await redis.safeRefresh('test:lock:1', 'ownerB', 120)).toBe(0);
    expect(await redis.safeRefresh('test:lock:1', 'ownerA', 120)).toBe(1);
    expect(await redis.ttl('test:lock:1')).toBeGreaterThan(60);
  });

  it('tryCleanupAcquire returns 0 when downloads-set non-empty', async () => {
    await redis.sadd('test:downloads:1', 'handler-x');
    expect(await redis.tryCleanupAcquire('test:lock:1', 'test:downloads:1', 'ownerA', 60)).toBe(0);
    expect(await redis.exists('test:lock:1')).toBe(0);
  });

  it('tryCleanupAcquire sets lock when downloads empty + lock free', async () => {
    expect(await redis.tryCleanupAcquire('test:lock:1', 'test:downloads:1', 'ownerA', 60)).toBe(1);
    expect(await redis.get('test:lock:1')).toBe('ownerA');
  });

  it('tryCleanupAcquire returns 0 when lock already held by other owner', async () => {
    await redis.set('test:lock:1', 'ownerA', 'EX', 60);
    expect(await redis.tryCleanupAcquire('test:lock:1', 'test:downloads:1', 'ownerB', 60)).toBe(0);
    expect(await redis.get('test:lock:1')).toBe('ownerA');
  });
});
