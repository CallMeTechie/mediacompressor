import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import type { FastifyInstance } from 'fastify';
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

const TEST_EMAILS = ['jobs9@b.com', 'jobs9-foreign@b.com'];

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
  ENABLE_LEGACY_JOB_STUB: false,
};

const apiKeyPepper = Buffer.from(config.API_KEY_PEPPER);

/**
 * Reads a single SSE event (terminated by blank-line `\n\n`) from a fetch
 * response body. Decodes UTF-8 progressively. Returns the event text WITHOUT
 * the terminating `\n\n`. Returns null on stream end.
 */
async function readNextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buf: { value: string },
): Promise<string | null> {
  const decoder = new TextDecoder();
  while (!buf.value.includes('\n\n')) {
    const { done, value } = await reader.read();
    if (done) return null;
    buf.value += decoder.decode(value, { stream: true });
  }
  const idx = buf.value.indexOf('\n\n');
  const evt = buf.value.slice(0, idx);
  buf.value = buf.value.slice(idx + 2);
  return evt;
}

async function startServer(app: FastifyInstance): Promise<{ url: string }> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}` };
}

describe('jobs-events route — GET /api/v1/jobs/:id/events (Plan 4 Task 9)', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId: string;
  let foreignUserId: string;
  let apiKey: string;
  let foreignApiKey: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);

    const u = await createTestUser(prisma, { email: 'jobs9@b.com' });
    userId = u.id;

    const f = await createTestUser(prisma, { email: 'jobs9-foreign@b.com' });
    foreignUserId = f.id;

    const seeded = generateApiKey();
    apiKey = seeded.key;
    await prisma.apiKey.create({
      data: {
        userId,
        name: 'jobs9-test',
        keyHash: hashApiKey(seeded.key, apiKeyPepper),
        keyPrefix: seeded.prefix,
        scopes: ['jobs:read'],
      },
    });

    const seededForeign = generateApiKey();
    foreignApiKey = seededForeign.key;
    await prisma.apiKey.create({
      data: {
        userId: foreignUserId,
        name: 'jobs9-foreign-test',
        keyHash: hashApiKey(seededForeign.key, apiKeyPepper),
        keyPrefix: seededForeign.prefix,
        scopes: ['jobs:read'],
      },
    });
  });

  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { userId: { in: [userId, foreignUserId] } } });
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
  });

  async function seedJob(opts: {
    ownerId: string;
    status?: 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'expired';
    progress?: number;
    outputBytes?: bigint | null;
  }) {
    return prisma.job.create({
      data: {
        userId: opts.ownerId,
        status: opts.status ?? 'processing',
        kind: 'image',
        profile: 'web-optimized',
        overrides: {},
        inputFilename: 'in.bin',
        uploadId: `task9-${Math.random().toString(36).slice(2)}-${Date.now()}`,
        progress: opts.progress ?? 0,
        ...(opts.outputBytes !== undefined ? { outputBytes: opts.outputBytes } : {}),
      },
    });
  }

  it('snapshot at connect — first message for a processing job is event: snapshot', async () => {
    const app = await buildServer(config);
    const { url } = await startServer(app);
    const ctrl = new AbortController();
    try {
      const job = await seedJob({ ownerId: userId, status: 'processing', progress: 42 });
      const res = await fetch(`${url}/api/v1/jobs/${job.id}/events`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(res.headers.get('cache-control')).toMatch(/no-cache/);
      expect(res.headers.get('x-accel-buffering')).toBe('no');

      const reader = res.body!.getReader();
      const buf = { value: '' };
      const evt = await readNextEvent(reader, buf);
      expect(evt).toBeTruthy();
      expect(evt).toMatch(/^event: snapshot\ndata: /);
      const dataLine = evt!.split('\n').find((l) => l.startsWith('data: '))!;
      const data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
      expect(data).toMatchObject({ jobId: job.id, status: 'processing', progress: 42 });
    } finally {
      ctrl.abort();
      await app.close();
    }
  });

  it('end-of-stream at terminal status — succeeded job → snapshot, then stream closes', async () => {
    const app = await buildServer(config);
    const { url } = await startServer(app);
    try {
      const job = await seedJob({ ownerId: userId, status: 'succeeded', progress: 100 });
      const res = await fetch(`${url}/api/v1/jobs/${job.id}/events`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.status).toBe(200);
      // Read the full body to completion — server should end after snapshot.
      const body = await res.text();
      expect(body).toMatch(/^event: snapshot\ndata: /);
      const dataLine = body.split('\n').find((l) => l.startsWith('data: '))!;
      const data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
      expect(data).toMatchObject({ jobId: job.id, status: 'succeeded' });
    } finally {
      await app.close();
    }
  });

  it('pub/sub forward — published status messages reach the SSE subscriber', async () => {
    const app = await buildServer(config);
    const { url } = await startServer(app);
    const pub = new IORedis(config.REDIS_URL);
    const ctrl = new AbortController();
    try {
      const job = await seedJob({ ownerId: userId, status: 'processing', progress: 0 });
      const res = await fetch(`${url}/api/v1/jobs/${job.id}/events`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      const reader = res.body!.getReader();
      const buf = { value: '' };

      // Discard snapshot.
      const snapshot = await readNextEvent(reader, buf);
      expect(snapshot).toMatch(/^event: snapshot\n/);

      // Give the route a moment to subscribe before we publish.
      await new Promise((r) => setTimeout(r, 50));
      await pub.publish(
        `job:status:${job.id}`,
        JSON.stringify({ status: 'processing', progress: 50 }),
      );

      const evt = await readNextEvent(reader, buf);
      expect(evt).toMatch(/^event: status\n/);
      const dataLine = evt!.split('\n').find((l) => l.startsWith('data: '))!;
      expect(JSON.parse(dataLine.slice(6))).toMatchObject({ status: 'processing', progress: 50 });
    } finally {
      ctrl.abort();
      await pub.quit();
      await app.close();
    }
  });

  it('cancel via DELETE arrives at SSE subscriber — stream sees canceled, then ends', async () => {
    const app = await buildServer(config);
    const { url } = await startServer(app);
    const ctrl = new AbortController();
    try {
      const job = await seedJob({ ownerId: userId, status: 'processing', progress: 10 });
      const sse = await fetch(`${url}/api/v1/jobs/${job.id}/events`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      const reader = sse.body!.getReader();
      const buf = { value: '' };
      // Snapshot.
      await readNextEvent(reader, buf);
      // Make sure subscribe has settled before DELETE publishes.
      await new Promise((r) => setTimeout(r, 50));

      const del = await fetch(`${url}/api/v1/jobs/${job.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(del.status).toBe(204);

      const evt = await readNextEvent(reader, buf);
      expect(evt).toMatch(/^event: status\n/);
      const dataLine = evt!.split('\n').find((l) => l.startsWith('data: '))!;
      expect(JSON.parse(dataLine.slice(6))).toMatchObject({ status: 'canceled' });

      // Stream ends.
      const after = await readNextEvent(reader, buf);
      expect(after).toBeNull();
    } finally {
      ctrl.abort();
      await app.close();
    }
  });

  it('C6 PFLICHT-REGRESSIONSTEST — cleanup is idempotent: end-status + client-close race produces no unhandledRejection', async () => {
    const app = await buildServer(config);
    const { url } = await startServer(app);
    const pub = new IORedis(config.REDIS_URL);

    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onRejection);

    try {
      const job = await seedJob({ ownerId: userId, status: 'processing', progress: 0 });
      const ctrl = new AbortController();
      const res = await fetch(`${url}/api/v1/jobs/${job.id}/events`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      const reader = res.body!.getReader();
      const buf = { value: '' };
      await readNextEvent(reader, buf); // snapshot

      // Wait for the route's redis subscribe to settle.
      await new Promise((r) => setTimeout(r, 50));

      // Trigger the race: simultaneously fire client-close AND publish a terminal-status event.
      // The route's `cleaned` flag must guarantee that double-cleanup (one from req.raw.on('close'),
      // one from the message handler observing the end-status) does not double-quit the redis sub.
      ctrl.abort();
      await pub.publish(`job:status:${job.id}`, JSON.stringify({ status: 'succeeded' }));

      // Wait for both paths to potentially fire and for any errors to surface.
      await new Promise((r) => setTimeout(r, 100));

      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRejection);
      await pub.quit();
      await app.close();
    }
  });

  it('404 foreign user — SSE for another user’s job returns 404', async () => {
    const app = await buildServer(config);
    const { url } = await startServer(app);
    try {
      const foreign = await seedJob({ ownerId: foreignUserId, status: 'processing' });
      const res = await fetch(`${url}/api/v1/jobs/${foreign.id}/events`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('NOT_FOUND');
    } finally {
      await app.close();
    }
  });

  it('401 no auth — unauthenticated SSE → 401', async () => {
    const app = await buildServer(config);
    const { url } = await startServer(app);
    try {
      const job = await seedJob({ ownerId: userId, status: 'processing' });
      const res = await fetch(`${url}/api/v1/jobs/${job.id}/events`);
      expect(res.status).toBe(401);
    } finally {
      // foreignApiKey is unused in this test, but keep it referenced to avoid no-unused-vars.
      void foreignApiKey;
      await app.close();
    }
  });
});
