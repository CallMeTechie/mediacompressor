import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Plan 8c Task 4: GET /profile/api-keys/new + POST /profile/api-keys.
 *
 * The form's only user-facing field is `name`. The Plan-4 inner JSON route
 * (POST /api/v1/users/me/api-keys, see apps/api/src/auth/api-key-routes.ts)
 * IGNORES any `scopes` value and hardcodes `['jobs:write', 'jobs:read']`
 * server-side, so we don't expose scope-checkboxes to the user (Pre-Flight
 * finding). The form just renders a hint of which scopes the key will get.
 *
 * One-time-reveal: POST forwards to the inner JSON route via app.inject(),
 * captures the response's `key` field, and renders `api-key-created.hbs`
 * directly with the raw key in the body. The user sees the raw key ONCE on
 * this single render — subsequent navigation to /profile/api-keys (the list)
 * shows only the prefix. C1-PR: this response carries Cache-Control:no-store
 * to prevent browser-cache / corporate-proxy / browser-back-after-logout
 * leak of the raw key. C9-PR Round-2: Pragma:no-cache intentionally NOT set
 * (HTTP/1.0 Request-only, ignored on responses, false-signal).
 *
 * Inner-status mapping:
 * - 201 → render api-key-created.hbs with raw key (single render)
 * - 401 → clearCookie + 303 /login (session-race / multi-tab logout)
 * - 403 → 303 /profile/api-keys/new?createflash=csrf-stale (CSRF rotation
 *         race; mc_session preserved so user can retry without re-login)
 * - else → re-render the form with a generic flash-error
 *
 * fp-wrap rule (Rev. 2.3): this plugin does NOT decorate anything → does NOT
 * need fp(). It only registers two routes.
 */

const CreateForm = z.object({
  name: z.string().min(1).max(64),
  _csrf: z.string().min(1),
});

const CreateQuery = z.object({
  createflash: z.string().optional(),
});

// Allowlist for createflash. Map (not Record) to avoid
// security/detect-object-injection lint warnings. Values outside the map →
// flash null (C3-PR allowlist gate, prevents URL-injection of arbitrary
// flash text).
const CREATE_FLASH_MAP = new Map<string, { level: 'error' | 'info'; message: string }>([
  [
    'csrf-stale',
    {
      level: 'error',
      message: 'Your session token had to be refreshed. Please try again.',
    },
  ],
]);

export const apiKeyCreateRoutePlugin: FastifyPluginAsync = async (app) => {
  app.get(
    '/profile/api-keys/new',
    { preHandler: app.requireSession, schema: { querystring: CreateQuery } },
    async (req, reply) => {
      reply.header('cache-control', 'no-store, max-age=0');
      const { createflash } = req.query as z.infer<typeof CreateQuery>;
      const flash = createflash ? (CREATE_FLASH_MAP.get(createflash) ?? null) : null;
      return reply.view('api-key-form', {
        title: 'Create API key',
        _csrfField: reply.renderCsrfField(),
        flash,
      });
    },
  );

  app.post(
    '/profile/api-keys',
    {
      preHandler: [app.requireSession, app.csrfProtection],
      // No `schema.body` — application/x-www-form-urlencoded is parsed into
      // an untyped record by @fastify/formbody, and we manually validate
      // via Zod below so we can re-render the form on validation errors.
    },
    async (req, reply) => {
      const parsed = CreateForm.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).view('api-key-form', {
          title: 'Create API key',
          flash: { level: 'error', message: 'Name is required (1–64 chars).' },
          _csrfField: reply.renderCsrfField(),
        });
      }
      const { name } = parsed.data;

      // WC-PL3: forward the CSRF token correctly. The form may submit via
      // body-_csrf OR x-csrf-token header; the inner JSON route reads via
      // the same getToken-shim Plan 8a wired into the plugin config.
      const headerToken = req.headers['x-csrf-token'];
      const csrfToken =
        (typeof headerToken === 'string' ? headerToken : undefined) ?? parsed.data._csrf;

      const inner = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/api-keys',
        headers: {
          'content-type': 'application/json',
          cookie: req.headers.cookie ?? '',
          'x-csrf-token': csrfToken,
        },
        payload: JSON.stringify({ name }),
      });

      // Multi-tab logout race: inner session truly expired/revoked.
      if (inner.statusCode === 401) {
        reply.clearCookie('mc_session', { path: '/' });
        return reply.code(303).header('location', '/login').send();
      }
      // CSRF rotation race: session still valid, just stale token.
      // mc_session preserved.
      if (inner.statusCode === 403) {
        return reply
          .code(303)
          .header('location', '/profile/api-keys/new?createflash=csrf-stale')
          .send();
      }
      if (inner.statusCode !== 201) {
        return reply.code(inner.statusCode).view('api-key-form', {
          title: 'Create API key',
          flash: { level: 'error', message: 'Could not create key. Try again.' },
          _csrfField: reply.renderCsrfField(),
        });
      }

      // Pre-Flight finding: inner response shape is
      //   { id, name, keyPrefix, createdAt, key }
      // The `scopes` field is NOT in the response — server-hardcoded —
      // so the created-page omits scopes entirely (the user will see them
      // on the /profile/api-keys list page after).
      const created = inner.json() as {
        id: string;
        key: string;
        keyPrefix: string;
        name: string;
        createdAt: string;
      };

      // C1-PR: anti-cache on the most security-sensitive page in the app.
      // `no-store` prevents browser disk-cache; `max-age=0` prevents shared-
      // proxy cache. C9-PR Round-2: Pragma:no-cache deliberately NOT set
      // (HTTP/1.0 Request-only, ignored on responses).
      reply.header('cache-control', 'no-store, max-age=0');
      return reply.view('api-key-created', {
        title: 'API key created',
        key: created.key,
        keyName: created.name,
        keyPrefix: created.keyPrefix,
      });
    },
  );
};
