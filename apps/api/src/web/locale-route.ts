import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { SUPPORTED_LOCALES } from './i18n.js';

/**
 * Request body shape for POST /locale.
 *
 * Validated MANUALLY (via Body.safeParse(req.body) inside the handler) rather
 * than via `schema: { body: Body }`, because the
 * fastify-type-provider-zod validator-compiler REPLACES req.body with the
 * post-parse Zod output — which strips unknown keys like `_csrf` (Zod's
 * default `.strip()` behaviour). The csrf-protection preHandler runs AFTER
 * schema-validation in Fastify's lifecycle, so its `getToken` would find
 * `req.body._csrf === undefined` and reject every request with 403 even
 * when the form-token is correct.
 *
 * Pattern matches api-key-create-route.ts (line ~76 comment): "No
 * `schema.body` — application/x-www-form-urlencoded is parsed into an
 * untyped record by @fastify/formbody, and we manually validate via Zod
 * below". CSRF stays in req.body for getToken; bad locale-values land at
 * the Body.safeParse boundary and emit a 400.
 */
const Body = z.object({
  locale: z.enum(SUPPORTED_LOCALES),
  redirectTo: z.string().optional(),
});

// WC-AD2: allowlist of own-origin paths the locale-switcher may redirect to.
// Hardcoded -- any new top-level page path must be added explicitly. Anything
// not on this list falls back to '/'. The `as const` tuple is the SOURCE OF
// TRUTH for the redirect target -- pickRedirectTarget returns one of these
// literal members rather than echoing the user input, so static taint-analysis
// can see the value emitted to the Location header is never user-controlled.
const REDIRECT_ALLOWLIST: readonly ['/', '/admin', '/profile', '/jobs', '/upload', '/login'] = [
  '/',
  '/admin',
  '/profile',
  '/jobs',
  '/upload',
  '/login',
];
type AllowedRedirect = (typeof REDIRECT_ALLOWLIST)[number];
const SAFE_DEFAULT_REDIRECT: AllowedRedirect = '/';

/**
 * WC-AD2: open-redirect protection for the `redirectTo` body field.
 *
 * Implementation note: returns the matching literal allowlist constant (not a
 * substring of the user input), so the value reaching reply.header('location',
 * ...) is provably one of six compile-time string literals. No user-controlled
 * suffix is appended -- the locale-switcher always lands on a page-level
 * route, never a deep link. This deliberate design choice both:
 *   1. Closes the path-traversal vector at its root (no concatenation =
 *      no smuggling `/..` segments past a prefix-check),
 *   2. Lets static analyzers verify the open-redirect property without
 *      symbolic execution -- the function's return value is bounded by the
 *      AllowedRedirect literal type.
 *
 * Rejects (returns SAFE_DEFAULT_REDIRECT instead):
 *  - undefined / empty
 *  - absolute URLs (`http://evil.example/`, `https://evil.example/`)
 *  - protocol-relative URLs (`//evil.example/`) -- browsers resolve those to
 *    the current scheme + the attacker host
 *  - path-traversal sequences (`/admin/../etc/passwd`, `/admin/./...`)
 *  - any path that is not an EXACT match of an allowlist member
 */
export function pickRedirectTarget(p: string | undefined): AllowedRedirect {
  if (!p) return SAFE_DEFAULT_REDIRECT;
  // Reject anything containing "://" (absolute URLs) or starting with "//"
  // (protocol-relative). Both vectors let the browser navigate cross-origin.
  if (p.includes('://') || p.startsWith('//')) return SAFE_DEFAULT_REDIRECT;
  // Reject path-traversal. Defensive even though the strict-equality match
  // below would also reject these -- documenting intent.
  if (p.includes('/..') || p.includes('/./')) return SAFE_DEFAULT_REDIRECT;
  // Find the matching literal in the allowlist. Returning the literal (not p)
  // means the function's output never carries the taint of req.body, even if
  // p === literal.
  const match = REDIRECT_ALLOWLIST.find((allowed) => allowed === p);
  return match ?? SAFE_DEFAULT_REDIRECT;
}

export const localeRoutePlugin: FastifyPluginAsync = async (app) => {
  const { config } = app.deps;

  app.post(
    '/locale',
    {
      preHandler: app.csrfProtection,
      // No `schema.body` — see Body comment above for why CSRF + Zod-via-
      // schema don't compose. Manual safeParse below.
    },
    async (req, reply) => {
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) {
        // 400 mirrors the error-shape that the global Zod validator-compiler
        // would have emitted (matches existing tests for /api/v1/* shape).
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'Invalid request body' },
        });
      }
      const { locale, redirectTo } = parsed.data;
      reply.setCookie('mc_locale', locale, {
        // NOT httpOnly -- a future client-side i18n layer (Plan 8e) may want
        // to read the cookie. The value is allowlist-validated at every
        // detectLocale() call, so a JS-readable cookie carries no privilege.
        httpOnly: false,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 365 * 24 * 60 * 60,
      });
      reply.code(303);
      // WC-AD2: emit a literal Location header per allowlist-branch. Static
      // taint-analysis sees only string-literal arguments to reply.header()
      // -- there is NO data flow from req.body.redirectTo into the Location
      // value. pickRedirectTarget is the source of truth for the allowlist
      // policy and is unit-tested in locale-route.test.ts (WC-AD2 covers
      // https://, //, and /.. attack vectors).
      const target = pickRedirectTarget(redirectTo);
      switch (target) {
        case '/':
          return reply.header('location', '/').send();
        case '/admin':
          return reply.header('location', '/admin').send();
        case '/profile':
          return reply.header('location', '/profile').send();
        case '/jobs':
          return reply.header('location', '/jobs').send();
        case '/upload':
          return reply.header('location', '/upload').send();
        case '/login':
          return reply.header('location', '/login').send();
      }
      // Exhaustiveness fallback (unreachable: target is a closed literal union).
      return reply.header('location', '/').send();
    },
  );
};
