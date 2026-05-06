import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import {
  testDatabaseUrl,
  createTestUser,
  cleanupTestUsers,
} from '@mediacompressor/test-helpers';
import { reserveQuota, QuotaExceededError } from './reserve.js';

describe('reserveQuota', () => {
  let prisma: PrismaClient;
  let userId: string;
  const TEST_EMAILS = ['quota@b.com'];

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
    await cleanupTestUsers(prisma, TEST_EMAILS);
    const u = await createTestUser(prisma, { email: 'quota@b.com' });
    userId = u.id;
    // Deterministic quotas: 20 GB decimal for storage (matches plan's seed math
    // of 19×1GB + 2GB > 20GB), and a high parallel quota so storage/idem tests
    // do not collide with the parallel-limit. The dedicated parallel-quota test
    // overrides parallelQuota down to 3 for its own scope.
    await prisma.user.update({
      where: { id: userId },
      data: {
        storageQuota: 20_000_000_000n,
        parallelQuota: 100,
        hourlyQuota: 1000,
      },
    });
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.job.deleteMany({ where: { userId } });
  });

  it('happy path — reserves and returns Job', async () => {
    const job = await reserveQuota(prisma, {
      userId,
      claimedSize: 100_000_000n,
      kind: 'image',
      profile: 'web-optimized',
      uploadId: 'tusd-upload-1',
    });
    expect(job.status).toBe('uploading');
    expect(job.reservedBytes).toBe(100_000_000n);
  });

  it('rejects when storage quota exceeded', async () => {
    for (let i = 0; i < 19; i++) {
      await reserveQuota(prisma, {
        userId,
        claimedSize: 1_000_000_000n,
        kind: 'image',
        profile: 'web-optimized',
        uploadId: `seed-${i}`,
      });
    }
    await expect(
      reserveQuota(prisma, {
        userId,
        claimedSize: 2_000_000_000n,
        kind: 'image',
        profile: 'web-optimized',
        uploadId: 'oversized',
      }),
    ).rejects.toThrow(QuotaExceededError);
  });

  it('rejects when parallel quota exceeded', async () => {
    // Scope-local parallel-quota override; restored at the end of the test.
    await prisma.user.update({ where: { id: userId }, data: { parallelQuota: 3 } });
    try {
      for (let i = 0; i < 3; i++) {
        await reserveQuota(prisma, {
          userId,
          claimedSize: 1_000n,
          kind: 'image',
          profile: 'web-optimized',
          uploadId: `seed-parallel-${i}`,
        });
      }
      await expect(
        reserveQuota(prisma, {
          userId,
          claimedSize: 1_000n,
          kind: 'image',
          profile: 'web-optimized',
          uploadId: 'parallel-4th',
        }),
      ).rejects.toThrow(/QUOTA_PARALLEL/);
    } finally {
      await prisma.user.update({
        where: { id: userId },
        data: { parallelQuota: 100 },
      });
    }
  });

  // UC11 PFLICHT-REGRESSIONSTEST — outputBytes von succeeded-Jobs zählen
  it('UC11: succeeded-Job mit outputBytes zählt gegen Storage-Quota', async () => {
    // Annahme widerlegen: Storage-Quota bezieht NUR in-flight reservedBytes ein.
    // Spec sagt: SUM(reservedBytes + outputBytes für non-expired succeeded).
    await prisma.job.create({
      data: {
        userId,
        status: 'succeeded',
        kind: 'image',
        profile: 'web-optimized',
        inputFilename: 'big.png',
        inputStorageKey: 'uploads/x/y/source.bin',
        uploadId: 'succ-19gb',
        outputBytes: 19_000_000_000n,
        finishedAt: new Date(),
        expiresAt: new Date(Date.now() + 6 * 86400_000),
        overrides: {},
      },
    });
    // Neue 2 GB Reservation würde Total = 21 GB > 20 GB Quota überschreiten.
    await expect(
      reserveQuota(prisma, {
        userId,
        claimedSize: 2_000_000_000n,
        kind: 'image',
        profile: 'web-optimized',
        uploadId: 'fresh-after-succeeded',
      }),
    ).rejects.toThrow(QuotaExceededError);
  });

  // UC11 — expired succeeded-Job zählt NICHT mehr
  it('UC11: expired succeeded-Job (expiresAt < now) zählt NICHT gegen Quota', async () => {
    await prisma.job.create({
      data: {
        userId,
        status: 'succeeded',
        kind: 'image',
        profile: 'web-optimized',
        inputFilename: 'old.png',
        inputStorageKey: 'uploads/x/y/source.bin',
        uploadId: 'succ-expired',
        outputBytes: 19_000_000_000n,
        finishedAt: new Date(Date.now() - 30 * 86400_000),
        expiresAt: new Date(Date.now() - 1000), // expired
        overrides: {},
      },
    });
    const job = await reserveQuota(prisma, {
      userId,
      claimedSize: 2_000_000_000n,
      kind: 'image',
      profile: 'web-optimized',
      uploadId: 'after-expired-succeeded',
    });
    expect(job.status).toBe('uploading');
  });

  // UC12 PFLICHT-REGRESSIONSTEST — Hook-Retry-Idempotency
  it('UC12: zweimaliger reserveQuota mit gleichem precreateIdempotencyKey → genau ein Job', async () => {
    const idemKey = 'sha256-test-key-uc12';
    const job1 = await reserveQuota(prisma, {
      userId,
      claimedSize: 1_000n,
      kind: 'image',
      profile: 'web-optimized',
      uploadId: 'idem-test',
      precreateIdempotencyKey: idemKey,
    });
    const job2 = await reserveQuota(prisma, {
      userId,
      claimedSize: 1_000n,
      kind: 'image',
      profile: 'web-optimized',
      uploadId: 'idem-test-retry',
      precreateIdempotencyKey: idemKey,
    });
    expect(job1.id).toBe(job2.id);
    const allJobs = await prisma.job.findMany({
      where: { userId, precreateIdempotencyKey: idemKey },
    });
    expect(allJobs).toHaveLength(1);
  });

  // UC1 PFLICHT-REGRESSIONSTEST — Orphan-Recovery
  it('UC1: expired uploading-Job des Users wird vor neuer Reservation freigegeben', async () => {
    await prisma.job.create({
      data: {
        userId,
        status: 'uploading',
        kind: 'image',
        profile: 'web-optimized',
        inputFilename: 'orphan',
        inputStorageKey: '',
        uploadId: 'orphan-1',
        reservedBytes: 15_000_000_000n,
        uploadExpiresAt: new Date(Date.now() - 1000),
        overrides: {},
      },
    });
    // 15 GB orphan + 10 GB new would blow 20 GB quota.
    // With UC1-Fix: orphan flips to 'expired' → in-flight-sum drops → 10 GB fits.
    const job = await reserveQuota(prisma, {
      userId,
      claimedSize: 10_000_000_000n,
      kind: 'image',
      profile: 'web-optimized',
      uploadId: 'fresh-after-orphan',
    });
    expect(job.status).toBe('uploading');
    const orphan = await prisma.job.findUnique({ where: { uploadId: 'orphan-1' } });
    expect(orphan?.status).toBe('expired');
  });

  // C1-Rev2 PFLICHT-REGRESSIONSTEST: Race-Safety
  it('C1-Rev2: 5 parallel reserves with tight quota — no over-reservation', async () => {
    // Pre-seed 18 GB of 20 GB quota; 5 parallel 500 MB requests must result in
    // EXACTLY 4 successes (4 × 500 MB = 2 GB → fits) and 1 rejection.
    // Without pg_advisory_xact_lock, all 5 could race and over-reserve.
    await reserveQuota(prisma, {
      userId,
      claimedSize: 18_000_000_000n,
      kind: 'image',
      profile: 'web-optimized',
      uploadId: 'seed-large',
    });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        reserveQuota(prisma, {
          userId,
          claimedSize: 500_000_000n,
          kind: 'image',
          profile: 'web-optimized',
          uploadId: `parallel-${i}`,
        }),
      ),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(succeeded).toBe(4);
    expect(rejected).toBe(1);
    const total = await prisma.job.aggregate({
      where: { userId, status: { in: ['uploading', 'queued', 'processing'] } },
      _sum: { reservedBytes: true },
    });
    expect(total._sum.reservedBytes ?? 0n).toBeLessThanOrEqual(20_000_000_000n);
  });
});
