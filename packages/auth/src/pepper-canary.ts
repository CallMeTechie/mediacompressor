import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@mediacompressor/db';
import { assertPepper } from './timing.js';

const CANARY_INPUT = 'mediacompressor-canary-v1';

export class PepperCanaryMismatchError extends Error {
  constructor(public readonly expected: string, public readonly actual: string) {
    super(
      `API_KEY_PEPPER mismatch.\n` +
        `Expected HMAC: ${expected}\n` +
        `Got HMAC:      ${actual}\n` +
        `If intentional, run bin/rotate-api-key-pepper.ts to invalidate all keys ` +
        `and re-seed the canary.`,
    );
    this.name = 'PepperCanaryMismatchError';
  }
}

function canaryHmac(pepper: Buffer): string {
  return createHmac('sha256', pepper).update(CANARY_INPUT).digest('hex');
}

/**
 * Boot-time self-check (Spec C3-Rev2 + C3-Rev3). Race-safe via ON CONFLICT DO NOTHING.
 */
export async function assertPepperCanary(prisma: PrismaClient, pepper: Buffer): Promise<void> {
  assertPepper(pepper);
  const actual = canaryHmac(pepper);
  await prisma.$executeRaw`
    INSERT INTO "PepperCanary" ("id", "expectedHmac")
    VALUES (1, ${actual})
    ON CONFLICT ("id") DO NOTHING
  `;
  const row = await prisma.pepperCanary.findUnique({ where: { id: 1 } });
  if (!row) {
    throw new Error('PepperCanary row missing after upsert');
  }
  const expectedBuf = Buffer.from(row.expectedHmac, 'hex');
  const actualBuf = Buffer.from(actual, 'hex');
  if (
    expectedBuf.length !== actualBuf.length ||
    !timingSafeEqual(expectedBuf, actualBuf)
  ) {
    throw new PepperCanaryMismatchError(row.expectedHmac, actual);
  }
}
