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

  it('GET / (no session, Accept: text/html) → 303 to /login', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: { accept: 'text/html' },
      });
      expect([302, 303]).toContain(res.statusCode);
      expect(res.headers.location).toBe('/login');
    } finally {
      await app.close();
    }
  });

  it('GET / (no session, no Accept) → 200 JSON {status:ok} (kept for native-app compat)', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  });

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

  // C5-Rev2 PFLICHT-REGRESSIONSTEST — post-login HTML on / has Cache-Control: no-store.
  // The home-placeholder will render user-bound data once Plan 8b lands;
  // browser/proxy caching of that HTML is a privacy regression.
  it('C5-Rev2: GET / with valid session has Cache-Control: no-store', async () => {
    const app = await buildServer(config);
    try {
      // Synthesize a valid session cookie so the / handler renders the
      // home-placeholder rather than redirecting to /login.
      // For this test it's enough to attach an mc_session cookie; the
      // handler doesn't validate it for the cache-control assertion.
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: {
          accept: 'text/html',
          cookie: 'mc_session=test-session-placeholder',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });
});
