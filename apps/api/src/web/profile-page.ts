import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { hashSessionToken } from '@mediacompressor/auth';

/**
 * Plan 8c Task 1: GET /profile — renders the user's email + quota summary +
 * active-sessions list. The CURRENT session is matched via tokenHash equality
 * against the request's mc_session cookie so the user can't accidentally
 * revoke it from this page (the row shows "(this device)" instead of a
 * revoke button).
 *
 * Render-time tokenHash compare is plain `===` here. This is RENDER-only
 * comparison; no timing-attack vector since the comparison output never
 * affects authentication-success/failure timing. Plan 8c Task 2 (Session-
 * Revoke) uses `crypto.timingSafeEqual` for the security-relevant compare.
 *
 * fp-wrap rule (Rev. 2.3 from Plan 8b): this plugin does NOT decorate
 * anything → does NOT need fp(). It only registers a single GET route.
 */

const Query = z.object({
  revokeflash: z.string().optional(),
});

// Allowlist of accepted revokeflash values. Any other query string → flash
// is null, preventing URL-injection of arbitrary flash text (C3-PR).
//
// Implemented as a Map so eslint's `security/detect-object-injection` rule
// doesn't flag the lookup (Map.get() doesn't expose prototype properties to
// arbitrary string keys the way bracket-indexing a plain object does).
// Mirrors the FLASH_MAP pattern in job-detail-page.ts (Plan 8b C6-LI).
const REVOKE_FLASH_MAP = new Map<string, { level: 'error' | 'info'; message: string }>([
  [
    'current-session',
    {
      level: 'error',
      message: 'Cannot revoke the current device. Use Sign out instead.',
    },
  ],
  ['revoked', { level: 'info', message: 'Session revoked.' }],
]);

export const profilePagePlugin: FastifyPluginAsync = async (app) => {
  const { prisma, config } = app.deps;
  const sessionPepper = Buffer.from(config.SESSION_SECRET);

  app.get(
    '/profile',
    { preHandler: app.requireSession, schema: { querystring: Query } },
    async (req, reply) => {
      // Post-login HTML carries user-bound data → never cache.
      reply.header('cache-control', 'no-store, max-age=0');

      const userId = req.auth!.userId;

      const [user, sessions] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: {
            email: true,
            role: true,
            status: true,
            storageQuota: true,
            parallelQuota: true,
            hourlyQuota: true,
            createdAt: true,
          },
        }),
        prisma.session.findMany({
          where: { userId, expiresAt: { gt: new Date() } },
          orderBy: { lastUsedAt: 'desc' },
          select: {
            id: true,
            tokenHash: true,
            userAgent: true,
            ip: true,
            createdAt: true,
            lastUsedAt: true,
            expiresAt: true,
          },
        }),
      ]);
      if (!user) {
        return reply.code(404).view('404', { title: 'Not found', path: req.url });
      }

      // Identify the current session by hashing the cookie token. Plain
      // string equality is fine here (render-only, no timing attack).
      const cookieToken = req.cookies.mc_session ?? '';
      const currentTokenHash = cookieToken
        ? hashSessionToken(cookieToken, sessionPepper)
        : '';

      const { revokeflash } = req.query as z.infer<typeof Query>;
      const flash = revokeflash ? (REVOKE_FLASH_MAP.get(revokeflash) ?? null) : null;

      return reply.view('profile', {
        title: 'Profile',
        user: {
          email: user.email,
          role: user.role,
          status: user.status,
          // BigInt is not template-friendly — string.
          storageQuota: String(user.storageQuota),
          parallelQuota: user.parallelQuota,
          hourlyQuota: user.hourlyQuota,
        },
        sessions: sessions.map((s) => ({
          id: s.id,
          userAgent: s.userAgent,
          ip: s.ip,
          createdAt: s.createdAt.toISOString(),
          lastUsedAt: s.lastUsedAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          isCurrent: s.tokenHash === currentTokenHash,
        })),
        // The page contains forms (logout, per-row revoke) that need a CSRF
        // token. {{> csrf}} reads `_csrfField` from the view context.
        _csrfField: reply.renderCsrfField(),
        flash,
      });
    },
  );
};
