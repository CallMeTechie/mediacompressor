import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

const RATE_LIMIT_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return { 0, oldest[2] or tostring(now) }
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs * 2)
return { 1, '0' }
`;

declare module 'ioredis' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface RedisCommander<Context> {
    mcRateLimit(
      key: string,
      limit: string,
      windowMs: string,
      now: string,
      member: string,
    ): Promise<[number, string]>;
  }
}

const definedClients = new WeakSet<Redis>();

export function defineRateLimitCommand(redis: Redis): void {
  if (definedClients.has(redis)) return;
  redis.defineCommand('mcRateLimit', { numberOfKeys: 1, lua: RATE_LIMIT_LUA });
  definedClients.add(redis);
}

export async function checkAndIncrementRateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  defineRateLimitCommand(redis);
  const now = Date.now();
  const setKey = `ratelimit:${key}`;
  const member = `${now}-${randomUUID()}`;

  const [allowed, oldestScoreStr] = await redis.mcRateLimit(
    setKey,
    String(limit),
    String(windowMs),
    String(now),
    member,
  );

  if (allowed === 1) return { allowed: true };
  const oldestScore = Number(oldestScoreStr);
  const retryAfterMs = Math.max(1, oldestScore + windowMs - now);
  return { allowed: false, retryAfterMs };
}
