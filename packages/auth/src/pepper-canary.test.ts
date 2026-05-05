import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { assertPepperCanary, PepperCanaryMismatchError } from './pepper-canary.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://mc:mc@127.0.0.1:5432/mc?schema=public';

let prisma: PrismaClient;

beforeAll(() => { prisma = createPrismaClient({ databaseUrl: DATABASE_URL }); });
afterAll(async () => {
  await prisma.pepperCanary.deleteMany();
  await prisma.$disconnect();
});

describe('assertPepperCanary', () => {
  it('initialises canary on first call (empty table)', async () => {
    await prisma.pepperCanary.deleteMany();
    const pepper = Buffer.alloc(32, 1);
    await expect(assertPepperCanary(prisma, pepper)).resolves.toBeUndefined();
    const row = await prisma.pepperCanary.findUnique({ where: { id: 1 } });
    expect(row).not.toBeNull();
  });

  it('passes on second call with same pepper', async () => {
    const pepper = Buffer.alloc(32, 2);
    await prisma.pepperCanary.deleteMany();
    await assertPepperCanary(prisma, pepper);
    await expect(assertPepperCanary(prisma, pepper)).resolves.toBeUndefined();
  });

  it('throws PepperCanaryMismatchError on different pepper', async () => {
    await prisma.pepperCanary.deleteMany();
    await assertPepperCanary(prisma, Buffer.alloc(32, 3));
    await expect(
      assertPepperCanary(prisma, Buffer.alloc(32, 4)),
    ).rejects.toBeInstanceOf(PepperCanaryMismatchError);
  });

  it('does NOT throw on parallel first-boot (race-safe via ON CONFLICT)', async () => {
    await prisma.pepperCanary.deleteMany();
    const pepper = Buffer.alloc(32, 5);
    const replicas = Array.from({ length: 4 }, () => assertPepperCanary(prisma, pepper));
    await expect(Promise.all(replicas)).resolves.toBeDefined();
    const rows = await prisma.pepperCanary.findMany();
    expect(rows).toHaveLength(1);
  });

  it('rejects pepper shorter than 32 bytes', async () => {
    await prisma.pepperCanary.deleteMany();
    await expect(
      assertPepperCanary(prisma, Buffer.from('short')),
    ).rejects.toThrow(/Pepper too short/);
  });
});
