import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { hashSessionToken } from '@mediacompressor/auth';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * View-middleware: ensures the request carries a valid mc_session cookie
     * AND the underlying user is active. On miss/expired/disabled: clears
     * mc_session + 303s to /login. On hit: populates req.auth (Plan-7 AP5
     * shape with role/status) and returns the userId.
     *
     * Used as a Fastify preHandler:
     *   app.get('/jobs', { preHandler: app.requireSession }, ...)
     *
     * Or invoked manually inside a handler (dashboard-page does this so the
     * non-HTML JSON branch can skip the auth check):
     *   const userId = await app.requireSession(req, reply);
     *   if (!userId) return; // already 303'd
     */
    requireSession(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined>;
  }
}

const requireSessionImpl = async (app: FastifyInstance) => {
  const { prisma, config } = app.deps;
  const sessionPepper = Buffer.from(config.SESSION_SECRET);

  app.decorate(
    'requireSession',
    async (req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
      const token = req.cookies.mc_session;
      if (!token) {
        reply.code(303).header('location', '/login').send();
        return undefined;
      }
      const tokenHash = hashSessionToken(token, sessionPepper);
      const session = await prisma.session.findUnique({
        where: { tokenHash },
        include: {
          user: { select: { id: true, role: true, status: true } },
        },
      });
      if (!session || session.expiresAt < new Date() || session.user.status !== 'active') {
        reply.clearCookie('mc_session', { path: '/' });
        reply.code(303).header('location', '/login').send();
        return undefined;
      }
      req.auth = {
        userId: session.userId,
        method: 'session',
        role: session.user.role,
        status: session.user.status,
      };
      return session.userId;
    },
  );
};

// fp-wrap required (Rev. 2.3 rule for decorator-bearing plugins) so the
// `requireSession` decorator bubbles up to the parent FastifyInstance and
// is visible to every plugin/route registered after it.
export const requireSessionPlugin = fp(requireSessionImpl, {
  name: 'web-require-session',
  fastify: '5.x',
});
