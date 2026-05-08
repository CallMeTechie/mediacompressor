import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  ADMIN_USER_FLASH_MAP,
  type AdminUserFlashKey,
} from './admin-user-flash-keys.js';

/**
 * Plan 8d Task 4: GET /admin/users/:id -- edit-form for a single user.
 *
 * Reads the target user via Prisma directly (Plan-7's admin JSON-API has
 * no single-user GET endpoint -- fetching via the cursor-paginated list
 * would be O(n) hacky). The form is then POSTed to /admin/users/:id
 * (admin-user-update-route.ts) which forwards to the inner PATCH.
 *
 * BigInt-safety: User.storageQuota is BigInt in Postgres. Handlebars's
 * default JSON serializer would crash on a BigInt value, so we stringify
 * before the render-data bag. The rendered <input value="..."> sees the
 * decimal string; the POST handler accepts both number and numeric-string
 * via z.coerce.bigint().
 *
 * Auth-gate: app.requireAdminSession (Plan 8d Task 1).
 *
 * fp-wrap rule: this plugin does NOT decorate anything -> NOT fp-wrapped.
 */

const Params = z.object({ id: z.string().uuid() });

const Query = z.object({
  updateflash: z.string().optional(),
});

export const adminUserEditPagePlugin: FastifyPluginAsync = async (app) => {
  const { prisma } = app.deps;

  app.get(
    '/admin/users/:id',
    {
      preHandler: app.requireAdminSession,
      schema: { params: Params, querystring: Query },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store, max-age=0');
      const { id } = req.params as z.infer<typeof Params>;
      const q = req.query as z.infer<typeof Query>;

      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          storageQuota: true,
          parallelQuota: true,
          hourlyQuota: true,
        },
      });
      if (!user) {
        return reply.code(404).view('404', { title: 'Not found', path: req.url });
      }

      // Concern #2: honor ?updateflash=csrf-stale so an inner-403 redirect
      // back to this edit-form renders the banner instead of silently
      // dropping the user back into the form. Same allowlist-gate as the
      // list-page (admin-user-flash-keys.ts).
      const flashEntry = q.updateflash
        ? ADMIN_USER_FLASH_MAP.get(q.updateflash as AdminUserFlashKey)
        : undefined;
      const flash = flashEntry
        ? {
            level: flashEntry.level,
            message: app.i18n.t(flashEntry.messageKey, { lng: req.locale }),
          }
        : null;

      return reply.view('admin-user-edit', {
        title: app.i18n.t('page_title_edit_user', { lng: req.locale }),
        flash,
        user: {
          ...user,
          // BigInt -> decimal string for the rendered <input value=...>.
          storageQuota: user.storageQuota.toString(),
        },
        _csrfField: reply.renderCsrfField(),
      });
    },
  );
};
