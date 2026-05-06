import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { generateApiKey, hashApiKey, hashPassword } from '@mediacompressor/auth';
import { buildServer } from '../server.js';
import type { Config } from '../config.js';

const config: Config = {
  DATABASE_URL:
    process.env.DATABASE_URL ??
    'postgresql://mediacompressor:changeme-dev@172.18.0.2:5432/mediacompressor?schema=public',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://172.18.0.3:6379',
  SESSION_SECRET: 'a'.repeat(32),
  CSRF_SECRET: 'b'.repeat(32),
  API_KEY_PEPPER: 'c'.repeat(32),
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  PORT: 0,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  ARGON2_MAX_CONCURRENCY: 8,
};

const apiKeyPepper = Buffer.from(config.API_KEY_PEPPER);

describe('jobs routes — POST /api/v1/jobs (Plan 4 Task 6 stub)', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    // Cleanup leftovers from prior runs.
    await prisma.session.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.job.deleteMany();
    await prisma.user.deleteMany({ where: { email: 'jobs@b.com' } });

    const u = await prisma.user.create({
      data: {
        email: 'jobs@b.com',
        passwordHash: await hashPassword('hunter22hunter22'),
      },
    });
    userId = u.id;

    const seeded = generateApiKey();
    apiKey = seeded.key;
    await prisma.apiKey.create({
      data: {
        userId,
        name: 'jobs-test',
        keyHash: hashApiKey(seeded.key, apiKeyPepper),
        keyPrefix: seeded.prefix,
        scopes: ['jobs:write', 'jobs:read'],
      },
    });

    // Drain BullMQ queue keys so leftover jobs from prior runs do not collide
    // with the per-test jobId we use for idempotency (job.id reuses the row id).
    const keys = await redis.keys('bull:compression:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { userId } });
    const keys = await redis.keys('bull:compression:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await prisma.job.deleteMany({ where: { userId } });
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.apiKey.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    const keys = await redis.keys('bull:compression:*');
    if (keys.length > 0) await redis.del(...keys);
    await prisma.$disconnect();
    await redis.quit();
  });

  it('POST without auth → 401', async () => {
    const app = await buildServer(config);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: {
        inputStorageKey: `uploads/${userId}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/source.bin`,
        kind: 'image',
        profile: 'web-optimized',
      },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('POST with Bearer-API-Key + valid storage key → 201, BullMQ-Queue has the job', async () => {
    const app = await buildServer(config);
    const jobUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        inputStorageKey: `uploads/${userId}/${jobUuid}/source.bin`,
        kind: 'image',
        profile: 'web-optimized',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      status: string;
      createdAt: string;
      links: { self: string; events: string };
    };
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('queued');
    expect(body.createdAt).toBeTruthy();
    expect(body.links.self).toBe(`/api/v1/jobs/${body.id}`);
    expect(body.links.events).toBe(`/api/v1/jobs/${body.id}/events`);

    // BullMQ-Queue contains the job with jobId == DB row id.
    const queue = new Queue('compression', { connection: redis });
    try {
      const queued = await queue.getJob(body.id);
      expect(queued).toBeDefined();
      expect(queued!.data).toMatchObject({
        jobId: body.id,
        userId,
        inputPath: `uploads/${userId}/${jobUuid}/source.bin`,
        outputPath: `results/${userId}/${body.id}/output`,
        profile: 'web-optimized',
      });
    } finally {
      await queue.close();
    }

    await app.close();
  });

  it('POST with invalid profile → 400 (Zod validation)', async () => {
    const app = await buildServer(config);
    const jobUuid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        inputStorageKey: `uploads/${userId}/${jobUuid}/source.bin`,
        kind: 'image',
        profile: 'not-a-real-profile',
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST with storage key for another user → 403 (C3-Rev1)', async () => {
    const app = await buildServer(config);
    const otherUuid = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const jobUuid = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        inputStorageKey: `uploads/${otherUuid}/${jobUuid}/source.bin`,
        kind: 'image',
        profile: 'web-optimized',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
    await app.close();
  });

  it('C7-Rev2: queue.add throws → NO Job in DB (Transaction-Rollback)', async () => {
    const app = await buildServer(config);

    const queueAddSpy = vi
      .spyOn(Queue.prototype, 'add')
      .mockRejectedValueOnce(new Error('redis connection lost'));

    const jobUuid = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        inputStorageKey: `uploads/${userId}/${jobUuid}/source.bin`,
        kind: 'image',
        profile: 'web-optimized',
      },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    const jobsInDb = await prisma.job.findMany({ where: { userId } });
    expect(jobsInDb).toHaveLength(0);

    queueAddSpy.mockRestore();
    await app.close();
  });
});
