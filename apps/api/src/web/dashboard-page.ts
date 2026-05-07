import type { FastifyPluginAsync } from 'fastify';
import { wantsHtml } from './accept.js';

/**
 * Dual-shape root handler:
 *   - non-HTML clients (Accept missing or star/star) → JSON {status:'ok'} so
 *     Plan-8a's native-app health-check contract is preserved.
 *   - HTML clients without a session → 303 to /login.
 *   - HTML clients with a session → render the dashboard view (recent jobs +
 *     in-flight count + quota summary + logout form), Cache-Control: no-store
 *     (C5-Rev2: post-login HTML carries user-bound data).
 *
 * The non-HTML JSON branch must skip auth, so we cannot use
 * `{ preHandler: app.requireSession }` here; instead we manually invoke
 * `await app.requireSession(req, reply)` AFTER the wantsHtml gate.
 */
export const dashboardPagePlugin: FastifyPluginAsync = async (app) => {
  const { prisma } = app.deps;

  app.get('/', async (req, reply) => {
    if (!wantsHtml(req)) {
      return reply.send({ status: 'ok' });
    }
    const userId = await app.requireSession(req, reply);
    if (!userId) return; // requireSession already 303'd to /login

    reply.header('cache-control', 'no-store, max-age=0');

    const [user, recentJobs, inFlightCount] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, storageQuota: true, parallelQuota: true },
      }),
      prisma.job.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          status: true,
          kind: true,
          profile: true,
          inputFilename: true,
          createdAt: true,
          finishedAt: true,
        },
      }),
      prisma.job.count({
        where: {
          userId,
          status: { in: ['uploading', 'queued', 'processing'] },
        },
      }),
    ]);

    return reply.view('dashboard', {
      title: 'Dashboard',
      user: {
        email: user?.email ?? '',
        storageQuota: String(user?.storageQuota ?? 0n),
      },
      recentJobs: recentJobs.map((j) => ({
        ...j,
        createdAt: j.createdAt.toISOString(),
        finishedAt: j.finishedAt?.toISOString() ?? null,
      })),
      inFlightCount,
      // Logout form on the page needs a CSRF token (POST /logout is csrfProtected).
      _csrfField: reply.renderCsrfField(),
    });
  });
};
