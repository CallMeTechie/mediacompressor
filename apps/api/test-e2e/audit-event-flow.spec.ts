import { test, expect } from '@playwright/test';
import { createPrismaClient } from '@mediacompressor/db';
import { createTestUser, cleanupTestUsers, testDatabaseUrl } from '@mediacompressor/test-helpers';

/**
 * Plan 10 Task 5: end-to-end happy-path for the AuditEvent persistent
 * audit-trail. Wires the chain admin-action -> recordAuditEvent
 * persistence -> /admin/audit-events render that all unit-tests cover
 * in isolation.
 *
 * Coverage:
 *  1. Admin logs in, edits target user (status=disabled), saves the form.
 *     This triggers a `user_update` AuditEvent row via the dual-write
 *     introduced in Plan 10 Task 3.
 *  2. Admin navigates to /admin/audit-events and sees the row with the
 *     correct action label, target type, target id, and admin actor-email.
 *  3. Filter `?action=user_update` returns the same row (verifies the
 *     z.enum allowlist + the composable-filter view-model from Task 4).
 *  4. Filter `?action=invite_create` returns NO rows (verifies the filter
 *     actually narrows, not just decorates the URL).
 *
 * Cleanup notes:
 *  - cleanupTestUsers (test-helpers, Plan 10 Task 1 WC-audit-7 fix)
 *    deletes AuditEvent rows for the seeded users BEFORE the User rows
 *    (FK ON DELETE RESTRICT). No manual auditEvent.deleteMany needed in
 *    afterAll -- cleanupTestUsers handles ordering.
 *  - status-change on TARGET is left disabled; cleanupTestUsers deletes
 *    the user anyway.
 */

const ADMIN_EMAIL = 'e2e-audit-admin@test.invalid';
const TARGET_EMAIL = 'e2e-audit-target@test.invalid';
const PASSWORD = 'hunter22hunter22';

test.beforeAll(async () => {
  const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
  try {
    await cleanupTestUsers(prisma, [ADMIN_EMAIL, TARGET_EMAIL]);
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
    // cleanupTestUsers deletes AuditEvent rows FIRST (Plan 10 Task 1
    // WC-audit-7 fix); no manual auditEvent.deleteMany needed here.
    await cleanupTestUsers(prisma, [ADMIN_EMAIL, TARGET_EMAIL]);
  } finally {
    await prisma.$disconnect();
  }
});

test('admin updates user -> AuditEvent row visible at /admin/audit-events', async ({ page }) => {
  // 1. Login as admin.
  await page.goto('/login');
  await page.fill('input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL('**/'), page.click('button[type="submit"]')]);

  // 2. /admin/users -> open TARGET edit form -> set status=disabled -> save.
  // Mirrors the existing admin-and-i18n-flow.spec.ts pattern.
  await page.goto('/admin/users');
  const targetRow = page.locator('tr', { hasText: TARGET_EMAIL });
  await expect(targetRow).toBeVisible();
  await targetRow.locator('a[href^="/admin/users/"]').click();
  await expect(page).toHaveURL(/\/admin\/users\/[0-9a-f-]{36}$/);

  // Capture target user-id from the URL so we can assert the AuditEvent
  // targetId column matches exactly. The edit-route URL shape is
  // /admin/users/<uuid>.
  const editUrl = page.url();
  const match = editUrl.match(/\/admin\/users\/([0-9a-f-]{36})$/);
  expect(match).not.toBeNull();
  const targetUserId = match![1]!;

  await page.selectOption('select[name="status"]', 'disabled');
  await Promise.all([
    // Bounded URL-suffix regex avoids the security/detect-unsafe-regex
    // ESLint warning that `(\?.*)?$` triggers (admin-and-i18n-flow.spec.ts
    // already pays that warning for its own redirect-assert; no need to
    // duplicate it here). The redirect target is always /admin/users with
    // an optional updateflash query-param.
    page.waitForURL((url) => url.pathname === '/admin/users'),
    page.click('form.admin-form button[type="submit"]'),
  ]);
  await expect(page.locator('.flash.flash-info')).toBeVisible();

  // 3. Navigate to /admin/audit-events. The row from step 2 must be visible
  // with action=user_update, target=user/<targetUserId>, actor=ADMIN_EMAIL.
  await page.goto('/admin/audit-events');
  // Locale-agnostic substring: matches both EN "Audit Events" and DE
  // "Audit-Ereignisse". Intentional — the E2E sets no `mc_locale` cookie,
  // so it should pass regardless of the test-env's default-locale config.
  await expect(page.locator('h1')).toContainText(/Audit/);

  // Default locale is `en` so the action label renders as "User updated"
  // (en/admin.json:audit_action_user_update). The row also contains the
  // target-id as a <code> sibling and the admin-email as actor.
  const auditRow = page.locator('tr', { hasText: 'User updated' }).filter({
    hasText: targetUserId,
  });
  await expect(auditRow).toBeVisible();
  await expect(auditRow).toContainText(ADMIN_EMAIL);

  // 4. Filter by action=user_update -- same row must still be present.
  await page.goto('/admin/audit-events?action=user_update');
  const filteredRow = page
    .locator('tr', { hasText: 'User updated' })
    .filter({ hasText: targetUserId });
  await expect(filteredRow).toBeVisible();

  // 5. Filter by action=invite_create -- our seeded user_update row must
  // NOT be visible. (We only made a user_update, never an invite_create
  // in this spec; if other suites concurrently created invites against
  // ADMIN_EMAIL, we still wouldn't see the user_update row.) Use the
  // strict empty-state OR row-without-targetUserId assertion.
  await page.goto('/admin/audit-events?action=invite_create');
  const wrongFilterRow = page
    .locator('tr', { hasText: 'User updated' })
    .filter({ hasText: targetUserId });
  await expect(wrongFilterRow).toHaveCount(0);
});
