import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

const TEST_EMAILS = ['download@b.com', 'download-foreign@b.com'];

// Tests use /tmp as the media-mount; fixtures live at
// /tmp/results/<userId>/<jobId>/output.bin so the route can stat+stream them.
const TEST_MEDIA_MOUNT = '/tmp';

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
  MEDIA_MOUNT_PATH: TEST_MEDIA_MOUNT,
  MIN_FREE_BYTES_RESERVE: 1n,
  ENABLE_LEGACY_JOB_STUB: false,
};

const apiKeyPepper = Buffer.from(config.API_KEY_PEPPER);

async function startServer(app: FastifyInstance): Promise<{ url: string }> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}` };
}

interface SeedJobOpts {
  ownerId: string;
  status?: 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'expired';
  outputStorageKey?: string | null;
  outputMime?: string | null;
  outputFormat?: string | null;
  outputBytes?: bigint | null;
  expiresAt?: Date | null;
}

describe('download route — GET /api/v1/jobs/:id/download (Plan 6 Task 4)', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId: string;
  let foreignUserId: string;
  let apiKey: string;
  const fixtureDirs: string[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS);

    const u = await createTestUser(prisma, { email: 'download@b.com' });
    userId = u.id;

    const f = await createTestUser(prisma, { email: 'download-foreign@b.com' });
    foreignUserId = f.id;

    const seeded = generateApiKey();
    apiKey = seeded.key;
    await prisma.apiKey.create({
      data: {
        userId,
        name: 'download-test',
        keyHash: hashApiKey(seeded.key, apiKeyPepper),
        keyPrefix: seeded.prefix,
        scopes: ['jobs:read'],
      },
    });
  });

  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { userId: { in: [userId, foreignUserId] } } });
    // Clear cleanup-locks/download-sets from prior tests.
    const lockKeys = await redis.keys('cleanup-lock:*');
    if (lockKeys.length > 0) await redis.del(...lockKeys);
    const dlKeys = await redis.keys('downloads:*');
    if (dlKeys.length > 0) await redis.del(...dlKeys);
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
    await redis.quit();
    for (const p of fixtureDirs) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  async function seedJob(opts: SeedJobOpts) {
    // For the happy-path/DC4 cases we need the storage key to embed the real
    // job.id; build a placeholder, then patch in a second update.
    const placeholderKey =
      opts.outputStorageKey === undefined
        ? `results/${opts.ownerId}/__pending__/output.bin`
        : opts.outputStorageKey;

    const job = await prisma.job.create({
      data: {
        userId: opts.ownerId,
        status: opts.status ?? 'succeeded',
        kind: 'image',
        profile: 'web-optimized',
        overrides: {},
        inputFilename: 'in.bin',
        uploadId: `task6-dl-${Math.random().toString(36).slice(2)}-${Date.now()}`,
        outputStorageKey: placeholderKey,
        outputMime:
          opts.outputMime === undefined ? 'application/octet-stream' : opts.outputMime,
        outputFormat: opts.outputFormat === undefined ? 'bin' : opts.outputFormat,
        ...(opts.outputBytes !== undefined && opts.outputBytes !== null
          ? { outputBytes: opts.outputBytes }
          : {}),
        ...(opts.expiresAt !== undefined && opts.expiresAt !== null
          ? { expiresAt: opts.expiresAt }
          : {}),
      },
    });

    if (opts.outputStorageKey === undefined) {
      const realKey = `results/${opts.ownerId}/${job.id}/output.bin`;
      await prisma.job.update({ where: { id: job.id }, data: { outputStorageKey: realKey } });
      job.outputStorageKey = realKey;
    }
    return job;
  }

  /**
   * Writes a binary fixture at <MEDIA_MOUNT>/<storageKey>; returns the byte size.
   * Tracks the parent dir for afterAll cleanup.
   */
  function writeFixture(storageKey: string, bytes = 1024): number {
    const abs = join(TEST_MEDIA_MOUNT, storageKey);
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    const buf = Buffer.alloc(bytes, 0xab);
    writeFileSync(abs, buf);
    fixtureDirs.push(dir);
    return bytes;
  }

  it('without auth → 401', async () => {
    const app = await buildServer(config);
    try {
      const job = await seedJob({ ownerId: userId, status: 'succeeded' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${job.id}/download`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('foreign user job → 404 NOT_FOUND', async () => {
    const app = await buildServer(config);
    try {
      const foreign = await seedJob({ ownerId: foreignUserId, status: 'succeeded' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${foreign.id}/download`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    } finally {
      await app.close();
    }
  });

  it('job in status=processing → 409 JOB_NOT_READY', async () => {
    const app = await buildServer(config);
    try {
      const job = await seedJob({
        ownerId: userId,
        status: 'processing',
        outputStorageKey: null,
        outputMime: null,
        outputFormat: null,
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${job.id}/download`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: { code: string; message?: string } };
      expect(body.error.code).toBe('JOB_NOT_READY');
      expect(body.error.message).toMatch(/processing/);
    } finally {
      await app.close();
    }
  });

  it('expired job (expiresAt < now) → 410 EXPIRED', async () => {
    const app = await buildServer(config);
    try {
      const past = new Date(Date.now() - 60_000);
      const job = await seedJob({
        ownerId: userId,
        status: 'succeeded',
        expiresAt: past,
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${job.id}/download`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(410);
      expect((res.json() as { error: { code: string } }).error.code).toBe('EXPIRED');
    } finally {
      await app.close();
    }
  });

  it('cleanup-lock active → 410 EXPIRED, message=cleanup in progress', async () => {
    const app = await buildServer(config);
    try {
      const job = await seedJob({ ownerId: userId, status: 'succeeded' });
      // Set a cleanup-lock so startDownloadHandler refuses.
      await redis.set(`cleanup-lock:${job.id}`, 'someowner', 'EX', 60);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${job.id}/download`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.statusCode).toBe(410);
      const body = res.json() as { error: { code: string; message?: string } };
      expect(body.error.code).toBe('EXPIRED');
      expect(body.error.message).toBe('cleanup in progress');
    } finally {
      await app.close();
    }
  });

  it('happy path: file streams, Content-Length matches, downloads-set has handler during stream, set empty after stream end', async () => {
    const app = await buildServer(config);
    const { url } = await startServer(app);
    try {
      const job = await seedJob({ ownerId: userId, status: 'succeeded' });
      // Use a large fixture so the read loop has multiple ticks to observe
      // the handler being present in the downloads-set.
      const size = writeFixture(job.outputStorageKey!, 16 * 1024 * 1024);

      const res = await fetch(`${url}/api/v1/jobs/${job.id}/download`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe(String(size));
      expect(res.headers.get('content-type')).toMatch(/octet-stream/);
      expect(res.headers.get('content-disposition')).toMatch(/attachment.*output\.bin/);

      const reader = res.body!.getReader();
      // After the first chunk arrives, the handler MUST be in the set.
      const first = await reader.read();
      expect(first.done).toBe(false);
      const cardDuring = await redis.scard(`downloads:${job.id}`);
      expect(cardDuring).toBe(1);

      // Drain the rest.
      let total = first.value!.byteLength;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
      }
      expect(total).toBe(size);

      // Allow the stream's end → ensureReleased → redis.srem to settle.
      const deadline = Date.now() + 1100;
      let card = await redis.scard(`downloads:${job.id}`);
      while (card !== 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        card = await redis.scard(`downloads:${job.id}`);
      }
      expect(card).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('DC4 PFLICHT-REGRESSIONSTEST: client disconnect mid-stream → handler released within 1s', async () => {
    const app = await buildServer(config);
    const { url } = await startServer(app);
    try {
      const job = await seedJob({ ownerId: userId, status: 'succeeded' });
      // Fixture must be large enough that the kernel/socket buffers cannot drain
      // it instantly — otherwise we cannot abort *during* the stream.
      writeFixture(job.outputStorageKey!, 32 * 1024 * 1024); // 32 MiB

      const ctrl = new AbortController();
      const res = await fetch(`${url}/api/v1/jobs/${job.id}/download`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      // Wait for the first chunk so the handler is definitely registered.
      const first = await reader.read();
      expect(first.done).toBe(false);

      const before = await redis.scard(`downloads:${job.id}`);
      expect(before).toBe(1);

      // Abort the client side mid-stream.
      ctrl.abort();
      try {
        // Drain to surface the abort. AbortError on next read is expected.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        /* expected on abort */
      }

      // Handler must be released within 1s. Poll up to ~1100 ms.
      const deadline = Date.now() + 1100;
      let card = await redis.scard(`downloads:${job.id}`);
      while (card !== 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        card = await redis.scard(`downloads:${job.id}`);
      }
      expect(card).toBe(0);
    } finally {
      // The aborted download may have left a half-closed TCP connection that
      // would block app.close() until the keep-alive timeout. Force-close all
      // open sockets so the test exits promptly. (Available on Node >=18.)
      type ClosableServer = { closeAllConnections?: () => void };
      const srv = app.server as unknown as ClosableServer;
      srv.closeAllConnections?.();
      await app.close();
    }
  });
});
