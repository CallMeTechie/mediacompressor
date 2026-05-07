import type { FastifyRequest } from 'fastify';

/**
 * Accept-aware HTML predicate. JSON-API and static-asset paths are always
 * non-HTML regardless of Accept header (so health-checks and curl don't
 * accidentally trigger HTML rendering / 303 redirects).
 *
 * Single source of truth: imported by error-pages.ts (404/500 + catch-alls)
 * and dashboard-page.ts (dual-shape `/` route). Plan 8b extracted this from
 * Plan 8a's inline definition in error-pages.ts to avoid duplication.
 */
export function wantsHtml(req: FastifyRequest): boolean {
  if (req.url.startsWith('/api/')) return false;
  if (req.url.startsWith('/static/')) return false;
  const accept = (req.headers.accept ?? '').toLowerCase();
  return accept.includes('text/html');
}
