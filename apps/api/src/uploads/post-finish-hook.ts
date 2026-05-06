import { promises as fsp } from 'node:fs';
import { open as fsOpen } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { fileTypeFromBuffer } from 'file-type';
import type { Queue } from 'bullmq';
import { uploadSourcePath } from '@mediacompressor/storage';

// `file-type`'s sniff window is the first ~4 KB; reading 4 KB is plenty for
// every supported magic-number signature (Spec Sektion 7).
const MIME_SNIFF_BYTES = 4096;

async function detectMimeFromFile(absPath: string): Promise<string | undefined> {
  const fh = await fsOpen(absPath, 'r');
  try {
    const buf = Buffer.alloc(MIME_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MIME_SNIFF_BYTES, 0);
    const detected = await fileTypeFromBuffer(buf.subarray(0, bytesRead));
    return detected?.mime;
  } finally {
    await fh.close();
  }
}
import { verifyTusdSharedSecret } from './shared-secret.js';
import { createCompressionQueue, type CompressJobData } from '../queue.js';

// tusd v2 post-finish hook-body (subset we use). tusd sends additional fields
// (HTTPRequest, Storage.Type, …) which we either consume opportunistically or
// ignore.
const TusdHookBody = z.object({
  Type: z.string().optional(),
  Event: z.object({
    Upload: z.object({
      ID: z.string().min(1),
      Size: z.number().int().nonnegative(),
      Storage: z
        .object({
          Type: z.string().optional(),
          Path: z.string().optional(),
        })
        .optional(),
      MetaData: z.record(z.string(), z.string()).default({}),
    }),
  }),
});

/**
 * Plan 5 Task 6: Post-Finish-Hook for tusd v2.
 *
 * Pipeline (in order):
 *   1. Shared-secret check (defense-in-depth — tusd is internal).
 *   2. Look up Job by uploadId. Unknown → 404.
 *   3. Idempotency: any non-'uploading' status (succeeded/failed/queued/…)
 *      → early-return 200 without moving the file or touching the queue.
 *      Combined with BullMQ's own jobId-dedup this is doubly-safe (UC6).
 *   4. Move tusd-data → final upload-path (rename, with EXDEV cross-device
 *      fallback to copy+unlink — UC4).
 *   5. Magic-number check (file-type). No detectable MIME → mark Job as
 *      `failed` with `ENGINE_INPUT_CORRUPT` (Spec Sektion 7).
 *   6. Atomic state transition `uploading → queued` via updateMany with the
 *      status guard. Sets inputBytes / inputMime / inputStorageKey and clears
 *      uploadExpiresAt (UC1: no longer orphan-eligible).
 *   7. Enqueue BullMQ compression job ONLY if updateMany.count > 0 — guards
 *      against the race where two concurrent hook calls both pass the
 *      job.status check but only one actually transitions (UC6).
 */
export const postFinishHook: FastifyPluginAsync = async (app) => {
  const { prisma, redis, config } = app.deps;
  const verifySecret = verifyTusdSharedSecret(config.TUSD_SHARED_SECRET);
  const queue: Queue<CompressJobData> = createCompressionQueue(redis);
  app.addHook('onClose', async () => {
    await queue.close();
  });

  app.post(
    '/api/v1/internal/uploads/hooks/post-finish',
    { schema: { body: TusdHookBody } },
    async (req, reply) => {
      // 1. Shared-secret check.
      if (!(await verifySecret(req, reply))) return;

      const body = req.body as z.infer<typeof TusdHookBody>;
      const upload = body.Event.Upload;
      const uploadId = upload.ID;

      // 2. Look up Job by uploadId.
      const job = await prisma.job.findUnique({ where: { uploadId } });
      if (!job) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: `uploadId ${uploadId} unknown` },
        });
      }

      // 3. Idempotency-guard. tusd retries the post-finish hook on transient
      // failures (5xx, network blip). A repeat call after the first one
      // already transitioned the Job MUST not move the file again or
      // re-enqueue.
      if (job.status !== 'uploading') {
        return reply.code(200).send({});
      }

      // 4. Move file. Prefer tusd-provided Storage.Path; fall back to the
      // filestore-convention `${TUSD_DATA_DIR}/${uploadId}.bin`. tusd-data
      // and uploads are subdirs of the same media-mount, so rename is O(1).
      const tusdSourcePath =
        upload.Storage?.Path ?? join(config.TUSD_DATA_DIR, `${uploadId}.bin`);
      const inputStorageKey = uploadSourcePath(job.userId, job.id);
      const finalAbsPath = join(
        config.TUSD_FINAL_DIR,
        job.userId,
        job.id,
        'source.bin',
      );

      try {
        await fsp.mkdir(dirname(finalAbsPath), { recursive: true });
        try {
          await fsp.rename(tusdSourcePath, finalAbsPath);
        } catch (renameErr) {
          // UC4: cross-device fallback — copy + unlink.
          if ((renameErr as NodeJS.ErrnoException).code === 'EXDEV') {
            await fsp.copyFile(tusdSourcePath, finalAbsPath);
            await fsp.unlink(tusdSourcePath);
          } else {
            throw renameErr;
          }
        }
      } catch (err) {
        app.log.error({ err, uploadId }, 'post-finish move failed');
        return reply.code(500).send({
          error: { code: 'INTERNAL', message: 'file move failed' },
        });
      }

      // 5. Magic-number check (Spec Sektion 7). The pre-create-hook only
      // checks the filename extension; the source-of-truth for "is this
      // really an image/video?" is the magic-bytes sniff after upload.
      const detectedMime = await detectMimeFromFile(finalAbsPath);
      if (!detectedMime) {
        // 5a. Atomic transition uploading → failed. updateMany guard prevents
        // racing with a parallel hook-call that already flipped the state.
        await prisma.job.updateMany({
          where: { id: job.id, status: 'uploading' },
          data: {
            status: 'failed',
            errorCode: 'ENGINE_INPUT_CORRUPT',
            errorMessage: 'no detectable mime',
            finishedAt: new Date(),
            uploadExpiresAt: null,
          },
        });
        return reply.code(200).send({});
      }

      // 6. UC6: atomic transition uploading → queued.
      const updated = await prisma.job.updateMany({
        where: { id: job.id, status: 'uploading' },
        data: {
          status: 'queued',
          inputBytes: BigInt(upload.Size),
          inputMime: detectedMime,
          inputStorageKey,
          uploadExpiresAt: null, // UC1: no longer orphan-eligible
        },
      });

      // 7. UC6: queue.add ONLY when the status-transition actually happened.
      // BullMQ's own jobId-dedup is a second line of defense, but skipping
      // here avoids enqueuing duplicates altogether on hook-retry.
      if (updated.count > 0) {
        await queue.add(
          'compress',
          {
            jobId: job.id,
            userId: job.userId,
            inputPath: inputStorageKey,
            outputPath: `results/${job.userId}/${job.id}/output`,
            profile: job.profile,
            overrides: (job.overrides ?? {}) as Record<string, unknown>,
          },
          {
            jobId: job.id,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
          },
        );
      }

      return reply.code(200).send({});
    },
  );
};
