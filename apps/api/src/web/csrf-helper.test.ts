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

describe('web/csrf-helper', () => {
  it('reply.renderCsrfField() returns a hidden input with a non-empty token', async () => {
    const app = await buildServer(config);
    app.get('/__test_csrf', async (_req, reply) => {
      return reply.view('partials/csrf', { _csrfField: reply.renderCsrfField() });
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/__test_csrf' });
      expect(res.statusCode).toBe(200);
      // Hidden input present with non-empty value (csrf-protection v7 token format).
      expect(res.body).toMatch(/<input type="hidden" name="_csrf" value="[A-Za-z0-9._\-]{16,}">/);
    } finally {
      await app.close();
    }
  });

  it('csrf-protection accepts a form post that echoes the token back via _csrf field', async () => {
    const app = await buildServer(config);
    // Test route requiring CSRF on a state-changing form-encoded body.
    app.post(
      '/__test_csrf_post',
      { preHandler: app.csrfProtection },
      async () => ({ ok: true }),
    );
    app.get('/__test_csrf_get', async (_req, reply) => {
      return reply.view('partials/csrf', { _csrfField: reply.renderCsrfField() });
    });
    try {
      // 1. GET issues mc_csrf cookie + we extract the token from the rendered HTML.
      const getRes = await app.inject({ method: 'GET', url: '/__test_csrf_get' });
      const setCookie = getRes.headers['set-cookie'];
      expect(setCookie).toBeTruthy();
      const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie!;
      const tokenMatch = (getRes.body as string).match(/value="([A-Za-z0-9._\-]{16,})"/);
      expect(tokenMatch).toBeTruthy();
      const token = tokenMatch![1]!;

      // 2. POST with the cookie + form body containing _csrf=<token> → 200.
      //    This tests the getToken-body-fallback added in Task 1 Step 5.
      const post = await app.inject({
        method: 'POST',
        url: '/__test_csrf_post',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `_csrf=${encodeURIComponent(token)}`,
      });
      expect(post.statusCode).toBe(200);
      expect(post.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('flash partial renders message + level', async () => {
    const app = await buildServer(config);
    app.get('/__test_flash', async (_req, reply) => {
      return reply.view('partials/flash', { flash: { level: 'error', message: 'Boom' } });
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/__test_flash' });
      expect(res.body).toContain('class="flash flash-error"');
      expect(res.body).toContain('Boom');
    } finally {
      await app.close();
    }
  });
});
