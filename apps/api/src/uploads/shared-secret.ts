import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Verifies the X-Tusd-Shared-Secret header against the configured secret.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * Returns a Fastify pre-handler. On failure, sends a 401 response and resolves
 * to `false`; the calling handler must check the boolean and `return`
 * immediately to avoid proceeding after the reply has been sent.
 *
 * The boolean return type (instead of `void`) lets Pre-Create- and
 * Post-Finish-Hook handlers branch cleanly with
 * `if (!await verify(req, reply)) return;`.
 */
export function verifyTusdSharedSecret(
  expected: string,
): (req: FastifyRequest, reply: FastifyReply) => Promise<boolean> {
  const expectedBuf = Buffer.from(expected, 'utf8');
  return async (req, reply) => {
    const provided = req.headers['x-tusd-shared-secret'];
    if (typeof provided !== 'string' || provided.length === 0) {
      reply.code(401).send({
        error: { code: 'AUTH_REQUIRED', message: 'tusd shared-secret missing' },
      });
      return false;
    }
    const providedBuf = Buffer.from(provided, 'utf8');
    // Length check first — timingSafeEqual throws on mismatched lengths.
    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      reply.code(401).send({
        error: { code: 'AUTH_INVALID', message: 'tusd shared-secret invalid' },
      });
      return false;
    }
    return true;
  };
}
