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

  // Plan 8e Task 2: locale-aware error pages. With `mc_locale=de` cookie set,
  // 404/500 templates must render German strings — proving the i18n migration
  // wired the templates + handler-passed titles through `req.t(... , 'common')`
  // and didn't silently fall back to English on the chrome layer.
  it('renders 404 page in DE when mc_locale=de cookie is set', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/this-route-does-not-exist',
        headers: { cookie: 'mc_locale=de', accept: 'text/html' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/Seite nicht gefunden/);
    } finally {
      await app.close();
    }
  });

  it('renders 500 page in DE when mc_locale=de cookie is set', async () => {
    const app = await buildServer(config);
    app.get('/__test_throw_de', async () => {
      throw new Error('boom');
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/__test_throw_de',
        headers: { cookie: 'mc_locale=de', accept: 'text/html' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/Interner Server-Fehler/);
    } finally {
      await app.close();
    }
  });

  // Plan 8e Task 2 review (Concern #6) PFLICHT-Regressionstest:
  // The layout-base nav's brand link MUST be visible on unauthenticated
  // pages (404, 500, /login) so users can always click "home". Earlier
  // iterations of this task wrapped the entire <nav> in a
  // {{#if currentUser}} guard, hiding the brand for logged-out users —
  // this test pins the spec'd behavior so a future regression that
  // re-gates the brand would fail loudly instead of silently shipping.
  // Authenticated nav-links (jobs/profile/admin/logout) stay gated; only
  // the brand and the surrounding <nav class="site-nav"> chrome render.
  it('layout-nav brand link is visible on unauthenticated 404 page', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/this-route-does-not-exist',
        headers: { accept: 'text/html' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toMatch(
        /<a[^>]*class="brand"[^>]*href="\/"|<a[^>]*href="\/"[^>]*class="brand"/,
      );
      expect(res.body).toMatch(/MediaCompressor/);
      // Authenticated nav-chrome MUST NOT render — no logout-form, no
      // /jobs / /profile / /admin links — when there is no session cookie.
      expect(res.body).not.toMatch(/<form[^>]*action="\/logout"/);
    } finally {
      await app.close();
    }
  });
});
