import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwords.js';

describe('passwords', () => {
  it('hashes and verifies a password successfully', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('secret');
    expect(await verifyPassword(hash, 'guess')).toBe(false);
  });

  it('uses argon2id variant (not argon2i or argon2d)', async () => {
    const hash = await hashPassword('x');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('produces different hashes for the same password (salt)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });

  it('verifies an algorithm-tag-tampered hash as false (defense in depth)', async () => {
    const hash = await hashPassword('x');
    const tampered = hash.replace('$argon2id$', '$argon2i$');
    expect(await verifyPassword(tampered, 'x')).toBe(false);
  });
});
