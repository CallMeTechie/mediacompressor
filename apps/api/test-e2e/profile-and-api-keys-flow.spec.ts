import { test, expect } from '@playwright/test';
import { createPrismaClient } from '@mediacompressor/db';
import { createTestUser, cleanupTestUsers, testDatabaseUrl } from '@mediacompressor/test-helpers';

const TEST_EMAIL = 'e2e-profile@test.invalid';
const PASSWORD = 'hunter22hunter22';

test.beforeAll(async () => {
  const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
  await cleanupTestUsers(prisma, [TEST_EMAIL]);
  await createTestUser(prisma, { email: TEST_EMAIL, password: PASSWORD });
  await prisma.$disconnect();
});

test.afterAll(async () => {
  const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
  await cleanupTestUsers(prisma, [TEST_EMAIL]);
  await prisma.$disconnect();
});

test('user navigates Profile, creates an API key (sees one-time reveal), revokes it', async ({
  page,
}) => {
  // 1. Login.
  await page.goto('/login');
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL('**/'), page.click('button[type="submit"]')]);

  // 2. Navigate to /profile. The dashboard does not currently link to /profile,
  //    so we navigate via direct URL — the route is part of the public surface.
  await page.goto('/profile');
  await expect(page.locator('h1')).toContainText(/Profile/);

  // 3. Navigate to API Keys via the in-page link.
  await page.click('a[href="/profile/api-keys"]');
  await expect(page).toHaveURL(/\/profile\/api-keys$/);
  await expect(page.locator('h1')).toContainText(/API Keys/);

  // 4. Create new key. Plan 8e Task 2 added a logout-form to the layout-nav
  //    on every authenticated page, so the bare `button[type="submit"]`
  //    selector now matches BOTH the logout button (DOM-first) and the
  //    create-form button. Scope to `form.api-key-form` so the click
  //    targets the create-form's submit unambiguously.
  await page.click('a[href="/profile/api-keys/new"]');
  await expect(page.locator('h1')).toContainText(/Create API key/);
  await page.fill('input[name="name"]', 'e2e-test-key');
  await page.click('form.api-key-form button[type="submit"]');
  await expect(page.locator('h1')).toContainText(/API key created/);
  // The raw key is visible exactly once. Format: `mc_<prefix-8>_<body-43>`,
  // where both segments are base64url (charset `[A-Za-z0-9_-]`). The body is
  // 32 random bytes b64url-encoded (~43 chars); we use 30+ as a loose lower
  // bound per C8-PR review.
  const keyText = await page.locator('.api-key-secret').textContent();
  expect(keyText).toMatch(/^mc_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{30,}$/);

  // 5. Navigate back to list, assert the new key row is present.
  await page.click('a[href="/profile/api-keys"]');
  await expect(page).toHaveURL(/\/profile\/api-keys$/);
  await expect(page.locator('td', { hasText: 'e2e-test-key' })).toBeVisible();

  // 6. Revoke. The revoke <form> sits inside the row's last <td>; we scope
  //    to that row to avoid clicking another key's revoke by accident.
  const revokeForm = page
    .locator('tr', { has: page.locator('td', { hasText: 'e2e-test-key' }) })
    .locator('form[action$="/revoke"]');
  await Promise.all([
    page.waitForURL(/\/api-keys/),
    revokeForm.locator('button[type="submit"]').click(),
  ]);
  await expect(page.locator('td', { hasText: 'e2e-test-key' })).not.toBeVisible();
});
