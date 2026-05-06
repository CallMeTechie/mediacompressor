import type { Redis } from 'ioredis';

const SAFE_UNLOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

const SAFE_REFRESH_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`;

const TRY_CLEANUP_ACQUIRE_LUA = `
if redis.call('SCARD', KEYS[2]) > 0 then
  return 0
end
local ok = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if ok then return 1 else return 0 end
`;

declare module 'ioredis' {
  interface RedisCommander {
    safeUnlock(key: string, ownerId: string): Promise<number>;
    safeRefresh(key: string, ownerId: string, ttlSec: number): Promise<number>;
    tryCleanupAcquire(
      lockKey: string,
      downloadsKey: string,
      ownerId: string,
      ttlSec: number,
    ): Promise<number>;
  }
}

export function registerCleanupScripts(redis: Redis): void {
  redis.defineCommand('safeUnlock', { numberOfKeys: 1, lua: SAFE_UNLOCK_LUA });
  redis.defineCommand('safeRefresh', { numberOfKeys: 1, lua: SAFE_REFRESH_LUA });
  redis.defineCommand('tryCleanupAcquire', {
    numberOfKeys: 2,
    lua: TRY_CLEANUP_ACQUIRE_LUA,
  });
}
