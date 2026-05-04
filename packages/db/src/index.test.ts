import { describe, expect, it } from 'vitest';
import { createPrismaClient } from './index.js';

describe('db package', () => {
  it('exports a createPrismaClient factory that returns a PrismaClient', () => {
    expect(typeof createPrismaClient).toBe('function');
  });

  it('PrismaClient type knows about User, Invite, Session models', () => {
    const client = createPrismaClient();
    expect(typeof client.user.findFirst).toBe('function');
    expect(typeof client.invite.findFirst).toBe('function');
    expect(typeof client.session.findFirst).toBe('function');
    void client.$disconnect();
  });
});
