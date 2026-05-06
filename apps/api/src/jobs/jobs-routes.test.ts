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

describe('jobs routes — GET /api/v1/jobs + GET /api/v1/jobs/:id (Plan 4 Task 7)', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId: string;
  let foreignUserId: string;
  let apiKey: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    // Cleanup leftovers from prior runs (use distinct emails for parallel-test isolation).
    await prisma.user.deleteMany({
      where: { email: { in: ['jobs7@b.com', 'jobs7-foreign@b.com'] } },
    });

    const u = await prisma.user.create({
      data: {
        email: 'jobs7@b.com',
        passwordHash: await hashPassword('hunter22hunter22'),
      },
    });
    userId = u.id;

    const foreign = await prisma.user.create({
      data: {
        email: 'jobs7-foreign@b.com',
        passwordHash: await hashPassword('hunter22hunter22'),
      },
    });
    foreignUserId = foreign.id;

    const seeded = generateApiKey();
    apiKey = seeded.key;
    await prisma.apiKey.create({
      data: {
        userId,
        name: 'jobs7-test',
        keyHash: hashApiKey(seeded.key, apiKeyPepper),
        keyPrefix: seeded.prefix,
        scopes: ['jobs:read'],
      },
    });
  });

  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { userId: { in: [userId, foreignUserId] } } });
  });

  afterAll(async () => {
    await prisma.job.deleteMany({ where: { userId: { in: [userId, foreignUserId] } } });
    await prisma.session.deleteMany({ where: { userId: { in: [userId, foreignUserId] } } });
    await prisma.apiKey.deleteMany({ where: { userId: { in: [userId, foreignUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, foreignUserId] } } });
    await prisma.$disconnect();
    await redis.quit();
  });

  /**
   * Seeds a Job row directly via Prisma (bypassing the POST endpoint and BullMQ
   * to keep these read-endpoint tests isolated from queue side-effects).
   */
  async function seedJob(opts: {
    ownerId: string;
    status?: 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'expired';
    kind?: 'image' | 'video';
    createdAt?: Date;
    profile?: string;
    inputFilename?: string;
  }) {
    return prisma.job.create({
      data: {
        userId: opts.ownerId,
        status: opts.status ?? 'queued',
        kind: opts.kind ?? 'image',
        profile: opts.profile ?? 'web-optimized',
        overrides: {},
        inputFilename: opts.inputFilename ?? 'in.bin',
        uploadId: `task7-${Math.random().toString(36).slice(2)}-${Date.now()}`,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
  }

  it('list paginated: 5 jobs, limit=2 → walks all pages with nextCursor', async () => {
    const app = await buildServer(config);
    try {
      // Seed 5 jobs with distinct createdAt so ordering is deterministic.
      const base = Date.now();
      for (let i = 0; i < 5; i++) {
        await seedJob({
          ownerId: userId,
          createdAt: new Date(base - i * 1000),
          inputFilename: `file-${i}.bin`,
        });
      }

      // Page 1
      const r1 = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?limit=2',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(r1.statusCode).toBe(200);
      const p1 = r1.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      expect(p1.items).toHaveLength(2);
      expect(p1.nextCursor).toBeTruthy();

      // Page 2
      const r2 = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(r2.statusCode).toBe(200);
      const p2 = r2.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      expect(p2.items).toHaveLength(2);
      expect(p2.nextCursor).toBeTruthy();
      // No overlap between pages
      const idsP1 = new Set(p1.items.map((j) => j.id));
      for (const j of p2.items) expect(idsP1.has(j.id)).toBe(false);

      // Page 3 (last)
      const r3 = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs?limit=2&cursor=${encodeURIComponent(p2.nextCursor!)}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(r3.statusCode).toBe(200);
      const p3 = r3.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      expect(p3.items).toHaveLength(1);
      expect(p3.nextCursor).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('list filtered: status=queued → returns only queued items', async () => {
    const app = await buildServer(config);
    try {
      await seedJob({ ownerId: userId, status: 'queued' });
      await seedJob({ ownerId: userId, status: 'queued' });
      await seedJob({ ownerId: userId, status: 'succeeded' });
      await seedJob({ ownerId: userId, status: 'failed' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?status=queued',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ status: string }>; nextCursor: string | null };
      expect(body.items).toHaveLength(2);
      for (const j of body.items) expect(j.status).toBe('queued');
    } finally {
      await app.close();
    }
  });

  it('detail: GET /jobs/:id of own job → 200 + job body', async () => {
    const app = await buildServer(config);
    try {
      const seeded = await seedJob({ ownerId: userId, inputFilename: 'mine.bin' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${seeded.id}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; userId: string; inputFilename: string };
      expect(body.id).toBe(seeded.id);
      expect(body.userId).toBe(userId);
      expect(body.inputFilename).toBe('mine.bin');
    } finally {
      await app.close();
    }
  });

  it('foreign-user 404: GET /jobs/:id of OTHER user → 404 NOT_FOUND (no existence-leak)', async () => {
    const app = await buildServer(config);
    try {
      const foreignJob = await seedJob({ ownerId: foreignUserId, inputFilename: 'theirs.bin' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${foreignJob.id}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      // Crucially 404, NOT 403 — prevents existence-leak of foreign job IDs.
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    } finally {
      await app.close();
    }
  });
});
