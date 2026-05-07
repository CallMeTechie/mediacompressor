import * as fs from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { createCompressionQueue } from '../queue.js';

// Plan 7 Task 5: GET /api/v1/admin/stats — admin-only operational dashboard
// aggregating users, jobs (per-status), storage usage and queue depth.
//
// AP3: We use the official BullMQ Queue API (`queue.getWaitingCount()` /
// `getActiveCount()`) instead of a brittle `redis.llen('bull:compression:wait')`.
// The internal Bull(MQ) key layout is an implementation detail and has changed
// between major versions; the official API stays version-safe.
//
// AP5: Read-only GET → uses requireAdmin (NOT requireAdminCsrf): GET requests
// are not state-changing and should not require a CSRF token.
//
// BigInt-safety: `Job.outputBytes` is BigInt in the DB. JSON has no BigInt
// literal, so we serialize as strings (`String(...)`). Same for the statfs
// disk-free numbers (block-count × block-size can exceed 2^53 on multi-TB
// filesystems — be safe by default).
export const adminStatsRoute: FastifyPluginAsync = async (app) => {
  const { prisma, redis, config } = app.deps;

  // Reuse the canonical queue-helper so connection/queue-name stay in sync
  // with `jobs-routes.ts`. Reusing the existing app.deps.redis client matches
  // the pattern in `apps/api/src/queue.ts`.
  const compressionQueue = createCompressionQueue(redis);
  app.addHook('onClose', async () => {
    // Lifecycle: BullMQ keeps Redis connections alive — without an explicit
    // close() the test runner hangs on app.close().
    await compressionQueue.close();
  });

  app.get('/api/v1/admin/stats', async (req, reply) => {
    const adminId = await app.requireAdmin(req, reply);
    if (!adminId) return;

    const [userCount, jobsByStatus, totalStorageUsed, queueWaiting, queueActive] =
      await Promise.all([
        prisma.user.count(),
        prisma.job.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.job.aggregate({
          where: {
            status: 'succeeded',
            // Active output retention: succeeded jobs whose retention has not
            // yet expired. NULL expiresAt means "never expires" (kept).
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          _sum: { outputBytes: true },
        }),
        compressionQueue.getWaitingCount().catch(() => 0),
        compressionQueue.getActiveCount().catch(() => 0),
      ]);

    let diskFree: { available: string; total: string } | null = null;
    try {
      // bigint:true keeps the math in BigInt-space; bavail/blocks × bsize can
      // overflow Number on multi-TB volumes.
      // Calling via the `fs.*` namespace (rather than a destructured import)
      // is intentional: it makes `vi.spyOn(fs, 'statfsSync')` actually
      // intercept the call from this module. Destructured imports get bound
      // statically and bypass the spy.
      const stat = fs.statfsSync(config.MEDIA_MOUNT_PATH, { bigint: true });
      diskFree = {
        available: String(stat.bavail * stat.bsize),
        total: String(stat.blocks * stat.bsize),
      };
    } catch {
      // statfs failures (e.g. mount path missing in test env) must not 500 the
      // whole stats endpoint — degrade gracefully to diskFree=null.
      diskFree = null;
    }

    return {
      users: { total: userCount },
      jobs: Object.fromEntries(jobsByStatus.map((j) => [j.status, j._count._all])),
      storage: {
        usedBytes: String(totalStorageUsed._sum.outputBytes ?? 0n),
        diskFree,
      },
      queue: { compressionWaiting: queueWaiting, compressionActive: queueActive },
    };
  });
};
