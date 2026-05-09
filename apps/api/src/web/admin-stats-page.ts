import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

/**
 * Plan 8d Task 6: GET /admin/stats -- read-only operational dashboard.
 *
 * Forwards to the inner Plan-7 JSON route GET /api/v1/admin/stats via
 * app.inject() and renders the response as HTML. Cookie is forwarded so the
 * inner route's requireAdmin sees the same admin session.
 *
 * Auth-gate: app.requireAdminSession (Plan 8d Task 1):
 *  - No session: 303 to /login (delegated by wrapped requireSession).
 *  - Valid non-admin: 403 HTML (no admin-existence-leak).
 *  - Valid admin: handler runs.
 *
 * Defense-in-depth: Zod-parse the inner-200 response shape so contract drift
 * is detected at the BFF boundary. Mirrors the InnerCreateResponse pattern
 * from admin-invite-create-route.ts (Plan 8d Task 5 Concern 2).
 *
 * Cache-Control: no-store, max-age=0 -- admin operational data is per-request,
 * not cacheable. Set BEFORE any rendering on every response path (200, drift-
 * detection-500, inner-error-500) so the header survives error branches too.
 *
 * fp-wrap rule: this plugin does NOT decorate anything -> NOT fp-wrapped.
 */

const InnerStatsResponse = z.object({
  users: z.object({ total: z.number().int().nonnegative() }),
  jobs: z.record(z.string(), z.number().int().nonnegative()),
  storage: z.object({
    usedBytes: z.string(),
    diskFree: z
      .object({ available: z.string(), total: z.string() })
      .nullable(),
  }),
  queue: z.object({
    compressionWaiting: z.number().int().nonnegative(),
    compressionActive: z.number().int().nonnegative(),
  }),
});

/**
 * Known job statuses for which we have explicit i18n labels. Mirrors the
 * Prisma `JobStatus` enum (packages/db/prisma/schema.prisma): if Plan-7 ever
 * adds a new status enum value, the BFF MUST be updated to add a
 * `stats_jobs_<status>` key in both locale files. Until then, unknown
 * statuses are rendered with a generic `stats_jobs_unknown` label and the
 * raw status string so they don't disappear from the dashboard.
 */
const KNOWN_JOB_STATUSES = new Set([
  'pending',
  'uploading',
  'queued',
  'processing',
  'succeeded',
  'failed',
  'canceled',
  'expired',
]);

export const adminStatsPagePlugin: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/stats',
    { preHandler: app.requireAdminSession },
    async (req, reply) => {
      reply.header('cache-control', 'no-store, max-age=0');

      const inner = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/stats',
        headers: { cookie: req.headers.cookie ?? '' },
      });

      if (inner.statusCode !== 200) {
        // Mirror admin-user-update-route's discipline: literal 500 + warn log
        // for unexpected inner status. Outer 401/403 cannot occur here because
        // requireAdminSession already authorised the request; if the inner
        // produces them, that's a genuine drift / session-race we want to log.
        app.log.warn(
          {
            adminId: req.auth!.userId,
            action: 'stats_view',
            innerStatus: inner.statusCode,
          },
          'unexpected inner status from /api/v1/admin/stats',
        );
        return reply.code(500).view('500', { title: 'Could not load stats' });
      }

      const parsed = InnerStatsResponse.safeParse(inner.json());
      if (!parsed.success) {
        app.log.error(
          {
            adminId: req.auth!.userId,
            action: 'stats_view',
            innerError: parsed.error.message,
          },
          'inner-200 response shape mismatch -- possible contract drift',
        );
        return reply.code(500).view('500', { title: 'Could not load stats' });
      }
      const data = parsed.data;

      // Build a stable, pre-translated view-model so the template stays simple
      // (Handlebars helpers run per-render -- fewer i18next round-trips this
      // way). Stable sort by status name for deterministic rendering.
      const jobRows = Object.entries(data.jobs)
        .map(([status, count]) => ({
          status,
          count,
          labelKey: KNOWN_JOB_STATUSES.has(status)
            ? `stats_jobs_${status}`
            : 'stats_jobs_unknown',
        }))
        .sort((a, b) => a.status.localeCompare(b.status));

      return reply.view('admin-stats', {
        title: app.i18n.t('page_title_stats', { lng: req.locale }),
        stats: {
          users: data.users,
          jobRows,
          storage: data.storage,
          queue: data.queue,
        },
      });
    },
  );
};
