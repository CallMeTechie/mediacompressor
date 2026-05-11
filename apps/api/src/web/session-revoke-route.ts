import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { hashSessionToken } from '@mediacompressor/auth';

/**
 * Plan 8c Task 2: POST /profile/sessions/:id/revoke — revoke a specific
 * session by deleting the corresponding DB row. Refuses to delete the CURRENT
 * session: that flow is /logout (which also clears the cookie + rotates CSRF
 * + returns the user to /login). Revoking the cookie-in-use here would leave
 * the browser holding an invalid cookie that the next request couldn't
 * recover from, so we 303 the user back to /profile with a flash hint.
 *
 * preHandler order: [requireSession, csrfProtection]
 * - requireSession runs first so missing/expired sessions short-circuit to
 *   `303 /login` BEFORE the CSRF token is consulted.
 * - csrfProtection then verifies the double-submit pattern.
 *
 * WC-PR6 (constant-time compare): the current-session guard hashes the
 * incoming mc_session cookie with the same SESSION_SECRET pepper used at
 * login, then compares against the target row's `tokenHash` via
 * `crypto.timingSafeEqual`. Plain `===` would be timing-attack-vulnerable
 * (theoretical, but Plan-Defense-in-Depth — see Plan 8c Devil's-Advocate
 * Round 2). The owner-check (`target.userId !== userId`) runs FIRST so we
 * never leak existence of foreign sessions through the timing channel.
 *
 * fp-wrap rule (Rev. 2.3 from Plan 8b): this plugin does NOT decorate
 * anything → does NOT need fp(). It only registers a single POST route.
 */

const Params = z.object({ id: z.string().uuid() });

export const sessionRevokeRoutePlugin: FastifyPluginAsync = async (app) => {
  const { prisma, config } = app.deps;
  const sessionPepper = Buffer.from(config.SESSION_SECRET);

  app.post(
    '/profile/sessions/:id/revoke',
    {
      preHandler: [app.requireSession, app.csrfProtection],
      schema: { params: Params },
    },
    async (req, reply) => {
      const userId = req.auth!.userId;
      const { id } = req.params as z.infer<typeof Params>;

      // Look up the session row + assert ownership. Owner-check happens
      // BEFORE any tokenHash compare so we don't leak existence-or-ownership
      // of foreign sessions through the constant-time-compare branch below.
      const target = await prisma.session.findUnique({
        where: { id },
        select: { userId: true, tokenHash: true },
      });
      if (!target || target.userId !== userId) {
        return reply.code(404).view('404', { title: 'Not found', path: req.url });
      }

      // WC-PR6: constant-time compare for the current-session guard.
      const cookieToken = req.cookies.mc_session ?? '';
      const currentTokenHash = cookieToken ? hashSessionToken(cookieToken, sessionPepper) : '';
      if (currentTokenHash) {
        const a = Buffer.from(target.tokenHash, 'hex');
        const b = Buffer.from(currentTokenHash, 'hex');
        // Defensive length-check: timingSafeEqual throws on mismatched lengths.
        // tokenHash is always 64-char hex (SHA-256), so equal in practice.
        if (a.length === b.length && timingSafeEqual(a, b)) {
          return reply.code(303).header('location', '/profile?revokeflash=current-session').send();
        }
      }

      await prisma.session.delete({ where: { id } });
      return reply.code(303).header('location', '/profile?revokeflash=revoked').send();
    },
  );
};
