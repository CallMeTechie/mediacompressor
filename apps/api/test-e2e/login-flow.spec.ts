import { test, expect } from '@playwright/test';
import { createPrismaClient } from '@mediacompressor/db';
import { createTestUser, cleanupTestUsers, testDatabaseUrl } from '@mediacompressor/test-helpers';

const TEST_EMAIL = 'e2e-login@test.invalid';
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

test('user can sign in via /login and is redirected to /', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveTitle(/Sign in/);

  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL('**/'),
    page.click('button[type="submit"]'),
  ]);

  // Plan-8b Task 1 changed `/`'s h1 from "MediaCompressor" → "Dashboard".
  // Match either so the spec survives a future re-rename without churn.
  await expect(page.locator('h1')).toContainText(/MediaCompressor|Dashboard/);
});

test('login with wrong password renders flash-error and stays on /login', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', 'WRONG');
  await page.click('button[type="submit"]');
  await expect(page.locator('.flash-error')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
