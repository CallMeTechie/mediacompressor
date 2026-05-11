import argon2 from 'argon2';
import { Prisma, type PrismaClient } from '@mediacompressor/db';

export interface TestUserOptions {
  email: string;
  password?: string;
  status?: 'active' | 'disabled';
}

// F2-Fix: argon2 direkt importieren (statt hashPassword aus @mediacompressor/auth)
// → bricht den Cycle `auth ↔ test-helpers`. Lighter Test-Params (4 MB statt 64 MB,
// timeCost 2 statt 3, parallelism 1 statt 4) halten beforeAll-Latenz bei ~10 ms
// statt ~100 ms; das produzierte `$argon2id$...`-Format ist kompatibel mit
// `verifyPassword` aus packages/auth (Format-Check `hash.startsWith('$argon2id$')`).
const TEST_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 4096,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function createTestUser(
  prisma: PrismaClient,
  opts: TestUserOptions,
): Promise<{ id: string; email: string }> {
  const passwordHash = await argon2.hash(opts.password ?? 'hunter22hunter22', TEST_HASH_OPTIONS);
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
 *
 * Plan 10 Task 1 Rev. 2.1 WC-audit-7: AuditEvent FK uses ON DELETE RESTRICT,
 * so events referencing these users must be deleted FIRST (before User row).
 * Without this, ALL admin-tests that create AuditEvent rows would fail in
 * afterAll once Plan 10 lands.
 *
 * WC-audit-18 defensive try/catch: pre-Plan-10 dev-environments don't have
 * the AuditEvent table yet — Prisma raises P2021 ("table does not exist").
 * Skip that error gracefully so cleanup keeps working across migration-states.
 */
export async function cleanupTestUsers(prisma: PrismaClient, emails: string[]): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  if (users.length === 0) return;
  const userIds = users.map((u) => u.id);
  try {
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
  } catch (e: unknown) {
    // P2021 = "table does not exist" — pre-Plan-10 environment.
    // Narrow to Prisma's typed error class so unrelated `Error` subclasses
    // with a `code === 'P2021'` field (extremely unlikely but possible)
    // can't accidentally match.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2021') {
      throw e;
    }
  }
  await prisma.job.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.apiKey.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
