import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Plan 4 Task 5 + Plan 7 Task 2: shared CSRF-hook driver.
 *
 * `@fastify/csrf-protection` v7 signals failure via `reply.send(error)` rather
 * than an exception. We invoke the plugin's `csrfProtection` hook against a
 * Proxy reply that captures the sent error WITHOUT committing the real
 * response, then return an outcome the caller can act on (typically: 403
 * AUTH_INVALID envelope on `reason: 'rejected'`, 500 INTERNAL on
 * `reason: 'missing-hook'`).
 *
 * Bearer-API-Key requests bypass CSRF via `req.skipCsrf` (set by the auth
 * middleware) — `runCsrfHook` should NOT be called in that case.
 */
type CsrfHook = (
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error | null) => void,
) => void;

export type CsrfOutcome =
  | { ok: true }
  | { ok: false; reason: 'missing-hook'; err: Error }
  | { ok: false; reason: 'rejected'; err: Error };

export async function runCsrfHook(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<CsrfOutcome> {
  // Read the plugin-decorated hook off the app. Cast is documented:
  // @fastify/csrf-protection adds `csrfProtection` at register time; if the
  // plugin is missing, the hook is undefined and the caller should fail loud
  // (no silent CSRF bypass).
  const csrfHook = (app as unknown as { csrfProtection?: CsrfHook }).csrfProtection;
  if (typeof csrfHook !== 'function') {
    return {
      ok: false,
      reason: 'missing-hook',
      err: new Error(
        'csrfProtection hook missing — @fastify/csrf-protection not registered',
      ),
    };
  }
  return new Promise<CsrfOutcome>((resolve) => {
    const stubReply: FastifyReply = new Proxy(reply, {
      get(target, prop, receiver) {
        if (prop === 'send') {
          return (payload: unknown) => {
            resolve({
              ok: false,
              reason: 'rejected',
              err:
                payload instanceof Error
                  ? payload
                  : new Error('CSRF protection rejected'),
            });
            return stubReply;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as FastifyReply;
    csrfHook(req, stubReply, (err) => {
      if (err) resolve({ ok: false, reason: 'rejected', err });
      else resolve({ ok: true });
    });
  });
}
