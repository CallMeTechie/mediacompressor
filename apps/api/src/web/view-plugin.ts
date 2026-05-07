import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import view from '@fastify/view';
import staticPlugin from '@fastify/static';
import formbody from '@fastify/formbody';
import handlebars from 'handlebars';
import { csrfHelperPlugin } from './csrf-helper.js';

declare module 'fastify' {
  interface FastifyReply {
    /**
     * Render a Handlebars template (relative to `views/`) WITHOUT the global
     * `layouts/base.hbs` wrapper. Used for HTMX swap-fragments where only the
     * partial markup is wanted (no `<html>`/`<head>` shell).
     *
     * @fastify/view always wraps with the global layout — there is no per-call
     * disable — so we render the template directly via the same Handlebars
     * instance that backs reply.view, after registering identical partials so
     * `{{> job-status-badge}}` etc. resolve.
     */
    viewFragment(template: string, data: Record<string, unknown>): Promise<FastifyReply>;
  }
}

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
        // Plan 8b Task 2: job-list rows partial (HTMX-swap target). Lives at
        // views/job-list-rows.hbs (not under partials/) because reply.view()
        // also renders it standalone in fragment-mode.
        'job-list-rows': 'job-list-rows.hbs',
        // Plan 8b Task 4: job-detail-status partial (SSE-target inner block).
        // Rendered standalone via reply.viewFragment for the ?fragment=1 polling
        // fallback; inlined as `{{> job-detail-status job}}` inside job-detail.hbs.
        'job-detail-status': 'job-detail-status.hbs',
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

  // Plan 8b Task 2: register the same partials on the standalone Handlebars
  // instance so reply.viewFragment can resolve `{{> job-status-badge}}` and
  // friends without going through @fastify/view's layout-wrapped renderer.
  const VIEWS_ROOT = path.join(APPS_API_ROOT, 'views');
  const FRAGMENT_PARTIALS: Record<string, string> = {
    csrf: 'partials/csrf.hbs',
    flash: 'partials/flash.hbs',
    'job-status-badge': 'partials/job-status-badge.hbs',
    'job-list-rows': 'job-list-rows.hbs',
    // Plan 8b Task 4: keep in sync with @fastify/view partials map above (see
    // Rev. 2.2 DRY-smell note — Plan-8c will hoist to a shared `const`).
    'job-detail-status': 'job-detail-status.hbs',
  };
  for (const [name, relPath] of Object.entries(FRAGMENT_PARTIALS)) {
    const src = await fs.readFile(path.join(VIEWS_ROOT, relPath), 'utf8');
    handlebars.registerPartial(name, src);
  }

  // Cache compiled fragment templates so repeated polling requests don't re-
  // read the file from disk.
  const fragmentCache = new Map<string, Handlebars.TemplateDelegate>();
  async function getFragmentTemplate(template: string): Promise<Handlebars.TemplateDelegate> {
    const cached = fragmentCache.get(template);
    if (cached) return cached;
    const file = template.endsWith('.hbs') ? template : `${template}.hbs`;
    const src = await fs.readFile(path.join(VIEWS_ROOT, file), 'utf8');
    const compiled = handlebars.compile(src);
    fragmentCache.set(template, compiled);
    return compiled;
  }

  app.decorateReply(
    'viewFragment',
    async function (this: FastifyReply, template: string, data: Record<string, unknown>) {
      const compiled = await getFragmentTemplate(template);
      const html = compiled(data);
      this.header('content-type', 'text/html; charset=utf-8');
      this.send(html);
      return this;
    },
  );
};

// Wrap with fastify-plugin so @fastify/view's reply.view decorator and
// @fastify/static's GET /static/* routes bubble up to the parent FastifyInstance.
// Without this, plugin-scoped encapsulation hides reply.view from the parent
// app and Tasks 3+/test handlers cannot call reply.view(...).
export const webViewPlugin = fp(webViewPluginImpl, {
  name: 'web-view-plugin',
  fastify: '5.x',
});
