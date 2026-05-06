import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { reserveQuota, QuotaExceededError } from '../quota/reserve.js';
import { checkGlobalDiskFree, GlobalDiskLowError } from '../quota/disk-free.js';
import { verifyTusdSharedSecret } from './shared-secret.js';

// UC7: hardcoded extension allowlist (Spec Sektion 7). Niemals dynamisch
// ableiten — File-Endung ist hier nur Defense-in-Depth, der Worker macht den
// finalen MIME-Sniff.
const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.avif',
  '.gif',
  '.tiff',
  '.tif',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
]);

// tusd v2 hook-body schema (subset we use). tusd sends additional fields
// (HTTPRequest, Storage, …) which we ignore.
const TusdHookBody = z.object({
  Type: z.string().optional(),
  Event: z.object({
    Upload: z.object({
      ID: z.string().optional(),
      Size: z.number().int().nonnegative(),
      MetaData: z.record(z.string(), z.string()).default({}),
    }),
  }),
});

/**
 * Plan 5 Task 5: Pre-Create-Hook for tusd v2.
 *
 * Pipeline (in order, fail-fast):
 *   1. Shared-secret check (defense-in-depth — tusd is internal, but if it
 *      were ever exposed, the hook is still the gate).
 *   2. UC5: Bearer-API-Key auth (forwarded by tusd via
 *      `-hooks-http-forward-headers=Authorization`).
 *   3. UC7: Filename-extension allowlist.
 *   4. metadata.kind / metadata.profile basic validation.
 *   5. C5-Rev3: global disk-free guard.
 *   6. UC12: deterministic idempotency key from (userId || metadata || size).
 *   7. C1-Rev2 + UC1 + UC11 + UC12: atomic reserveQuota under advisory-lock.
 *   8. Respond with `ChangeFileInfo.ID = job.id` so tusd uses the DB row id
 *      as the upload-id (Job.id === Job.uploadId, 1:1).
 */
export const preCreateHook: FastifyPluginAsync = async (app) => {
  const { prisma, config } = app.deps;
  const verifySecret = verifyTusdSharedSecret(config.TUSD_SHARED_SECRET);

  app.post(
    '/api/v1/internal/uploads/hooks/pre-create',
    { schema: { body: TusdHookBody } },
    async (req, reply) => {
      // 1. Shared-secret check.
      if (!(await verifySecret(req, reply))) return;

      // 2. UC5: User-Auth via Bearer-API-Key. requireAuth (NOT requireAuthCsrf)
      // because tusd has no session/CSRF context — only the forwarded header.
      const userId = await app.requireAuth(req, reply);
      if (!userId) return;

      const body = req.body as z.infer<typeof TusdHookBody>;
      const upload = body.Event.Upload;
      const metadata = upload.MetaData;

      const claimedSize = BigInt(upload.Size);
      const filename = metadata.filename ?? '';
      const kindRaw = metadata.kind ?? '';
      const profileRaw = metadata.profile ?? '';

      // 3. UC7: Filename-extension allowlist.
      const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
      if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
        return reply.code(400).send({
          error: {
            code: 'UNSUPPORTED_INPUT_FORMAT',
            message: `extension ${ext ?? '(none)'} not allowed`,
          },
        });
      }

      // 4. Basic kind/profile validation. Profile is validated more strictly
      // by the worker (PROFILES allowlist in @mediacompressor/compression);
      // we only enforce non-empty here so the DB column is well-formed.
      if (kindRaw !== 'image' && kindRaw !== 'video') {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'metadata.kind must be "image" or "video"',
          },
        });
      }
      if (profileRaw.length === 0) {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'metadata.profile is required',
          },
        });
      }

      // 5. C5-Rev3: global disk-free check. Prevents over-commit when the
      // sum of user quotas exceeds physical disk capacity.
      try {
        checkGlobalDiskFree(
          config.MEDIA_MOUNT_PATH,
          claimedSize,
          config.MIN_FREE_BYTES_RESERVE,
        );
      } catch (err) {
        if (err instanceof GlobalDiskLowError) {
          return reply.code(503).send({
            error: { code: 'GLOBAL_DISK_LOW', message: err.message },
          });
        }
        throw err;
      }

      // 6. UC12: deterministic idempotency key. tusd retries the pre-create
      // hook on transient failures — the same body must produce the same
      // Job (DB UNIQUE on Job.precreateIdempotencyKey is the second line of
      // defense).
      const idemKey = createHash('sha256')
        .update(userId)
        .update(JSON.stringify(metadata))
        .update(String(upload.Size))
        .digest('hex');

      // 7. Pre-generate UUID so Job.id === Job.uploadId. tusd's upload-id
      // (set via ChangeFileInfo.ID below) is then identical to the DB row id.
      const jobId = randomUUID();

      // 8. C1-Rev2 + UC1 + UC11 + UC12: atomic reservation under
      // pg_advisory_xact_lock. Idempotency-lookup happens first inside the
      // tx — repeated hook calls return the same Job row and skip cleanup.
      let job;
      try {
        job = await reserveQuota(prisma, {
          id: jobId,
          userId,
          claimedSize,
          kind: kindRaw,
          profile: profileRaw,
          uploadId: jobId,
          inputFilename: filename,
          precreateIdempotencyKey: idemKey,
        });
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          return reply.code(413).send({
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }

      // 9. Tell tusd to use job.id as its upload-id. MetaData round-trips
      // back so any tusd-side bookkeeping (e.g. `kind`, `profile`) is
      // preserved on the upload object.
      return reply.code(200).send({
        ChangeFileInfo: {
          ID: job.id,
          MetaData: metadata,
        },
      });
    },
  );
};
