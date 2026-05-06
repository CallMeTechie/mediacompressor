import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  dummyCompare,
  hashApiKey,
  hashSessionToken,
  parseApiKey,
} from '@mediacompressor/auth';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { userId: string; method: 'session' | 'api-key' };
    /** C1-Rev1: marker for csrf-protection plugin to skip Bearer-API-Key requests. */
    skipCsrf?: boolean;
  }
  interface FastifyInstance {
    requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined>;
    requireAuthCsrf(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined>;
  }
}

export function registerAuthMiddleware(app: FastifyInstance): void {
  const { prisma, config } = app.deps;
  const sessionPepper = Buffer.from(config.SESSION_SECRET);
  const apiKeyPepper = Buffer.from(config.API_KEY_PEPPER);

  app.decorate(
    'requireAuth',
    async (req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
      // Try API-key first (Bearer header).
      const auth = req.headers.authorization;
      if (auth && auth.startsWith('Bearer ')) {
        const key = auth.slice(7).trim();
        const parsed = parseApiKey(key);
        if (parsed) {
          const keyHash = hashApiKey(key, apiKeyPepper);
          const row = await prisma.apiKey.findUnique({
            where: { keyHash },
            include: { user: true },
          });
          if (row && !row.revokedAt && row.user.status === 'active') {
            // C4-Rev2: fire-and-forget update of lastUsedAt — not blocking the request path.
            void prisma.apiKey
              .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
              .catch(() => {});
            req.auth = { userId: row.userId, method: 'api-key' };
            // C1-Rev1: Bearer-API-Key requests are CSRF-immune (no implicit credential).
            req.skipCsrf = true;
            return row.userId;
          }
        }
        // Constant-time miss: dummy timingSafeEqual against random buffer.
        dummyCompare(32);
        reply.code(401).send({ error: { code: 'AUTH_INVALID' } });
        return;
      }

      // Fall back to session cookie.
      const token = req.cookies.mc_session;
      if (token) {
        const tokenHash = hashSessionToken(token, sessionPepper);
        const session = await prisma.session.findUnique({ where: { tokenHash } });
        if (session && session.expiresAt > new Date()) {
          req.auth = { userId: session.userId, method: 'session' };
          return session.userId;
        }
      }
      reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } });
      return;
    },
  );

  // C1-Rev1 + C9-Rev2: Wrapper für state-changing Routes — erst Auth, dann CSRF (außer Bearer).
  //
  // C9-Rev2: Statt blindem Cast `(app as unknown as { csrfProtection })` nutzen
  // wir die typisierte Fastify-Hook-Signatur `(req, reply, done) => void`. Bei
  // API-Drift im Plugin wirft der Aufruf laut (kein Silent-Pass = kein
  // CSRF-Bypass). `app.csrfProtection` wird vom @fastify/csrf-protection-Plugin
  // decoriert — wir rufen ihn manuell auf einem Stub-Reply, fangen das vom
  // Plugin gesendete Error-Objekt ab und mappen es auf unser AUTH_INVALID-Envelope.
  type CsrfHook = (
    req: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error | null) => void,
  ) => void;

  app.decorate(
    'requireAuthCsrf',
    async (req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
      const userId = await app.requireAuth(req, reply);
      if (!userId) return;
      if (req.skipCsrf) return userId; // Bearer-API-Key — CSRF-immun

      const csrfHook = (app as unknown as { csrfProtection?: CsrfHook }).csrfProtection;
      if (typeof csrfHook !== 'function') {
        // Fail loud — Plugin-Drift / fehlende Registration. KEIN Silent-Pass.
        app.log.error('csrfProtection hook missing — @fastify/csrf-protection not registered?');
        reply
          .code(500)
          .send({ error: { code: 'INTERNAL', message: 'CSRF subsystem unavailable' } });
        return;
      }

      // @fastify/csrf-protection v7 signals failure via `reply.send(error)` and
      // returns — `next()` is only called on success. We pass a stub reply that
      // captures the sent error without committing the real response, then map
      // failure to our own AUTH_INVALID envelope (403).
      const outcome = await new Promise<{ ok: true } | { ok: false; err: Error }>(
        (resolve) => {
          const stubReply = new Proxy(reply, {
            get(target, prop, receiver) {
              if (prop === 'send') {
                return (payload: unknown) => {
                  resolve({
                    ok: false,
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
          });
          csrfHook(req, stubReply as FastifyReply, (err) => {
            if (err) resolve({ ok: false, err });
            else resolve({ ok: true });
          });
        },
      );

      if (!outcome.ok) {
        reply
          .code(403)
          .send({ error: { code: 'AUTH_INVALID', message: 'CSRF token missing or invalid' } });
        return;
      }
      return userId;
    },
  );
}
