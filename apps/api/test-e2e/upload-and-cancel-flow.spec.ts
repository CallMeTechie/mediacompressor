import { test, expect } from '@playwright/test';
import { createPrismaClient } from '@mediacompressor/db';
import { createTestUser, cleanupTestUsers, testDatabaseUrl } from '@mediacompressor/test-helpers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_EMAIL = 'e2e-upload@test.invalid';
const PASSWORD = 'hunter22hunter22';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-image.jpg');

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

test('user uploads a file, lands on /jobs/:id, sees status, cancels it', async ({ page }) => {
  // 1. Login.
  await page.goto('/login');
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL('**/'), page.click('button[type="submit"]')]);
  await expect(page.locator('h1')).toContainText(/Dashboard/);

  // 2. Navigate to upload page.
  await page.click('a[href="/upload"]');
  await expect(page.locator('h1')).toContainText(/Upload/);

  // 3. Attach the fixture, set kind=image + profile=web-optimized.
  await page.setInputFiles('input[name="file"]', FIXTURE);
  await page.check('input[name="kind"][value="image"]');
  await page.selectOption('select[name="profile"]', 'web-optimized');

  // 4. Submit. Wait for redirect to /jobs/<id>. Plan 8e Task 2 added a
  //    logout-form to the layout-nav on every authenticated page, so the
  //    bare `button[type="submit"]` selector now matches the logout button
  //    first. Scope to `form#upload-form` so the click hits the upload-
  //    form's submit unambiguously.
  await Promise.all([
    page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 30_000 }),
    page.click('form#upload-form button[type="submit"]'),
  ]);

  // 5. Verify the SSE-target div is present and reflects a job status. The
  //    initial server-render contains a `.status` badge inside the target;
  //    htmx-ext-sse may then swap the target's contents with the raw SSE-event
  //    payload (a JSON string like `{"status":"succeeded",…}`). Either form
  //    is acceptable proof that the page is wired correctly — we assert on
  //    the target div's text, which is robust against the swap.
  const sseTarget = page.locator('#job-detail-sse-target');
  await expect(sseTarget).toBeVisible();
  // Plan 8e Task 5 i18n migration: status labels are now locale-translated
  // via the {{tStatus}} helper. EN labels are PascalCase ("Succeeded",
  // "Failed", etc.). Match case-insensitively so the assertion works for
  // both the canonical lowercase enum-string (when the SSE event is
  // displayed raw as JSON) and the rendered localized label.
  await expect(sseTarget).toContainText(/uploading|queued|processing|succeeded|failed|canceled/i);

  // 6. If a cancel button is rendered (server-side `canCancel` was true),
  //    submit it and assert the page lands back on /jobs/:id with a status
  //    that's either canceled or already-terminal (the worker may have
  //    finished the tiny fixture before we click).
  const cancelBtn = page.locator('form[action$="/cancel"] button[type="submit"]');
  if (await cancelBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await Promise.all([page.waitForURL(/\/jobs\/[0-9a-f-]{36}/), cancelBtn.click()]);
    await expect(page.locator('#job-detail-sse-target')).toContainText(
      /canceled|succeeded|failed/i,
    );
  }
});
