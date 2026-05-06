import * as fs from 'node:fs';
import { promises as fsp, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { registerCleanupScripts } from '@mediacompressor/cleanup';
import {
  testDatabaseUrl,
  testRedisUrl,
  createTestUser,
  cleanupTestUsers,
} from '@mediacompressor/test-helpers';
import { sweepExpiredJobs } from './expired-sweep.js';
import { seedJobInDb } from './test-helpers.js';

const TEST_EMAILS = ['expired-sweep@b.com'];
const DATABASE_URL = testDatabaseUrl();
const REDIS_URL = testRedisUrl();

const noopLog = (): void => {};

describe('sweepExpiredJobs (Plan 6 Task 5)', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId: string;
  let mediaMountPath: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: DATABASE_URL });
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    registerCleanupScripts(redis);

    await cleanupTestUsers(prisma, TEST_EMAILS);
    const u = await createTestUser(prisma, { email: 'expired-sweep@b.com' });
    userId = u.id;
    mediaMountPath = mkdtempSync(join(tmpdir(), 'mc-sweep-test-'));
  });

  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { userId } });
    const lockKeys = await redis.keys('cleanup-lock:*');
    if (lockKeys.length > 0) await redis.del(...lockKeys);
    const dlKeys = await redis.keys('downloads:*');
    if (dlKeys.length > 0) await redis.del(...dlKeys);
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    rmSync(mediaMountPath, { recursive: true, force: true });
    await prisma.$disconnect();
    await redis.quit();
  });

  it('happy: expired succeeded-job → status=expired, input+output files unlinked', async () => {
    const job = await seedJobInDb(prisma, {
      userId,
      status: 'succeeded',
      expiresAt: new Date(Date.now() - 1000),
      finishedAt: new Date(Date.now() - 8 * 86400_000),
      outputBytes: 12n,
      outputMime: 'application/octet-stream',
      outputFormat: 'bin',
    });
    await prisma.job.update({
      where: { id: job.id },
      data: { outputStorageKey: `results/${userId}/${job.id}/output.bin` },
    });
    const refreshed = await prisma.job.findUnique({ where: { id: job.id } });

    const inputAbs = join(mediaMountPath, refreshed!.inputStorageKey!);
    const outputAbs = join(mediaMountPath, refreshed!.outputStorageKey!);
    await fsp.mkdir(dirname(inputAbs), { recursive: true });
    await fsp.mkdir(dirname(outputAbs), { recursive: true });
    await fsp.writeFile(inputAbs, 'input-content');
    await fsp.writeFile(outputAbs, 'output-content');

    const result = await sweepExpiredJobs({
      prisma,
      redis,
      mediaMountPath,
      log: noopLog,
    });

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);

    const after = await prisma.job.findUnique({ where: { id: job.id } });
    expect(after?.status).toBe('expired');
    expect(fs.existsSync(inputAbs)).toBe(false);
    expect(fs.existsSync(outputAbs)).toBe(false);
  });

  it('skipped: active download → sweep returns skipped, files NOT unlinked, status NOT changed', async () => {
    const job = await seedJobInDb(prisma, {
      userId,
      status: 'succeeded',
      expiresAt: new Date(Date.now() - 1000),
      finishedAt: new Date(Date.now() - 8 * 86400_000),
      outputBytes: 12n,
      outputMime: 'application/octet-stream',
      outputFormat: 'bin',
    });
    await prisma.job.update({
      where: { id: job.id },
      data: { outputStorageKey: `results/${userId}/${job.id}/output.bin` },
    });
    const refreshed = await prisma.job.findUnique({ where: { id: job.id } });

    const inputAbs = join(mediaMountPath, refreshed!.inputStorageKey!);
    const outputAbs = join(mediaMountPath, refreshed!.outputStorageKey!);
    await fsp.mkdir(dirname(inputAbs), { recursive: true });
    await fsp.mkdir(dirname(outputAbs), { recursive: true });
    await fsp.writeFile(inputAbs, 'input-content');
    await fsp.writeFile(outputAbs, 'output-content');

    // Active download by adding a handler to the downloads-set.
    await redis.sadd(`downloads:${job.id}`, 'fake-handler');
    await redis.expire(`downloads:${job.id}`, 300);

    const result = await sweepExpiredJobs({
      prisma,
      redis,
      mediaMountPath,
      log: noopLog,
    });

    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);

    const after = await prisma.job.findUnique({ where: { id: job.id } });
    expect(after?.status).toBe('succeeded');
    expect(fs.existsSync(inputAbs)).toBe(true);
    expect(fs.existsSync(outputAbs)).toBe(true);
  });

  it('UC1: orphan uploading-job (uploadExpiresAt < now) is also swept', async () => {
    const job = await seedJobInDb(prisma, {
      userId,
      status: 'uploading',
      uploadExpiresAt: new Date(Date.now() - 1000),
    });
    const refreshed = await prisma.job.findUnique({ where: { id: job.id } });
    const inputAbs = join(mediaMountPath, refreshed!.inputStorageKey!);
    await fsp.mkdir(dirname(inputAbs), { recursive: true });
    await fsp.writeFile(inputAbs, 'partial-upload');

    const result = await sweepExpiredJobs({
      prisma,
      redis,
      mediaMountPath,
      log: noopLog,
    });

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);

    const after = await prisma.job.findUnique({ where: { id: job.id } });
    expect(after?.status).toBe('expired');
    expect(fs.existsSync(inputAbs)).toBe(false);
  });

  // C5 + DC24 PFLICHT-REGRESSIONSTEST: parallel download + sweep coordination.
  // While a download-handler is registered, sweep MUST NOT touch either file.
  // After the handler is removed, sweep MUST unlink BOTH input AND output files
  // (DC24: forgetting one file leaves storage-quota leaks).
  it('C5 + DC24: parallel download + sweep — both input AND output files preserved during download, both unlinked after', async () => {
    const job = await seedJobInDb(prisma, {
      userId,
      status: 'succeeded',
      expiresAt: new Date(Date.now() - 1000),
      finishedAt: new Date(Date.now() - 8 * 86400_000),
      outputBytes: 12n,
      outputMime: 'application/octet-stream',
      outputFormat: 'bin',
    });
    // Patch the outputStorageKey now that we have the job.id.
    await prisma.job.update({
      where: { id: job.id },
      data: { outputStorageKey: `results/${userId}/${job.id}/output.bin` },
    });
    const refreshed = await prisma.job.findUnique({ where: { id: job.id } });

    const inputAbs = join(mediaMountPath, refreshed!.inputStorageKey!);
    const outputAbs = join(mediaMountPath, refreshed!.outputStorageKey!);
    await fsp.mkdir(dirname(inputAbs), { recursive: true });
    await fsp.mkdir(dirname(outputAbs), { recursive: true });
    await fsp.writeFile(inputAbs, 'input-content');
    await fsp.writeFile(outputAbs, 'output-content');

    // Active download by adding handler to downloads-set.
    await redis.sadd(`downloads:${job.id}`, 'fake-handler');
    await redis.expire(`downloads:${job.id}`, 300);

    const result = await sweepExpiredJobs({
      prisma,
      redis,
      mediaMountPath,
      log: noopLog,
    });
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
    expect(fs.existsSync(inputAbs)).toBe(true);
    expect(fs.existsSync(outputAbs)).toBe(true);

    // Release the handler.
    await redis.srem(`downloads:${job.id}`, 'fake-handler');

    const result2 = await sweepExpiredJobs({
      prisma,
      redis,
      mediaMountPath,
      log: noopLog,
    });
    expect(result2.processed).toBe(1);
    // DC24: BOTH files weg.
    expect(fs.existsSync(inputAbs)).toBe(false);
    expect(fs.existsSync(outputAbs)).toBe(false);
  });
});
