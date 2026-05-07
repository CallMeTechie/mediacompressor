import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
// so script-source paths are stable regardless of cwd.
const __dirname = dirname(fileURLToPath(import.meta.url));

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

describe('web/view-plugin', () => {
  it('serves /static/css/app.css with text/css mime', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/static/css/app.css' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/css/);
      expect(res.body).toContain('/* mediacompressor base styles */');
    } finally {
      await app.close();
    }
  });

  it('serves /static/vendor/htmx.min.js with javascript mime', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/static/vendor/htmx.min.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/javascript/);
      // Sanity: htmx 2.x file is >40 KB minified.
      expect(res.body.length).toBeGreaterThan(40_000);
    } finally {
      await app.close();
    }
  });

  it('rejects /static/../config.ts (path traversal)', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/static/../src/config.ts',
      });
      // @fastify/static must NOT serve files outside the configured root.
      expect([400, 403, 404]).toContain(res.statusCode);
    } finally {
      await app.close();
    }
  });

  it('app.view("home-placeholder", {title: "Home"}) renders <title>Home</title>', async () => {
    const app = await buildServer(config);
    app.get('/__test_view', async (_req, reply) => {
      return reply.view('home-placeholder', { title: 'Home' });
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/__test_view' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('<title>Home</title>');
      expect(res.body).toContain('<!doctype html>');
    } finally {
      await app.close();
    }
  });

  // WC6 PFLICHT-REGRESSIONSTEST — CSP-Header on HTML responses.
  it('WC6: HTML response carries content-security-policy header', async () => {
    const app = await buildServer(config);
    app.get('/__test_csp', async (_req, reply) => {
      return reply.view('home-placeholder', { title: 'CSP test' });
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/__test_csp' });
      expect(res.statusCode).toBe(200);
      const csp = res.headers['content-security-policy'];
      expect(csp).toBeTruthy();
      expect(csp).toMatch(/default-src 'self'/);
      expect(csp).toMatch(/script-src 'self'/);
    } finally {
      await app.close();
    }
  });

  // WC6 PFLICHT-REGRESSIONSTEST — JSON API responses MUST NOT have CSP.
  it('WC6: JSON-API response has NO content-security-policy header (regression-watch)', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-security-policy']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  // C8-LI PFLICHT-REGRESSIONSTEST — htmx-session-redirect.js is loaded GLOBALLY
  // on every HTML page (via base.hbs), not just SSE-pages. Without this, HTMX
  // polling responses that 303 to /login would silently swap the login HTML
  // into the page DOM.
  it('C8-LI: base layout loads /static/js/htmx-session-redirect.js on every HTML page', async () => {
    const app = await buildServer(config);
    app.get('/__test_session_redirect_script', async (_req, reply) => {
      return reply.view('home-placeholder', { title: 'session redirect' });
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/__test_session_redirect_script',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(
        '<script src="/static/js/htmx-session-redirect.js"',
      );
    } finally {
      await app.close();
    }
  });

  // C10-LI PFLICHT-REGRESSIONSTEST — htmx-session-redirect.js binds the literal
  // htmx-2.0.x event `htmx:beforeSwap` and cancels the swap by setting
  // `event.detail.shouldSwap = false` when the responseURL points at /login.
  // Read via fs and assert via REGEX so the test fails LOUD on future
  // htmx-3.0 bumps (event-name or detail-API shift) instead of silently
  // breaking session-redirect UX. The `\.shouldSwap` anchor enforces the
  // assignment lives on a property reference (matches the runtime statement
  // `ev.detail.shouldSwap = false`), not in a tidy-able comment.
  it('C10-LI: htmx-session-redirect.js literal-API regex (htmx:beforeSwap + shouldSwap)', () => {
    const scriptPath = join(
      __dirname,
      '..',
      '..',
      'public',
      'js',
      'htmx-session-redirect.js',
    );
    const src = readFileSync(scriptPath, 'utf-8');
    expect(src).toMatch(/addEventListener\(['"]htmx:beforeSwap['"]/);
    expect(src).toMatch(/\.shouldSwap\s*=\s*false/);
    expect(src).toMatch(/responseURL/);
  });

  // Task 4: htmx-ext-sse extension is vendored under /static/vendor/.
  it('Task 4: serves /static/vendor/htmx-ext-sse.min.js', async () => {
    const app = await buildServer(config);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/static/vendor/htmx-ext-sse.min.js',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/javascript/);
      // Sanity: htmx-ext-sse min is at least ~1 KB.
      expect(res.body.length).toBeGreaterThan(1_000);
    } finally {
      await app.close();
    }
  });

  // WC1 PFLICHT-REGRESSIONSTEST — trustProxy honors loopback x-forwarded-for.
  // Verifies that when an in-process app.inject() spoofs x-forwarded-for, the
  // inner handler's req.ip reflects the spoofed value. Without trustProxy, the
  // BFF rate-limit sees 127.0.0.1 for ALL logins and the per-IP budget collapses.
  it('WC1: req.ip reflects x-forwarded-for from loopback (trustProxy enabled)', async () => {
    const app = await buildServer(config);
    let observedIp: string | undefined;
    app.get('/__test_ip', async (req) => {
      observedIp = req.ip;
      return { ip: req.ip };
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/__test_ip',
        headers: { 'x-forwarded-for': '203.0.113.42' },
      });
      expect(res.statusCode).toBe(200);
      expect(observedIp).toBe('203.0.113.42');
    } finally {
      await app.close();
    }
  });
});
