import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as fs from 'node:fs';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';

// ESM-Caveat: A direct `vi.spyOn(fs, 'statfsSync')` fails with "Cannot redefine
// property" because `node:fs`'s namespace is read-only. `vi.mock` patches the
// module at resolver level. We default-delegate to the real implementation so
// only Test 5 (diskFree-fails-gracefully) flips it via `mockImplementationOnce`.
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof fs>();
  return {
    ...actual,
    statfsSync: vi.fn(actual.statfsSync),
  };
});

// Late dynamic import so we get the mocked module (after `vi.mock` hoists).
const mockedFs = await import('node:fs');
import {
  TEST_API_KEY_PEPPER,
  TEST_SESSION_SECRET,
  TEST_CSRF_SECRET,
  testDatabaseUrl,
  testRedisUrl,
  createTestUser,
  cleanupTestUsers,
} from '@mediacompressor/test-helpers';
import { buildServer } from '../server.js';
import type { Config } from '../config.js';

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
  ENABLE_LEGACY_JOB_STUB: false,
};

interface LoginCreds {
  session: string;
  csrfCookie: string;
  csrfToken: string;
}

async function loginAndGetCreds(
  app: Awaited<ReturnType<typeof buildServer>>,
  email: string,
  password = 'hunter22hunter22',
): Promise<LoginCreds> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (login.statusCode !== 200) {
    throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  }
  const session = login.cookies.find((c) => c.name === 'mc_session')!.value;
  const csrfCookie = login.cookies.find((c) => c.name === 'mc_csrf')!.value;
  const csrfToken = (login.json() as { csrfToken: string }).csrfToken;
  return { session, csrfCookie, csrfToken };
}

// Per-describe scoped emails for parallel-test isolation.
const TEST_EMAILS_AUTH = [
  'stats-auth-admin@test.invalid',
  'stats-auth-user@test.invalid',
];
const TEST_EMAILS_HAPPY = [
  'stats-happy-admin@test.invalid',
  'stats-happy-user@test.invalid',
];
const TEST_EMAILS_QUEUE = [
  'stats-queue-admin@test.invalid',
];
const TEST_EMAILS_DISKFREE = [
  'stats-disk-admin@test.invalid',
];

async function drainCompressionQueue(redis: IORedis): Promise<void> {
  const keys = await redis.keys('bull:compression:*');
  if (keys.length > 0) await redis.del(...keys);
}

describe('admin stats route — auth/role guards', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId_admin: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS_AUTH);

    const adm = await createTestUser(prisma, { email: 'stats-auth-admin@test.invalid' });
    userId_admin = adm.id;
    await prisma.user.update({
      where: { id: userId_admin },
      data: { role: 'admin' },
    });

    await createTestUser(prisma, { email: 'stats-auth-user@test.invalid' });
  });

  beforeEach(async () => {
    for (const email of TEST_EMAILS_AUTH) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS_AUTH);
    await prisma.$disconnect();
    await redis.quit();
  });

  // Test 1: Non-admin user → 403 FORBIDDEN.
  it('GET as non-admin user → 403 FORBIDDEN', async () => {
    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'stats-auth-user@test.invalid');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/stats',
      headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    await app.close();
  });

  // Test 2: Unauth → 401 AUTH_REQUIRED.
  it('GET unauth (no session, no Bearer) → 401 AUTH_REQUIRED', async () => {
    const app = await buildServer(config);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/stats',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    await app.close();
  });
});

describe('admin stats route — GET happy path', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let userId_admin: string;
  let userId_user: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS_HAPPY);
    await drainCompressionQueue(redis);

    const adm = await createTestUser(prisma, { email: 'stats-happy-admin@test.invalid' });
    userId_admin = adm.id;
    await prisma.user.update({
      where: { id: userId_admin },
      data: { role: 'admin' },
    });

    const u = await createTestUser(prisma, { email: 'stats-happy-user@test.invalid' });
    userId_user = u.id;
  });

  beforeEach(async () => {
    for (const email of TEST_EMAILS_HAPPY) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
    // Clean per-test job state.
    await prisma.job.deleteMany({ where: { userId: { in: [userId_admin, userId_user] } } });
    await drainCompressionQueue(redis);
  });

  afterAll(async () => {
    await prisma.job.deleteMany({ where: { userId: { in: [userId_admin, userId_user] } } });
    await cleanupTestUsers(prisma, TEST_EMAILS_HAPPY);
    await drainCompressionQueue(redis);
    await prisma.$disconnect();
    await redis.quit();
  });

  it('GET happy — aggregates users, jobs, storage, queue; BigInt-as-string', async () => {
    // Seed jobs in various statuses for the test user.
    // 2 queued, 1 processing, 3 succeeded (with outputBytes), 1 failed.
    // One succeeded job is expired (expiresAt < now) — should NOT count toward storage.
    const baseUploadId = `stats-happy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = new Date();
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 3_600_000);

    await prisma.job.createMany({
      data: [
        {
          userId: userId_user,
          uploadId: `${baseUploadId}-q1`,
          status: 'queued',
          kind: 'image',
          profile: 'web-optimized',
          overrides: {},
          inputFilename: 'q1.bin',
        },
        {
          userId: userId_user,
          uploadId: `${baseUploadId}-q2`,
          status: 'queued',
          kind: 'image',
          profile: 'web-optimized',
          overrides: {},
          inputFilename: 'q2.bin',
        },
        {
          userId: userId_user,
          uploadId: `${baseUploadId}-p1`,
          status: 'processing',
          kind: 'image',
          profile: 'web-optimized',
          overrides: {},
          inputFilename: 'p1.bin',
        },
        // Succeeded with expiresAt=null (counts toward storage).
        {
          userId: userId_user,
          uploadId: `${baseUploadId}-s1`,
          status: 'succeeded',
          kind: 'image',
          profile: 'web-optimized',
          overrides: {},
          inputFilename: 's1.bin',
          outputBytes: 1000n,
          expiresAt: null,
        },
        // Succeeded with expiresAt in future (counts).
        {
          userId: userId_user,
          uploadId: `${baseUploadId}-s2`,
          status: 'succeeded',
          kind: 'image',
          profile: 'web-optimized',
          overrides: {},
          inputFilename: 's2.bin',
          outputBytes: 2500n,
          expiresAt: future,
        },
        // Succeeded but expired — should NOT count toward storage.
        {
          userId: userId_user,
          uploadId: `${baseUploadId}-s3`,
          status: 'succeeded',
          kind: 'image',
          profile: 'web-optimized',
          overrides: {},
          inputFilename: 's3.bin',
          outputBytes: 9999n,
          expiresAt: past,
        },
        {
          userId: userId_user,
          uploadId: `${baseUploadId}-f1`,
          status: 'failed',
          kind: 'image',
          profile: 'web-optimized',
          overrides: {},
          inputFilename: 'f1.bin',
        },
      ],
    });

    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'stats-happy-admin@test.invalid');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/stats',
      headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      users: { total: number };
      jobs: Record<string, number>;
      storage: {
        usedBytes: string;
        diskFree: { available: string; total: string } | null;
      };
      queue: { compressionWaiting: number; compressionActive: number };
    };

    // users.total — must equal current DB user count (other test files may also seed users,
    // but tests run serially so we compare against the live DB count at request time).
    const dbUserCount = await prisma.user.count();
    expect(body.users.total).toBe(dbUserCount);

    // jobs dictionary — verify groupBy mapping.
    expect(body.jobs.queued).toBe(2);
    expect(body.jobs.processing).toBe(1);
    expect(body.jobs.succeeded).toBe(3);
    expect(body.jobs.failed).toBe(1);

    // storage.usedBytes — sum of outputBytes from succeeded non-expired jobs.
    // Only s1 (1000) + s2 (2500) = 3500. s3 is expired and must be excluded.
    expect(typeof body.storage.usedBytes).toBe('string');
    expect(body.storage.usedBytes).toBe('3500');

    // queue counts are numbers (queue is empty after beforeEach drain).
    expect(typeof body.queue.compressionWaiting).toBe('number');
    expect(typeof body.queue.compressionActive).toBe('number');
    expect(body.queue.compressionWaiting).toBe(0);
    expect(body.queue.compressionActive).toBe(0);

    // diskFree is either {available:string,total:string} or null.
    if (body.storage.diskFree !== null) {
      expect(typeof body.storage.diskFree.available).toBe('string');
      expect(typeof body.storage.diskFree.total).toBe('string');
    }

    await app.close();
  });
});

describe('admin stats route — AP3: BullMQ Queue API used (not redis.llen)', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS_QUEUE);

    const adm = await createTestUser(prisma, { email: 'stats-queue-admin@test.invalid' });
    await prisma.user.update({
      where: { id: adm.id },
      data: { role: 'admin' },
    });
  });

  beforeEach(async () => {
    for (const email of TEST_EMAILS_QUEUE) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
    // Drain queue so we start from a known empty state and asserting >=1 is meaningful.
    await drainCompressionQueue(redis);
  });

  afterAll(async () => {
    await drainCompressionQueue(redis);
    await cleanupTestUsers(prisma, TEST_EMAILS_QUEUE);
    await prisma.$disconnect();
    await redis.quit();
  });

  // AP3 PFLICHT-REGRESSIONSTEST
  // Adding a real BullMQ job via the official Queue('compression').add(...) API
  // must increment queue.compressionWaiting in the response. This proves we use
  // the official BullMQ API (queue.getWaitingCount), not a fragile
  // `redis.llen('bull:compression:wait')` that depends on internal key layout.
  it('AP3 PFLICHT-REGRESSIONSTEST: BullMQ-added job increments compressionWaiting', async () => {
    const app = await buildServer(config);
    await app.ready();

    // Start: queue empty after beforeEach drain.
    const creds = await loginAndGetCreds(app, 'stats-queue-admin@test.invalid');
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/stats',
      headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
    });
    expect(before.statusCode).toBe(200);
    const beforeBody = before.json() as { queue: { compressionWaiting: number } };
    expect(beforeBody.queue.compressionWaiting).toBe(0);

    // Add a real BullMQ job with a unique jobId so it cannot collide.
    const uniqueJobId = `stats-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const queue = new Queue('compression', { connection: redis });
    try {
      await queue.add(
        'compress',
        {
          jobId: uniqueJobId,
          userId: 'noop-user',
          inputPath: '/dev/null',
          outputPath: '/dev/null',
          profile: 'web-optimized',
        },
        { jobId: uniqueJobId },
      );

      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/stats',
        headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
      });
      expect(after.statusCode).toBe(200);
      const afterBody = after.json() as { queue: { compressionWaiting: number } };
      // Use >=1 because no worker is running to drain it; this is robust
      // even if leftover events linger in the queue.
      expect(afterBody.queue.compressionWaiting).toBeGreaterThanOrEqual(1);
    } finally {
      await queue.close();
    }

    await app.close();
  });
});

describe('admin stats route — diskFree fails gracefully on statfs throw', () => {
  let prisma: PrismaClient;
  let redis: IORedis;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });
    redis = new IORedis(config.REDIS_URL);
    await cleanupTestUsers(prisma, TEST_EMAILS_DISKFREE);

    const adm = await createTestUser(prisma, { email: 'stats-disk-admin@test.invalid' });
    await prisma.user.update({
      where: { id: adm.id },
      data: { role: 'admin' },
    });
  });

  beforeEach(async () => {
    for (const email of TEST_EMAILS_DISKFREE) {
      await redis.del(`ratelimit:login:acct:${email}`);
    }
    await redis.del('ratelimit:login:ip:127.0.0.1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS_DISKFREE);
    await prisma.$disconnect();
    await redis.quit();
  });

  it('statfsSync throws → response 200 with storage.diskFree=null and other fields populated', async () => {
    // Flip the resolver-level mock to throw on the next call. `mockImplementationOnce`
    // restores the default (delegate-to-real) implementation after the throw.
    const statfsMock = mockedFs.statfsSync as unknown as ReturnType<typeof vi.fn>;
    statfsMock.mockImplementationOnce(() => {
      throw new Error('mock disk fail');
    });

    const app = await buildServer(config);
    await app.ready();

    const creds = await loginAndGetCreds(app, 'stats-disk-admin@test.invalid');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/stats',
      headers: { cookie: `mc_session=${creds.session}; mc_csrf=${creds.csrfCookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      users: { total: number };
      jobs: Record<string, number>;
      storage: {
        usedBytes: string;
        diskFree: { available: string; total: string } | null;
      };
      queue: { compressionWaiting: number; compressionActive: number };
    };

    expect(body.storage.diskFree).toBeNull();
    // Other fields must still be populated.
    expect(typeof body.users.total).toBe('number');
    expect(body.users.total).toBeGreaterThan(0);
    expect(typeof body.storage.usedBytes).toBe('string');
    expect(typeof body.queue.compressionWaiting).toBe('number');
    expect(typeof body.queue.compressionActive).toBe('number');

    await app.close();
  });
});
