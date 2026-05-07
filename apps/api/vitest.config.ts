import { defineConfig } from 'vitest/config';

// API tests share singleton DB-rows (e.g. PepperCanary id=1) and a single Postgres
// schema. Running test files in parallel produces flakes when one file deletes/
// rewrites the canary while another file's `buildServer()` boot-check runs
// concurrently. Serializing test files is the simplest stable fix; per-file
// runtime is small (~7s parallel → ~14s serial), so the trade-off is acceptable.
// If a per-file setup ever isolates DB state (per-test-schema, transactional
// rollback, etc.), this can be flipped back to true.
export default defineConfig({
  test: {
    fileParallelism: false,
    // Playwright specs in apps/api/test-e2e/*.spec.ts use @playwright/test's
    // global `test.beforeAll`, which conflicts with vitest's runner. They're
    // launched separately via `pnpm test:e2e`; vitest must not pick them up.
    exclude: ['**/node_modules/**', '**/dist/**', 'test-e2e/**'],
  },
});
