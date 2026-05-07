import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { generateInviteToken, hashInviteToken } from '@mediacompressor/auth';

// Plan 7 Task 4: Admin invite-management endpoints.
//
// AP1: POST + DELETE are state-changing → CSRF-Pflicht for cookie-auth (Bearer
// API-Key bypasses via skipCsrf). AP5: all routes require role='admin' AND
// status='active' via app.requireAdmin / app.requireAdminCsrf.
//
// Token model: the raw invite token is returned ONLY in the POST 201 response
// (one-shot). Only the HMAC-SHA-256 hash is persisted in `Invite.token`. GET
// never exposes the hash either. Pepper convention from Plan 3: SESSION_SECRET
// is reused as invite-pepper. Plan 9 may introduce a dedicated INVITE_PEPPER.

const PostBody = z.object({
  email: z.string().email().optional(),
  // Cap at 7d (168h) to bound the lifetime of single-use credentials.
  expiresInHours: z.number().int().min(1).max(168).default(24),
});

const InviteIdParams = z.object({ id: z.string().uuid() });

export const adminInvitesRoutes: FastifyPluginAsync = async (app) => {
  const { prisma, config } = app.deps;
  // Plan 3 used SESSION_SECRET as invite-pepper; Plan 9 may introduce a
  // dedicated INVITE_PEPPER env var.
  const invitePepper = Buffer.from(config.SESSION_SECRET);

  // POST /api/v1/admin/invites — create new invite. AP1: CSRF-required for
  // cookie-auth (state-changing).
  app.post(
    '/api/v1/admin/invites',
    { schema: { body: PostBody } },
    async (req, reply) => {
      const adminId = await app.requireAdminCsrf(req, reply);
      if (!adminId) return;
      const { email, expiresInHours } = req.body as z.infer<typeof PostBody>;

      const token = generateInviteToken();
      const tokenHash = hashInviteToken(token, invitePepper);
      const expiresAt = new Date(Date.now() + expiresInHours * 3600_000);

      // exactOptionalPropertyTypes: only spread `email` when actually provided
      // (the field is optional in the model and we want SQL NULL, not empty
      // string, when omitted).
      const invite = await prisma.invite.create({
        data: {
          token: tokenHash,
          ...(email !== undefined ? { email } : {}),
          createdById: adminId,
          expiresAt,
        },
        select: { id: true, email: true, expiresAt: true },
      });
      // The Invite model has no `createdAt` column (verified in
      // prisma/schema.prisma); ordering on GET uses `expiresAt` instead.
      return reply.code(201).send({ ...invite, token });
    },
  );

  // GET /api/v1/admin/invites — list active + consumed invites. The raw token
  // is NEVER exposed (only the hash exists in DB, and we don't select it).
  app.get('/api/v1/admin/invites', async (req, reply) => {
    const adminId = await app.requireAdmin(req, reply);
    if (!adminId) return;
    const invites = await prisma.invite.findMany({
      // No createdAt column on Invite — order by expiresAt (newest expiring
      // last). Stable enough for an admin list view.
      orderBy: { expiresAt: 'desc' },
      select: {
        id: true,
        email: true,
        expiresAt: true,
        consumedAt: true,
      },
    });
    return { items: invites };
  });

  // DELETE /api/v1/admin/invites/:id — revoke an active invite. Cannot revoke
  // a consumed invite (preserves audit trail). AP1: CSRF-required.
  app.delete(
    '/api/v1/admin/invites/:id',
    { schema: { params: InviteIdParams } },
    async (req, reply) => {
      const adminId = await app.requireAdminCsrf(req, reply);
      if (!adminId) return;
      const { id } = req.params as z.infer<typeof InviteIdParams>;
      // deleteMany lets us filter by `consumedAt: null` inline; result.count
      // distinguishes "not found OR consumed" from "deleted". A two-step
      // findUnique-then-delete would race against concurrent consumption.
      const result = await prisma.invite.deleteMany({
        where: { id, consumedAt: null },
      });
      if (result.count === 0) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }
      return reply.code(204).send();
    },
  );
};
