import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { TEST_API_KEY_PEPPER, testDatabaseUrl } from '@mediacompressor/test-helpers';
import { runPepperCanaryOnBoot } from './pepper-canary-hook.js';

const DATABASE_URL = testDatabaseUrl();

let prisma: PrismaClient;

beforeAll(() => {
  prisma = createPrismaClient({ databaseUrl: DATABASE_URL });
});
afterAll(async () => {
  await prisma.pepperCanary.deleteMany();
  await prisma.$disconnect();
});

describe('runPepperCanaryOnBoot', () => {
  it('passes on consistent pepper', async () => {
    await prisma.pepperCanary.deleteMany();
    const pepper = Buffer.from(TEST_API_KEY_PEPPER);
    await expect(runPepperCanaryOnBoot(prisma, pepper)).resolves.toBeUndefined();
    await expect(runPepperCanaryOnBoot(prisma, pepper)).resolves.toBeUndefined();
  });

  it('throws on pepper change', async () => {
    await prisma.pepperCanary.deleteMany();
    await runPepperCanaryOnBoot(prisma, Buffer.alloc(32, 8));
    await expect(runPepperCanaryOnBoot(prisma, Buffer.alloc(32, 9))).rejects.toThrow(
      /API_KEY_PEPPER mismatch/,
    );
    // H1-Fix: clean up local mismatch peppers so other tests/files see an empty canary.
    await prisma.pepperCanary.deleteMany();
  });
});
