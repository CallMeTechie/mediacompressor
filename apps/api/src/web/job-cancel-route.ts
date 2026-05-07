import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Plan 8b Task 3: POST /jobs/:id/cancel — HTML form-target that delegates
 * to the JSON-API DELETE /api/v1/jobs/:id (Plan 7 jobs-routes) via
 * `app.inject(...)`. We translate the inner status code into a redirect-or-
 * error pattern appropriate for browser-form-POST flows.
 *
 * preHandler order:
 *   [requireSession, csrfProtection]
 * - requireSession runs first so missing/expired sessions short-circuit to
 *   `303 /login` BEFORE the CSRF token is even consulted.
 * - csrfProtection then verifies the double-submit pattern (cookie token vs
 *   form-_csrf or x-csrf-token header). If it fails, the plugin's onError
 *   handler responds with 403 directly — our handler is never invoked.
 *
 * WC-PL3: the user's CSRF token may live in either `_csrf` body-field
 * (default for HTML forms) or `x-csrf-token` header (HTMX / JS). We forward
 * whichever is present so the inner DELETE's requireAuthCsrf finds the same
 * token (using the same getToken Plan-8a wired into the plugin config).
 *
 * Status mapping (inner statusCode → outer behaviour):
 * - 204 → 303 to `/jobs/:id`              (success)
 * - 404 → 404 HTML                        (foreign / nonexistent)
 * - 401 → clearCookie + 303 `/login`      (C2-LI session-race)
 * - 403 → 303 `/jobs/:id?cancelflash=csrf-stale` (C6-LI CSRF stale)
 * - else → render `views/500.hbs` with the inner status code
 */

const Params = z.object({ id: z.string().uuid() });

export const jobCancelRoutePlugin: FastifyPluginAsync = async (app) => {
  app.post(
    '/jobs/:id/cancel',
    {
      preHandler: [app.requireSession, app.csrfProtection],
      schema: { params: Params },
    },
    async (req, reply) => {
      const { id } = req.params as z.infer<typeof Params>;

      // WC-PL3: forward CSRF correctly. The user may submit via form-body
      // (_csrf) OR via x-csrf-token header (HTMX). The inner DELETE
      // /api/v1/jobs/:id (Plan-7) uses requireAuthCsrf → reads via the SAME
      // getToken hook (Plan-8a body-fallback). Forward whichever is present.
      const headerToken = req.headers['x-csrf-token'];
      const bodyToken =
        typeof (req.body as Record<string, unknown> | undefined)?._csrf === 'string'
          ? (req.body as Record<string, string>)._csrf
          : undefined;
      const csrfToken =
        (typeof headerToken === 'string' ? headerToken : undefined) ?? bodyToken ?? '';

      const inner = await app.inject({
        method: 'DELETE',
        url: `/api/v1/jobs/${id}`,
        headers: {
          cookie: req.headers.cookie ?? '',
          'x-csrf-token': csrfToken,
        },
      });

      if (inner.statusCode === 204) {
        return reply.code(303).header('location', `/jobs/${id}`).send();
      }
      if (inner.statusCode === 404) {
        return reply.code(404).view('404', { title: 'Not found', path: req.url });
      }
      // C2-LI: 401 = inner session truly expired/revoked (multi-tab logout
      // race). Clear cookie + redirect to /login so the next page-load is
      // already unauthenticated.
      if (inner.statusCode === 401) {
        reply.clearCookie('mc_session', { path: '/' });
        return reply.code(303).header('location', '/login').send();
      }
      // C6-LI: 403 = inner CSRF token mismatch (typically a cross-tab CSRF
      // rotation). Session is still valid → DON'T logout. Re-render the
      // detail page with a flash hint via cancelflash=csrf-stale so the user
      // gets a fresh form-token and can retry without losing the session.
      if (inner.statusCode === 403) {
        return reply
          .code(303)
          .header('location', `/jobs/${id}?cancelflash=csrf-stale`)
          .send();
      }
      // 5xx — render the 500 page.
      return reply.code(inner.statusCode).view('500', { title: 'Cancel failed' });
    },
  );
};
