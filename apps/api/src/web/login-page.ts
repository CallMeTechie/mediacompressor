import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';

const LoginForm = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  _csrf: z.string().min(1),
});

export const loginPagePlugin: FastifyPluginAsync = async (app) => {
  app.get('/login', async (_req, reply) => {
    // WC7: form pages must not be cached — stale CSRF token would 403 on submit
    // after browser-back, and CSRF tokens shouldn't persist on shared workstations.
    reply.header('cache-control', 'no-store, max-age=0');
    return reply.view('login', {
      title: 'Sign in',
      _csrfField: reply.renderCsrfField(),
      email: '',
    });
  });

  // POST goes through @fastify/csrf-protection via the existing csrfProtection
  // preHandler. On invalid credentials we re-render the form with a flash-error;
  // on success we issue mc_session via app.inject() to the existing JSON login
  // endpoint to avoid duplicating the rate-limit / argon2 logic, then redirect.
  app.post(
    '/login',
    { preHandler: app.csrfProtection },
    async (req, reply) => {
      const parsed = LoginForm.safeParse(req.body);
      if (!parsed.success) {
        return reply.view('login', {
          title: 'Sign in',
          _csrfField: reply.renderCsrfField(),
          flash: { level: 'error', message: 'Email and password required' },
          email:
            typeof (req.body as Record<string, unknown> | undefined)?.email === 'string'
              ? (req.body as Record<string, string>).email
              : '',
        });
      }
      const { email, password } = parsed.data;

      // Reuse the JSON login handler to avoid duplicating session creation
      // + rate-limit + argon2 logic.
      const inner = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          'content-type': 'application/json',
          // WC1: forward client IP so the rate-limiter sees the real source.
          // trustProxy='loopback' (Task 1) makes Fastify trust this header on
          // in-process inject() calls.
          'x-forwarded-for': req.ip,
        },
        payload: JSON.stringify({ email, password }),
      });
      if (inner.statusCode !== 200) {
        // 401, 429 etc. Render the form again with a generic error to avoid
        // leaking the failure mode (e.g. distinguishing "no such user" from
        // "wrong password"). Existing JSON envelope: { error: { code, message } }.
        const body = (() => {
          try {
            return inner.json() as { error?: { message?: string } };
          } catch {
            return { error: { message: 'Login failed' } };
          }
        })();
        return reply.code(200).view('login', {
          title: 'Sign in',
          _csrfField: reply.renderCsrfField(),
          flash: {
            level: 'error',
            message: body.error?.message ?? 'Invalid email or password',
          },
          email,
        });
      }

      // Forward the mc_session cookie set by the inner call. fastify-cookie
      // supports multiple set-cookie headers per response, so reply.header()
      // with the same key is additive (does not overwrite mc_csrf below).
      const innerCookie = inner.headers['set-cookie'];
      const cookies = Array.isArray(innerCookie)
        ? innerCookie
        : innerCookie
          ? [innerCookie]
          : [];
      for (const c of cookies) {
        reply.header('set-cookie', c);
      }
      // WC4: rotate mc_csrf after successful auth-state transition to prevent
      // session-fixation. generateCsrf() updates the CSRF cookie via the
      // plugin's machinery so the new token is bound to the post-login session.
      // MUST be called BEFORE reply.send() — send() commits the response.
      reply.generateCsrf();
      return reply.code(303).header('location', '/').send();
    },
  );
};
