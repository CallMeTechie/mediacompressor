import { randomBytes, timingSafeEqual } from 'node:crypto';

export function equalsConstantTime(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function dummyCompare(length: number): boolean {
  const a = randomBytes(length);
  const b = randomBytes(length);
  return timingSafeEqual(a, b);
}

/**
 * Validate that a pepper buffer is at least `minBytes` long.
 * Defense-in-Depth (C4-Rev1): empty or too-short peppers reduce HMAC security
 * to plain SHA-256 of input. Helpers (`hashApiKey`, `hashSessionToken`, …)
 * call this at entry to fail fast on misconfiguration of `API_KEY_PEPPER`.
 */
export function assertPepper(pepper: Buffer, minBytes = 32): asserts pepper is Buffer {
  if (!Buffer.isBuffer(pepper)) {
    throw new Error('Pepper must be a Buffer');
  }
  if (pepper.length < minBytes) {
    throw new Error(`Pepper too short: ${pepper.length} < ${minBytes} bytes`);
  }
}
