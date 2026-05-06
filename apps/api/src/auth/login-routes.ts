import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  Argon2Semaphore,
  checkAndIncrementRateLimit,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from '@mediacompressor/auth';

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// C2-Rev1: Spec Sektion 7 fordert 10/min IP + 5/15min Account.
const RATE_LIMIT_IP = { limit: 10, windowMs: 60_000 };
const RATE_LIMIT_ACCOUNT = { limit: 5, windowMs: 15 * 60_000 };

// C13-Rev2: Dummy-Hash zur Modul-Init-Zeit GENERIEREN (statt hardcoded String).
// Lazy-Init via Promise: erst beim ersten Login berechnet, danach gecached.
let dummyHashPromise: Promise<string> | undefined;
const getDummyHash = (): Promise<string> => {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('dummy-constant-time-placeholder-x9k2lq');
  }
  return dummyHashPromise;
};

export const loginRoutes: FastifyPluginAsync = async (app) => {
  const { prisma, redis, config } = app.deps;
  const argonSem = new Argon2Semaphore(config.ARGON2_MAX_CONCURRENCY);
  const sessionPepper = Buffer.from(config.SESSION_SECRET);

  app.post('/api/v1/auth/login', { schema: { body: LoginBody } }, async (req, reply) => {
    const { email, password } = req.body as z.infer<typeof LoginBody>;

    // C2-Rev1: Rate-Limit pro IP + pro Account VOR argon2-Verify.
    const ipResult = await checkAndIncrementRateLimit(
      redis,
      `login:ip:${req.ip}`,
      RATE_LIMIT_IP.limit,
      RATE_LIMIT_IP.windowMs,
    );
    if (!ipResult.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(Math.ceil((ipResult.retryAfterMs ?? 60_000) / 1000)))
        .send({ error: { code: 'AUTH_INVALID', message: 'Too many login attempts' } });
    }
    const accountResult = await checkAndIncrementRateLimit(
      redis,
      `login:acct:${email.toLowerCase()}`,
      RATE_LIMIT_ACCOUNT.limit,
      RATE_LIMIT_ACCOUNT.windowMs,
    );
    if (!accountResult.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(Math.ceil((accountResult.retryAfterMs ?? 60_000) / 1000)))
        .send({ error: { code: 'AUTH_INVALID', message: 'Too many login attempts' } });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    const hash = user?.passwordHash ?? (await getDummyHash()); // C13-Rev2

    const ok = await argonSem.run(() => verifyPassword(hash, password));
    if (!ok || !user || user.status !== 'active') {
      return reply.code(401).send({
        error: { code: 'AUTH_INVALID', message: 'Invalid credentials' },
      });
    }

    // C8-Rev2: Bei erfolgreichem Login den Account-Counter zurücksetzen.
    // Note: checkAndIncrementRateLimit prefixes the key with 'ratelimit:'.
    await redis.del(`ratelimit:login:acct:${email.toLowerCase()}`);

    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token, sessionPepper);
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        userAgent: req.headers['user-agent'] ?? '',
        ip: req.ip,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });

    reply.setCookie('mc_session', token, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });

    // C1-Rev1: CSRF-Token wird im Response-Body geliefert.
    // @fastify/csrf-protection v7: reply.generateCsrf() returns string synchronously.
    const csrfToken = reply.generateCsrf();
    return { id: user.id, email: user.email, csrfToken };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const token = req.cookies.mc_session;
    if (token) {
      const tokenHash = hashSessionToken(token, sessionPepper);
      await prisma.session.deleteMany({ where: { tokenHash } });
    }
    reply.clearCookie('mc_session', { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/v1/auth/me', async (req, reply) => {
    const token = req.cookies.mc_session;
    if (!token) {
      return reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } });
    }
    const tokenHash = hashSessionToken(token, sessionPepper);
    const session = await prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!session || session.expiresAt < new Date()) {
      return reply.code(401).send({ error: { code: 'AUTH_EXPIRED' } });
    }
    await prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    });
    return { id: session.user.id, email: session.user.email, role: session.user.role };
  });
};
