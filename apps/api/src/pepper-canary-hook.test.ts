// FU4: This test file shares the postgres `PepperCanary` row (id=1) with the
// docker `api` container. The docker container uses the dev `API_KEY_PEPPER`
// from `.env`; vitest uses `TEST_API_KEY_PEPPER`. If both run concurrently
// against the same postgres, every `buildServer()` boot in the docker-api
// reseeds the canary with the WRONG pepper, racing with this test's
// `deleteMany` + `runPepperCanaryOnBoot(TEST_API_KEY_PEPPER)` calls. The
// failure mode is a confusing "API_KEY_PEPPER mismatch" that's actually a
// concurrency artifact, not a real pepper drift.
//
// Constraint: stop the docker `api` container before running this test.
//   $ docker compose stop api
//
// The `beforeAll` below short-circuits with a clear error if it detects a
// running docker-api on :3000, replacing the confusing pepper-mismatch with
// an actionable operations message.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import { TEST_API_KEY_PEPPER, testDatabaseUrl } from '@mediacompressor/test-helpers';
import { runPepperCanaryOnBoot } from './pepper-canary-hook.js';

const DATABASE_URL = testDatabaseUrl();

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: DATABASE_URL });

  // FU4: Detect a concurrent docker-api on :3000 — its boot-time pepper-canary
  // writes race with this file's tests, producing a confusing pepper-mismatch
  // error. Best-effort fetch with a short timeout: a successful health-response
  // means the docker-api is running and we must fail-fast with an actionable
  // message. Network error / timeout = no docker-api → safe to proceed.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 250);
    let res: Response;
    try {
      res = await fetch('http://localhost:3000/api/v1/health', {
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      throw new Error(
        'docker-api is running on :3000 — its pepper-canary writes race ' +
          'with this test. Stop with `docker compose stop api` before re-running.',
      );
    }
  } catch (err) {
    // Re-throw our own actionable error; swallow network/timeout errors
    // (which mean: no docker-api → safe).
    if ((err as Error).message?.includes('docker-api is running')) throw err;
  }
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
