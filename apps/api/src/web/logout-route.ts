import type { FastifyPluginAsync } from 'fastify';
import { hashSessionToken } from '@mediacompressor/auth';

export const logoutRoutePlugin: FastifyPluginAsync = async (app) => {
  const { prisma, config } = app.deps;
  const sessionPepper = Buffer.from(config.SESSION_SECRET);

  app.post('/logout', { preHandler: app.csrfProtection }, async (req, reply) => {
    const token = req.cookies.mc_session;
    if (token) {
      const tokenHash = hashSessionToken(token, sessionPepper);
      await prisma.session.deleteMany({ where: { tokenHash } });
    }
    reply.clearCookie('mc_session', { path: '/' });
    // WC4: also clear mc_csrf so a subsequent login flow gets a fresh token.
    // (The CSRF cookie itself isn't a credential, but rotating it on logout
    // keeps the auth-state-transition rules symmetric with login/redeem.)
    reply.clearCookie('mc_csrf', { path: '/' });
    return reply.code(303).header('location', '/login').send();
  });
};
