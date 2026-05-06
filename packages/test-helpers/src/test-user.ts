import { hashPassword } from '@mediacompressor/auth';
import type { PrismaClient } from '@mediacompressor/db';

export interface TestUserOptions {
  email: string;
  password?: string;
  status?: 'active' | 'disabled';
}

export async function createTestUser(
  prisma: PrismaClient,
  opts: TestUserOptions,
): Promise<{ id: string; email: string }> {
  const passwordHash = await hashPassword(opts.password ?? 'hunter22hunter22');
  const user = await prisma.user.upsert({
    where: { email: opts.email },
    update: { passwordHash, status: opts.status ?? 'active' },
    create: { email: opts.email, passwordHash, status: opts.status ?? 'active' },
  });
  return { id: user.id, email: user.email };
}

/**
 * H2-Fix: Scoped cleanup. Order matters: foreign-key constraints require
 * sessions/apiKeys/jobs before users.
 */
export async function cleanupTestUsers(
  prisma: PrismaClient,
  emails: string[],
): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  if (users.length === 0) return;
  const userIds = users.map((u) => u.id);
  await prisma.job.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.apiKey.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
