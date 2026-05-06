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

  // Tasks 2–9 register hooks/routes here.

  return app;
}
