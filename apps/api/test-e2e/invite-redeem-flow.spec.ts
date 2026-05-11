import { test, expect } from '@playwright/test';
import { createPrismaClient } from '@mediacompressor/db';
import {
  createTestUser,
  cleanupTestUsers,
  testDatabaseUrl,
  TEST_SESSION_SECRET,
} from '@mediacompressor/test-helpers';
import { generateInviteToken, hashInviteToken } from '@mediacompressor/auth';

const ADMIN_EMAIL = 'e2e-invite-admin@test.invalid';
const NEW_EMAIL = 'e2e-invite-new@test.invalid';
const PASSWORD = 'verysecurepassword12';

async function cleanupInvitesAndUsers(emails: string[]): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
  // Delete invites that reference the test users (FK on createdById /
  // consumedById blocks `cleanupTestUsers` otherwise — the redeem flow leaves
  // an Invite row whose consumedById points at the new user).
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  if (users.length > 0) {
    const userIds = users.map((u) => u.id);
    await prisma.invite.deleteMany({
      where: {
        OR: [{ createdById: { in: userIds } }, { consumedById: { in: userIds } }],
      },
    });
  }
  await cleanupTestUsers(prisma, emails);
  await prisma.$disconnect();
}

test.beforeAll(async () => {
  await cleanupInvitesAndUsers([ADMIN_EMAIL, NEW_EMAIL]);
  const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
  const admin = await createTestUser(prisma, { email: ADMIN_EMAIL });
  const token = generateInviteToken();
  // Plan-8b Task 6: the running api container hashes invite tokens with the
  // SESSION_SECRET it was booted with. When playwright runs against the
  // docker-compose stack, that's the value loaded from .env (see
  // playwright.config.ts process.loadEnvFile). Fall back to TEST_SESSION_SECRET
  // for in-process / CI runs that haven't seeded an env file.
  const sessionSecret = process.env.SESSION_SECRET ?? TEST_SESSION_SECRET;
  const tokenHash = hashInviteToken(token, Buffer.from(sessionSecret));
  await prisma.invite.create({
    data: {
      token: tokenHash,
      createdById: admin.id,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    },
  });
  process.env.E2E_INVITE_TOKEN = token;
  await prisma.$disconnect();
});

test.afterAll(async () => {
  await cleanupInvitesAndUsers([ADMIN_EMAIL, NEW_EMAIL]);
});

test('user can redeem an invite and reach the home placeholder', async ({ page }) => {
  const token = process.env.E2E_INVITE_TOKEN!;
  await page.goto(`/invites/${token}`);
  // Plan 8e Task 3 i18n migration: "Create your account" was renamed to
  // the i18n-keyed "Complete your account" (en/auth.json:invite_redeem_title).
  await expect(page.locator('h1')).toContainText(/Complete your account/);
  await page.fill('input[name="email"]', NEW_EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL('**/'), page.click('button[type="submit"]')]);
  // Plan-8b Task 1 changed `/`'s h1 from "MediaCompressor" → "Dashboard"
  // (invite-redeem 303s to `/` on success, which is now the Dashboard view).
  await expect(page.locator('h1')).toContainText(/MediaCompressor|Dashboard/);
});
