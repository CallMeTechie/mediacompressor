import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { AdminUserFlashKey } from './admin-user-flash-keys.js';

/**
 * Plan 8d Task 4: POST /admin/users/:id -- HTML form-target that delegates
 * to the JSON-API PATCH /api/v1/admin/users/:id (Plan 7) via app.inject().
 *
 * preHandler order: [requireAdminSession, csrfProtection]
 *  - requireAdminSession runs first so missing/expired sessions short-
 *    circuit to /login (303) and non-admins get 403 BEFORE the CSRF token
 *    is consulted. C4-AD-PR clarified WC-AD8: a valid admin session WITHOUT
 *    a _csrf body field MUST yield 403 (csrfProtection runs after requireAdmin).
 *
 * Rev. 2.2: `_csrf` is NOT in `schema.body` -- fastify-type-provider-zod's
 * validatorCompiler strips unknown fields BEFORE csrfProtection's preHandler
 * runs, so the body would arrive at csrfProtection without _csrf. We instead
 * keep `schema` to params-only and manually safeParse the body inside the
 * handler (mirrors Plan 8c's api-key-create-route.ts).
 *
 * BigInt-safety (C6-AD-PR): the audit-log payload uses `patchForJson` (where
 * storageQuota is a string), NOT `patch` (where it's a BigInt). Pino v8
 * throws TypeError("Do not know how to serialize a BigInt") on raw BigInts;
 * mirrors Plan-8b's jobs-events-route fix.
 *
 * Inner-status mapping:
 *  - 200 / 204 -> 303 /admin/users?updateflash=updated      (success)
 *  - 400       -> 400 HTML edit-form re-render with error   (BFF/inner drift)
 *  - 401       -> clearCookie + 303 /login                  (session race)
 *  - 403       -> 303 /admin/users/:id?updateflash=csrf-stale (CSRF rotation)
 *  - 404       -> 404 HTML
 *  - else      -> 500 HTML
 *
 * fp-wrap rule: this plugin does NOT decorate anything -> NOT fp-wrapped.
 */

const Params = z.object({ id: z.string().uuid() });

// IMPORTANT (Rev. 2.2): UpdateForm is NOT placed in `schema.body`.
// fastify-type-provider-zod's validatorCompiler strips unknown fields BEFORE
// csrfProtection's preHandler sees them, dropping `_csrf`. We safeParse the
// body manually below.
const UpdateForm = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  storageQuota: z.coerce.bigint().min(0n).optional(),
  parallelQuota: z.coerce.number().int().min(1).max(100).optional(),
  hourlyQuota: z.coerce.number().int().min(1).max(1000).optional(),
  _csrf: z.string().min(1),
});

export const adminUserUpdateRoutePlugin: FastifyPluginAsync = async (app) => {
  const { prisma } = app.deps;

  app.post(
    '/admin/users/:id',
    {
      preHandler: [app.requireAdminSession, app.csrfProtection],
      schema: { params: Params }, // body NOT here per Rev. 2.2
    },
    async (req, reply) => {
      const { id } = req.params as z.infer<typeof Params>;
      const parsed = UpdateForm.safeParse(req.body);
      if (!parsed.success) {
        // Concern #5: re-fetch user for re-render so the form shows current
        // DB values rather than the user's submitted (invalid) values. Adds
        // one DB roundtrip per malformed POST -- acceptable for this admin-
        // only path; not a public endpoint.
        const user = await prisma.user.findUnique({
          where: { id },
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            storageQuota: true,
            parallelQuota: true,
            hourlyQuota: true,
          },
        });
        if (!user) {
          return reply.code(404).view('404', { title: 'Not found', path: req.url });
        }
        return reply.code(400).view('admin-user-edit', {
          title: app.i18n.t('page_title_edit_user', { lng: req.locale, ns: 'admin' }),
          flash: {
            level: 'error',
            message: app.i18n.t('flash_invalid_input', { lng: req.locale, ns: 'admin' }),
          },
          user: {
            ...user,
            storageQuota: user.storageQuota.toString(),
          },
          _csrfField: reply.renderCsrfField(),
        });
      }

      const { _csrf, ...patch } = parsed.data;

      // C6-AD-PR + concern #6: BigInt -> string for inner JSON payload AND
      // audit-log. Plan-7's PatchBody uses z.coerce.bigint(), which accepts
      // numeric strings. JSON has no BigInt literal anyway. Explicit type
      // (instead of Record<string, unknown>) keeps the status / parallel /
      // hourly union narrow downstream (logger + inject payload).
      type PatchForJson = Omit<
        z.infer<typeof UpdateForm>,
        '_csrf' | 'storageQuota'
      > & {
        storageQuota?: string;
      };
      const patchForJson: PatchForJson = {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.storageQuota !== undefined
          ? { storageQuota: patch.storageQuota.toString() }
          : {}),
        ...(patch.parallelQuota !== undefined
          ? { parallelQuota: patch.parallelQuota }
          : {}),
        ...(patch.hourlyQuota !== undefined
          ? { hourlyQuota: patch.hourlyQuota }
          : {}),
      };

      // Forward CSRF: header takes precedence over body (matches the global
      // getToken-shim wired in server.ts). Concern #4: fall-through ternary
      // is equivalent to the previous `(... ?? undefined) ?? _csrf` and reads
      // cleaner.
      const headerToken = req.headers['x-csrf-token'];
      const csrfToken = typeof headerToken === 'string' ? headerToken : _csrf;

      const inner = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${id}`,
        headers: {
          'content-type': 'application/json',
          cookie: req.headers.cookie ?? '',
          'x-csrf-token': csrfToken,
        },
        payload: JSON.stringify(patchForJson),
      });

      if (inner.statusCode === 200 || inner.statusCode === 204) {
        // C5-AD-PR: audit-log scaffolding for admin state-changes. Plan 10
        // replaces this with a dedicated AuditEvent table. Until then, Pino
        // stdout-line is the source of truth for who-changed-what.
        // C6-AD-PR: log patchForJson (string-converted), NOT patch (BigInt) --
        // Pino v8 throws on BigInt, mirrors Plan-8b jobs-events-route fix.
        app.log.info(
          {
            adminId: req.auth!.userId,
            action: 'user_update',
            targetUserId: id,
            patch: patchForJson,
          },
          'admin action',
        );
        const successKey: AdminUserFlashKey = 'updated';
        return reply
          .code(303)
          .header('location', `/admin/users?updateflash=${successKey}`)
          .send();
      }
      if (inner.statusCode === 400) {
        // Concern #1: BFF UpdateForm and Plan-7 PatchBody bounds match today
        // so this branch is unreachable in production. If they ever drift,
        // re-render the edit-form with the inner's error message instead of
        // a generic 500. Defensive parse: inner body might not be JSON.
        let innerErrorMessage: string | undefined;
        try {
          const payload = inner.json() as
            | { error?: { message?: unknown } }
            | undefined;
          if (typeof payload?.error?.message === 'string') {
            innerErrorMessage = payload.error.message;
          }
        } catch {
          // Inner body wasn't JSON; fall through to translated default.
        }
        const user = await prisma.user.findUnique({
          where: { id },
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            storageQuota: true,
            parallelQuota: true,
            hourlyQuota: true,
          },
        });
        if (!user) {
          return reply.code(404).view('404', { title: 'Not found', path: req.url });
        }
        return reply.code(400).view('admin-user-edit', {
          title: app.i18n.t('page_title_edit_user', { lng: req.locale, ns: 'admin' }),
          flash: {
            level: 'error',
            message:
              innerErrorMessage ??
              app.i18n.t('flash_invalid_input', { lng: req.locale, ns: 'admin' }),
          },
          user: {
            ...user,
            // Re-render with submitted values so the admin doesn't lose typed
            // input. patchForJson holds the (already-validated-by-BFF) values.
            status: patchForJson.status ?? user.status,
            storageQuota:
              patchForJson.storageQuota ?? user.storageQuota.toString(),
            parallelQuota: patchForJson.parallelQuota ?? user.parallelQuota,
            hourlyQuota: patchForJson.hourlyQuota ?? user.hourlyQuota,
          },
          _csrfField: reply.renderCsrfField(),
        });
      }
      if (inner.statusCode === 401) {
        reply.clearCookie('mc_session', { path: '/' });
        return reply.code(303).header('location', '/login').send();
      }
      if (inner.statusCode === 403) {
        // Concern #2: redirect to the EDIT-form (not the list) so the admin
        // can retry the update against the rotated CSRF token without losing
        // their place. Mirrors the api-key-create precedent.
        //
        // Open-redirect defense-in-depth: `id` is already a zod-validated
        // UUID (Params.id = z.string().uuid()), so it cannot contain `/`,
        // `?`, `#`, or `\`. The explicit regex re-check below makes that
        // invariant local-and-obvious so static analyzers don't have to
        // trace the value back through the schema.
        if (!/^[0-9a-f-]{36}$/i.test(id)) {
          return reply.code(404).view('404', { title: 'Not found', path: req.url });
        }
        const csrfStaleKey: AdminUserFlashKey = 'csrf-stale';
        const safeLocation = '/admin/users/' + id + '?updateflash=' + csrfStaleKey;
        return reply.code(303).header('location', safeLocation).send();
      }
      if (inner.statusCode === 404) {
        return reply.code(404).view('404', { title: 'Not found', path: req.url });
      }
      return reply.code(inner.statusCode).view('500', { title: 'Update failed' });
    },
  );
};
