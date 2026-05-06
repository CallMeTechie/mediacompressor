import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { generateApiKey, hashApiKey } from '@mediacompressor/auth';
import {
  TEST_API_KEY_PEPPER,
  TEST_SESSION_SECRET,
  TEST_CSRF_SECRET,
  testDatabaseUrl,
  testRedisUrl,
  createTestUser,
  cleanupTestUsers,
} from '@mediacompressor/test-helpers';
import { buildServer } from '../server.js';
import type { Config } from '../config.js';

// Per-describe scoped emails for parallel-test isolation. The union of these
// is the set of users this file may seed/cleanup; each describe's beforeAll/
// afterAll touches only its own slice (HC1-Fix from Devil's-Advocate).
const TEST_EMAILS_TASK6 = ['jobs@b.com'];
const TEST_EMAILS_TASK7 = ['jobs7@b.com', 'jobs7-foreign@b.com'];
const TEST_EMAILS_TASK8 = ['jobs8@b.com', 'jobs8-foreign@b.com'];

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
    // Cleanup leftovers from prior runs (scoped — does not nuke other suites).
    await cleanupTestUsers(prisma, TEST_EMAILS_TASK6);

    const u = await createTestUser(prisma, { email: 'jobs@b.com' });
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
    await cleanupTestUsers(prisma, TEST_EMAILS_TASK6);
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
    // Cleanup leftovers from prior runs (scoped — does not nuke other suites).
    await cleanupTestUsers(prisma, TEST_EMAILS_TASK7);

    const u = await createTestUser(prisma, { email: 'jobs7@b.com' });
    userId = u.id;

    const foreign = await createTestUser(prisma, { email: 'jobs7-foreign@b.com' });
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
    await cleanupTestUsers(prisma, TEST_EMAILS_TASK7);
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

describe('jobs routes — DELETE /api/v1/jobs/:id (Plan 4 Task 8)', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId: string;
  let foreignUserId: string;
  let apiKey: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    // Cleanup leftovers from prior runs (scoped — does not nuke other suites).
    await cleanupTestUsers(prisma, TEST_EMAILS_TASK8);

    const u = await createTestUser(prisma, { email: 'jobs8@b.com' });
    userId = u.id;

    const foreign = await createTestUser(prisma, { email: 'jobs8-foreign@b.com' });
    foreignUserId = foreign.id;

    const seeded = generateApiKey();
    apiKey = seeded.key;
    await prisma.apiKey.create({
      data: {
        userId,
        name: 'jobs8-test',
        keyHash: hashApiKey(seeded.key, apiKeyPepper),
        keyPrefix: seeded.prefix,
        scopes: ['jobs:write', 'jobs:read'],
      },
    });

    // Drain leftover cancel keys to prevent flakes.
    const cancelKeys = await redis.keys('cancel:*');
    if (cancelKeys.length > 0) await redis.del(...cancelKeys);
  });

  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { userId: { in: [userId, foreignUserId] } } });
    const cancelKeys = await redis.keys('cancel:*');
    if (cancelKeys.length > 0) await redis.del(...cancelKeys);
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS_TASK8);
    const cancelKeys = await redis.keys('cancel:*');
    if (cancelKeys.length > 0) await redis.del(...cancelKeys);
    await prisma.$disconnect();
    await redis.quit();
  });

  async function seedJob(opts: {
    ownerId: string;
    status?: 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'expired';
    kind?: 'image' | 'video';
    profile?: string;
    inputFilename?: string;
    finishedAt?: Date | null;
  }) {
    return prisma.job.create({
      data: {
        userId: opts.ownerId,
        status: opts.status ?? 'queued',
        kind: opts.kind ?? 'image',
        profile: opts.profile ?? 'web-optimized',
        overrides: {},
        inputFilename: opts.inputFilename ?? 'in.bin',
        uploadId: `task8-${Math.random().toString(36).slice(2)}-${Date.now()}`,
        ...(opts.finishedAt !== undefined ? { finishedAt: opts.finishedAt } : {}),
      },
    });
  }

  it('DELETE without auth → 401', async () => {
    const app = await buildServer(config);
    try {
      const job = await seedJob({ ownerId: userId, status: 'queued' });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/jobs/${job.id}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("DELETE foreign user's job → 404 NOT_FOUND (no existence-leak)", async () => {
    const app = await buildServer(config);
    try {
      const foreignJob = await seedJob({ ownerId: foreignUserId, status: 'queued' });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/jobs/${foreignJob.id}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      // Job state must be unchanged.
      const after = await prisma.job.findUnique({ where: { id: foreignJob.id } });
      expect(after?.status).toBe('queued');
      // No cancel-key written for foreign job.
      const cancelVal = await redis.get(`cancel:${foreignJob.id}`);
      expect(cancelVal).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE own queued job → 204, DB=canceled, cancel-key set, pub/sub event seen', async () => {
    const app = await buildServer(config);
    const sub = new IORedis(config.REDIS_URL);
    try {
      const job = await seedJob({ ownerId: userId, status: 'queued' });

      // Subscribe BEFORE the DELETE to avoid losing the event.
      await sub.subscribe(`job:status:${job.id}`);
      const messages: string[] = [];
      sub.on('message', (_ch, raw) => messages.push(raw));

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/jobs/${job.id}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(204);

      // DB row updated to canceled.
      const after = await prisma.job.findUnique({ where: { id: job.id } });
      expect(after?.status).toBe('canceled');
      expect(after?.finishedAt).not.toBeNull();

      // Redis cancel-key set with a TTL (worker reads this).
      const cancelVal = await redis.get(`cancel:${job.id}`);
      expect(cancelVal).toBe('1');
      const ttl = await redis.ttl(`cancel:${job.id}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);

      // Pub/sub event arrived (poll-loop with safety bound).
      const start = Date.now();
      while (messages.length === 0 && Date.now() - start < 200) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(messages.length).toBeGreaterThan(0);
      expect(JSON.parse(messages[0]!)).toMatchObject({ status: 'canceled' });
    } finally {
      await sub.quit();
      await app.close();
    }
  });

  it('C10-Rev2: DELETE /jobs/:id publiziert canceled-Event innerhalb von 100 ms', async () => {
    const app = await buildServer(config);
    const sub = new IORedis(config.REDIS_URL);
    try {
      const job = await seedJob({ ownerId: userId, status: 'processing' });

      await sub.subscribe(`job:status:${job.id}`);
      const messages: string[] = [];
      sub.on('message', (_ch, raw) => messages.push(raw));

      const t0 = Date.now();
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/jobs/${job.id}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(204);

      // Spin until the canceled-event arrives or the safety-timeout fires.
      const start = Date.now();
      while (messages.length === 0 && Date.now() - start < 200) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const elapsed = Date.now() - t0;
      expect(messages.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(100);
      expect(JSON.parse(messages[0]!)).toMatchObject({ status: 'canceled' });
    } finally {
      await sub.quit();
      await app.close();
    }
  });

  it('DELETE already-finished job → 204 (idempotent), status unchanged, NO event', async () => {
    const app = await buildServer(config);
    const sub = new IORedis(config.REDIS_URL);
    try {
      const finishedAt = new Date(Date.now() - 60_000);
      const job = await seedJob({ ownerId: userId, status: 'succeeded', finishedAt });

      await sub.subscribe(`job:status:${job.id}`);
      const messages: string[] = [];
      sub.on('message', (_ch, raw) => messages.push(raw));

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/jobs/${job.id}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(204);

      // DB row untouched.
      const after = await prisma.job.findUnique({ where: { id: job.id } });
      expect(after?.status).toBe('succeeded');
      expect(after?.finishedAt?.getTime()).toBe(finishedAt.getTime());

      // No cancel-key set.
      const cancelVal = await redis.get(`cancel:${job.id}`);
      expect(cancelVal).toBeNull();

      // Wait briefly to ensure no event was published.
      await new Promise((r) => setTimeout(r, 50));
      expect(messages).toHaveLength(0);
    } finally {
      await sub.quit();
      await app.close();
    }
  });
});
