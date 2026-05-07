import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

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

      // Reuse the same Promise-wrap pattern as requireAuthCsrf.
      type CsrfHook = (
        req: FastifyRequest,
        reply: FastifyReply,
        done: (err?: Error | null) => void,
      ) => void;
      const csrfHook = (app as unknown as { csrfProtection?: CsrfHook }).csrfProtection;
      if (typeof csrfHook !== 'function') {
        app.log.error(
          'csrfProtection hook missing — @fastify/csrf-protection not registered?',
        );
        reply
          .code(500)
          .send({ error: { code: 'INTERNAL', message: 'CSRF subsystem unavailable' } });
        return;
      }

      const outcome = await new Promise<{ ok: true } | { ok: false; err: Error }>(
        (resolve) => {
          const stubReply = new Proxy(reply, {
            get(target, prop, receiver) {
              if (prop === 'send') {
                return (payload: unknown) => {
                  resolve({
                    ok: false,
                    err:
                      payload instanceof Error
                        ? payload
                        : new Error('CSRF protection rejected'),
                  });
                  return stubReply;
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          csrfHook(req, stubReply as FastifyReply, (err) => {
            if (err) resolve({ ok: false, err });
            else resolve({ ok: true });
          });
        },
      );

      if (!outcome.ok) {
        reply
          .code(403)
          .send({ error: { code: 'AUTH_INVALID', message: 'CSRF token missing or invalid' } });
        return;
      }
      return userId;
    },
  );
}
