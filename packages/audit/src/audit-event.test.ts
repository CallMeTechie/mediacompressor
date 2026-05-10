import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@mediacompressor/db';
import {
  cleanupTestUsers,
  createTestUser,
  testDatabaseUrl,
} from '@mediacompressor/test-helpers';
import { recordAuditEvent } from './audit-event.js';

const ACTOR_EMAIL = 'audit-event-test-actor@test.invalid';
const TARGET_EMAIL = 'audit-event-test-target@test.invalid';
const TEST_EMAILS = [ACTOR_EMAIL, TARGET_EMAIL];

describe('audit-event/recordAuditEvent', () => {
  let prisma: PrismaClient;
  let actorId: string;
  let targetId: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
    await cleanupTestUsers(prisma, TEST_EMAILS);
    const actor = await createTestUser(prisma, { email: ACTOR_EMAIL });
    const target = await createTestUser(prisma, { email: TARGET_EMAIL });
    actorId = actor.id;
    targetId = target.id;
  });

  afterAll(async () => {
    await cleanupTestUsers(prisma, TEST_EMAILS);
    await prisma.$disconnect();
  });

  it('happy path: writes a row and returns {id, createdAt}', async () => {
    const result = await recordAuditEvent(prisma, {
      actorUserId: actorId,
      action: 'user_update',
      targetType: 'user',
      targetId,
      payload: { note: 'hello' },
    });
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.createdAt).toBeInstanceOf(Date);

    const stored = await prisma.auditEvent.findUnique({ where: { id: result.id } });
    expect(stored).toMatchObject({
      actorUserId: actorId,
      action: 'user_update',
      targetType: 'user',
      targetId,
    });
    expect(stored?.payload).toEqual({ note: 'hello' });

    await prisma.auditEvent.delete({ where: { id: result.id } });
  });

  it('BigInt-safe: coerces bigint payload values to decimal strings', async () => {
    // Plan 8d Task 4 Concern 6 Lehre carry-forward.
    const result = await recordAuditEvent(prisma, {
      actorUserId: actorId,
      action: 'user_update',
      targetType: 'user',
      targetId,
      payload: { storageQuota: 1073741824n, role: 'admin' },
    });
    const stored = await prisma.auditEvent.findUnique({ where: { id: result.id } });
    expect(stored?.payload).toEqual({ storageQuota: '1073741824', role: 'admin' });
    await prisma.auditEvent.delete({ where: { id: result.id } });
  });

  it('FK violation: rejects with invalid actorUserId', async () => {
    await expect(
      recordAuditEvent(prisma, {
        actorUserId: '00000000-0000-0000-0000-000000000999',
        action: 'user_update',
        targetType: 'user',
        targetId,
      }),
    ).rejects.toThrow();
  });

  for (const key of [
    'token',
    'password',
    'passwordHash',
    'secret',
    'apiKey',
    'sessionToken',
  ]) {
    it(`FORBIDDEN_PAYLOAD_KEYS: rejects payload-key "${key}"`, async () => {
      await expect(
        recordAuditEvent(prisma, {
          actorUserId: actorId,
          action: 'user_update',
          targetType: 'user',
          targetId,
          payload: { [key]: 'secret-value' },
        }),
      ).rejects.toThrow(/disallowed payload key/i);
    });
  }

  it('payload undefined: stores SQL NULL (Prisma.DbNull)', async () => {
    const result = await recordAuditEvent(prisma, {
      actorUserId: actorId,
      action: 'invite_revoke',
      targetType: 'invite',
      targetId: '33333333-3333-3333-3333-333333333333',
    });
    const stored = await prisma.auditEvent.findUnique({ where: { id: result.id } });
    expect(stored?.payload).toBeNull();
    await prisma.auditEvent.delete({ where: { id: result.id } });
  });

  it('PFLICHT WC-audit-9: coerces bigint inside arrays', async () => {
    const result = await recordAuditEvent(prisma, {
      actorUserId: actorId,
      action: 'user_update',
      targetType: 'user',
      targetId,
      payload: { ids: [1n, 2n, 3n], plain: 'foo' },
    });
    const stored = await prisma.auditEvent.findUnique({ where: { id: result.id } });
    expect(stored?.payload).toEqual({ ids: ['1', '2', '3'], plain: 'foo' });
    await prisma.auditEvent.delete({ where: { id: result.id } });
  });

  it('PFLICHT WC-audit-9: rejects single-object self-reference', async () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    await expect(
      recordAuditEvent(prisma, {
        actorUserId: actorId,
        action: 'user_update',
        targetType: 'user',
        targetId,
        payload: cyclic,
      }),
    ).rejects.toThrow(/cyclic reference/);
  });

  it('PFLICHT WC-audit-9: rejects nesting > 10 levels', async () => {
    let nested: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 12; i++) nested = { wrap: nested };
    await expect(
      recordAuditEvent(prisma, {
        actorUserId: actorId,
        action: 'user_update',
        targetType: 'user',
        targetId,
        payload: nested,
      }),
    ).rejects.toThrow(/nesting depth/);
  });

  it('PFLICHT WC-audit-16: rejects 2-step (mutual) cyclic references', async () => {
    // a.b -> b, b.a -> a: mutual cycle. With seen.add at coercePayload entry,
    // this triggers the explicit cyclic-reference error rather than only
    // failing via the depth-limit (which would mask the real cause).
    // Concern 7: tightened from /cyclic reference|nesting depth/ to require
    // the explicit cycle-detector to fire (not the depth-limit fallback).
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a };
    a.b = b;
    await expect(
      recordAuditEvent(prisma, {
        actorUserId: actorId,
        action: 'user_update',
        targetType: 'user',
        targetId,
        payload: a,
      }),
    ).rejects.toThrow(/cyclic reference/);
  });

  it('PFLICHT WC-audit-9 Concern 1: rejects self-referential arrays as cyclic, not depth-error', async () => {
    // a[1] === a: cyclic array (no objects involved). Without array-tracking
    // in `seen`, this would only fail via the depth-limit (masking root cause).
    const a: unknown[] = [1];
    a.push(a);
    await expect(
      recordAuditEvent(prisma, {
        actorUserId: actorId,
        action: 'user_update',
        targetType: 'user',
        targetId,
        payload: { ids: a },
      }),
    ).rejects.toThrow(/cyclic reference/);
  });

  it('PFLICHT WC-audit-9 Concern 2-date: serializes Date to ISO-string', async () => {
    const result = await recordAuditEvent(prisma, {
      actorUserId: actorId,
      action: 'invite_create',
      targetType: 'invite',
      targetId,
      payload: { expiresAt: new Date('2026-12-31T00:00:00Z') },
    });
    const stored = await prisma.auditEvent.findUnique({ where: { id: result.id } });
    expect(stored?.payload).toEqual({ expiresAt: '2026-12-31T00:00:00.000Z' });
    await prisma.auditEvent.delete({ where: { id: result.id } });
  });

  it('PFLICHT WC-audit-9 Concern 2-class: rejects Map / Set / RegExp instances', async () => {
    await expect(
      recordAuditEvent(prisma, {
        actorUserId: actorId,
        action: 'user_update',
        targetType: 'user',
        targetId,
        payload: { lookup: new Map() },
      }),
    ).rejects.toThrow(/unsupported payload value-type/);
    await expect(
      recordAuditEvent(prisma, {
        actorUserId: actorId,
        action: 'user_update',
        targetType: 'user',
        targetId,
        payload: { unique: new Set() },
      }),
    ).rejects.toThrow(/unsupported payload value-type/);
    await expect(
      recordAuditEvent(prisma, {
        actorUserId: actorId,
        action: 'user_update',
        targetType: 'user',
        targetId,
        payload: { pattern: /foo/ },
      }),
    ).rejects.toThrow(/unsupported payload value-type/);
  });

  it('PFLICHT WC-audit-9 Concern 3: rejects function / symbol values', async () => {
    await expect(
      recordAuditEvent(prisma, {
        actorUserId: actorId,
        action: 'user_update',
        targetType: 'user',
        targetId,
        payload: { handler: () => 'leak' },
      }),
    ).rejects.toThrow(/unsupported payload value-type: function/);
    await expect(
      recordAuditEvent(prisma, {
        actorUserId: actorId,
        action: 'user_update',
        targetType: 'user',
        targetId,
        payload: { marker: Symbol('leak') },
      }),
    ).rejects.toThrow(/unsupported payload value-type: symbol/);
  });

  it('PFLICHT WC-audit-1 Concern 6-case: rejects FORBIDDEN keys with mixed-case', async () => {
    // Adversary-typo prevention: case-insensitive lookup against lowercase set.
    // Note: snake_case/kebab-case variants (e.g. "api_key") are NOT covered by
    // the lowercase-compare; they would need separate entries. v0.1.0 scope.
    for (const key of ['Token', 'TOKEN', 'PassWord', 'apiKey', 'APIKEY', 'SessionToken']) {
      await expect(
        recordAuditEvent(prisma, {
          actorUserId: actorId,
          action: 'user_update',
          targetType: 'user',
          targetId,
          payload: { [key]: 'should-leak' },
        }),
      ).rejects.toThrow(/disallowed payload key/);
    }
  });

  it('PFLICHT WC-audit-11: rejects payload > 4096 bytes', async () => {
    const big = { huge: 'x'.repeat(5000) };
    await expect(
      recordAuditEvent(prisma, {
        actorUserId: actorId,
        action: 'user_update',
        targetType: 'user',
        targetId,
        payload: big,
      }),
    ).rejects.toThrow(/exceeds 4096 bytes/);
  });

  it('PFLICHT WC-audit-14: @mediacompressor/audit exports NO mutating audit-APIs', async () => {
    const exports = await import('./index.js');
    const exportNames = Object.keys(exports);
    // recordAuditEvent is the ONLY mutation-API; everything else is types/constants/validators.
    const mutating = exportNames.filter((n) =>
      /update|delete|drop|truncate|modify|patch/i.test(n),
    );
    expect(mutating).toEqual([]);
    expect(exportNames).toContain('recordAuditEvent');
  });
});
