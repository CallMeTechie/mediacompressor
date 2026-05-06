import { describe, expect, it } from 'vitest';
import { createPrismaClient } from '@mediacompressor/db';
import { buildServer } from './server.js';
import type { Config } from './config.js';

const config: Config = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://mc:mc@127.0.0.1:5432/mc?schema=public',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  SESSION_SECRET: 'a'.repeat(32),
  CSRF_SECRET: 'b'.repeat(32),
  API_KEY_PEPPER: 'c'.repeat(32),
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  PORT: 0,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  ARGON2_MAX_CONCURRENCY: 8,
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
