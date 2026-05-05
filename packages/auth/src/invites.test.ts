import { describe, expect, it } from 'vitest';
import { generateInviteToken, hashInviteToken, verifyInviteToken } from './invites.js';

const PEPPER = Buffer.from('i'.repeat(32));

describe('invites', () => {
  it('generateInviteToken returns base64url string', () => {
    const t = generateInviteToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThan(40);
  });

  it('hashInviteToken is deterministic', () => {
    const t = 'fixed';
    expect(hashInviteToken(t, PEPPER)).toBe(hashInviteToken(t, PEPPER));
  });

  it('verifyInviteToken returns true on match, false on mismatch', () => {
    const t = generateInviteToken();
    const h = hashInviteToken(t, PEPPER);
    expect(verifyInviteToken(t, h, PEPPER)).toBe(true);
    expect(verifyInviteToken('different', h, PEPPER)).toBe(false);
  });

  it('rejects pepper shorter than 32 bytes', () => {
    expect(() => hashInviteToken('x', Buffer.from('short'))).toThrow(/Pepper too short/);
  });
});
