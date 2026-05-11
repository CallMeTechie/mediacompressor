import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { PROFILES } from '@mediacompressor/compression/types';
import type { Prisma } from '@mediacompressor/db';
import { isValidUploadPath, parseUploadPath } from '@mediacompressor/storage';
import { createCompressionQueue, type CompressJobData } from '../queue.js';

// @deprecated since Plan 5: The canonical job-creation flow is via tusd
// (POST /uploads/ → pre-create-hook → post-finish-hook). This Plan-4-Stub
// remains as an internal/testing-only Bearer-API-Key endpoint and may be
// removed in v1.0. Production deployments should disable it via a feature
// flag (Plan 7 polish work).
//
// UC13-Fix: Plan-4-Stub originally used a weak `[0-9a-f-]{36}` regex. We now
// delegate to `isValidUploadPath` / `parseUploadPath` from
// @mediacompressor/storage (strict UUIDv4 8-4-4-4-12 layout). Defense-in-Depth:
// rejects 36×'a' and dash-misaligned strings that the old regex accepted.

const ListQuery = z.object({
  status: z.enum(['queued', 'processing', 'succeeded', 'failed', 'canceled', 'expired']).optional(),
  kind: z.enum(['image', 'video']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const JobIdParams = z.object({ id: z.string().uuid() });

const PostJobBody = z.object({
  inputStorageKey: z.string().refine(isValidUploadPath, {
    message: 'inputStorageKey must be uploads/{userUuid}/{jobUuid}/source.bin',
  }),
  kind: z.enum(['image', 'video']),
  profile: z.enum(PROFILES),
  overrides: z
    .object({
      quality: z.number().int().min(1).max(100).optional(),
      maxWidth: z.number().int().min(1).max(16384).optional(),
      maxHeight: z.number().int().min(1).max(16384).optional(),
      targetFormat: z
        .string()
        .regex(/^[a-z0-9]+$/)
        .optional(),
    })
    .optional(),
});

export const jobsRoutes: FastifyPluginAsync = async (app) => {
  const { prisma, redis } = app.deps;
  const queue = createCompressionQueue(redis);
  app.addHook('onClose', async () => {
    await queue.close();
  });

  // Plan 7 Task 7: POST /jobs is gated behind ENABLE_LEGACY_JOB_STUB. Default
  // is OFF — production deployments do not register the route at all (404),
  // forcing callers to use the canonical tusd upload flow. Tests that need the
  // legacy stub set `ENABLE_LEGACY_JOB_STUB: true` in their config object.
  if (app.deps.config.ENABLE_LEGACY_JOB_STUB) {
    app.log.warn('ENABLE_LEGACY_JOB_STUB=true — POST /jobs stub is active. Disable in production.');
    // C1-Rev1: state-changing → CSRF-Pflicht (Bearer-API-Key bypassed via skipCsrf).
    app.post('/api/v1/jobs', { schema: { body: PostJobBody } }, async (req, reply) => {
      const userId = await app.requireAuthCsrf(req, reply);
      if (!userId) return;

      const { inputStorageKey, kind, profile, overrides } = req.body as z.infer<typeof PostJobBody>;

      // C3-Rev1 + UC13: Server-Side-Check — userUuid im Pfad muss mit auth.userId
      // übereinstimmen. parseUploadPath enforced strikte UUIDv4-Layout (Defense-in-Depth).
      const parsed = parseUploadPath(inputStorageKey);
      if (!parsed || parsed.userId !== userId) {
        return reply.code(403).send({
          error: {
            code: 'AUTH_INVALID',
            message: 'inputStorageKey does not belong to authenticated user',
          },
        });
      }

      // C7-Rev2: Outbox-Pattern. DB-Insert + queue.add MÜSSEN atomar sein —
      // sonst gibt es bei Crash/Redis-Ausfall zwischen den beiden Operationen
      // einen Zombie-Job. prisma.$transaction um beide Operationen.
      const job = await prisma.$transaction(async (tx) => {
        const j = await tx.job.create({
          data: {
            userId,
            status: 'queued',
            kind,
            profile,
            overrides: overrides ?? {},
            inputFilename: inputStorageKey.split('/').pop() ?? 'unknown',
            inputStorageKey,
            uploadId: `stub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          },
          select: { id: true, status: true, createdAt: true },
        });

        // exactOptionalPropertyTypes: only spread `overrides` if defined.
        const jobData: CompressJobData = {
          jobId: j.id,
          userId,
          inputPath: inputStorageKey,
          outputPath: `results/${userId}/${j.id}/output`,
          profile,
          ...(overrides ? { overrides } : {}),
        };
        await queue.add(
          'compress',
          jobData,
          // C12-Rev2: Job-Optionen — jobId für Idempotenz, attempts/backoff für transiente Fehler.
          { jobId: j.id, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        );

        return j;
      });

      return reply.code(201).send({
        id: job.id,
        status: 'queued',
        createdAt: job.createdAt,
        links: {
          self: `/api/v1/jobs/${job.id}`,
          events: `/api/v1/jobs/${job.id}/events`,
        },
      });
    });
  }

  // Public job projection for read-endpoints. Excludes storage keys, raw
  // overrides, errorMessage, etc. — only the safe view-model fields.
  const PUBLIC_JOB_SELECT = {
    id: true,
    userId: true,
    status: true,
    kind: true,
    profile: true,
    inputFilename: true,
    inputBytes: true,
    outputBytes: true,
    progress: true,
    createdAt: true,
    finishedAt: true,
  } as const satisfies Prisma.JobSelect;

  // BigInt is not JSON-serializable. Convert nullable BigInt fields to string
  // so callers can safely consume the JSON response. Strings keep precision for
  // bytes > 2^53 (large-file safety) at minimal client cost.
  type RawJob = {
    inputBytes: bigint | null;
    outputBytes: bigint | null;
  } & Record<string, unknown>;
  function toPublicJob(j: RawJob): Record<string, unknown> {
    return {
      ...j,
      inputBytes: j.inputBytes === null ? null : j.inputBytes.toString(),
      outputBytes: j.outputBytes === null ? null : j.outputBytes.toString(),
    };
  }

  // GET /api/v1/jobs — cursor-paginated list of the authenticated user's jobs.
  // Cursor format `iso|id` keyed on (createdAt DESC, id DESC). UUIDs cannot
  // contain `|`, so the delimiter is unambiguous.
  app.get('/api/v1/jobs', { schema: { querystring: ListQuery } }, async (req, reply) => {
    const userId = await app.requireAuth(req, reply);
    if (!userId) return;
    const { status, kind, limit, cursor } = req.query as z.infer<typeof ListQuery>;

    let cursorWhere: Prisma.JobWhereInput = {};
    if (cursor) {
      const [iso, id] = cursor.split('|');
      if (iso && id) {
        cursorWhere = {
          OR: [
            { createdAt: { lt: new Date(iso) } },
            { AND: [{ createdAt: new Date(iso) }, { id: { lt: id } }] },
          ],
        };
      }
    }

    const items = await prisma.job.findMany({
      where: { userId, ...(status && { status }), ...(kind && { kind }), ...cursorWhere },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: PUBLIC_JOB_SELECT,
    });
    const hasMore = items.length > limit;
    const slice = items.slice(0, limit);
    const last = slice[slice.length - 1];
    const nextCursor = hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null;
    return { items: slice.map(toPublicJob), nextCursor };
  });

  // GET /api/v1/jobs/:id — detail for a single job owned by the caller.
  // Foreign jobs return 404 (NOT 403) to avoid leaking the existence of
  // other users' job IDs.
  app.get('/api/v1/jobs/:id', { schema: { params: JobIdParams } }, async (req, reply) => {
    const userId = await app.requireAuth(req, reply);
    if (!userId) return;
    const { id } = req.params as z.infer<typeof JobIdParams>;
    const job = await prisma.job.findFirst({
      where: { id, userId },
      select: PUBLIC_JOB_SELECT,
    });
    if (!job) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return toPublicJob(job);
  });

  // DELETE /api/v1/jobs/:id — cancel an in-flight job. Idempotent for terminal
  // states (returns 204 without side-effects). Foreign jobs return 404 to avoid
  // existence-leak (mirrors GET /jobs/:id).
  // C1-Rev1: state-changing → CSRF-Pflicht (Bearer-API-Key bypassed via skipCsrf).
  app.delete('/api/v1/jobs/:id', { schema: { params: JobIdParams } }, async (req, reply) => {
    const userId = await app.requireAuthCsrf(req, reply);
    if (!userId) return;
    const { id } = req.params as z.infer<typeof JobIdParams>;
    const job = await prisma.job.findFirst({ where: { id, userId } });
    if (!job) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });

    if (job.status === 'queued' || job.status === 'processing') {
      // Worker polls `cancel:{jobId}` to abort in-flight work. 600s TTL prevents
      // indefinite key buildup if the worker never picks the job up.
      await redis.set(`cancel:${job.id}`, '1', 'EX', 600);

      // C10-Rev2: updateMany statt update mit Idempotenz-Guard. Worker setzt
      // ggf. parallel status='canceled'; updateMany mit `notIn: terminalStates`
      // verhindert Doppel-Schreibe / finishedAt-Race.
      await prisma.job.updateMany({
        where: {
          id: job.id,
          status: { notIn: ['canceled', 'succeeded', 'failed', 'expired'] as const },
        },
        data: { status: 'canceled', finishedAt: new Date() },
      });

      // C10-Rev2: SOFORT publizieren — SSE-Subscriber sieht Cancel ohne Worker-Poll-Latenz.
      await redis.publish(`job:status:${job.id}`, JSON.stringify({ status: 'canceled' }));
    }

    return reply.code(204).send();
  });
};
