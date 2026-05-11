import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Plan-8b Task 6: load the repo-root `.env` so worker processes inherit
// SESSION_SECRET / API_KEY_PEPPER / DATABASE_URL / REDIS_URL from the same
// file that docker-compose read. The invite-redeem spec must hash invite
// tokens with the SAME SESSION_SECRET the api container uses; otherwise the
// hash-lookup misses and the page 404s. Node 22's process.loadEnvFile is a
// no-op in CI if the file is missing, so this is safe in both environments.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_ENV = path.join(__dirname, '..', '..', '..', '.env');
try {
  process.loadEnvFile(REPO_ROOT_ENV);
} catch {
  // file missing → fall back to whatever env the runner provides.
}

export default defineConfig({
  testDir: '.',
  // Restrict to *.spec.ts in this directory only. Without these, Playwright's
  // default testMatch `**/*.@(spec|test).?(c|m)[jt]s?(x)` walks up to the
  // package root and collects `apps/api/dist/**/*.test.js` (vitest-style tests
  // built by `tsc -b`). Those files `import { ... } from 'vitest'`, which loads
  // `@vitest/expect` and clashes with Playwright's bundled `expect` on the
  // `Symbol($$jest-matchers-object)` global → "Cannot redefine property" crash
  // before any spec runs.
  testMatch: /.*\.spec\.ts$/,
  testIgnore: ['**/dist/**', '**/node_modules/**'],
  timeout: 30_000,
  fullyParallel: false, // share singleton DB rows
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
