import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Plan 8c Task 3: GET /profile/api-keys — lists the authenticated user's
 * NON-revoked API keys (id, name, keyPrefix, scopes, createdAt, lastUsedAt).
 * The raw key is NEVER exposed here — it's only shown ONCE during create
 * (Task 4). Revoked keys are EXCLUDED via the `revokedAt: null` filter so
 * the user can only see keys that are currently usable.
 *
 * Each row carries a per-key revoke form posting to
 * `/profile/api-keys/:id/revoke` (Task 4) and the page-header links to
 * `/profile/api-keys/new` (Task 4) for creating a new key.
 *
 * fp-wrap rule (Rev. 2.3 from Plan 8b): this plugin does NOT decorate
 * anything → does NOT need fp(). It only registers a single GET route.
 */

const Query = z.object({
  revokeflash: z.string().optional(),
});

// Allowlist for revokeflash query param. Map (not Record) to avoid
// security/detect-object-injection lint warning. Mirrors the FLASH_MAP
// pattern used in profile-page.ts (Plan 8c Task 1) and Plan-8b's
// job-detail-page.ts (C6-LI). Any value outside the map → flash null
// (C3-PR allowlist gate, prevents URL-injection of arbitrary flash text).
const REVOKE_FLASH_MAP = new Map<string, { level: 'error' | 'info'; message: string }>([
  ['revoked', { level: 'info', message: 'API key revoked.' }],
  [
    'csrf-stale',
    {
      level: 'error',
      message: 'Your session token had to be refreshed. Please try again.',
    },
  ],
]);

export const apiKeysListPagePlugin: FastifyPluginAsync = async (app) => {
  const { prisma } = app.deps;

  app.get(
    '/profile/api-keys',
    { preHandler: app.requireSession, schema: { querystring: Query } },
    async (req, reply) => {
      // Post-login HTML carries user-bound data → never cache.
      reply.header('cache-control', 'no-store, max-age=0');

      const userId = req.auth!.userId;

      // WC-PR2: select ONLY the listing-safe columns. `keyHash` is NEVER
      // selected — even though it's a hash and not the raw key, leaking it
      // to the page-render path would let a future template bug expose it.
      // `revokedAt: null` filter excludes revoked keys (out of scope for
      // listing — revoked keys cannot be re-activated, only created anew).
      const keys = await prisma.apiKey.findMany({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          scopes: true,
          createdAt: true,
          lastUsedAt: true,
        },
      });

      const { revokeflash } = req.query as z.infer<typeof Query>;
      const flash = revokeflash ? (REVOKE_FLASH_MAP.get(revokeflash) ?? null) : null;

      return reply.view('api-keys-list', {
        title: 'API Keys',
        keys: keys.map((k) => ({
          id: k.id,
          name: k.name,
          keyPrefix: k.keyPrefix,
          scopes: k.scopes,
          createdAt: k.createdAt.toISOString(),
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        })),
        // Each per-row revoke form needs a CSRF token. {{> csrf}} reads
        // `_csrfField` from the view context.
        _csrfField: reply.renderCsrfField(),
        flash,
      });
    },
  );
};
