import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { AdminInviteFlashKey } from './admin-invite-flash-keys.js';

/**
 * Plan 8d Task 5: POST /admin/invites/:id/revoke -- HTML form-target that
 * delegates to the JSON-API DELETE /api/v1/admin/invites/:id (Plan 7) via
 * app.inject().
 *
 * preHandler order: [requireAdminSession, csrfProtection]
 *  - requireAdminSession runs first so missing/expired sessions short-
 *    circuit to /login (303) and non-admins get 403 BEFORE the CSRF token
 *    is consulted (WC-AD8 / C4-AD-PR).
 *
 * Defense-in-depth UUID re-check: `id` is already validated as a Zod UUID
 * via `schema.params`, but the explicit regex re-check below makes that
 * invariant local-and-obvious so static analyzers do not have to trace the
 * value back through the schema before any URL-interpolation. Mirrors the
 * Task-4 update-route pattern.
 *
 * The `_csrf` token is read defensively from the body without a Zod schema
 * (Rev. 2.2: the validatorCompiler would otherwise strip it before
 * csrfProtection runs). The csrfProtection plugin itself accepts header OR
 * `_csrf` form field, so all this handler does is forward whichever we got
 * to the inner DELETE.
 *
 * Inner-status mapping:
 *  - 204 -> 303 /admin/invites?updateflash=revoked          (success)
 *  - 401 -> clearCookie + 303 /login                        (session race)
 *  - 403 -> 303 /admin/invites?updateflash=csrf-stale       (CSRF rotation)
 *  - 404 -> 404 HTML (consumed/missing/foreign — same response shape so the
 *           admin cannot distinguish "doesn't exist" from "already consumed")
 *  - else -> 500 HTML
 *
 * fp-wrap rule: this plugin does NOT decorate anything -> NOT fp-wrapped.
 */

const Params = z.object({ id: z.string().uuid() });

// Defense-in-depth: avoid open-redirect false-positives in static analyzers
// even though Params.id is already a Zod UUID. Mirrors Task-4 update-route.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const adminInviteRevokeRoutePlugin: FastifyPluginAsync = async (app) => {
  app.post(
    '/admin/invites/:id/revoke',
    {
      preHandler: [app.requireAdminSession, app.csrfProtection],
      schema: { params: Params },
    },
    async (req, reply) => {
      const { id } = req.params as z.infer<typeof Params>;

      // Defense-in-depth UUID re-check before any `:id` interpolation into
      // a URL or redirect-Location. Cannot be reached in practice (Zod
      // already rejected non-UUIDs), but keeps the local invariant obvious
      // to static analyzers.
      if (!UUID_RE.test(id)) {
        return reply.code(400).view('500', { title: 'Bad request' });
      }

      // Forward CSRF: header takes precedence over body. The form may submit
      // `_csrf` in the body (form-encoded) or as `x-csrf-token` (header).
      const headerToken = req.headers['x-csrf-token'];
      const bodyCsrf = (req.body as { _csrf?: unknown } | null | undefined)?._csrf;
      const csrfToken =
        typeof headerToken === 'string'
          ? headerToken
          : typeof bodyCsrf === 'string'
            ? bodyCsrf
            : '';

      const inner = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/invites/${id}`,
        headers: {
          cookie: req.headers.cookie ?? '',
          'x-csrf-token': csrfToken,
        },
      });

      if (inner.statusCode === 204) {
        // C5-PR audit-log scaffolding (admin state-change). Whitelist fields
        // only -- no secrets.
        app.log.info(
          {
            adminId: req.auth!.userId,
            action: 'invite_revoke',
            inviteId: id,
          },
          'admin action',
        );
        const successKey: AdminInviteFlashKey = 'revoked';
        return reply
          .code(303)
          .header('location', `/admin/invites?updateflash=${successKey}`)
          .send();
      }
      if (inner.statusCode === 401) {
        reply.clearCookie('mc_session', { path: '/' });
        return reply.code(303).header('location', '/login').send();
      }
      if (inner.statusCode === 403) {
        const csrfStaleKey: AdminInviteFlashKey = 'csrf-stale';
        return reply
          .code(303)
          .header('location', `/admin/invites?updateflash=${csrfStaleKey}`)
          .send();
      }
      if (inner.statusCode === 404) {
        return reply
          .code(404)
          .view('404', { title: 'Not found', path: req.url });
      }
      return reply
        .code(inner.statusCode)
        .view('500', { title: 'Revoke invite failed' });
    },
  );
};
