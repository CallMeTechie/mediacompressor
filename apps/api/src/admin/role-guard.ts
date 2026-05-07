import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { runCsrfHook } from '../auth/csrf-stub-reply.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * AP1 + AP5: requireAdmin. Delegates to requireAuth, then validates that the
     * resolved user is an active admin. Uses cached `req.auth.role`/`status`
     * (populated by requireAuth via resolveAuth) — no extra DB roundtrip.
     */
    requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined>;
    /**
     * AP1: state-changing admin routes need CSRF (Cookie-Auth) AND admin-role.
     * Bearer-API-Key bypasses CSRF (skipCsrf set by requireAuth) but still
     * goes through role-check. Mirrors requireAuthCsrf's stub-reply CSRF pattern.
     */
    requireAdminCsrf(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined>;
  }
}

export function registerAdminGuard(app: FastifyInstance): void {
  app.decorate(
    'requireAdmin',
    async (req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
      const userId = await app.requireAuth(req, reply);
      if (!userId) return;
      if (!req.auth || req.auth.status !== 'active' || req.auth.role !== 'admin') {
        // 403 vs 401 split is intentional — non-admin (logged in but unprivileged)
        // gets 403, unauth gets 401 via requireAuth. Small existence-leak for admin
        // endpoints (a logged-in user can probe whether they have admin role) is
        // accepted per spec.
        reply
          .code(403)
          .send({ error: { code: 'FORBIDDEN', message: 'admin role required' } });
        return;
      }
      return userId;
    },
  );

  app.decorate(
    'requireAdminCsrf',
    async (req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
      const userId = await app.requireAdmin(req, reply);
      if (!userId) return;
      if (req.skipCsrf) return userId;

      const outcome = await runCsrfHook(app, req, reply);
      if (outcome.ok) return userId;
      if (outcome.reason === 'missing-hook') {
        app.log.error(
          'csrfProtection hook missing — @fastify/csrf-protection not registered?',
        );
        reply
          .code(500)
          .send({ error: { code: 'INTERNAL', message: 'CSRF subsystem unavailable' } });
        return;
      }
      reply
        .code(403)
        .send({ error: { code: 'AUTH_INVALID', message: 'CSRF token missing or invalid' } });
      return;
    },
  );
}
