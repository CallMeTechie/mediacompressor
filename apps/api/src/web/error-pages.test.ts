import { describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import type { Config } from '../config.js';
import {
  TEST_API_KEY_PEPPER,
  TEST_SESSION_SECRET,
  TEST_CSRF_SECRET,
  testDatabaseUrl,
  testRedisUrl,
} from '@mediacompressor/test-helpers';

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
  TRUSTED_PROXY_CIDR: 'loopback',
  ENABLE_LEGACY_JOB_STUB: false,
};

describe('web/error-pages', () => {
  it('GET /this-does-not-exist (Accept: text/html) → 404 HTML', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/this-does-not-exist',
        headers: { accept: 'text/html' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/Not found|404/i);
    } finally {
      await app.close();
    }
  });

  it('GET /api/v1/this-does-not-exist (no Accept header) → 404 JSON (regression: API stays JSON)', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/this-does-not-exist' });
      expect(res.statusCode).toBe(404);
      // Default fastify 404 returns JSON; we must not regress that for API paths.
      expect(res.headers['content-type']).toMatch(/application\/json/);
    } finally {
      await app.close();
    }
  });

  // Plan 8b Task 1: GET / behavior tests (303-no-session, JSON-no-Accept,
  // C5-Rev2 no-store) moved to dashboard-page.test.ts because the dashboard
  // owns `/` now. error-pages.ts no longer registers `app.get('/')`.

  it('500 page renders for HTML clients on a thrown error', async () => {
    const app = await buildServer(config);
    app.get('/__test_throw', async () => {
      throw new Error('boom');
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/__test_throw',
        headers: { accept: 'text/html' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/Server error|500/i);
    } finally {
      await app.close();
    }
  });

  // Plan 8b Task 1: C5-Rev2 PFLICHT-REGRESSIONSTEST migrated to
  // dashboard-page.test.ts (test 5: 'GET / (HTML, valid session) has
  // Cache-Control: no-store') — the dashboard owns `/` and uses a real
  // session lookup instead of the Plan-8a placeholder cookie sniff.
});
