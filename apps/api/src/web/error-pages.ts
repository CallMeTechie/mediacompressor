import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

function wantsHtml(req: FastifyRequest): boolean {
  // Browsers send `accept: text/html,...`. API clients usually send
  // `accept: application/json` or `*/*`. Only `text/html` opts into HTML.
  // We also exclude /api/* and /static/* prefixes so JSON APIs and assets
  // are unaffected by the accept-sniff.
  if (req.url.startsWith('/api/')) return false;
  if (req.url.startsWith('/static/')) return false;
  const accept = (req.headers.accept ?? '').toLowerCase();
  return accept.includes('text/html');
}

const errorPagesPluginImpl: FastifyPluginAsync = async (app) => {
  app.setNotFoundHandler((req, reply) => {
    if (wantsHtml(req)) {
      return reply.code(404).view('404', { title: 'Not found', path: req.url });
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'unhandled');
    if (wantsHtml(req)) {
      return reply.code(500).view('500', { title: 'Server error' });
    }
    return reply.code(500).send({ error: { code: 'INTERNAL', message: err.message } });
  });

  // Root: HTML clients without session → /login; with session → home placeholder.
  // Non-HTML clients → existing JSON {status:ok} so health-check tooling keeps working.
  app.get('/', async (req, reply) => {
    if (wantsHtml(req)) {
      const session = req.cookies.mc_session;
      if (!session) return reply.code(303).header('location', '/login').send();
      // C5-Rev2: post-login HTML renders user-bound data (Plan 8b will surface
      // job-counts, recent activity, etc.) — must not be browser/proxy cached.
      reply.header('cache-control', 'no-store, max-age=0');
      return reply.view('home-placeholder', { title: 'MediaCompressor' });
    }
    return reply.send({ status: 'ok' });
  });
};

// Wrap with fastify-plugin so setNotFoundHandler / setErrorHandler bubble up
// to the parent scope. Without fp(), Fastify scopes them to this encapsulated
// plugin only, and routes registered at the parent scope (e.g. test-only
// routes added after buildServer returns) would fall through to the default
// JSON error handler instead of the accept-aware one. The catch-all 404 still
// only fires for URLs that no parent-scope route matched, because it's
// registered LAST in server.ts.
export const errorPagesPlugin = fp(errorPagesPluginImpl, {
  name: 'error-pages-plugin',
  fastify: '5.x',
});

