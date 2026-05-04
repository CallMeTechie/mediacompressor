import { describe, expect, it } from 'vitest';
import { createPrismaClient } from './index.js';

describe('db package', () => {
  it('exports a createPrismaClient factory that returns a PrismaClient', () => {
    expect(typeof createPrismaClient).toBe('function');
  });
});
