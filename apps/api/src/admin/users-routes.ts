import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@mediacompressor/db';

// Plan 7 Task 3: Admin user-management endpoints.
//
// AP1: PATCH is state-changing, so it requires CSRF for cookie-auth (Bearer
// API-Key bypasses via skipCsrf). AP5: both routes require role='admin' and
// status='active' via app.requireAdmin / app.requireAdminCsrf.
//
// BigInt-safety: User.storageQuota is BigInt in Postgres. JSON has no BigInt,
// so we serialize it as a string in responses (preserves precision for any
// quota value, including > 2^53).

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

// PatchBody: all fields optional so callers can update individual quotas
// independently. z.coerce.bigint accepts numeric strings ("1073741824") and
// numbers — JSON has no BigInt literal, so admin clients send the quota as
// a string.
const PatchBody = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  storageQuota: z.coerce.bigint().min(0n).optional(),
  parallelQuota: z.coerce.number().int().min(1).max(100).optional(),
  hourlyQuota: z.coerce.number().int().min(1).max(10000).optional(),
});

const UserIdParams = z.object({ id: z.string().uuid() });

export const adminUsersRoutes: FastifyPluginAsync = async (app) => {
  const { prisma } = app.deps;

  // GET /api/v1/admin/users — cursor-paginated list (orderBy id ASC). The
  // cursor is the LAST returned item's id; we fetch limit+1 to detect
  // "has more" without a separate COUNT query.
  app.get('/api/v1/admin/users', { schema: { querystring: ListQuery } }, async (req, reply) => {
    const adminId = await app.requireAdmin(req, reply);
    if (!adminId) return;
    const { limit, cursor } = req.query as z.infer<typeof ListQuery>;

    const items = await prisma.user.findMany({
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        storageQuota: true,
        parallelQuota: true,
        hourlyQuota: true,
        createdAt: true,
      },
    });

    const hasMore = items.length > limit;
    const slice = items.slice(0, limit);
    const last = slice[slice.length - 1];
    const nextCursor = hasMore && last ? last.id : null;

    return {
      items: slice.map((u) => ({ ...u, storageQuota: String(u.storageQuota) })),
      nextCursor,
    };
  });

  // PATCH /api/v1/admin/users/:id — partial update of admin-managed user
  // properties (status + per-user quotas). AP1: CSRF-required for cookie-auth.
  app.patch(
    '/api/v1/admin/users/:id',
    { schema: { params: UserIdParams, body: PatchBody } },
    async (req, reply) => {
      const adminId = await app.requireAdminCsrf(req, reply);
      if (!adminId) return;

      const { id } = req.params as z.infer<typeof UserIdParams>;
      const patch = req.body as z.infer<typeof PatchBody>;

      // exactOptionalPropertyTypes: spread only fields that were actually
      // provided so Prisma's UpdateInput sees them as required-when-present
      // (rather than `T | undefined`).
      const data: Prisma.UserUpdateInput = {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.storageQuota !== undefined ? { storageQuota: patch.storageQuota } : {}),
        ...(patch.parallelQuota !== undefined ? { parallelQuota: patch.parallelQuota } : {}),
        ...(patch.hourlyQuota !== undefined ? { hourlyQuota: patch.hourlyQuota } : {}),
      };

      try {
        const updated = await prisma.user.update({
          where: { id },
          data,
          select: {
            id: true,
            email: true,
            status: true,
            storageQuota: true,
            parallelQuota: true,
            hourlyQuota: true,
          },
        });
        return { ...updated, storageQuota: String(updated.storageQuota) };
      } catch (err) {
        // Distinguish 404 (Prisma P2025 = "Record to update not found") from
        // genuine 500-class errors. A bare catch-all would mask DB-connection
        // problems as 404s — sloppy and hides real issues.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
        }
        throw err;
      }
    },
  );
};
