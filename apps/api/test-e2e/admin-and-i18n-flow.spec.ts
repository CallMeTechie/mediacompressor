import { test, expect } from '@playwright/test';
import { createPrismaClient } from '@mediacompressor/db';
import { createTestUser, cleanupTestUsers, testDatabaseUrl } from '@mediacompressor/test-helpers';

/**
 * Plan 8d Task 7: end-to-end happy-path for the admin panel + locale-switch.
 *
 * Coverage:
 *  1. Admin login → /admin dashboard renders with locale-switcher.
 *  2. /admin/users → edit target user → status=disabled → save → flash banner.
 *  3. /admin/invites → create invite → one-time-reveal page exposes raw token
 *     in `<code class="invite-token-secret">` → revoke just-created invite.
 *  4. /admin/stats → 4 sections render (Users, Jobs, Storage, Queue).
 *  5. Locale-switch on /admin: POST /locale (locale=de, redirectTo=/admin) →
 *     303 → reload → German strings present.
 *
 * Cleanup notes:
 *  - cleanupTestUsers (test-helpers) cascades Job/ApiKey/Session/User but NOT
 *    Invite. Invites must be deleted manually in afterAll BEFORE the user
 *    rows go (FK on createdById; even though ON DELETE SET NULL, leaking rows
 *    across runs would pollute /admin/invites and break the "newest revoke
 *    target" assumption on retry).
 *  - The status-change leaves the target user disabled; cleanupTestUsers
 *    deletes the user, so no separate restore needed.
 */

const ADMIN_EMAIL = 'e2e-admin@test.invalid';
const TARGET_EMAIL = 'e2e-admin-target@test.invalid';
const PASSWORD = 'hunter22hunter22';

test.beforeAll(async () => {
  const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
  try {
    // Drop any leftover invites from earlier runs of this spec BEFORE
    // cleaning up users (FK ordering safety). The seed admin's prior
    // invites would otherwise survive the user-delete because of the
    // ON DELETE SET NULL on Invite.createdById (Plan-7 schema choice).
    const stale = await prisma.user.findMany({
      where: { email: { in: [ADMIN_EMAIL, TARGET_EMAIL] } },
      select: { id: true },
    });
    if (stale.length > 0) {
      await prisma.invite.deleteMany({
        where: { createdById: { in: stale.map((u) => u.id) } },
      });
    }
    await cleanupTestUsers(prisma, [ADMIN_EMAIL, TARGET_EMAIL]);

    // Seed admin then promote (createTestUser creates `user` role; the role-
    // promotion is the official seed-pattern for E2E admin flows per Plan 8d
    // Task 7 spec).
    const admin = await createTestUser(prisma, {
      email: ADMIN_EMAIL,
      password: PASSWORD,
    });
    await prisma.user.update({
      where: { id: admin.id },
      data: { role: 'admin' },
    });
    await createTestUser(prisma, { email: TARGET_EMAIL, password: PASSWORD });
  } finally {
    await prisma.$disconnect();
  }
});

test.afterAll(async () => {
  const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
  try {
    const admin = await prisma.user.findUnique({
      where: { email: ADMIN_EMAIL },
      select: { id: true },
    });
    if (admin) {
      // Delete invites first (cleanupTestUsers does NOT cascade them).
      await prisma.invite.deleteMany({ where: { createdById: admin.id } });
    }
    await cleanupTestUsers(prisma, [ADMIN_EMAIL, TARGET_EMAIL]);
  } finally {
    await prisma.$disconnect();
  }
});

test('admin happy-path: dashboard → edit user → invite create+reveal+revoke → stats', async ({
  page,
}) => {
  // 1. Login as admin.
  await page.goto('/login');
  await page.fill('input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL('**/'), page.click('button[type="submit"]')]);

  // 2. /admin dashboard. h1 = page_title_dashboard ("Admin" in EN/DE).
  await page.goto('/admin');
  await expect(page.locator('h1')).toContainText(/Admin/);
  // Locale-switcher exposes both buttons.
  await expect(page.locator('form[action="/locale"] button[value="en"]')).toBeVisible();
  await expect(page.locator('form[action="/locale"] button[value="de"]')).toBeVisible();
  // Nav-links point to /admin/{users,invites,stats}.
  await expect(page.locator('a[href="/admin/users"]')).toBeVisible();
  await expect(page.locator('a[href="/admin/invites"]')).toBeVisible();
  await expect(page.locator('a[href="/admin/stats"]')).toBeVisible();

  // 3. /admin/users → edit TARGET → status=disabled → save → flash.
  await page.goto('/admin/users');
  await expect(page.locator('h1')).toContainText(/Users|Benutzer/);
  // Scope to the row containing TARGET_EMAIL so the click cannot land on
  // the admin's own row.
  const targetRow = page.locator('tr', { hasText: TARGET_EMAIL });
  await expect(targetRow).toBeVisible();
  await targetRow.locator('a[href^="/admin/users/"]').click();
  await expect(page).toHaveURL(/\/admin\/users\/[0-9a-f-]{36}$/);

  await page.selectOption('select[name="status"]', 'disabled');
  // Plan 8e Task 2 added a logout-form to the layout-nav on every
  // authenticated page, so the bare `button[type="submit"]` selector
  // matches the logout button first. Scope to the admin user-edit form so
  // the click hits the save-button unambiguously.
  await Promise.all([
    page.waitForURL(/\/admin\/users(\?.*)?$/),
    page.click('form.admin-form button[type="submit"]'),
  ]);
  // Successful update redirects to /admin/users?updateflash=updated and the
  // shared partial renders <div class="flash flash-info">.
  await expect(page.locator('.flash.flash-info')).toBeVisible();
  // Status change is reflected in the table row.
  const reflectedRow = page.locator('tr', { hasText: TARGET_EMAIL });
  await expect(reflectedRow).toContainText('disabled');

  // 4. /admin/invites → fill create-form → submit → one-time-reveal.
  await page.goto('/admin/invites');
  await expect(page.locator('h1')).toContainText(/Invites|Einladungen/);

  // Inline create-form on the list page (no separate /admin/invites/new).
  // Email is optional; expiresInHours has a default but we set it explicitly.
  await page.fill('input[name="expiresInHours"]', '24');
  await page.click('form[action="/admin/invites"] button[type="submit"]');

  // One-time-reveal renders admin-invite-created.hbs DIRECTLY (no redirect),
  // so the URL stays /admin/invites but the heading + token are visible.
  await expect(page.locator('h1')).toContainText(/Invite|Einladung/);
  const tokenLocator = page.locator('code.invite-token-secret');
  await expect(tokenLocator).toBeVisible();
  const tokenText = (await tokenLocator.textContent())?.trim() ?? '';
  // Plan-7 invite tokens are 64-char hex; lower-bound 20 mirrors the BFF's
  // InnerCreateResponse Zod schema in admin-invite-create-route.ts.
  expect(tokenText.length).toBeGreaterThanOrEqual(20);

  // Navigate back to the list via the "Done" link.
  await page.click('a[href="/admin/invites"]');
  await expect(page).toHaveURL(/\/admin\/invites$/);

  // Revoke the freshly-created invite. Each active row exposes a revoke
  // <form action="/admin/invites/:id/revoke">. Pick the FIRST visible
  // revoke form -- that's the newest row by Plan-7's ORDER BY createdAt
  // DESC contract.
  const revokeForm = page.locator('form[action$="/revoke"]').first();
  await expect(revokeForm).toBeVisible();
  await Promise.all([
    page.waitForURL(/\/admin\/invites/),
    revokeForm.locator('button[type="submit"]').click(),
  ]);
  await expect(page.locator('.flash.flash-info')).toBeVisible();

  // 5. /admin/stats → 4 sections: Users, Jobs, Storage, Queue.
  await page.goto('/admin/stats');
  await expect(page.locator('h1')).toContainText(/Stat/);
  await expect(page.locator('section.stats-section')).toHaveCount(4);
});

test('locale-switch: clicking DE on /admin reloads with German strings', async ({ page }) => {
  // Fresh login (each Playwright test gets a clean storageState).
  await page.goto('/login');
  await page.fill('input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL('**/'), page.click('button[type="submit"]')]);

  await page.goto('/admin');
  // Pre-condition: default locale is `en` (no mc_locale cookie set), so the
  // dashboard nav-link to invites reads "Invites" (en/admin.json:nav_invites).
  await expect(page.locator('a[href="/admin/invites"]')).toContainText('Invites');

  // Click the DE button. The form does method=POST action=/locale with a
  // hidden _csrf + redirectTo=/admin and submits via name="locale" value="de".
  await Promise.all([
    page.waitForURL('**/admin'),
    page.locator('form[action="/locale"] button[value="de"]').click(),
  ]);

  // After reload the nav-link to invites must read "Einladungen" (de.nav_invites).
  // This is THE canonical proof that detectLocale() picked up the new cookie.
  await expect(page.locator('a[href="/admin/invites"]')).toContainText('Einladungen');
  // Defense-in-depth: at least one other German string is present in the
  // page (page-title is "Admin" in both languages, so we don't gate on it).
  await expect(page.locator('body')).toContainText(/Sprache|Statistik/);
});
