// apps/api/src/quota/reserve.ts

import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient, Job } from '@mediacompressor/db';

export class QuotaExceededError extends Error {
  constructor(
    public code:
      | 'QUOTA_STORAGE_EXCEEDED'
      | 'QUOTA_PARALLEL_EXCEEDED'
      | 'QUOTA_HOURLY_EXCEEDED',
    message: string,
  ) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export interface ReserveQuotaInput {
  userId: string;
  claimedSize: bigint;
  kind: 'image' | 'video';
  profile: string;
  uploadId: string;
  overrides?: Record<string, unknown>;
  inputFilename?: string;
  // UC12: deterministischer Key für Hook-Retry-Idempotency.
  precreateIdempotencyKey?: string;
  /**
   * Plan 5 Task 5: Pre-Create-Hook needs Job.id == Job.uploadId so tusd's
   * upload-id matches the DB row. Caller may pre-generate a UUID and pass it
   * here to override Prisma's @default(uuid()) for `id`. Optional —
   * existing callers (Plan 4 jobs-routes) keep getting auto-generated IDs.
   */
  id?: string;
}

const IN_FLIGHT_STATUSES = ['uploading', 'queued', 'processing'] as const;

// UC1-Fix: Orphan-Schutz. uploading-Jobs mit uploadExpiresAt < now haben den
// User-tusd-Flow nie zu Ende gebracht — vor neuer Reservation atomisch räumen.
const TUSD_UPLOAD_TTL_MS = 24 * 60 * 60_000; // 24h, Spec Sektion „tusd Inaktivität"

/**
 * C1-Rev2: Atomic quota reservation under pg_advisory_xact_lock.
 * UC1-Fix: cleanup of expired `uploading`-Jobs of the SAME user inside the
 * locked transaction → no orphan-quota accumulation under tusd-crash race.
 * UC2-Fix: 64-bit lock-key (SHA-256 first 4 bytes) instead of 31-bit hash.
 * UC11-Fix: Storage-Sum includes outputBytes from non-expired succeeded-Jobs.
 * UC12-Fix: idempotency-lookup BEFORE cleanup/reserve — repeated identical
 * pre-create hooks return the same Job.
 */
export async function reserveQuota(
  prisma: PrismaClient,
  input: ReserveQuotaInput,
): Promise<Job> {
  return prisma.$transaction(async (tx) => {
    // UC2: bigint variant of pg_advisory_xact_lock with namespaced 64-bit key.
    // $executeRaw because pg_advisory_xact_lock returns void and Prisma's
    // $queryRaw can't deserialize it.
    const lockKey = quotaLockKey(input.userId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;

    // UC12: Idempotency check BEFORE cleanup/reserve. Hook-Retry returns same Job.
    if (input.precreateIdempotencyKey) {
      const existing = await tx.job.findUnique({
        where: { precreateIdempotencyKey: input.precreateIdempotencyKey },
      });
      if (existing) return existing;
    }

    // UC1: räume expirierte uploading-Jobs des Users (orphan-quota-recovery).
    await tx.job.updateMany({
      where: {
        userId: input.userId,
        status: 'uploading',
        uploadExpiresAt: { lt: new Date() },
      },
      data: { status: 'expired', finishedAt: new Date() },
    });

    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { storageQuota: true, parallelQuota: true, hourlyQuota: true },
    });
    if (!user) {
      throw new QuotaExceededError(
        'QUOTA_STORAGE_EXCEEDED',
        'QUOTA_STORAGE_EXCEEDED: user not found',
      );
    }

    // UC11-Fix: SUM(reservedBytes für in-flight) + SUM(outputBytes für non-expired succeeded).
    const inFlightSum = await tx.job.aggregate({
      where: { userId: input.userId, status: { in: [...IN_FLIGHT_STATUSES] } },
      _sum: { reservedBytes: true },
    });
    const succeededSum = await tx.job.aggregate({
      where: {
        userId: input.userId,
        status: 'succeeded',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      _sum: { outputBytes: true },
    });
    const inFlightBytes = inFlightSum._sum.reservedBytes ?? 0n;
    const succeededBytes = succeededSum._sum.outputBytes ?? 0n;
    const totalUsed = inFlightBytes + succeededBytes;

    if (totalUsed + input.claimedSize > user.storageQuota) {
      throw new QuotaExceededError(
        'QUOTA_STORAGE_EXCEEDED',
        `QUOTA_STORAGE_EXCEEDED: storage quota exceeded (in-flight=${inFlightBytes}, succeeded=${succeededBytes}, claim=${input.claimedSize}, max=${user.storageQuota})`,
      );
    }

    const inFlightCount = await tx.job.count({
      where: { userId: input.userId, status: { in: [...IN_FLIGHT_STATUSES] } },
    });
    if (inFlightCount >= user.parallelQuota) {
      throw new QuotaExceededError(
        'QUOTA_PARALLEL_EXCEEDED',
        `QUOTA_PARALLEL_EXCEEDED: parallel quota exceeded (count=${inFlightCount}, max=${user.parallelQuota})`,
      );
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60_000);
    const lastHourCount = await tx.job.count({
      where: { userId: input.userId, createdAt: { gte: oneHourAgo } },
    });
    if (lastHourCount >= user.hourlyQuota) {
      throw new QuotaExceededError(
        'QUOTA_HOURLY_EXCEEDED',
        `QUOTA_HOURLY_EXCEEDED: hourly quota exceeded (count=${lastHourCount}, max=${user.hourlyQuota})`,
      );
    }

    const job = await tx.job.create({
      data: {
        // Plan 5 Task 5: Pre-Create-Hook supplies a pre-generated UUID so
        // that Job.id === Job.uploadId === tusd-upload-id. If omitted, Prisma
        // falls back to @default(uuid()).
        ...(input.id !== undefined ? { id: input.id } : {}),
        userId: input.userId,
        status: 'uploading',
        kind: input.kind,
        profile: input.profile,
        overrides: (input.overrides ?? {}) as Prisma.InputJsonValue,
        inputFilename: input.inputFilename ?? 'pending',
        inputStorageKey: '',
        uploadId: input.uploadId,
        reservedBytes: input.claimedSize,
        // UC1: orphan-Schutz, post-finish-Hook setzt das auf null.
        uploadExpiresAt: new Date(Date.now() + TUSD_UPLOAD_TTL_MS),
        // UC12: idempotency-key, falls vom Caller übergeben.
        precreateIdempotencyKey: input.precreateIdempotencyKey ?? null,
      },
    });
    return job;
  });
}

/**
 * UC2-Fix (post-Plan-5 hardening): 63-bit advisory-lock key with full
 * SHA-256-derived entropy. The previous 32-bit userPart had birthday-collision
 * probability ~50% at ~65k users (sqrt(2^32)) — low but tangible at scale.
 * 63-bit userPart pushes that to ~3 Mrd. users (sqrt(2^63)). Lock-namespacing
 * is encoded by XORing the namespace into the top byte, so different namespaces
 * (future: cleanup-cron, download-lease) still serialize on disjoint key ranges
 * while keeping 63 bits of effective userPart entropy.
 *
 * Postgres `pg_advisory_xact_lock(bigint)` takes a signed bigint; we mask the
 * sign bit to stay in the non-negative range.
 */
function quotaLockKey(userId: string): bigint {
  const NAMESPACE_STORAGE_QUOTA = 1n;
  const digest = createHash('sha256').update(userId).digest();
  // First 8 bytes → 64-bit unsigned. Mask top bit for signed-bigint safety.
  const userPart = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  // XOR the namespace into the top byte so different lock namespaces serialize
  // on disjoint key ranges without sacrificing entropy.
  return userPart ^ (NAMESPACE_STORAGE_QUOTA << 56n);
}
