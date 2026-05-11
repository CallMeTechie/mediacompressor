import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@mediacompressor/db';

/**
 * Plan 8b Task 2: GET /jobs — cursor-paginated HTML list of the authenticated
 * user's jobs.
 *
 * Polling: when the current slice contains an in-flight job (uploading/queued/
 * processing), the rendered <tbody> carries hx-trigger="every 3s" so HTMX
 * re-fetches `/jobs?fragment=1...` every 3s and outerHTML-swaps the tbody.
 * When all visible jobs are terminal (succeeded/failed/canceled/expired), the
 * polling attrs are omitted on the fresh fragment → HTMX naturally stops
 * re-polling (WC-PL4).
 *
 * Fragment-mode (`?fragment=1`) renders the rows partial WITHOUT the layout
 * so HTMX swaps a clean <tbody> in place of the existing one.
 */

const ListQuery = z.object({
  status: z
    .enum(['queued', 'processing', 'succeeded', 'failed', 'canceled', 'expired', 'uploading'])
    .optional(),
  cursor: z.string().optional(),
  fragment: z.coerce.boolean().default(false),
});

const PUBLIC_JOB_SELECT = {
  id: true,
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

const PAGE_SIZE = 20;
// Status filters exposed in the filter-bar UI. `uploading` is intentionally
// omitted — that state belongs to the upload-wizard, not the list page.
const STATUS_FILTERS = ['queued', 'processing', 'succeeded', 'failed'] as const;
const IN_FLIGHT_STATUSES: ReadonlyArray<string> = ['uploading', 'queued', 'processing'];

export const jobListPagePlugin: FastifyPluginAsync = async (app) => {
  const { prisma } = app.deps;

  app.get(
    '/jobs',
    { preHandler: app.requireSession, schema: { querystring: ListQuery } },
    async (req, reply) => {
      // C5-Rev2: post-login HTML carries user-bound data → never cache.
      reply.header('cache-control', 'no-store, max-age=0');

      const userId = req.auth!.userId;
      const { status, cursor, fragment } = req.query as z.infer<typeof ListQuery>;

      // Cursor format `<iso>|<id>` mirrors Plan-7 jobs-routes.ts. UUIDs cannot
      // contain `|`, so the delimiter is unambiguous. Tolerant of malformed
      // cursors (treat as no-cursor) — never throws.
      let cursorWhere: Prisma.JobWhereInput = {};
      if (cursor) {
        const [iso, id] = cursor.split('|');
        if (iso && id) {
          const isoDate = new Date(iso);
          if (!Number.isNaN(isoDate.getTime())) {
            cursorWhere = {
              OR: [
                { createdAt: { lt: isoDate } },
                { AND: [{ createdAt: isoDate }, { id: { lt: id } }] },
              ],
            };
          }
        }
      }

      const items = await prisma.job.findMany({
        where: { userId, ...(status && { status }), ...cursorWhere },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE + 1,
        select: PUBLIC_JOB_SELECT,
      });
      const hasMore = items.length > PAGE_SIZE;
      const slice = items.slice(0, PAGE_SIZE);
      const last = slice[slice.length - 1];
      const nextCursor = hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null;

      // Precompute statusOptions as `[{value, active}]` so the .hbs template
      // can use `{{#if active}}active{{/if}}` without relying on a custom
      // ifEq Handlebars helper.
      const statusOptions = STATUS_FILTERS.map((value) => ({
        value,
        active: value === status,
      }));

      const view = {
        // Plan 8e Task 5: page-title resolved via req.t with explicit
        // `ns: 'jobs'` (typed Namespace). defaultNS is still `'admin'`
        // (Task 7 cleanup), so the namespace MUST be passed explicitly.
        title: req.t('page_title_list', undefined, 'jobs'),
        jobs: slice.map((j) => ({
          ...j,
          // BigInt is not JSON-serializable / not useful in templates — string.
          inputBytes: j.inputBytes === null ? null : j.inputBytes.toString(),
          outputBytes: j.outputBytes === null ? null : j.outputBytes.toString(),
          createdAt: j.createdAt.toISOString(),
          finishedAt: j.finishedAt?.toISOString() ?? null,
        })),
        statusFilter: status ?? '',
        statusOptions,
        nextCursor,
        hasInFlight: slice.some((j) => IN_FLIGHT_STATUSES.includes(j.status)),
      };

      // Fragment mode for HTMX polling — render only the rows partial, no
      // layout. The fragment carries the SAME conditional polling attrs, so
      // when hasInFlight transitions to false, the swapped tbody has no
      // hx-trigger and HTMX naturally stops re-polling (WC-PL4).
      if (fragment) {
        return reply.viewFragment('job-list-rows', view);
      }
      return reply.view('job-list', view);
    },
  );
};
