import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../server.js';
import type { Config } from '../config.js';
import {
  TEST_API_KEY_PEPPER,
  TEST_SESSION_SECRET,
  TEST_CSRF_SECRET,
  testDatabaseUrl,
  testRedisUrl,
} from '@mediacompressor/test-helpers';

// ESM-Caveat: `__dirname` is not defined in ESM. Compute it from import.meta.url
// so the snapshot path is stable regardless of cwd.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, '..', '..', 'openapi-snapshot.json');

// AP4 — Operational note (Plan 7 Task 6): every plan/PR that changes routes
// MUST regenerate this snapshot via `UPDATE_SNAPSHOT=1 pnpm --filter
// @mediacompressor/api test snapshot` and commit `openapi-snapshot.json`
// alongside the code change. Without that, this test fails (drift-check).
const config: Config = {
  DATABASE_URL: testDatabaseUrl(),
  REDIS_URL: testRedisUrl(),
  SESSION_SECRET: TEST_SESSION_SECRET,
  CSRF_SECRET: TEST_CSRF_SECRET,
  API_KEY_PEPPER: TEST_API_KEY_PEPPER,
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  PORT: 0,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  ARGON2_MAX_CONCURRENCY: 8,
  TUSD_SHARED_SECRET: 'a'.repeat(64),
  TUSD_REQUIRE_SHARED_SECRET: true,
  TUSD_DATA_DIR: '/media/tusd-data',
  TUSD_FINAL_DIR: '/media/uploads',
  MEDIA_MOUNT_PATH: '/media',
  MIN_FREE_BYTES_RESERVE: 1n,
  // Plan 7 Task 7: snapshot reflects production-default config — Plan-4 stub
  // (POST /jobs) is OFF, so the snapshot does NOT include that path.
  ENABLE_LEGACY_JOB_STUB: false,
};

describe('OpenAPI snapshot', () => {
  it('matches committed snapshot (UPDATE_SNAPSHOT=1 to regenerate)', async () => {
    const app = await buildServer(config);
    // Ready ensures all plugins (including @fastify/swagger) have wired up
    // before we ask for the spec.
    await app.ready();
    const spec = app.swagger();
    await app.close();

    // BigInt-safe replacer: Zod schemas like `z.bigint()` may surface
    // BigInt-typed example/default values in the JSON-Schema, and JSON.stringify
    // throws on bare BigInts. Serialize as numeric string with a "n" suffix
    // (mirrors v8 BigInt literal syntax) so any drift is still visible.
    const expected = JSON.stringify(
      spec,
      (_key, value) => (typeof value === 'bigint' ? `${value.toString()}n` : value),
      2,
    );
    if (process.env.UPDATE_SNAPSHOT === '1') {
      writeFileSync(SNAPSHOT_PATH, expected, 'utf-8');
    }
    if (!existsSync(SNAPSHOT_PATH)) {
      throw new Error(
        `OpenAPI snapshot not found at ${SNAPSHOT_PATH} — run UPDATE_SNAPSHOT=1`,
      );
    }
    const committed = readFileSync(SNAPSHOT_PATH, 'utf-8');
    expect(expected).toBe(committed);
  });
});
