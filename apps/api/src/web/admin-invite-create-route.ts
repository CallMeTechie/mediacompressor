import { z } from 'zod';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  buildInvitesViewModel,
  type InviteRowApi,
  type InviteRowView,
} from './admin-invites-list-page.js';

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

/**
 * Concern #2: Zod-validate the inner 201 response shape rather than blindly
 * casting. Detects contract drift early (e.g. Plan-7 silently renaming
 * `token` → `inviteToken` would otherwise produce an empty `<code>` element
 * with no error visible to the admin). On mismatch we log + 500.
 *
 * `token: z.string().min(20)` — Plan-7's invite tokens are 64-char hex; 20
 * is a comfortable lower bound. `email: z.string().nullable()` covers the
 * Concern #4 cast (subsumed here).
 */
const InnerCreateResponse = z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  expiresAt: z.string(),
  token: z.string().min(20),
});

/**
 * Concern #6: re-fetch invites for the 400-rerender branches so the list
 * isn't replaced with an empty table. Mirrors Task-4's update-route pattern
 * (which re-fetches the user). DRY shape via the shared `buildInvitesViewModel`
 * exported from admin-invites-list-page.ts.
 *
 * If the inner GET fails, fall back to an empty list rather than masking the
 * primary 400 error with a secondary 5xx.
 */
async function fetchInvitesForRerender(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<InviteRowView[]> {
  const inner = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/invites',
    headers: { cookie: req.headers.cookie ?? '' },
  });
  if (inner.statusCode !== 200) return [];
  try {
    const data = inner.json() as { items: InviteRowApi[] };
    return buildInvitesViewModel(data.items, Date.now());
  } catch {
    return [];
  }
}

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
        // Concern #6: re-fetch invites so the rerendered list is not empty.
        const invites = await fetchInvitesForRerender(app, req);
        return reply.code(400).view('admin-invites-list', {
          title: app.i18n.t('page_title_invites', { lng: req.locale, ns: 'admin' }),
          invites,
          flash: {
            level: 'error',
            message: app.i18n.t('flash_invalid_input', { lng: req.locale, ns: 'admin' }),
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
        // Concern #2 (subsumes #4): Zod-validate the inner 201 shape rather
        // than blindly casting. Catches contract drift between Plan-7's
        // /api/v1/admin/invites POST response and this BFF (e.g. silent
        // rename of `token` -> `inviteToken`). On mismatch: 500 + error log.
        let parsedJson: unknown;
        try {
          parsedJson = inner.json();
        } catch {
          parsedJson = null;
        }
        const inner201 = InnerCreateResponse.safeParse(parsedJson);
        if (!inner201.success) {
          app.log.error(
            {
              adminId: req.auth!.userId,
              action: 'invite_create',
              innerError: inner201.error.message,
            },
            'inner-201 response shape mismatch — possible contract drift',
          );
          return reply
            .code(500)
            .view('500', { title: 'Create invite failed' });
        }
        const body = inner201.data;
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
          title: app.i18n.t('page_title_invite_created', { lng: req.locale, ns: 'admin' }),
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
        // Concern #6: re-fetch invites so the rerendered list is not empty.
        const invites = await fetchInvitesForRerender(app, req);
        return reply.code(400).view('admin-invites-list', {
          title: app.i18n.t('page_title_invites', { lng: req.locale, ns: 'admin' }),
          invites,
          flash: {
            level: 'error',
            message:
              innerErrorMessage ??
              app.i18n.t('flash_invalid_input', { lng: req.locale, ns: 'admin' }),
          },
          _csrfField: reply.renderCsrfField(),
        });
      }
      // Concern #5: unexpected inner status — coerce to literal 500 + warn
      // log. Avoids surfacing inner status codes (e.g. 502, 200) directly
      // to the admin while showing the generic 500 view.
      app.log.warn(
        {
          adminId: req.auth!.userId,
          action: 'invite_create',
          innerStatus: inner.statusCode,
        },
        'unexpected inner status from /api/v1/admin/invites',
      );
      return reply.code(500).view('500', { title: 'Create invite failed' });
    },
  );
};
