import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Plan 8c Task 4: POST /profile/api-keys/:id/revoke — HTML form-target that
 * delegates to the JSON-API DELETE /api/v1/users/me/api-keys/:id (Plan 4)
 * via app.inject(). Translates the inner status code into a redirect-or-
 * error pattern appropriate for browser-form-POST flows.
 *
 * preHandler order: [requireSession, csrfProtection]
 * - requireSession runs first so missing/expired sessions short-circuit to
 *   `303 /login` BEFORE the CSRF token is consulted.
 * - csrfProtection then verifies the double-submit pattern.
 *
 * Inner-status mapping (verified via Pre-Flight read of api-key-routes.ts):
 * - 204 / 200 → 303 /profile/api-keys?revokeflash=revoked  (success)
 * - 401       → clearCookie + 303 /login                   (session-race)
 * - 403       → 303 /profile/api-keys?revokeflash=csrf-stale (CSRF rotation)
 * - 404       → 404 HTML                                    (foreign / nonexistent)
 * - else      → render `views/500.hbs`
 *
 * fp-wrap rule (Rev. 2.3): this plugin does NOT decorate anything → does NOT
 * need fp(). It only registers a single POST route.
 */

const Params = z.object({ id: z.string().uuid() });

export const apiKeyRevokeRoutePlugin: FastifyPluginAsync = async (app) => {
  app.post(
    '/profile/api-keys/:id/revoke',
    {
      preHandler: [app.requireSession, app.csrfProtection],
      schema: { params: Params },
    },
    async (req, reply) => {
      const { id } = req.params as z.infer<typeof Params>;

      // WC-PL3: forward the CSRF token correctly. May come from the form
      // body (_csrf) or the x-csrf-token header; the inner DELETE reads
      // via the same getToken-shim Plan 8a wired into the plugin config.
      const headerToken = req.headers['x-csrf-token'];
      const bodyToken =
        typeof (req.body as Record<string, unknown> | undefined)?._csrf === 'string'
          ? (req.body as Record<string, string>)._csrf
          : undefined;
      const csrfToken =
        (typeof headerToken === 'string' ? headerToken : undefined) ?? bodyToken ?? '';

      const inner = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/me/api-keys/${id}`,
        headers: {
          cookie: req.headers.cookie ?? '',
          'x-csrf-token': csrfToken,
        },
      });

      if (inner.statusCode === 204 || inner.statusCode === 200) {
        return reply.code(303).header('location', '/profile/api-keys?revokeflash=revoked').send();
      }
      // Multi-tab logout race: inner session truly expired/revoked.
      if (inner.statusCode === 401) {
        reply.clearCookie('mc_session', { path: '/' });
        return reply.code(303).header('location', '/login').send();
      }
      // CSRF rotation race: session valid, just stale token.
      if (inner.statusCode === 403) {
        return reply
          .code(303)
          .header('location', '/profile/api-keys?revokeflash=csrf-stale')
          .send();
      }
      if (inner.statusCode === 404) {
        return reply.code(404).view('404', { title: 'Not found', path: req.url });
      }
      // 5xx — render the 500 page.
      return reply.code(inner.statusCode).view('500', { title: 'Revoke failed' });
    },
  );
};
