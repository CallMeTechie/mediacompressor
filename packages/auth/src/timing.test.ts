import { describe, expect, it } from 'vitest';
import { equalsConstantTime, dummyCompare, assertPepper } from './timing.js';

describe('timing', () => {
  it('equalsConstantTime returns true for identical buffers', () => {
    const a = Buffer.from('hello');
    const b = Buffer.from('hello');
    expect(equalsConstantTime(a, b)).toBe(true);
  });

  it('equalsConstantTime returns false for different content', () => {
    expect(equalsConstantTime(Buffer.from('hello'), Buffer.from('world'))).toBe(false);
  });

  it('equalsConstantTime returns false (without throwing) for different lengths', () => {
    expect(equalsConstantTime(Buffer.from('a'), Buffer.from('ab'))).toBe(false);
  });

  it('dummyCompare runs a real timingSafeEqual against a random buffer of given length', () => {
    expect(dummyCompare(32)).toBe(false);
  });

  it('assertPepper accepts a 32-byte buffer', () => {
    expect(() => assertPepper(Buffer.alloc(32))).not.toThrow();
  });

  it('assertPepper throws on buffer shorter than minBytes', () => {
    expect(() => assertPepper(Buffer.from('short'))).toThrow(/Pepper too short/);
    expect(() => assertPepper(Buffer.alloc(31))).toThrow(/Pepper too short/);
  });

  it('assertPepper throws on non-buffer input', () => {
    // @ts-expect-error testing runtime guard
    expect(() => assertPepper('not a buffer')).toThrow(/must be a Buffer/);
  });

  it('assertPepper accepts custom minBytes', () => {
    expect(() => assertPepper(Buffer.alloc(16), 16)).not.toThrow();
    expect(() => assertPepper(Buffer.alloc(15), 16)).toThrow(/Pepper too short/);
  });
});
