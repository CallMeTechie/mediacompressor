import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

// Subset of light-my-request's Response shape we consume. Importing the
// package directly would add it as a runtime dep — it's currently only a
// transitive dep of fastify. The headers field permits number for parity
// with Node's OutgoingHttpHeaders.
interface InjectResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | number | undefined>;
}

/**
 * Plan 5 Task 8: tusd HTTP-Hook dispatcher.
 *
 * tusd v2 sends ALL hook events (pre-create, post-create, post-receive,
 * post-finish, post-terminate, pre-finish) to a SINGLE HTTP endpoint
 * configured via `-hooks-http=...`. The hook-type is identified by the
 * `Type` field in the JSON body (e.g. `"Type": "pre-create"`).
 *
 * tusd 2.x reference: https://tus.github.io/tusd/advanced-topics/hooks/
 *
 * Our handler implementations (pre-create-hook.ts, post-finish-hook.ts) are
 * registered at per-Type routes for clean unit-test surface. This dispatcher
 * is the single URL that tusd actually targets and forwards events to the
 * matching per-Type route via `app.inject()` (in-process, zero-copy).
 *
 * Events we don't care about (post-create, post-receive, post-terminate,
 * pre-finish) are acknowledged with 200 so tusd does not retry. Authorization
 * forwarding is preserved via -hooks-http-forward-headers in docker-compose.
 */
const ROUTE_BY_TYPE: Record<string, string> = {
  'pre-create': '/api/v1/internal/uploads/hooks/pre-create',
  'post-finish': '/api/v1/internal/uploads/hooks/post-finish',
};

const PASSTHROUGH_HEADERS = ['x-tusd-shared-secret', 'authorization', 'x-csrf-token'] as const;

export const tusdHooksDispatcher: FastifyPluginAsync = async (app) => {
  app.post('/api/v1/internal/uploads/hooks', async (req, reply) => {
    const body = req.body as { Type?: string } | undefined;
    const type = body?.Type;

    // Unknown / not-handled event types: tusd treats 2xx as success and
    // won't retry. We deliberately accept and no-op so tusd-config can enable
    // any subset of events without breaking the upload.
    if (!type || !ROUTE_BY_TYPE[type]) {
      reply.code(200);
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.raw.end('{}');
      return reply;
    }

    // Forward to the per-Type route in-process via inject (zero-copy, no TCP).
    // The per-Type routes are the source-of-truth for pre-create / post-finish
    // logic; this dispatcher is a pure HTTP-layer fan-out.
    const headers = forwardHeaders(req);

    // app.inject() returns a chainable proxy whose `await` resolves to a
    // light-my-request Response. The fastify-type-provider-zod overlay
    // narrows the payload type, so we cast req.body to the inject-friendly
    // JSON-serializable shape.
    const inner: InjectResponse = await app.inject({
      method: 'POST',
      url: ROUTE_BY_TYPE[type],
      headers,
      payload: req.body as Record<string, unknown>,
    });

    // Mirror the inner response back to tusd. The per-Type routes guarantee
    // a JSON body (success: {} | {ChangeFileInfo:...}; error: {error:...});
    // we forward the raw bytes through reply.raw to keep this layer purely
    // transport. Fastify-inject returns the body as a string with a known
    // content-type — pass both through unchanged.
    const ct = inner.headers['content-type'];
    reply.code(inner.statusCode);
    reply.header(
      'content-type',
      typeof ct === 'string' ? ct : 'application/json; charset=utf-8',
    );
    reply.raw.end(inner.body ?? '');
    return reply;
  });
};

/**
 * Headers tusd-flavoured downstream routes need:
 *  - x-tusd-shared-secret: defense-in-depth (verifyTusdSharedSecret)
 *  - authorization: forwarded by tusd via -hooks-http-forward-headers
 *  - x-csrf-token: forwarded — currently unused but kept symmetric with the
 *    -hooks-http-forward-headers config in docker-compose.yml.
 *  - content-type: must be application/json so the inner Fastify route
 *    parses the JSON body, not opaque text.
 */
function forwardHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {
    'content-type': 'application/json',
  };
  for (const h of PASSTHROUGH_HEADERS) {
    const v = req.headers[h];
    if (typeof v === 'string') out[h] = v;
  }
  return out;
}
