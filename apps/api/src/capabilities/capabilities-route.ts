import type { FastifyPluginAsync } from 'fastify';
import { PROFILES } from '@mediacompressor/compression/types';

// Spec Section 7: Allowlists are HARDCODED. Do not derive dynamically.
const ALLOWED_INPUT_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/gif',
  'image/tiff',
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
] as const;

const ALLOWED_OUTPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'mp4', 'webm'] as const;

// 2 GiB upload cap (matches tusd / pre-create-hook conventions). BigInt for
// JSON-safe large-byte representation; serialized to String in the response.
const MAX_UPLOAD_BYTES = 2n * 1024n * 1024n * 1024n;

/**
 * Plan-7 Task-1: GET /api/v1/capabilities — public discovery endpoint.
 *
 * Two-tier response (AP2-Concern):
 *   - Anonymous callers (missing/invalid auth) → 200 with the discovery subset
 *     (profiles + MIME + format allowlists + maxUploadBytes). NO `quota` field.
 *   - Authenticated callers → 200 with the full payload including
 *     `quota: { limits, used }` for client-side dashboards / pre-flight checks.
 *
 * Capabilities is best-effort: invalid auth falls through to anonymous (NOT 401).
 */
export const capabilitiesRoute: FastifyPluginAsync = async (app) => {
  const { prisma } = app.deps;

  app.get('/api/v1/capabilities', async (req) => {
    const anonymousPayload = {
      imageProfiles: PROFILES,
      videoProfiles: PROFILES,
      allowedInputMimes: ALLOWED_INPUT_MIMES,
      allowedOutputFormats: ALLOWED_OUTPUT_FORMATS,
      limits: { maxUploadBytes: MAX_UPLOAD_BYTES.toString() },
    };

    const userId = await app.tryAuth(req);
    if (!userId) return anonymousPayload;

    // Parallelize the four independent quota lookups. The `inFlightAggregate`
    // combines the previous separate `_sum: reservedBytes` and `count` queries
    // into a single round-trip. The deleted-user case (`!user`) still falls
    // through to anonymousPayload — the small wasted aggregate work on a
    // deleted-user hit is acceptable for the latency win on the common path.
    const [user, inFlightAggregate, succeededSum, lastHourCount] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { storageQuota: true, parallelQuota: true, hourlyQuota: true },
      }),
      // In-flight reservations (uploading + queued + processing) — billed against
      // the storage quota at reservation time so users cannot oversubscribe.
      prisma.job.aggregate({
        where: { userId, status: { in: ['uploading', 'queued', 'processing'] } },
        _sum: { reservedBytes: true },
        _count: { _all: true },
      }),
      // Succeeded non-expired outputs — still occupy disk and count against quota.
      prisma.job.aggregate({
        where: {
          userId,
          status: 'succeeded',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        _sum: { outputBytes: true },
      }),
      prisma.job.count({
        where: { userId, createdAt: { gte: new Date(Date.now() - 60 * 60_000) } },
      }),
    ]);
    if (!user) return anonymousPayload;

    const usedStorageBytes =
      (inFlightAggregate._sum.reservedBytes ?? 0n) + (succeededSum._sum.outputBytes ?? 0n);
    const inFlightCount = inFlightAggregate._count._all;

    return {
      ...anonymousPayload,
      quota: {
        limits: {
          // BigInt → String for JSON serialization (matches toPublicJob in jobs-routes.ts).
          storageBytes: user.storageQuota.toString(),
          parallel: user.parallelQuota,
          hourly: user.hourlyQuota,
        },
        used: {
          storageBytes: usedStorageBytes.toString(),
          parallel: inFlightCount,
          hourly: lastHourCount,
        },
      },
    };
  });
};
