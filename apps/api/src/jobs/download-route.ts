import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { startDownloadHandler, registerCleanupScripts } from '@mediacompressor/cleanup';

const ParamSchema = z.object({ id: z.string().uuid() });

/**
 * Plan 6 Task 4 — GET /api/v1/jobs/:id/download.
 *
 * Streams the compressed output for a `succeeded` job, while holding a
 * download-handler entry in `downloads:<jobId>` for the lifetime of the
 * HTTP response. The cleanup-worker (Task 5+) refuses to delete the file
 * while any handler exists; the handler is released on stream end / error /
 * close, including the client-disconnect path (DC4).
 *
 * Status mapping:
 *   401 — unauthenticated
 *   404 — job does not exist OR belongs to a different user
 *   409 — job not yet succeeded (or no outputStorageKey)
 *   410 — job expired, file gone, or cleanup-lock held
 *   200 — streaming download
 */
export const downloadRoute: FastifyPluginAsync = async (app) => {
  const { prisma, redis, config } = app.deps;
  // Idempotent on a given Redis connection — defining the same Lua command
  // twice is a no-op in ioredis.
  registerCleanupScripts(redis);

  app.get('/api/v1/jobs/:id/download', { schema: { params: ParamSchema } }, async (req, reply) => {
    const userId = await app.requireAuth(req, reply);
    if (!userId) return;
    const { id: jobId } = req.params as z.infer<typeof ParamSchema>;

    const job = await prisma.job.findFirst({ where: { id: jobId, userId } });
    if (!job) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    if (job.status !== 'succeeded' || !job.outputStorageKey) {
      return reply.code(409).send({
        error: { code: 'JOB_NOT_READY', message: `job is in status=${job.status}` },
      });
    }
    if (job.expiresAt && job.expiresAt < new Date()) {
      return reply.code(410).send({ error: { code: 'EXPIRED' } });
    }

    let abortRequested = false;
    const handle = await startDownloadHandler(redis, jobId, () => {
      abortRequested = true;
      app.log.error({ jobId }, 'download.aborted_redis_unavailable');
    });
    if (!handle) {
      return reply.code(410).send({ error: { code: 'EXPIRED', message: 'cleanup in progress' } });
    }

    // DC4-Fix: handle.release() is wired into the stream lifecycle
    // (end / error / close), not a sync `finally` — otherwise the handler
    // would be released *before* bytes are flushed.
    let released = false;
    const ensureReleased = (): void => {
      if (released) return;
      released = true;
      void handle.release().catch(() => {});
    };

    let absPath: string;
    try {
      absPath = join(config.MEDIA_MOUNT_PATH, job.outputStorageKey);
      const fileStat = await stat(absPath).catch(() => null);
      if (!fileStat) {
        ensureReleased();
        return reply.code(410).send({ error: { code: 'EXPIRED', message: 'file gone' } });
      }
      // Defense-in-depth: even though outputMime/outputFormat are written by
      // the worker from a hardcoded allowlist (packages/compression/src/types.ts),
      // sanitize before injecting into HTTP headers to neutralize any future
      // upstream regression that could enable header-injection. `attachment`
      // disposition also prevents browsers from interpreting the body inline,
      // which is the primary XSS mitigation for this route.
      const safeFormat = (job.outputFormat ?? 'bin').replace(/[^a-zA-Z0-9]/g, '');
      const safeMime = /^[\w./+-]+$/.test(job.outputMime ?? '')
        ? job.outputMime!
        : 'application/octet-stream';
      reply.header('Content-Length', String(fileStat.size));
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
      // Not an XSS surface: Content-Disposition: attachment forces download.
      // outputMime/outputFormat are allowlisted (packages/compression/types.ts)
      // AND defense-in-depth-sanitized above. Body is a binary file stream.
      reply.header('Content-Type', safeMime);
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
      reply.header('Content-Disposition', `attachment; filename="output.${safeFormat || 'bin'}"`);
      reply.header('X-Accel-Buffering', 'no');
    } catch (err) {
      ensureReleased();
      throw err;
    }

    const stream = createReadStream(absPath);
    const checkInterval = setInterval(() => {
      if (abortRequested) {
        clearInterval(checkInterval);
        stream.destroy();
        // Only safe if headers are NOT yet sent; otherwise this is a TCP
        // reset (no graceful close). Race-acceptable per plan.
        reply.raw.destroy();
      }
    }, 1000);
    checkInterval.unref();

    stream.on('end', () => {
      clearInterval(checkInterval);
      ensureReleased();
    });
    stream.on('error', () => {
      clearInterval(checkInterval);
      ensureReleased();
    });
    stream.on('close', () => {
      clearInterval(checkInterval);
      ensureReleased();
    });

    return reply.send(stream);
  });
};
