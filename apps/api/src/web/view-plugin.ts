import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import view from '@fastify/view';
import staticPlugin from '@fastify/static';
import formbody from '@fastify/formbody';
import handlebars from 'handlebars';
import { csrfHelperPlugin } from './csrf-helper.js';

// __dirname-shim for ESM. The plugin file lives at apps/api/src/web/view-plugin.ts;
// views/ is at apps/api/views/ and public/ is at apps/api/public/, so we go ../..
// from src/web/ to reach the apps/api/ root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPS_API_ROOT = path.join(__dirname, '..', '..');

const webViewPluginImpl: FastifyPluginAsync = async (app) => {
  // Form bodies (application/x-www-form-urlencoded) — needed for HTML forms.
  await app.register(formbody);

  // Handlebars rendering. Layout `layouts/base.hbs` is the default wrapper for
  // every page; per-view templates extend it via the `body` block (see base.hbs).
  await app.register(view, {
    engine: { handlebars },
    root: path.join(APPS_API_ROOT, 'views'),
    layout: 'layouts/base.hbs',
    options: {
      // partials/<name>.hbs auto-discovered.
      partials: {
        csrf: 'partials/csrf.hbs',
        flash: 'partials/flash.hbs',
        // Plan 8b Task 1: status badge reused on dashboard / job-list / job-detail.
        'job-status-badge': 'partials/job-status-badge.hbs',
      },
      useHtmlMinifier: false, // Plan 8b/8c may turn this on.
    },
  });

  // Static assets. `prefix: '/static/'` so the canonical paths are
  // /static/css/app.css and /static/vendor/htmx.min.js. `decorateReply: false`
  // because Fastify already has reply decorators registered by the auth plugins.
  await app.register(staticPlugin, {
    root: path.join(APPS_API_ROOT, 'public'),
    prefix: '/static/',
    decorateReply: false,
    // @fastify/static already blocks `..` traversal; explicit dotfile rejection
    // catches `.env`-style mistakes.
    dotfiles: 'deny',
  });

  // WC6: CSP for HTML responses only. helmet() in server.ts has CSP disabled
  // because Plan-4 was JSON-only. Now that Plan 8a serves HTML, layer a
  // restrictive CSP on every text/html response. JSON-API + static-asset
  // responses are unaffected (the predicate keys off the actual content-type
  // the route already chose). Hardcoded directives = no user input → safe.
  app.addHook('onSend', async (_req, reply, payload) => {
    const ct = reply.getHeader('content-type');
    const ctStr = Array.isArray(ct) ? ct.join(';') : ((ct as string | undefined) ?? '');
    if (ctStr.toLowerCase().startsWith('text/html')) {
      reply.header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self';",
      );
    }
    return payload;
  });

  // Task 2: CSRF form-helper. Decorates reply.renderCsrfField() and is registered
  // here (inside the fp-wrapped impl) so the decorator bubbles up to the parent
  // app scope alongside reply.view from @fastify/view.
  await app.register(csrfHelperPlugin);
};

// Wrap with fastify-plugin so @fastify/view's reply.view decorator and
// @fastify/static's GET /static/* routes bubble up to the parent FastifyInstance.
// Without this, plugin-scoped encapsulation hides reply.view from the parent
// app and Tasks 3+/test handlers cannot call reply.view(...).
export const webViewPlugin = fp(webViewPluginImpl, {
  name: 'web-view-plugin',
  fastify: '5.x',
});
