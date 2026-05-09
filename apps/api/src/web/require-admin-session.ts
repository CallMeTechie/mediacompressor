import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * View-middleware: ensures the request carries a valid admin session.
     * Wraps Plan-8b's `app.requireSession`:
     *  - On miss/expired/disabled-user: requireSession already 303s to
     *    /login + clears the mc_session cookie; this function returns
     *    `undefined` without touching the reply further.
     *  - On valid-but-non-admin (role !== 'admin' OR status !== 'active'):
     *    renders a 403 HTML page (NOT 303 — the user IS authenticated, just
     *    lacks admin privileges; redirecting to /login would be misleading
     *    and produce a re-login loop on the same role).
     *  - On valid-admin: returns the userId for downstream handlers.
     *
     * WC-AD1: the rendered 403 page-shell is identical regardless of which
     * `/admin/*` path was probed, so non-admins cannot enumerate admin
     * routes by diffing the response body.
     *
     * Used as a Fastify preHandler:
     *   app.get('/admin', { preHandler: app.requireAdminSession }, ...)
     */
    requireAdminSession(
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<string | undefined>;
  }
}

const requireAdminSessionImpl = async (app: FastifyInstance) => {
  app.decorate(
    'requireAdminSession',
    async (req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
      const userId = await app.requireSession(req, reply);
      if (!userId) return undefined; // requireSession already 303'd + cleared cookie.
      if (
        !req.auth ||
        req.auth.role !== 'admin' ||
        req.auth.status !== 'active'
      ) {
        reply.code(403).header('cache-control', 'no-store, max-age=0');
        // Plan 8e Task 2: title + message both routed through i18n
        // (`common.error_403_title`, `common.error_403_admin_body`). The
        // admin-specific body key keeps the existing test-assertion
        // (`/admin privileges/` in EN) and adds a DE equivalent
        // (`/Admin-Rechte/`) without losing the role-context information.
        await reply.view('403', {
          title: req.t('error_403_title', undefined, 'common'),
          message: req.t('error_403_admin_body', undefined, 'common'),
        });
        return undefined;
      }
      return userId;
    },
  );
};

// fp-wrap required (Rev. 2.3 rule for decorator-bearing plugins) so the
// `requireAdminSession` decorator bubbles up to the parent FastifyInstance
// and is visible to every plugin/route registered after it.
export const requireAdminSessionPlugin = fp(requireAdminSessionImpl, {
  name: 'web-require-admin-session',
  fastify: '5.x',
});
