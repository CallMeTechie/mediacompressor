import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Verifies the X-Tusd-Shared-Secret header against the configured secret.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * Plan-5-Followup note: tusd v2.4.0 has NO CLI flag to inject a static header
 * on hook calls (`-hooks-http-header` does not exist; only
 * `-hooks-http-forward-headers` for client-supplied headers). Plan 9 will
 * front tusd with Caddy that injects the X-Tusd-Shared-Secret. Until then,
 * Plan-5-internal-Compose deployments rely on the internal docker network
 * for trust (`require=false` mode). The middleware still:
 *   - rejects forged/wrong headers when one IS provided (always),
 *   - rejects missing headers when `require=true` (Plan 9 + production).
 *
 * Returns a Fastify pre-handler. On failure, sends a 401 response and resolves
 * to `false`; the calling handler must check the boolean and `return`
 * immediately to avoid proceeding after the reply has been sent.
 */
export function verifyTusdSharedSecret(
  expected: string,
  require: boolean = true,
): (req: FastifyRequest, reply: FastifyReply) => Promise<boolean> {
  const expectedBuf = Buffer.from(expected, 'utf8');
  return async (req, reply) => {
    const provided = req.headers['x-tusd-shared-secret'];
    if (typeof provided !== 'string' || provided.length === 0) {
      if (!require) {
        // Network-trust mode: caller relies on the docker-internal network
        // for confidentiality. Header-absence is acceptable.
        return true;
      }
      reply.code(401).send({
        error: { code: 'AUTH_REQUIRED', message: 'tusd shared-secret missing' },
      });
      return false;
    }
    const providedBuf = Buffer.from(provided, 'utf8');
    // Length check first — timingSafeEqual throws on mismatched lengths.
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      // A header WAS supplied — reject forgery regardless of `require`.
      reply.code(401).send({
        error: { code: 'AUTH_INVALID', message: 'tusd shared-secret invalid' },
      });
      return false;
    }
    return true;
  };
}
