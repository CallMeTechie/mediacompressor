import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { TEST_API_KEY_PEPPER, testDatabaseUrl } from '@mediacompressor/test-helpers';
import { assertPepperCanary, PepperCanaryMismatchError } from './pepper-canary.js';

const DATABASE_URL = testDatabaseUrl();

let prisma: PrismaClient;

beforeAll(() => {
  prisma = createPrismaClient({ databaseUrl: DATABASE_URL });
});
afterAll(async () => {
  await prisma.pepperCanary.deleteMany();
  await prisma.$disconnect();
});

describe('assertPepperCanary', () => {
  it('initialises canary on first call (empty table)', async () => {
    await prisma.pepperCanary.deleteMany();
    const pepper = Buffer.from(TEST_API_KEY_PEPPER);
    await expect(assertPepperCanary(prisma, pepper)).resolves.toBeUndefined();
    const row = await prisma.pepperCanary.findUnique({ where: { id: 1 } });
    expect(row).not.toBeNull();
  });

  it('passes on second call with same pepper', async () => {
    const pepper = Buffer.from(TEST_API_KEY_PEPPER);
    await prisma.pepperCanary.deleteMany();
    await assertPepperCanary(prisma, pepper);
    await expect(assertPepperCanary(prisma, pepper)).resolves.toBeUndefined();
  });

  it('throws PepperCanaryMismatchError on different pepper', async () => {
    await prisma.pepperCanary.deleteMany();
    await assertPepperCanary(prisma, Buffer.alloc(32, 8));
    await expect(assertPepperCanary(prisma, Buffer.alloc(32, 9))).rejects.toBeInstanceOf(
      PepperCanaryMismatchError,
    );
    // H1-Fix: clean up local mismatch peppers so other tests/files see an empty canary.
    await prisma.pepperCanary.deleteMany();
  });

  it('does NOT throw on parallel first-boot (race-safe via ON CONFLICT)', async () => {
    await prisma.pepperCanary.deleteMany();
    const pepper = Buffer.from(TEST_API_KEY_PEPPER);
    const replicas = Array.from({ length: 4 }, () => assertPepperCanary(prisma, pepper));
    await expect(Promise.all(replicas)).resolves.toBeDefined();
    const rows = await prisma.pepperCanary.findMany();
    expect(rows).toHaveLength(1);
  });

  it('rejects pepper shorter than 32 bytes', async () => {
    await prisma.pepperCanary.deleteMany();
    await expect(assertPepperCanary(prisma, Buffer.from('short'))).rejects.toThrow(
      /Pepper too short/,
    );
  });
});
