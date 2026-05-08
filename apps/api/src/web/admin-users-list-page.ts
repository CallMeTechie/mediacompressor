import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Plan 8d Task 4: GET /admin/users -- paginated user list (BFF).
 *
 * Forwards cursor-pagination to the inner Plan-7 JSON route
 * (GET /api/v1/admin/users?cursor=&limit=) via app.inject() and renders the
 * response as an HTML table. Cookie is forwarded so the inner route's
 * requireAdmin sees the same admin session.
 *
 * Auth-gate: app.requireAdminSession (Plan 8d Task 1):
 *  - No session: 303 to /login (delegated by wrapped requireSession).
 *  - Valid non-admin: 403 HTML (no admin-existence-leak).
 *  - Valid admin: handler runs.
 *
 * C1-AD-PR: flash-messages are stored as i18n-keys in FLASH_MAP and
 * server-translated at render-time via app.i18n.t(messageKey, {lng:
 * req.locale}). Plain English strings would render in the wrong language
 * for German users; partial-context-loss inside {{#each}} blocks would
 * also break {{t}}-helper-based late-translation. Pre-translating at
 * render-time avoids both.
 *
 * fp-wrap rule: this plugin does NOT decorate anything -> NOT fp-wrapped.
 */

const Query = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  updateflash: z.string().optional(),
});

// C1-AD-PR + C3-PR allowlist gate: only known flash-keys render. Any
// arbitrary `?updateflash=evil` value falls through to `null`.
const FLASH_MAP = new Map<string, { level: 'error' | 'info'; messageKey: string }>([
  ['updated', { level: 'info', messageKey: 'flash_user_updated' }],
  ['csrf-stale', { level: 'error', messageKey: 'flash_csrf_stale' }],
]);

export const adminUsersListPagePlugin: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/users',
    {
      preHandler: app.requireAdminSession,
      schema: { querystring: Query },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store, max-age=0');
      const q = req.query as z.infer<typeof Query>;

      const params = new URLSearchParams();
      if (q.cursor) params.set('cursor', q.cursor);
      params.set('limit', String(q.limit));

      const inner = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/users?${params.toString()}`,
        headers: { cookie: req.headers.cookie ?? '' },
      });

      if (inner.statusCode !== 200) {
        return reply
          .code(inner.statusCode)
          .view('500', { title: 'Could not load users' });
      }

      const data = inner.json() as {
        items: Array<Record<string, unknown>>;
        nextCursor: string | null;
      };

      const flashEntry = q.updateflash ? FLASH_MAP.get(q.updateflash) : undefined;
      const flash = flashEntry
        ? {
            level: flashEntry.level,
            message: app.i18n.t(flashEntry.messageKey, { lng: req.locale }),
          }
        : null;

      return reply.view('admin-users-list', {
        title: app.i18n.t('page_title_users', { lng: req.locale }),
        users: data.items,
        nextCursor: data.nextCursor,
        flash,
      });
    },
  );
};
