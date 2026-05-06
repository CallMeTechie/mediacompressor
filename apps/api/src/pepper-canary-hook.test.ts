import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { runPepperCanaryOnBoot } from './pepper-canary-hook.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://mc:mc@127.0.0.1:5432/mc?schema=public';

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
    const pepper = Buffer.alloc(32, 7);
    await expect(runPepperCanaryOnBoot(prisma, pepper)).resolves.toBeUndefined();
    await expect(runPepperCanaryOnBoot(prisma, pepper)).resolves.toBeUndefined();
  });

  it('throws on pepper change', async () => {
    await prisma.pepperCanary.deleteMany();
    await runPepperCanaryOnBoot(prisma, Buffer.alloc(32, 8));
    await expect(runPepperCanaryOnBoot(prisma, Buffer.alloc(32, 9))).rejects.toThrow(
      /API_KEY_PEPPER mismatch/,
    );
  });
});
