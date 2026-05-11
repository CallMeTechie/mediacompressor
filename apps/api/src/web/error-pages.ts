import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { wantsHtml } from './accept.js';

const errorPagesPluginImpl: FastifyPluginAsync = async (app) => {
  app.setNotFoundHandler((req, reply) => {
    if (wantsHtml(req)) {
      // Plan 8e Task 2: title comes from i18n (`common.error_404_title`) so
      // the <title>-tag (rendered in layouts/base.hbs from `{{title}}`) is
      // locale-aware in the same render-pass as the body. `path` is
      // interpolated into the body string by the {{t}} helper.
      return reply.code(404).view('404', {
        title: req.t('error_404_title', undefined, 'common'),
        path: req.url,
      });
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'unhandled');
    if (wantsHtml(req)) {
      // Plan 8e Task 2: title comes from i18n (`common.error_500_title`).
      return reply.code(500).view('500', {
        title: req.t('error_500_title', undefined, 'common'),
      });
    }
    return reply.code(500).send({ error: { code: 'INTERNAL', message: err.message } });
  });

  // Plan 8b Task 1: GET / is now owned by dashboardPagePlugin (registered
  // BEFORE this plugin in server.ts). The Plan-8a inline `/` route was
  // removed because the dashboard renders the real welcome page (recent
  // jobs + quota) and preserves the non-HTML JSON {status:'ok'} branch.
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
