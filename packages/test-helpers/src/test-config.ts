const DEFAULT_POSTGRES_HOST = 'postgres';
const DEFAULT_REDIS_HOST = 'redis';
const DEFAULT_DB_USER = 'mediacompressor';
const DEFAULT_DB_PASS = 'changeme-dev';
const DEFAULT_DB_NAME = 'mediacompressor';

export function testDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    `postgresql://${DEFAULT_DB_USER}:${DEFAULT_DB_PASS}@${DEFAULT_POSTGRES_HOST}:5432/${DEFAULT_DB_NAME}?schema=public`
  );
}

export function testRedisUrl(): string {
  return (
    process.env.REDIS_URL ?? process.env.TEST_REDIS_URL ?? `redis://${DEFAULT_REDIS_HOST}:6379`
  );
}
