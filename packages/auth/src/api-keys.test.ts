import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, verifyApiKey, parseApiKey } from './api-keys.js';

const PEPPER = Buffer.from('a'.repeat(32));

describe('api-keys', () => {
  it('generateApiKey returns "mc_<prefix-8>_<random>" format', () => {
    const { key, prefix } = generateApiKey();
    expect(key).toMatch(/^mc_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]+$/);
    expect(key.startsWith('mc_' + prefix + '_')).toBe(true);
    expect(prefix.length).toBe(8);
  });

  it('hashApiKey is deterministic (same input → same output)', () => {
    const h1 = hashApiKey('mc_aaaaaaaa_xyz', PEPPER);
    const h2 = hashApiKey('mc_aaaaaaaa_xyz', PEPPER);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashApiKey changes when pepper changes', () => {
    const h1 = hashApiKey('mc_a_x', PEPPER);
    const h2 = hashApiKey('mc_a_x', Buffer.from('b'.repeat(32)));
    expect(h1).not.toBe(h2);
  });

  it('verifyApiKey returns true for matching hash', () => {
    const { key } = generateApiKey();
    const stored = hashApiKey(key, PEPPER);
    expect(verifyApiKey(key, stored, PEPPER)).toBe(true);
  });

  it('verifyApiKey returns false for tampered hash', () => {
    const { key } = generateApiKey();
    const stored = hashApiKey(key, PEPPER);
    const tampered = '0' + stored.slice(1);
    expect(verifyApiKey(key, tampered, PEPPER)).toBe(false);
  });

  it('parseApiKey extracts prefix or returns null for malformed input', () => {
    expect(parseApiKey('mc_aaaaaaaa_xyz')).toEqual({ prefix: 'aaaaaaaa', body: 'xyz' });
    expect(parseApiKey('not-a-key')).toBeNull();
    expect(parseApiKey('mc__missing-prefix')).toBeNull();
  });

  it('verifyApiKey latency for miss is within 5× of hit (C4-Rev3 stopwatch — hardened)', () => {
    const { key } = generateApiKey();
    const stored = hashApiKey(key, PEPPER);
    const tampered = '0'.repeat(64);

    // Warm-up V8/JIT for both paths
    for (let i = 0; i < 1000; i++) {
      verifyApiKey(key, stored, PEPPER);
      verifyApiKey(key, tampered, PEPPER);
    }

    const ITER = 10_000;
    const measure = (run: () => void): number => {
      const start = process.hrtime.bigint();
      for (let i = 0; i < ITER; i++) run();
      return Number(process.hrtime.bigint() - start);
    };

    // Best-of-3: take the run with smallest jitter difference. Naive non-constant-
    // time implementation diverges by 100×+ — threshold 5 has comfortable margin
    // against CI jitter while still catching obvious leaks.
    const ratios: number[] = [];
    for (let i = 0; i < 3; i++) {
      const hit = measure(() => verifyApiKey(key, stored, PEPPER));
      const miss = measure(() => verifyApiKey(key, tampered, PEPPER));
      ratios.push(Math.max(hit, miss) / Math.min(hit, miss));
    }
    const bestRatio = Math.min(...ratios);
    expect(bestRatio).toBeLessThan(5);
  });

  it('rejects pepper shorter than 32 bytes (C4-Rev1 defense-in-depth)', () => {
    const { key } = generateApiKey();
    expect(() => hashApiKey(key, Buffer.from('short'))).toThrow(/Pepper too short/);
    expect(() => verifyApiKey(key, '0'.repeat(64), Buffer.from('short'))).toThrow(
      /Pepper too short/,
    );
  });
});
