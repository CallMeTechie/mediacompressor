import type { FastifyPluginAsync } from 'fastify';

/**
 * Plan 8d Task 3: GET /admin -- admin landing page.
 *
 * Renders a small dashboard with nav-links to /admin/users, /admin/invites,
 * /admin/stats plus a localised "Welcome, {{adminEmail}}" header and the
 * locale-switcher form (C3-AD-PR + C7-AD-PR -- CSP-clean submit-buttons,
 * current-locale button is disabled + .active).
 *
 * Auth-gate: `app.requireAdminSession` (Task 1).
 *  - No session: 303 to /login (delegated by wrapped requireSession).
 *  - Valid non-admin session: 403 HTML (no admin-existence-leak).
 *  - Valid admin: handler runs.
 *
 * Cache-Control: no-store, max-age=0 -- post-login HTML carries user-bound
 * data and must not be browser/proxy-cached. Mirrors the C5-Rev2 rule from
 * Plan-8b's dashboard-page.
 *
 * NOT fp-wrapped (registers a single route, no decorators). The `app.deps`,
 * `app.requireAdminSession`, `app.i18n` decorators are inherited from
 * earlier-registered plugins.
 */
export const adminDashboardPagePlugin: FastifyPluginAsync = async (app) => {
  const { prisma } = app.deps;

  app.get('/admin', { preHandler: app.requireAdminSession }, async (req, reply) => {
    reply.header('cache-control', 'no-store, max-age=0');
    // requireAdminSession guarantees req.auth is populated and role==='admin',
    // so the non-null assertion is safe here.
    const userId = req.auth!.userId;
    const admin = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    return reply.view('admin-dashboard', {
      title: app.i18n.t('page_title_dashboard', { lng: req.locale }),
      adminEmail: admin?.email ?? '',
      // The dashboard contains two state-changing forms (logout + locale-
      // switcher) that need a CSRF token. {{> csrf}} reads `_csrfField` from
      // the view context. Without this line the forms ship empty CSRF inputs
      // and POST submits 403 (regression discovered by Plan-8d Task 7 E2E).
      _csrfField: reply.renderCsrfField(),
    });
  });
};
