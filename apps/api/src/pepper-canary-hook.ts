import { assertPepperCanary } from '@mediacompressor/auth';
import type { PrismaClient } from '@mediacompressor/db';

/** Plan-3-Helper wrapped for the Fastify boot phase. Re-thrown errors abort boot. */
export async function runPepperCanaryOnBoot(
  prisma: PrismaClient,
  pepper: Buffer,
): Promise<void> {
  await assertPepperCanary(prisma, pepper);
}
