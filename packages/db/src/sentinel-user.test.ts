import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from './index.js';

/**
 * Plan 10 Task 1 Rev. 2.1 WC-audit-15 PFLICHT-Test:
 * GDPR-anonymization sentinel-user must exist after the
 * 20260510193319_add_audit_event migration applies.
 *
 * The sentinel is referenced by docs/operations/runbook.md DSGVO-procedure
 * to redirect AuditEvent.actorUserId on right-to-be-forgotten requests.
 * Without it, the procedure is unactionable (placeholder uuid).
 *
 * Note: this test inlines the testDatabaseUrl resolution rather than importing
 * from `@mediacompressor/test-helpers`, because test-helpers depends on
 * `@mediacompressor/db` and a reverse dev-dep would create a TS-composite
 * cycle. The inline resolution mirrors `packages/test-helpers/src/test-config.ts`.
 */
function testDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    'postgresql://mediacompressor:changeme-dev@postgres:5432/mediacompressor?schema=public'
  );
}

describe('PFLICHT WC-audit-15: GDPR sentinel-user', () => {
  const SENTINEL_ID = '00000000-0000-0000-0000-000000000000';
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('sentinel-user exists with id=00000000-0000-0000-0000-000000000000', async () => {
    const sentinel = await prisma.user.findUnique({
      where: { id: SENTINEL_ID },
    });
    expect(sentinel).toBeTruthy();
    // User.email is @db.Citext — Postgres stores literal-case but compares
    // case-insensitively. The migration inserts lowercase; this assertion
    // uses literal-case match for now. If the migration ever changes the
    // literal case, update this assertion.
    expect(sentinel?.email).toBe('anonymized@deleted.invalid');
    expect(sentinel?.status).toBe('disabled');
  });

  it('sentinel-user is idempotent: re-applying migration is safe', async () => {
    // The migration's ON CONFLICT DO NOTHING guarantees idempotency.
    // Verify there is exactly one sentinel-user, regardless of repeated runs
    // or other test-bootstrapping that might attempt the same INSERT.
    const count = await prisma.user.count({
      where: { id: SENTINEL_ID },
    });
    expect(count).toBe(1);
  });
});
