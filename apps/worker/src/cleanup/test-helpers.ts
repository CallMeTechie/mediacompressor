import { randomUUID } from 'node:crypto';
import type { PrismaClient, Job } from '@mediacompressor/db';

export interface SeedJobOpts {
  userId: string;
  status:
    | 'pending'
    | 'uploading'
    | 'queued'
    | 'processing'
    | 'succeeded'
    | 'failed'
    | 'canceled'
    | 'expired';
  expiresAt?: Date | null;
  uploadExpiresAt?: Date | null;
  finishedAt?: Date | null;
  inputStorageKey?: string;
  outputStorageKey?: string | null;
  inputBytes?: bigint;
  outputBytes?: bigint;
  outputMime?: string;
  outputFormat?: string;
}

/**
 * DC21: shared seed-helper for cleanup-tests (expired-sweep + orphan-sweep).
 * Defaults: input-storage-key derived from `uploads/<userId>/<jobId>/source.bin`
 * (so tests can compute the absolute path on disk after the row exists).
 */
export async function seedJobInDb(
  prisma: PrismaClient,
  opts: SeedJobOpts,
): Promise<Job> {
  const id = randomUUID();
  return prisma.job.create({
    data: {
      id,
      userId: opts.userId,
      uploadId: id,
      status: opts.status,
      kind: 'image',
      profile: 'web-optimized',
      overrides: {},
      inputFilename: 'src.bin',
      inputStorageKey:
        opts.inputStorageKey ?? `uploads/${opts.userId}/${id}/source.bin`,
      reservedBytes: 0n,
      ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      ...(opts.uploadExpiresAt !== undefined
        ? { uploadExpiresAt: opts.uploadExpiresAt }
        : {}),
      ...(opts.finishedAt !== undefined ? { finishedAt: opts.finishedAt } : {}),
      ...(opts.outputStorageKey !== undefined
        ? { outputStorageKey: opts.outputStorageKey }
        : {}),
      ...(opts.inputBytes !== undefined ? { inputBytes: opts.inputBytes } : {}),
      ...(opts.outputBytes !== undefined
        ? { outputBytes: opts.outputBytes }
        : {}),
      ...(opts.outputMime !== undefined ? { outputMime: opts.outputMime } : {}),
      ...(opts.outputFormat !== undefined
        ? { outputFormat: opts.outputFormat }
        : {}),
    },
  });
}
