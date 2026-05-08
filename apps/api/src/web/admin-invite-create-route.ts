import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Plan 8d Task 5: POST /admin/invites -- HTML form-target that delegates to
 * the JSON-API POST /api/v1/admin/invites (Plan 7) via app.inject() and
 * captures the inner 201 response's `token` field for one-time-reveal.
 *
 * One-time-reveal (mirrors Plan-8c api-key-create-route.ts pattern):
 *  - Inner returns the raw invite token in the 201 body. We render
 *    `admin-invite-created.hbs` DIRECTLY (no redirect -- a redirect would
 *    drop the token into the browser-history URL or lose it entirely) with
 *    `Cache-Control: no-store, max-age=0`. C1-PR + C7-PR + C9-PR (no
 *    Pragma:no-cache -- HTTP/1.0 Request-only header).
 *
 * preHandler order: [requireAdminSession, csrfProtection]
 *  - requireAdminSession runs first so missing/expired sessions short-
 *    circuit to /login (303) and non-admins get 403 BEFORE the CSRF token
 *    is consulted (WC-AD8 / C4-AD-PR).
 *
 * Rev. 2.2: `_csrf` is NOT in `schema.body` -- fastify-type-provider-zod's
 * validatorCompiler strips unknown fields BEFORE csrfProtection's preHandler
 * runs. We safeParse the body manually below.
 *
 * C5-PR: audit-log on success uses a whitelist payload (`adminId`, `action`,
 * `inviteId`, `expiresAt`). The raw token is NEVER logged -- doing so
 * would defeat the one-time-reveal property.
 *
 * Inner-status mapping:
 *  - 201 -> render admin-invite-created.hbs directly with raw token (no-store)
 *  - 400 -> 400 HTML re-render of list with inner error message (defense-in-
 *           depth; CreateForm bounds match Plan-7 PostBody today)
 *  - 401 -> clearCookie + 303 /login                        (session race)
 *  - 403 -> 303 /admin/invites?updateflash=csrf-stale       (CSRF rotation)
 *  - else -> 500 HTML
 *
 * fp-wrap rule: this plugin does NOT decorate anything -> NOT fp-wrapped.
 */

// IMPORTANT (Rev. 2.2): CreateForm is NOT placed in `schema.body`.
// fastify-type-provider-zod's validatorCompiler strips unknown fields BEFORE
// csrfProtection's preHandler sees them, dropping `_csrf`. We safeParse the
// body manually inside the handler.
//
// `email` accepts a valid email OR an empty string (form input left blank ->
// browsers submit ""). The empty-string variant transforms to `undefined`
// so the inner JSON body omits the field (so Plan-7's email column gets SQL
// NULL rather than empty string).
const CreateForm = z.object({
  email: z
    .string()
    .email()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  expiresInHours: z.coerce.number().int().min(1).max(168).default(24),
  _csrf: z.string().min(1),
});

export const adminInviteCreateRoutePlugin: FastifyPluginAsync = async (app) => {
  app.post(
    '/admin/invites',
    {
      preHandler: [app.requireAdminSession, app.csrfProtection],
      // Body NOT in schema per Rev. 2.2.
    },
    async (req, reply) => {
      // C7-PR: render path always sets no-store -- even on error/re-render --
      // so a misroute, browser-back, or proxy-cache can never re-show a page
      // that contained the raw token even if validation rerouted us elsewhere.
      reply.header('cache-control', 'no-store, max-age=0');

      const parsed = CreateForm.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).view('admin-invites-list', {
          title: app.i18n.t('page_title_invites', { lng: req.locale }),
          invites: [],
          flash: {
            level: 'error',
            message: app.i18n.t('flash_invalid_input', { lng: req.locale }),
          },
          _csrfField: reply.renderCsrfField(),
        });
      }

      const { _csrf, ...payload } = parsed.data;

      // Forward CSRF: header takes precedence over body (matches the global
      // getToken-shim wired in server.ts).
      const headerToken = req.headers['x-csrf-token'];
      const csrfToken = typeof headerToken === 'string' ? headerToken : _csrf;

      const inner = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/invites',
        headers: {
          'content-type': 'application/json',
          cookie: req.headers.cookie ?? '',
          'x-csrf-token': csrfToken,
        },
        payload: JSON.stringify(payload),
      });

      if (inner.statusCode === 201) {
        const body = inner.json() as {
          id: string;
          email: string | null;
          expiresAt: string;
          token: string;
        };
        // C5-PR audit-log scaffolding for admin state-changes. Whitelist
        // payload only -- NEVER include `body.token` (raw one-time secret).
        // The `expiresAt` field is non-secret. Plan 10 replaces this with
        // a dedicated AuditEvent table.
        app.log.info(
          {
            adminId: req.auth!.userId,
            action: 'invite_create',
            inviteId: body.id,
            expiresAt: body.expiresAt,
          },
          'admin action',
        );
        // C1-PR/C2-PR/C7-PR: render created-page DIRECTLY with the raw token
        // and Cache-Control: no-store. NO redirect (would drop the token).
        return reply.view('admin-invite-created', {
          title: app.i18n.t('page_title_invite_created', { lng: req.locale }),
          invite: {
            id: body.id,
            email: body.email,
            expiresAt: body.expiresAt,
            token: body.token,
          },
        });
      }

      if (inner.statusCode === 401) {
        reply.clearCookie('mc_session', { path: '/' });
        return reply.code(303).header('location', '/login').send();
      }
      if (inner.statusCode === 403) {
        return reply
          .code(303)
          .header('location', '/admin/invites?updateflash=csrf-stale')
          .send();
      }
      if (inner.statusCode === 400) {
        // Defense-in-depth: re-render the list page with the inner's error
        // message. CreateForm bounds match Plan-7's PostBody today, so this
        // branch is unreachable in production. If they ever drift, surface
        // the inner error rather than a generic 500.
        let innerErrorMessage: string | undefined;
        try {
          const innerBody = inner.json() as
            | { error?: { message?: unknown } }
            | undefined;
          if (typeof innerBody?.error?.message === 'string') {
            innerErrorMessage = innerBody.error.message;
          }
        } catch {
          // Inner body wasn't JSON; fall through to translated default.
        }
        return reply.code(400).view('admin-invites-list', {
          title: app.i18n.t('page_title_invites', { lng: req.locale }),
          invites: [],
          flash: {
            level: 'error',
            message:
              innerErrorMessage ??
              app.i18n.t('flash_invalid_input', { lng: req.locale }),
          },
          _csrfField: reply.renderCsrfField(),
        });
      }
      return reply
        .code(inner.statusCode)
        .view('500', { title: 'Create invite failed' });
    },
  );
};
