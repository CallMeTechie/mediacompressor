import { createHmac, randomBytes } from 'node:crypto';
import { assertPepper, equalsConstantTime } from './timing.js';

const PREFIX_LEN = 8;
const BODY_BYTES = 32;

/**
 * Generates a new API key.
 * Format: `mc_<prefix-8>_<random-32-bytes-base64url>`.
 */
export function generateApiKey(): { key: string; prefix: string } {
  const raw = randomBytes(PREFIX_LEN + BODY_BYTES);
  const prefix = raw.subarray(0, PREFIX_LEN).toString('base64url').slice(0, PREFIX_LEN);
  const body = raw.subarray(PREFIX_LEN).toString('base64url');
  return { key: `mc_${prefix}_${body}`, prefix };
}

/**
 * HMAC-SHA-256(pepper, key) in lowercase hex. Deterministic → indexable.
 */
export function hashApiKey(key: string, pepper: Buffer): string {
  assertPepper(pepper);
  return createHmac('sha256', pepper).update(key).digest('hex');
}

/**
 * Constant-time verification of a key against its stored HMAC hash.
 */
export function verifyApiKey(key: string, storedHashHex: string, pepper: Buffer): boolean {
  assertPepper(pepper);
  const candidate = Buffer.from(hashApiKey(key, pepper), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHashHex, 'hex');
  } catch {
    return false;
  }
  return equalsConstantTime(candidate, stored);
}

/**
 * Pull the 8-char prefix and body out of a key string. Returns null on malformed.
 */
export function parseApiKey(key: string): { prefix: string; body: string } | null {
  const match = key.match(/^mc_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  return { prefix: match[1]!, body: match[2]! };
}
