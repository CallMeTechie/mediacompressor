import type { FastifyPluginAsync } from 'fastify';
import IORedis from 'ioredis';
import { z } from 'zod';

const ParamSchema = z.object({ id: z.string().uuid() });
const ENDSTATUS = new Set(['succeeded', 'failed', 'canceled', 'expired']);

export const jobsEventsRoute: FastifyPluginAsync = async (app) => {
  const { prisma, config } = app.deps;

  app.get('/api/v1/jobs/:id/events', { schema: { params: ParamSchema } }, async (req, reply) => {
    const userId = await app.requireAuth(req, reply);
    if (!userId) return;

    const { id } = req.params as z.infer<typeof ParamSchema>;
    const job = await prisma.job.findFirst({ where: { id, userId } });
    if (!job) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // BigInt fields must be coerced to string — JSON.stringify rejects bare BigInt
    // (mirrors jobs-routes.ts list/get and dashboard-page.ts patterns).
    send('snapshot', {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      outputBytes: job.outputBytes === null ? null : job.outputBytes.toString(),
    });
    if (ENDSTATUS.has(job.status)) {
      reply.raw.end();
      return reply;
    }

    const sub = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
    const channel = `job:status:${job.id}`;
    await sub.subscribe(channel);

    const heartbeat = setInterval(() => {
      reply.raw.write(`:heartbeat\n\n`);
    }, 15_000);

    // C6: idempotenter Cleanup. `cleaned`-Flag schützt vor Double-unsubscribe/quit,
    // wenn Client-Close-Event und End-of-Stream-Event nahezu gleichzeitig feuern.
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      void sub
        .unsubscribe(channel)
        .catch(() => {})
        .finally(() => {
          void sub.quit().catch(() => {});
        });
    };

    sub.on('message', (_ch, raw) => {
      try {
        const msg = JSON.parse(raw) as { status?: string };
        send('status', msg);
        if (msg.status && ENDSTATUS.has(msg.status)) {
          cleanup();
          reply.raw.end();
        }
      } catch {
        /* ignore malformed */
      }
    });

    req.raw.on('close', cleanup);
    return reply;
  });
};
