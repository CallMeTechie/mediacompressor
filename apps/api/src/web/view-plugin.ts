import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import fp from 'fastify-plugin';
import view from '@fastify/view';
import staticPlugin from '@fastify/static';
import formbody from '@fastify/formbody';
import handlebars from 'handlebars';
import { csrfHelperPlugin } from './csrf-helper.js';
import { CLIENT_I18N_KEYS } from './i18n-client-keys.js';
import { DEFAULT_LOCALE } from './i18n.js';

/**
 * Plan 8e Task 2 (code-review concern #7): security-relevant projection of
 * `req.auth` to the layout-base view-context. Hoisted to module-scope so the
 * whitelist of fields exposed to Handlebars templates is auditable in one
 * place — the view-wrap site below MUST go through this function rather than
 * spreading `req.auth` directly. Adding a new field here is a deliberate
 * decision, not an accidental leak (e.g. exposing `userId` would let any
 * `<a href="...">` template construct user-enumerating URLs from the layout).
 *
 * Returns null for unauthenticated requests so `{{#if currentUser}}` in
 * `layouts/base.hbs` cleanly hides the authed nav-chrome.
 */
type CurrentUserView = { role: 'user' | 'admin'; status: 'active' | 'disabled' } | null;

function safeCurrentUser(auth: FastifyRequest['auth']): CurrentUserView {
  if (!auth) return null;
  return { role: auth.role, status: auth.status };
}

/**
 * Plan 8f Task 4 (Rev. 2 WC-i18n-f4 + Rev. 2 WC-i18n-f8 + Rev. 2.1 WC-i18n-f20):
 * Resolve every entry in `CLIENT_I18N_KEYS` against the per-request locale
 * and return a flat `{ key: translated-string }` map. The map is serialized
 * via the `{{{json}}}` Handlebars-helper into the `<meta name="mc-i18n"
 * content='...'>` attribute that `i18n-bridge.js` reads at page-load.
 *
 * Locale resolution: `req.locale` is set by the `i18nFastifyPlugin`
 * onRequest-hook, which runs BEFORE this preHandler-wrap. If — through some
 * future plugin-load-order regression — `req.locale` is undefined, fall
 * back to `DEFAULT_LOCALE` rather than crash; matches the same defense in
 * `req.t(...)` (i18n.ts).
 *
 * Only server-resolved translation strings flow through this map — no
 * user-input ever reaches `_clientI18n`. The `json`-helper additionally
 * HTML-attribute-encodes the payload (Rev. 2.1 WC-i18n-f15) so unusual
 * locale-string content (apostrophe, ampersand, double-quote) survives
 * `<meta content='...'>` round-tripping.
 */
function buildClientI18n(
  req: FastifyRequest,
  app: FastifyInstance,
): Record<string, string> {
  const lng = req.locale ?? DEFAULT_LOCALE;
  const out: Record<string, string> = {};
  for (const { ns, key } of CLIENT_I18N_KEYS) {
    out[key] = app.i18n.t(key, { lng, ns }) as string;
  }
  return out;
}

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

  // Plan 8d Task 2: per-request wrap of reply.view + reply.viewFragment to
  // inject `_locale: req.locale` into every render's data bag. The Handlebars
  // `{{t 'key'}}` helper (registered in i18n.ts) reads `_locale` from
  // `@root._locale` first (C1-AD-PR), so this single injection cascades into
  // every partial and {{#each}}-iteration. The i18n plugin's `onRequest` hook
  // sets `req.locale` BEFORE preHandler fires (onRequest precedes preHandler in
  // the lifecycle), so the wrap always sees a valid locale (cookie >
  // Accept-Language > 'en').
  //
  // Plan 8e Task 2: also inject `currentUser` (derived from `req.auth`) and
  // `_csrfField` (when authed) so the shared `layouts/base.hbs` nav can
  // render the logged-in chrome (jobs/profile/admin links + logout button)
  // without every page-handler having to thread these props manually. Both
  // are injected with handler-data-wins semantics (spread `data` AFTER the
  // defaults) so a handler that already passes `currentUser` / `_csrfField`
  // overrides the defaults — no breakage of pre-existing call-sites.
  //
  // `req.auth` is populated by `requireSession` / `requireAuth` preHandlers
  // that run AFTER this hook (preHandler order = registration order, and
  // webViewPlugin registers BEFORE the auth plugins in server.ts). Reading
  // `req.auth` lazily INSIDE the wrapped reply.view (not at preHandler-time)
  // means the read happens at handler-render-time, by which point auth
  // preHandlers have run for protected routes. For unauthenticated routes
  // (404, /login), `req.auth` stays undefined and `currentUser` resolves to
  // null — the layout's `{{#if currentUser}}` guard hides the nav.
  //
  // Wrapping in a preHandler — rather than at decorateReply-time — means the
  // wrap is per-FastifyReply instance, not shared globally; concurrent
  // requests don't clobber each other's `_locale`.
  app.addHook('preHandler', async (req, reply) => {
    const origView = reply.view.bind(reply);
    reply.view = ((template: string, data?: Record<string, unknown>, opts?: object) => {
      // Concern #7 (Plan 8e Task 2 review): projection goes through the
      // module-scope `safeCurrentUser` whitelist, NOT a literal `{role, status}`
      // spread, so adding a sensitive field to `req.auth` (e.g. an `email` or
      // `userId`) does not silently surface in every Handlebars template.
      const currentUser = safeCurrentUser(req.auth);
      // Concern #3 (Plan 8e Task 2 review): the CSRF token is generated FRESH
      // per authed render — not per session — so it rotates on every page-view.
      // Cost: one HMAC per authed GET (renderCsrfField is HMAC-only, no DB).
      // Benefit: strong replay-attack resistance for every state-changing form
      // on the rendered page (logout, locale-switch, session-revoke, etc.) —
      // a leaked token from one page-render is invalid for the next.
      // Logged-out pages (404, 500, /login) skip generation so they don't set
      // an mc_csrf cookie unnecessarily on every error/login page-load.
      const csrfDefault = req.auth ? reply.renderCsrfField() : '';
      // Plan 8f Task 4 (Rev. 2 WC-i18n-f8): per-render projection of the
      // server-resolved client-i18n key-set. Computed lazily here (not at
      // hook-time) so reads of `app.i18n` happen against the parent-scope
      // FastifyInstance after every plugin has registered. Injected into
      // every page-render so layouts/base.hbs's <meta name="mc-i18n"> tag
      // always carries a valid JSON payload.
      const clientI18n = buildClientI18n(req, app);
      return origView(
        template,
        {
          currentUser,
          _csrfField: csrfDefault,
          ...(data ?? {}),
          // _locale and _clientI18n are injected LAST so handler-passed
          // overrides cannot break the canonical per-request locale
          // (Plan 8d invariant) or smuggle attacker-controlled JSON into
          // the <meta name="mc-i18n"> bootstrap.
          _locale: req.locale,
          _clientI18n: clientI18n,
        },
        opts,
      );
    }) as typeof reply.view;
    if (typeof reply.viewFragment === 'function') {
      const origFragment = reply.viewFragment.bind(reply);
      reply.viewFragment = ((template: string, data?: Record<string, unknown>) => {
        // Fragments are HTMX swap-targets that don't render the layout's
        // nav, so currentUser/_csrfField aren't needed — keep the fragment
        // wrap minimal to avoid generating CSRF cookies on every poll.
        return origFragment(template, { ...(data ?? {}), _locale: req.locale });
      }) as typeof reply.viewFragment;
    }
  });
};

// Wrap with fastify-plugin so @fastify/view's reply.view decorator and
// @fastify/static's GET /static/* routes bubble up to the parent FastifyInstance.
// Without this, plugin-scoped encapsulation hides reply.view from the parent
// app and Tasks 3+/test handlers cannot call reply.view(...).
export const webViewPlugin = fp(webViewPluginImpl, {
  name: 'web-view-plugin',
  fastify: '5.x',
});
