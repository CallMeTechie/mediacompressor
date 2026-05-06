import { describe, expect, it } from 'vitest';
import { createPrismaClient } from '@mediacompressor/db';
import {
  TEST_API_KEY_PEPPER,
  TEST_CSRF_SECRET,
  TEST_SESSION_SECRET,
  testDatabaseUrl,
  testRedisUrl,
} from '@mediacompressor/test-helpers';
import { buildServer } from './server.js';
import type { Config } from './config.js';

const config: Config = {
  DATABASE_URL: testDatabaseUrl(),
  REDIS_URL: testRedisUrl(),
  SESSION_SECRET: TEST_SESSION_SECRET,
  CSRF_SECRET: TEST_CSRF_SECRET,
  API_KEY_PEPPER: TEST_API_KEY_PEPPER,
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  PORT: 0,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  ARGON2_MAX_CONCURRENCY: 8,
  TUSD_SHARED_SECRET: 'a'.repeat(64),
  TUSD_REQUIRE_SHARED_SECRET: true,
  TUSD_DATA_DIR: '/media/tusd-data',
  TUSD_FINAL_DIR: '/media/uploads',
  MEDIA_MOUNT_PATH: '/media',
  MIN_FREE_BYTES_RESERVE: 1n,
};

describe('health and ready', () => {
  it('GET /api/v1/health returns 200 ok', async () => {
    const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    await prisma.pepperCanary.deleteMany();
    await prisma.$disconnect();
    const app = await buildServer(config);
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /api/v1/ready returns 200 with db+redis', async () => {
    const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    await prisma.pepperCanary.deleteMany();
    await prisma.$disconnect();
    const app = await buildServer(config);
    const res = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: true, redis: true });
    await app.close();
  });
});
