import { describe, expect, it } from 'vitest';
import { generateSessionToken, hashSessionToken, verifySessionToken } from './sessions.js';

const PEPPER = Buffer.from('s'.repeat(32));

describe('sessions', () => {
  it('generateSessionToken returns 43-44 char base64url string (32 random bytes)', () => {
    const t = generateSessionToken();
    expect(t.length).toBeGreaterThanOrEqual(42);
    expect(t.length).toBeLessThanOrEqual(44);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashSessionToken is deterministic and 64-char hex', () => {
    const t = 'fixed-token';
    const h1 = hashSessionToken(t, PEPPER);
    const h2 = hashSessionToken(t, PEPPER);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifySessionToken returns true for matching hash, false otherwise', () => {
    const t = generateSessionToken();
    const h = hashSessionToken(t, PEPPER);
    expect(verifySessionToken(t, h, PEPPER)).toBe(true);
    expect(verifySessionToken('different', h, PEPPER)).toBe(false);
  });

  it('rejects pepper shorter than 32 bytes', () => {
    expect(() => hashSessionToken('x', Buffer.from('short'))).toThrow(/Pepper too short/);
  });
});
