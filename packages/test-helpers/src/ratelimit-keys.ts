import type { Redis } from 'ioredis';

/**
 * H3-Fix: Reset ALL login-related ratelimit keys before tests that
 * trigger /auth/login. checkAndIncrementRateLimit prefixes keys with `ratelimit:`.
 */
export async function resetLoginRateLimits(redis: Redis, emails: string[]): Promise<void> {
  const ipKeys = ['ratelimit:login:ip:127.0.0.1', 'ratelimit:login:ip:::1'];
  const acctKeys = emails.map((e) => `ratelimit:login:acct:${e.toLowerCase()}`);
  await redis.del(...ipKeys, ...acctKeys);
}
