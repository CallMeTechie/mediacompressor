import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  ADMIN_INVITE_FLASH_KEYS,
  ADMIN_INVITE_FLASH_MAP,
} from './admin-invite-flash-keys.js';

/**
 * Plan 8d Task 5: GET /admin/invites -- paginated invite list (BFF).
 *
 * Forwards to the inner Plan-7 JSON route GET /api/v1/admin/invites via
 * app.inject() and renders the response as an HTML table. Cookie is
 * forwarded so the inner route's requireAdmin sees the same admin session.
 *
 * Auth-gate: app.requireAdminSession (Plan 8d Task 1):
 *  - No session: 303 to /login (delegated by wrapped requireSession).
 *  - Valid non-admin: 403 HTML (no admin-existence-leak).
 *  - Valid admin: handler runs.
 *
 * Status derivation: the inner route returns `{id, email, expiresAt,
 * consumedAt}`. We compute a `statusKey` (i18n-key) per row from that data:
 *  - consumedAt set -> 'invites_status_consumed'
 *  - expiresAt < now -> 'invites_status_expired'
 *  - else -> 'invites_status_active' (only this branch shows the Revoke
 *    button, since the inner DELETE 404s on consumed/missing invites).
 *
 * Flash-banner allowlist (C1-AD-PR / C3-PR): admin-invite-flash-keys.ts is
 * the single source of truth; arbitrary `?updateflash=evil` values are
 * rejected by Zod's enum and never reach the renderer.
 *
 * fp-wrap rule: this plugin does NOT decorate anything -> NOT fp-wrapped.
 */

const Query = z.object({
  updateflash: z.enum(ADMIN_INVITE_FLASH_KEYS).optional(),
});

type InviteRowApi = {
  id: string;
  email: string | null;
  expiresAt: string;
  consumedAt: string | null;
};

export const adminInvitesListPagePlugin: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/invites',
    {
      preHandler: app.requireAdminSession,
      schema: { querystring: Query },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store, max-age=0');
      const q = req.query as z.infer<typeof Query>;

      const inner = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/invites',
        headers: { cookie: req.headers.cookie ?? '' },
      });

      if (inner.statusCode !== 200) {
        return reply
          .code(inner.statusCode)
          .view('500', { title: 'Could not load invites' });
      }

      const data = inner.json() as { items: InviteRowApi[] };

      const flashEntry = q.updateflash
        ? ADMIN_INVITE_FLASH_MAP.get(q.updateflash)
        : undefined;
      const flash = flashEntry
        ? {
            level: flashEntry.level,
            message: app.i18n.t(flashEntry.messageKey, { lng: req.locale }),
          }
        : null;

      const now = Date.now();
      const invites = data.items.map((inv) => {
        const expiresAtMs = new Date(inv.expiresAt).getTime();
        const consumed = inv.consumedAt !== null;
        const expired = !consumed && expiresAtMs < now;
        const statusKey = consumed
          ? 'invites_status_consumed'
          : expired
            ? 'invites_status_expired'
            : 'invites_status_active';
        return {
          id: inv.id,
          email: inv.email,
          expiresAt: inv.expiresAt,
          consumedAt: inv.consumedAt,
          statusKey,
          canRevoke: !consumed && !expired,
        };
      });

      return reply.view('admin-invites-list', {
        title: app.i18n.t('page_title_invites', { lng: req.locale }),
        invites,
        flash,
        _csrfField: reply.renderCsrfField(),
      });
    },
  );
};
