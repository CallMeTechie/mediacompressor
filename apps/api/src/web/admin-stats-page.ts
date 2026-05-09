import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { JobStatus } from '@mediacompressor/db';

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
 * Known job statuses for which we have explicit i18n labels. Derived directly
 * from the Prisma `JobStatus` enum (packages/db/prisma/schema.prisma) via the
 * `@mediacompressor/db` re-export so the BFF can never silently drift from
 * the database schema. If Plan-7 / the schema ever adds a new status, the
 * `KNOWN_JOB_STATUSES` set picks it up automatically — but the `stats_jobs_*`
 * locale lookup will return the raw key, so the drift-guard test in
 * admin-stats-page.test.ts asserts both locale files cover every enum value.
 *
 * Unknown statuses (e.g. mid-deploy where the DB has a value the BFF binary
 * was built before) are rendered with a generic `stats_jobs_unknown` label
 * plus the raw status string so they don't disappear from the dashboard.
 */
const KNOWN_JOB_STATUSES: ReadonlySet<string> = new Set(Object.values(JobStatus));

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

      // Concern #4 (Plan 8d Task 6 review): defensive parse around inner.json().
      // Plan-7 currently always returns valid JSON on 200, but if a content-type
      // drift / proxy interpolation ever produces non-JSON on 200 we MUST still
      // hit the 500 + Cache-Control: no-store path. A sync throw would otherwise
      // bypass the 500 view (Fastify default 500 has no no-store). Mirrors the
      // try/catch precedent in admin-invite-create-route.ts (Plan 8d Task 5).
      let parsedJson: unknown;
      try {
        parsedJson = inner.json();
      } catch (err) {
        app.log.error(
          {
            adminId: req.auth!.userId,
            action: 'stats_view',
            err: err instanceof Error ? err.message : String(err),
          },
          'inner-200 returned non-JSON body -- possible content-type drift',
        );
        return reply.code(500).view('500', { title: 'Could not load stats' });
      }
      const parsed = InnerStatsResponse.safeParse(parsedJson);
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
