import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import csrf from '@fastify/csrf-protection';
import helmet from '@fastify/helmet';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import IORedis, { type Redis } from 'ioredis';
import type { Config } from './config.js';
import { runPepperCanaryOnBoot } from './pepper-canary-hook.js';
import { loginRoutes } from './auth/login-routes.js';
import { registerAuthMiddleware } from './auth/auth-middleware.js';
import { registerAdminGuard } from './admin/role-guard.js';
import { adminUsersRoutes } from './admin/users-routes.js';
import { adminInvitesRoutes } from './admin/invites-routes.js';
import { adminStatsRoute } from './admin/stats-route.js';
import { apiKeyRoutes } from './auth/api-key-routes.js';
import { capabilitiesRoute } from './capabilities/capabilities-route.js';
import { jobsRoutes } from './jobs/jobs-routes.js';
import { jobsEventsRoute } from './jobs/jobs-events-route.js';
import { downloadRoute } from './jobs/download-route.js';
import { preCreateHook } from './uploads/pre-create-hook.js';
import { postFinishHook } from './uploads/post-finish-hook.js';
import { tusdHooksDispatcher } from './uploads/hooks-dispatcher.js';
import { openapiSpecPlugin, openapiUiPlugin } from './openapi/plugin.js';

export interface AppDeps {
  prisma: PrismaClient;
  redis: Redis;
  config: Config;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export async function buildServer(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    disableRequestLogging: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie, { secret: config.SESSION_SECRET });

  // C4: CORS für Web-UI Cross-Origin (Plan 8). credentials:true wegen Cookie-Auth.
  await app.register(cors, {
    origin: config.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
  });

  // C1: CSRF-Schutz für Cookie-Sessions. Routes mit Bearer-API-Key sind via
  // skipCsrf in der Auth-Middleware vom Plugin ausgenommen — kein implicit
  // credential = kein CSRF-Risiko. State-changing Cookie-Routes erfordern
  // X-CSRF-Token-Header (Double-Submit-Pattern).
  await app.register(csrf, {
    cookieKey: 'mc_csrf',
    cookieOpts: {
      signed: false,
      httpOnly: false,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    },
    getToken: (req) => req.headers['x-csrf-token'] as string | undefined,
  });

  const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
  const redis = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

  app.decorate('deps', { prisma, redis, config } satisfies AppDeps);

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  // Plan 4 Task 2: Pepper-Canary Boot-Self-Check
  await runPepperCanaryOnBoot(prisma, Buffer.from(config.API_KEY_PEPPER));

  // Plan 7 Task 6: register @fastify/swagger BEFORE all documented routes —
  // its `onRoute` hook only collects metadata for routes registered after it.
  // The matching `openapiUiPlugin` is registered at the END of buildServer to
  // mount Swagger-UI and `GET /api/v1/openapi.json`.
  await app.register(openapiSpecPlugin);

  app.get('/api/v1/health', async () => ({ status: 'ok' }));

  app.get('/api/v1/ready', async () => {
    let db = false;
    let redisOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      /* keep false */
    }
    try {
      const pong = await Promise.race([
        redis.ping(),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      if (pong === 'PONG') redisOk = true;
    } catch {
      /* keep false */
    }
    return { status: db && redisOk ? 'ok' : 'degraded', db, redis: redisOk };
  });

  // Tasks 3–9 register hooks/routes here.
  await app.register(loginRoutes);

  // Plan 4 Task 5: Auth-Middleware (Session ODER API-Key). Must be registered
  // BEFORE Task-4 routes (API-Key-Routes) since they call app.requireAuth.
  registerAuthMiddleware(app);

  // Plan 7 Task 2 (AP1+AP5): Admin role-guard decorators. Registered AFTER
  // registerAuthMiddleware because requireAdmin/requireAdminCsrf delegate to
  // app.requireAuth and read req.auth.role/status (populated by resolveAuth).
  registerAdminGuard(app);

  // Plan 7 Task 3: Admin user-management routes. Registered AFTER
  // registerAdminGuard because the routes use app.requireAdmin /
  // app.requireAdminCsrf decorators.
  await app.register(adminUsersRoutes);

  // Plan 7 Task 4: Admin invite-management routes (POST/GET/DELETE
  // /admin/invites). Same registration ordering as adminUsersRoutes —
  // depends on registerAdminGuard for app.requireAdmin/requireAdminCsrf.
  await app.register(adminInvitesRoutes);

  // Plan 7 Task 5: Admin operational stats (GET /api/v1/admin/stats) —
  // users/jobs/storage/queue aggregates. Read-only GET; uses requireAdmin
  // (no CSRF, since GETs are not state-changing). Registered alongside the
  // other admin routes after registerAdminGuard.
  await app.register(adminStatsRoute);

  // Plan 4 Task 4: API-Key-Routes (CRUD for the authenticated user's keys).
  // Registered AFTER registerAuthMiddleware because it relies on
  // app.requireAuth / app.requireAuthCsrf decorators.
  await app.register(apiKeyRoutes);

  // Plan 7 Task 1: GET /api/v1/capabilities — discovery endpoint with anonymous
  // + authenticated subsets. Uses tryAuth (not requireAuth) so missing/invalid
  // auth falls through to anonymous (NOT 401).
  await app.register(capabilitiesRoute);

  // Plan 4 Task 6: POST /jobs stub + BullMQ producer (Outbox-Pattern).
  await app.register(jobsRoutes);

  // Plan 4 Task 9: GET /jobs/:id/events (SSE) — snapshot + Pub/Sub forwarding.
  await app.register(jobsEventsRoute);

  // Plan 6 Task 4: GET /jobs/:id/download — streams compressed output while
  // holding a download-handler in `downloads:<jobId>`. Cleanup-worker cannot
  // delete files under active downloads (C5 + C2-Rev4 + DC4).
  await app.register(downloadRoute);

  // Plan 5 Task 5: tusd Pre-Create-Hook
  // (POST /api/v1/internal/uploads/hooks/pre-create). Shared-secret +
  // Bearer-API-Key + UC7 MIME-allowlist + atomic quota reservation.
  await app.register(preCreateHook);

  // Plan 5 Task 6: tusd Post-Finish-Hook
  // (POST /api/v1/internal/uploads/hooks/post-finish). Shared-secret +
  // file-move (rename, EXDEV-fallback) + magic-number-check + atomic
  // status-transition uploading→queued + BullMQ-Enqueue (UC4/UC6).
  await app.register(postFinishHook);

  // Plan 5 Task 8: tusd HTTP-Hook dispatcher (POST /api/v1/internal/uploads/hooks).
  // tusd posts ALL events to a single URL; this thin route fans out by
  // body.Type to the per-Type routes registered above. Must run AFTER both
  // per-Type plugins so the in-process app.inject() sees them.
  await app.register(tusdHooksDispatcher);

  // Plan 7 Task 6: Swagger-UI + GET /api/v1/openapi.json. MUST be registered
  // LAST — pairs with openapiSpecPlugin (registered early); openapiSpecPlugin
  // installed swagger's onRoute hook so every route registered above this
  // line is now in the spec. Exposes /api/v1/openapi.json + /api/v1/docs.
  await app.register(openapiUiPlugin);

  return app;
}
