import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { generateApiKey, hashApiKey } from '@mediacompressor/auth';

const CreateBody = z.object({ name: z.string().min(1).max(64) });
const RevokeParams = z.object({ id: z.string().uuid() });

export const apiKeyRoutes: FastifyPluginAsync = async (app) => {
  const { prisma, config } = app.deps;
  const apiKeyPepper = Buffer.from(config.API_KEY_PEPPER);

  // GET ist read-only — kein CSRF nötig.
  app.get('/api/v1/users/me/api-keys', async (req, reply) => {
    const userId = await app.requireAuth(req, reply);
    if (!userId) return;
    const keys = await prisma.apiKey.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return { items: keys };
  });

  // POST ist state-changing — CSRF-Pflicht (außer Bearer).
  app.post('/api/v1/users/me/api-keys', { schema: { body: CreateBody } }, async (req, reply) => {
    const userId = await app.requireAuthCsrf(req, reply);
    if (!userId) return;
    const { name } = req.body as z.infer<typeof CreateBody>;
    const { key, prefix } = generateApiKey();
    const keyHash = hashApiKey(key, apiKeyPepper);
    const row = await prisma.apiKey.create({
      data: {
        userId,
        name,
        keyHash,
        keyPrefix: prefix,
        scopes: ['jobs:write', 'jobs:read'],
      },
      select: { id: true, name: true, keyPrefix: true, createdAt: true },
    });
    return reply.code(201).send({ ...row, key });
  });

  // DELETE ist state-changing — CSRF-Pflicht (außer Bearer).
  app.delete(
    '/api/v1/users/me/api-keys/:id',
    { schema: { params: RevokeParams } },
    async (req, reply) => {
      const userId = await app.requireAuthCsrf(req, reply);
      if (!userId) return;
      const { id } = req.params as z.infer<typeof RevokeParams>;
      const updated = await prisma.apiKey.updateMany({
        where: { id, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (updated.count === 0) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }
      return reply.code(204).send();
    },
  );
};
