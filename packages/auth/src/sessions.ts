import { createHmac, randomBytes } from 'node:crypto';
import { assertPepper, equalsConstantTime } from './timing.js';

const TOKEN_BYTES = 32;

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string, pepper: Buffer): string {
  assertPepper(pepper);
  return createHmac('sha256', pepper).update(token).digest('hex');
}

export function verifySessionToken(token: string, storedHashHex: string, pepper: Buffer): boolean {
  assertPepper(pepper);
  const candidate = Buffer.from(hashSessionToken(token, pepper), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHashHex, 'hex');
  } catch {
    return false;
  }
  return equalsConstantTime(candidate, stored);
}
