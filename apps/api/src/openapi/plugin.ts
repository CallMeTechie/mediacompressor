import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

/**
 * Plan 7 Task 6: OpenAPI doc-generation.
 *
 * Spec Section 5 (line 559): exposes `/api/v1/openapi.json` (machine-readable
 * spec) and `/api/v1/docs` (Swagger-UI). Spec Section 12 (line 1185) requires
 * an OpenAPI-Drift-Check against a committed snapshot — see snapshot.test.ts.
 *
 * Two-step registration is REQUIRED because @fastify/swagger uses an `onRoute`
 * hook to collect route metadata — that hook only fires for routes registered
 * AFTER the swagger plugin itself. Therefore:
 *
 *  - `openapiSpecPlugin` (this file's first export): register EARLY in
 *    `buildServer`, BEFORE any documented routes.
 *  - `openapiUiPlugin`: register LAST, after every route, so the `GET
 *    /api/v1/openapi.json` route and Swagger-UI mount are added on top.
 *
 * Both wrappers use `fastify-plugin` so the `app.swagger()` decorator bubbles
 * up to the parent FastifyInstance — the snapshot test calls it on the
 * top-level app, not from inside any plugin scope.
 */
const openapiSpecImpl: FastifyPluginAsync = async (app) => {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'MediaCompressor API',
        version: '0.1.0',
        description: 'REST API for MediaCompressor — image/video compression service',
      },
      servers: [{ url: 'http://localhost:3000' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'mc_session' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
};

export const openapiSpecPlugin = fp(openapiSpecImpl, {
  name: 'mediacompressor-openapi-spec',
  fastify: '5.x',
});

const openapiUiImpl: FastifyPluginAsync = async (app) => {
  await app.register(swaggerUI, {
    routePrefix: '/api/v1/docs',
    uiConfig: { docExpansion: 'list', deepLinking: false },
  });

  app.get('/api/v1/openapi.json', async () => app.swagger());
};

export const openapiUiPlugin = fp(openapiUiImpl, {
  name: 'mediacompressor-openapi-ui',
  fastify: '5.x',
});
