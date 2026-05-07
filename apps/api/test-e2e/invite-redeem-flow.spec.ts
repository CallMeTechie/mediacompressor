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
        OR: [
          { createdById: { in: userIds } },
          { consumedById: { in: userIds } },
        ],
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
  const tokenHash = hashInviteToken(token, Buffer.from(TEST_SESSION_SECRET));
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
  await expect(page.locator('h1')).toContainText(/Create your account/);
  await page.fill('input[name="email"]', NEW_EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL('**/'),
    page.click('button[type="submit"]'),
  ]);
  await expect(page.locator('h1')).toContainText(/MediaCompressor/);
});
