import { defineConfig } from 'vitest/config';

// H4-Fix (Hardening Task 2): `pool: 'forks'` runs each test file in a child
// process so sharp's native addon loads cleanly (the default 'threads' pool
// can crash worker_threads when sharp is imported). Same pattern as
// apps/worker/vitest.config.ts.
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 30_000,
  },
});
