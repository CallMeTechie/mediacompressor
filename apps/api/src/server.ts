import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import csrf from '@fastify/csrf-protection';
import helmet from '@fastify/helmet';
import httpProxy from '@fastify/http-proxy';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import IORedis, { type Redis } from 'ioredis';
import type { Config } from './config.js';
import { runPepperCanaryOnBoot } from './pepper-canary-hook.js';
import { loginRoutes } from './auth/login-routes.js';
import { registerAuthMiddleware } from './auth/auth-middleware.js';
import { registerAdminGuard } from './admin/role-guard.js';
import { adminUsersRoutes } from './admin/users-routes.js';
import { adminInvitesRoutes } from './admin/invites-routes.js';
import { adminStatsRoute } from './admin/stats-route.js';
import { apiKeyRoutes } from './auth/api-key-routes.js';
import { capabilitiesRoute } from './capabilities/capabilities-route.js';
import { jobsRoutes } from './jobs/jobs-routes.js';
import { jobsEventsRoute } from './jobs/jobs-events-route.js';
import { downloadRoute } from './jobs/download-route.js';
import { preCreateHook } from './uploads/pre-create-hook.js';
import { postFinishHook } from './uploads/post-finish-hook.js';
import { tusdHooksDispatcher } from './uploads/hooks-dispatcher.js';
import { openapiSpecPlugin, openapiUiPlugin } from './openapi/plugin.js';
import { webViewPlugin } from './web/view-plugin.js';
import { loginPagePlugin } from './web/login-page.js';
import { inviteRedeemPagePlugin } from './web/invite-redeem-page.js';
import { logoutRoutePlugin } from './web/logout-route.js';
import { errorPagesPlugin } from './web/error-pages.js';
import { requireSessionPlugin } from './web/require-session.js';
import { requireAdminSessionPlugin } from './web/require-admin-session.js';
import { dashboardPagePlugin } from './web/dashboard-page.js';
import { profilePagePlugin } from './web/profile-page.js';
import { sessionRevokeRoutePlugin } from './web/session-revoke-route.js';
import { apiKeysListPagePlugin } from './web/api-keys-list-page.js';
import { apiKeyCreateRoutePlugin } from './web/api-key-create-route.js';
import { apiKeyRevokeRoutePlugin } from './web/api-key-revoke-route.js';
import { jobListPagePlugin } from './web/job-list-page.js';
import { jobDetailPagePlugin } from './web/job-detail-page.js';
import { jobCancelRoutePlugin } from './web/job-cancel-route.js';
import { uploadWizardPagePlugin } from './web/upload-wizard-page.js';
import { i18nFastifyPlugin } from './web/i18n.js';
import { localeRoutePlugin } from './web/locale-route.js';
import { adminDashboardPagePlugin } from './web/admin-dashboard-page.js';
import { adminUsersListPagePlugin } from './web/admin-users-list-page.js';
import { adminUserEditPagePlugin } from './web/admin-user-edit-page.js';
import { adminUserUpdateRoutePlugin } from './web/admin-user-update-route.js';

export interface AppDeps {
  prisma: PrismaClient;
  redis: Redis;
  config: Config;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export async function buildServer(config: Config): Promise<FastifyInstance> {
  // WC1 + C1-Rev2: enable trustProxy so app.inject() (used by the BFF login
  // handler) can spoof x-forwarded-for AND so Plan 9's Caddy can forward the
  // real client IP. The list/preset passed to Fastify's trustProxy is
  // parameterised via config so dev (loopback only) and production
  // (loopback + caddy-subnet) can differ without code changes.
  // Multiple CIDRs come as a comma-separated string in env; Fastify accepts
  // either a single string preset, a single CIDR, OR a string[]. Split if
  // the value contains a comma.
  const trustProxyConfig: string | string[] = config.TRUSTED_PROXY_CIDR.includes(',')
    ? config.TRUSTED_PROXY_CIDR.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : config.TRUSTED_PROXY_CIDR;
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    disableRequestLogging: false,
    trustProxy: trustProxyConfig,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie, { secret: config.SESSION_SECRET });

  // C4: CORS für Web-UI Cross-Origin (Plan 8). credentials:true wegen Cookie-Auth.
  await app.register(cors, {
    origin: config.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
  });

  // C1: CSRF-Schutz für Cookie-Sessions. Routes mit Bearer-API-Key sind via
  // skipCsrf in der Auth-Middleware vom Plugin ausgenommen — kein implicit
  // credential = kein CSRF-Risiko. State-changing Cookie-Routes erfordern
  // X-CSRF-Token-Header (Double-Submit-Pattern).
  await app.register(csrf, {
    cookieKey: 'mc_csrf',
    cookieOpts: {
      signed: false,
      httpOnly: false,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    },
    // Plan 8a Task 1 Pre-Flight: extended for HTML form posts. The web BFF posts
    // application/x-www-form-urlencoded with a _csrf body field; legacy JSON/API-key
    // callers still pass the x-csrf-token header. Header takes precedence so existing
    // CSRF tests are unaffected.
    getToken: (req) => {
      const header = req.headers['x-csrf-token'];
      if (typeof header === 'string') return header;
      const body = req.body as Record<string, unknown> | undefined;
      if (body && typeof body._csrf === 'string') return body._csrf;
      return undefined;
    },
  });

  // Plan 8b Task 6: dev-side reverse proxy for tus-js-client browser uploads.
  // The Upload-Wizard's <script>/static/js/upload-wizard.js POSTs to a
  // *relative* /uploads/ endpoint (so the browser stays same-origin, cookies
  // and CSRF behave). tusd runs on a separate container (`tusd:1080` in
  // docker-compose.yml, base-path `/uploads/`); from the host or another
  // origin, the browser cannot reach it directly. We forward /uploads/* 1:1
  // to TUSD_UPSTREAM here.
  //
  // Plan 9 (Caddy) will front tusd on the public host and serve the same
  // `/uploads/*` path; this proxy is removable then. Kept here as a plain
  // env-var (NOT in config.ts) so test configs do not have to set it.
  //
  // Path-rewriting: docker-compose.yml's tusd command sets
  // `-base-path=/uploads/`, so the rewrite is the identity (`/uploads/*` →
  // upstream `/uploads/*`). Adjust `rewritePrefix` if that ever changes.
  const TUSD_UPSTREAM = process.env.TUSD_UPSTREAM ?? 'http://tusd:1080';
  await app.register(httpProxy, {
    upstream: TUSD_UPSTREAM,
    prefix: '/uploads',
    rewritePrefix: '/uploads',
    http2: false,
    // tus PATCHes carry `application/offset+octet-stream`. We need
    // @fastify/http-proxy's catch-all content-type parser registered (the
    // default when `proxyPayloads` is unset/true) so Fastify doesn't 415
    // on the chunk uploads. The catch-all parser is registered iff
    // `opts.proxyPayloads !== false` (see @fastify/http-proxy/index.js
    // ~line 253), so we leave it at the default.
    replyOptions: {
      // tusd's POST /uploads/ response has Location:
      // `http://tusd:1080/uploads/<id>` — that hostname is unreachable from
      // the browser. Rewrite it to a same-origin relative path so the
      // subsequent tus-js-client PATCH chunks come back through this proxy.
      // @fastify/http-proxy's built-in `internalRewriteLocationHeader` only
      // touches *relative* Location values; tusd builds absolute URLs, so we
      // override here.
      rewriteHeaders: (headers) => {
        const loc = headers.location;
        if (typeof loc === 'string') {
          try {
            const u = new URL(loc);
            if (u.pathname.startsWith('/uploads/')) {
              headers.location = u.pathname + u.search;
            }
          } catch {
            // not a URL; leave it.
          }
        }
        return headers;
      },
    },
  });

  const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
  const redis = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

  app.decorate('deps', { prisma, redis, config } satisfies AppDeps);

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  // Plan 4 Task 2: Pepper-Canary Boot-Self-Check
  await runPepperCanaryOnBoot(prisma, Buffer.from(config.API_KEY_PEPPER));

  // Plan 8a Task 1: register the web BFF view-plugin (Handlebars + static
  // assets + form-body parser + HTML CSP onSend hook). Mounted before the
  // route plugins so partials and reply.view are available to all later
  // route registrations.
  await app.register(webViewPlugin);

  // Plan 8d Task 2: i18n foundation. Registered AFTER webViewPlugin so the
  // view-plugin's `preHandler` reply.view-wrap can rely on `req.locale` being
  // populated by this plugin's `onRequest` hook (onRequest always fires before
  // preHandler in Fastify's lifecycle, regardless of plugin-registration
  // order, so this is order-robust). Also AFTER `csrf` (line ~97) so the
  // POST /locale route — registered later via localeRoutePlugin — can use
  // app.csrfProtection. Decorates `app.i18n` and `req.locale`.
  await app.register(i18nFastifyPlugin);

  // Plan 8b Task 1: requireSession decorator (HTML-aware session check that
  // 303s to /login on miss/expired/disabled). MUST be registered BEFORE any
  // plugin that reads `app.requireSession` — fp-wrapped (Rev. 2.3 rule) so
  // the decorator bubbles up to the parent FastifyInstance.
  await app.register(requireSessionPlugin);

  // Plan 8d Task 1: requireAdminSession decorator (HTML-aware admin-gate that
  // wraps requireSession + checks role==='admin' && status==='active'). On
  // valid-but-non-admin: renders 403 HTML (NOT 303 — non-admin user IS
  // authenticated, just lacks privileges). MUST be registered AFTER
  // requireSessionPlugin (it calls app.requireSession) and BEFORE any
  // admin-page plugin that reads `app.requireAdminSession` — fp-wrapped
  // (Rev. 2.3 rule).
  await app.register(requireAdminSessionPlugin);

  // Plan 7 Task 6: register @fastify/swagger BEFORE all documented routes —
  // its `onRoute` hook only collects metadata for routes registered after it.
  // The matching `openapiUiPlugin` is registered at the END of buildServer to
  // mount Swagger-UI and `GET /api/v1/openapi.json`.
  await app.register(openapiSpecPlugin);

  app.get('/api/v1/health', async () => ({ status: 'ok' }));

  app.get('/api/v1/ready', async () => {
    let db = false;
    let redisOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      /* keep false */
    }
    try {
      const pong = await Promise.race([
        redis.ping(),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      if (pong === 'PONG') redisOk = true;
    } catch {
      /* keep false */
    }
    return { status: db && redisOk ? 'ok' : 'degraded', db, redis: redisOk };
  });

  // Tasks 3–9 register hooks/routes here.
  await app.register(loginRoutes);

  // Plan 8a Task 3: GET /login + POST /login HTML page (BFF). Internally
  // delegates to /api/v1/auth/login via app.inject(), so registered AFTER
  // loginRoutes — although app.inject() is runtime-late-bound, keeping the
  // dependency-aware order makes the intent obvious.
  await app.register(loginPagePlugin);

  // Plan 8a Task 4: GET /invites/:token + POST /invites/:token HTML pages
  // (BFF). Atomic-claim via updateMany (WC3) + Argon2Semaphore (WC2) +
  // CSRF rotation (WC4) + revert-on-failure logging (C3-Rev2). Reads
  // invite tokens hashed with SESSION_SECRET (HMAC-SHA-256).
  await app.register(inviteRedeemPagePlugin);

  // Plan 8a Task 5: POST /logout HTML route (BFF). Clears mc_session +
  // mc_csrf cookies and the corresponding DB row, then 303 → /login.
  // Idempotent: missing session cookie still returns 303. CSRF-protected.
  await app.register(logoutRoutePlugin);

  // Plan 4 Task 5: Auth-Middleware (Session ODER API-Key). Must be registered
  // BEFORE Task-4 routes (API-Key-Routes) since they call app.requireAuth.
  registerAuthMiddleware(app);

  // Plan 7 Task 2 (AP1+AP5): Admin role-guard decorators. Registered AFTER
  // registerAuthMiddleware because requireAdmin/requireAdminCsrf delegate to
  // app.requireAuth and read req.auth.role/status (populated by resolveAuth).
  registerAdminGuard(app);

  // Plan 7 Task 3: Admin user-management routes. Registered AFTER
  // registerAdminGuard because the routes use app.requireAdmin /
  // app.requireAdminCsrf decorators.
  await app.register(adminUsersRoutes);

  // Plan 7 Task 4: Admin invite-management routes (POST/GET/DELETE
  // /admin/invites). Same registration ordering as adminUsersRoutes —
  // depends on registerAdminGuard for app.requireAdmin/requireAdminCsrf.
  await app.register(adminInvitesRoutes);

  // Plan 7 Task 5: Admin operational stats (GET /api/v1/admin/stats) —
  // users/jobs/storage/queue aggregates. Read-only GET; uses requireAdmin
  // (no CSRF, since GETs are not state-changing). Registered alongside the
  // other admin routes after registerAdminGuard.
  await app.register(adminStatsRoute);

  // Plan 4 Task 4: API-Key-Routes (CRUD for the authenticated user's keys).
  // Registered AFTER registerAuthMiddleware because it relies on
  // app.requireAuth / app.requireAuthCsrf decorators.
  await app.register(apiKeyRoutes);

  // Plan 7 Task 1: GET /api/v1/capabilities — discovery endpoint with anonymous
  // + authenticated subsets. Uses tryAuth (not requireAuth) so missing/invalid
  // auth falls through to anonymous (NOT 401).
  await app.register(capabilitiesRoute);

  // Plan 4 Task 6: POST /jobs stub + BullMQ producer (Outbox-Pattern).
  await app.register(jobsRoutes);

  // Plan 4 Task 9: GET /jobs/:id/events (SSE) — snapshot + Pub/Sub forwarding.
  await app.register(jobsEventsRoute);

  // Plan 6 Task 4: GET /jobs/:id/download — streams compressed output while
  // holding a download-handler in `downloads:<jobId>`. Cleanup-worker cannot
  // delete files under active downloads (C5 + C2-Rev4 + DC4).
  await app.register(downloadRoute);

  // Plan 5 Task 5: tusd Pre-Create-Hook
  // (POST /api/v1/internal/uploads/hooks/pre-create). Shared-secret +
  // Bearer-API-Key + UC7 MIME-allowlist + atomic quota reservation.
  await app.register(preCreateHook);

  // Plan 5 Task 6: tusd Post-Finish-Hook
  // (POST /api/v1/internal/uploads/hooks/post-finish). Shared-secret +
  // file-move (rename, EXDEV-fallback) + magic-number-check + atomic
  // status-transition uploading→queued + BullMQ-Enqueue (UC4/UC6).
  await app.register(postFinishHook);

  // Plan 5 Task 8: tusd HTTP-Hook dispatcher (POST /api/v1/internal/uploads/hooks).
  // tusd posts ALL events to a single URL; this thin route fans out by
  // body.Type to the per-Type routes registered above. Must run AFTER both
  // per-Type plugins so the in-process app.inject() sees them.
  await app.register(tusdHooksDispatcher);

  // Plan 7 Task 6: Swagger-UI + GET /api/v1/openapi.json. MUST be registered
  // LAST — pairs with openapiSpecPlugin (registered early); openapiSpecPlugin
  // installed swagger's onRoute hook so every route registered above this
  // line is now in the spec. Exposes /api/v1/openapi.json + /api/v1/docs.
  await app.register(openapiUiPlugin);

  // Plan 8b Task 1: dashboard page (GET /). Registered BEFORE errorPagesPlugin
  // so the dashboard's `/` route is matched before the catch-all 404. Uses
  // app.requireSession internally (manual invocation, not a preHandler) so
  // the non-HTML JSON branch can return {status:'ok'} without auth.
  await app.register(dashboardPagePlugin);

  // Plan 8c Task 1: GET /profile — email + quota summary + active-sessions
  // list (current session highlighted via tokenHash equality so the user
  // can't accidentally revoke the cookie in use). Registered AFTER
  // dashboardPagePlugin (which owns `/`) and BEFORE errorPagesPlugin (the
  // catch-all 404). preHandler: app.requireSession → unauthenticated GETs
  // 303 to /login. Cache-Control: no-store, max-age=0 (post-login HTML
  // carries user-bound data).
  await app.register(profilePagePlugin);

  // Plan 8c Task 2: POST /profile/sessions/:id/revoke — revoke a specific
  // session by deleting the row. Refuses to delete the CURRENT session
  // (that flow is /logout). CSRF-protected. Owner-checked. WC-PR6 uses
  // crypto.timingSafeEqual for the current-session compare. Registered
  // AFTER profilePagePlugin (which renders the form) and BEFORE
  // errorPagesPlugin (the catch-all 404).
  await app.register(sessionRevokeRoutePlugin);

  // Plan 8c Task 3: GET /profile/api-keys — lists the authenticated user's
  // NON-revoked API keys (id, name, keyPrefix, scopes, createdAt, lastUsedAt).
  // The raw key is NEVER exposed here — only shown ONCE during create
  // (Task 4). Revoked keys are EXCLUDED via the `revokedAt: null` filter.
  // Registered AFTER sessionRevokeRoutePlugin (which owns the session-revoke
  // form posted from /profile) and BEFORE errorPagesPlugin (the catch-all
  // 404). preHandler: app.requireSession → unauthenticated GETs 303 to
  // /login. Cache-Control: no-store, max-age=0.
  await app.register(apiKeysListPagePlugin);

  // Plan 8c Task 4: GET /profile/api-keys/new + POST /profile/api-keys —
  // create form + one-time-reveal flow. Forwards to inner /api/v1/users/me/
  // api-keys via app.inject() and renders the raw key directly with
  // Cache-Control:no-store (C1-PR). Registered AFTER apiKeysListPagePlugin
  // (which owns the list this form is reached from) and BEFORE
  // errorPagesPlugin (the catch-all 404).
  await app.register(apiKeyCreateRoutePlugin);

  // Plan 8c Task 4: POST /profile/api-keys/:id/revoke — HTML form-target
  // that delegates to the JSON-API DELETE /api/v1/users/me/api-keys/:id via
  // app.inject(). Translates inner statuses into 303 redirects with flash
  // hints. Registered AFTER apiKeyCreateRoutePlugin and BEFORE
  // errorPagesPlugin (the catch-all 404).
  await app.register(apiKeyRevokeRoutePlugin);

  // Plan 8b Task 2: GET /jobs HTML list page with HTMX polling. Registered
  // AFTER dashboardPagePlugin (which owns `/`) and BEFORE errorPagesPlugin
  // (which is the catch-all 404). Uses `app.requireSession` as a preHandler
  // so unauthenticated requests 303 to /login.
  await app.register(jobListPagePlugin);

  // Plan 8b Task 3: GET /jobs/:id HTML detail page (status, profile, cancel
  // form, download link) + view-time errorMessage redaction (C1-LI).
  // Cancel-form posts to /jobs/:id/cancel below.
  await app.register(jobDetailPagePlugin);

  // Plan 8b Task 3: POST /jobs/:id/cancel — form-target that delegates to
  // DELETE /api/v1/jobs/:id via app.inject(). Differentiates inner 401 (true
  // session-race → /login + clearCookie, C2-LI) from 403 (CSRF stale →
  // /jobs/:id?cancelflash=csrf-stale, mc_session preserved, C6-LI). Must be
  // registered AFTER jobsRoutes (which owns DELETE /api/v1/jobs/:id) so the
  // in-process app.inject() finds it.
  await app.register(jobCancelRoutePlugin);

  // Plan 8b Task 5: GET /upload — resumable-upload wizard. Renders a
  // Handlebars form whose submit is hijacked client-side by tus-js-client
  // (vendored at /static/vendor/tus.min.js) to upload to /uploads/ (tusd).
  // <noscript>+<style>#upload-form{display:none} hides the form when JS is
  // disabled (C7-LI), pointing the user at the JSON API docs instead.
  await app.register(uploadWizardPagePlugin);

  // Plan 8d Task 2: POST /locale — locale-switcher endpoint. Sets the
  // mc_locale cookie and 303s back to a `redirectTo` body field validated
  // against an own-origin allowlist (WC-AD2). Registered AFTER
  // i18nFastifyPlugin (uses SUPPORTED_LOCALES) and BEFORE errorPagesPlugin
  // (the catch-all 404). Uses app.csrfProtection — registered globally near
  // the top of buildServer.
  await app.register(localeRoutePlugin);

  // Plan 8d Task 3: GET /admin -- admin landing page. Renders nav-links to
  // /admin/users, /admin/invites, /admin/stats plus the locale-switcher form
  // (C3-AD-PR + C7-AD-PR). preHandler: app.requireAdminSession (303 unauth,
  // 403 non-admin). Cache-Control: no-store, max-age=0. Registered AFTER
  // requireAdminSessionPlugin (uses app.requireAdminSession), AFTER
  // i18nFastifyPlugin (uses app.i18n + req.locale), and BEFORE
  // errorPagesPlugin (the catch-all 404). NOT fp-wrapped (no decorators).
  await app.register(adminDashboardPagePlugin);

  // Plan 8d Task 4: GET /admin/users -- paginated user list. Forwards to
  // inner GET /api/v1/admin/users via app.inject(). preHandler:
  // app.requireAdminSession (303 unauth, 403 non-admin). Cache-Control:
  // no-store, max-age=0. Registered AFTER adminDashboardPagePlugin (sibling
  // ordering) and BEFORE errorPagesPlugin (the catch-all 404). NOT fp-wrapped
  // (no decorators).
  await app.register(adminUsersListPagePlugin);

  // Plan 8d Task 4: GET /admin/users/:id -- edit-form for a single user.
  // Reads user via Prisma directly (Plan-7 admin JSON-API has no single-user
  // GET). preHandler: app.requireAdminSession. Cache-Control: no-store.
  await app.register(adminUserEditPagePlugin);

  // Plan 8d Task 4: POST /admin/users/:id -- delegates to inner
  // PATCH /api/v1/admin/users/:id via app.inject(). preHandler chain
  // [requireAdminSession, csrfProtection]. Rev. 2.2 manual safeParse for
  // _csrf body field. C5/C6-AD-PR audit-log via app.log.info on success
  // (BigInt-safe via patchForJson).
  await app.register(adminUserUpdateRoutePlugin);

  // Plan 8a Task 6: Accept-aware 404/500 (BFF). MUST be registered LAST so
  // the catch-all setNotFoundHandler doesn't shadow real routes registered
  // above. wantsHtml(req) excludes /api/* and /static/* prefixes so existing
  // JSON-API 404 tests (and asset 404s) keep returning JSON instead of HTML.
  // Plan 8b Task 1: GET / no longer registered here — owned by dashboardPagePlugin.
  await app.register(errorPagesPlugin);

  return app;
}
