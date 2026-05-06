import { defineConfig } from 'vitest/config';

// `pool: 'forks'` runs each test file in a child process so sharp's native
// addon loads cleanly (the default 'threads' pool can crash worker_threads
// when sharp is imported transitively via @mediacompressor/compression).
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 60_000,
  },
});
