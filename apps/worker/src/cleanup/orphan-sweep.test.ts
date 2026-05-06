import * as fs from 'node:fs';
import { promises as fsp, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import {
  testDatabaseUrl,
  createTestUser,
  cleanupTestUsers,
} from '@mediacompressor/test-helpers';
import { sweepOrphans } from './orphan-sweep.js';
import { seedJobInDb } from './test-helpers.js';

const TEST_EMAILS = ['orphan-sweep@b.com'];
const DATABASE_URL = testDatabaseUrl();

const noopLog = (): void => {};

/** Backdate a directory's mtime/atime to N hours ago. */
async function backdateMtime(path: string, hoursAgo: number): Promise<void> {
  const t = (Date.now() - hoursAgo * 3600_000) / 1000;
  await fsp.utimes(path, t, t);
}

describe('sweepOrphans (Plan 6 Task 6)', () => {
  let prisma: PrismaClient;
  let userId: string;
  let mediaMountPath: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: DATABASE_URL });
    await cleanupTestUsers(prisma, TEST_EMAILS);
    const u = await createTestUser(prisma, { email: 'orphan-sweep@b.com' });
    userId = u.id;
    mediaMountPath = mkdtempSync(join(tmpdir(), 'mc-orphan-test-'));
  });

  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { userId } });
    rmSync(mediaMountPath, { recursive: true, force: true });
    await fsp.mkdir(mediaMountPath, { recursive: true });
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    rmSync(mediaMountPath, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it('orphan dir without DB-job + dir-mtime > 1h → deleted', async () => {
    const phantomJobId = randomUUID();
    const target = join(mediaMountPath, 'uploads', userId, phantomJobId);
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(join(target, 'source.bin'), 'phantom-data');
    // Backdate mtime to 2h ago AFTER writing children.
    await backdateMtime(target, 2);

    const result = await sweepOrphans({
      prisma,
      mediaMountPath,
      log: noopLog,
    });

    expect(result.scanned).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  // DC5 PFLICHT-REGRESSIONSTEST
  it('DC5: orphan dir with mtime < 1h is NOT deleted (race-protect against active worker)', async () => {
    const phantomJobId = randomUUID();
    const target = join(mediaMountPath, 'results', userId, phantomJobId);
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(join(target, 'output'), 'fresh-data');
    // mtime is now (just-written) — within 1h grace.

    const result = await sweepOrphans({
      prisma,
      mediaMountPath,
      log: noopLog,
    });
    expect(result.scanned).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(1);
    expect(fs.existsSync(join(target, 'output'))).toBe(true);

    // Backdate to >1h ago — now eligible for deletion.
    await backdateMtime(target, 2);

    const result2 = await sweepOrphans({
      prisma,
      mediaMountPath,
      log: noopLog,
    });
    expect(result2.deleted).toBe(1);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('dir with succeeded-job → kept', async () => {
    const job = await seedJobInDb(prisma, {
      userId,
      status: 'succeeded',
      finishedAt: new Date(Date.now() - 1 * 86400_000),
      expiresAt: new Date(Date.now() + 6 * 86400_000),
    });
    const target = join(mediaMountPath, 'uploads', userId, job.id);
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(join(target, 'source.bin'), 'live-data');
    await backdateMtime(target, 2); // out of mtime-grace so DB-check runs

    const result = await sweepOrphans({
      prisma,
      mediaMountPath,
      log: noopLog,
    });
    expect(result.scanned).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(1);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('dir with expired-job, finishedAt < 24h ago → kept', async () => {
    const job = await seedJobInDb(prisma, {
      userId,
      status: 'expired',
      finishedAt: new Date(Date.now() - 6 * 3600_000), // 6h ago, < 24h
    });
    const target = join(mediaMountPath, 'uploads', userId, job.id);
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(join(target, 'source.bin'), 'just-expired');
    await backdateMtime(target, 2);

    const result = await sweepOrphans({
      prisma,
      mediaMountPath,
      log: noopLog,
    });
    expect(result.scanned).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(1);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('dir with expired-job, finishedAt > 24h ago + dir-mtime > 1h → deleted', async () => {
    const job = await seedJobInDb(prisma, {
      userId,
      status: 'expired',
      finishedAt: new Date(Date.now() - 48 * 3600_000), // 2 days ago
    });
    const target = join(mediaMountPath, 'uploads', userId, job.id);
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(join(target, 'source.bin'), 'old-data');
    await backdateMtime(target, 2);

    const result = await sweepOrphans({
      prisma,
      mediaMountPath,
      log: noopLog,
    });
    expect(result.scanned).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });
});
