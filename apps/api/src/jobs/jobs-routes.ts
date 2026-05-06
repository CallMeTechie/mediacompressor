import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { PROFILES } from '@mediacompressor/compression/types';
import { createCompressionQueue, type CompressJobData } from '../queue.js';

// C3-Rev1: Strikte Format-Pflicht für inputStorageKey — verhindert Path-Traversal
// in den Worker. Plan 5 ersetzt das durch tusd-Pre-Create-Hook, aber Plan 4 (Stub)
// muss schon defense-in-depth haben.
const STORAGE_KEY_RE = /^uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/source\.bin$/;

const PostJobBody = z.object({
  inputStorageKey: z.string().regex(STORAGE_KEY_RE, {
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

  // C1-Rev1: state-changing → CSRF-Pflicht (Bearer-API-Key bypassed via skipCsrf).
  app.post('/api/v1/jobs', { schema: { body: PostJobBody } }, async (req, reply) => {
    const userId = await app.requireAuthCsrf(req, reply);
    if (!userId) return;

    const { inputStorageKey, kind, profile, overrides } = req.body as z.infer<typeof PostJobBody>;

    // C3-Rev1: Server-Side-Check — userUuid im Pfad muss mit auth.userId übereinstimmen.
    const match = inputStorageKey.match(/^uploads\/([0-9a-f-]{36})\//);
    if (!match || match[1] !== userId) {
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
};
