import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectMime, MimeMismatchError, verifyClaimedMime } from './magic-number.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'compression', 'test-fixtures');

describe('magic-number', () => {
  it('detectMime returns image/png for tiny.png', async () => {
    const buf = await readFile(join(FIXTURES, 'tiny.png'));
    expect(await detectMime(buf)).toBe('image/png');
  });

  it('detectMime returns image/jpeg for tiny.jpg', async () => {
    const buf = await readFile(join(FIXTURES, 'tiny.jpg'));
    expect(await detectMime(buf)).toBe('image/jpeg');
  });

  it('detectMime returns video/mp4 for tiny.mp4', async () => {
    const buf = await readFile(join(FIXTURES, 'tiny.mp4'));
    expect(await detectMime(buf)).toBe('video/mp4');
  });

  it('verifyClaimedMime returns silently when claimed matches actual', async () => {
    const buf = await readFile(join(FIXTURES, 'tiny.png'));
    await expect(verifyClaimedMime(buf, 'image/png')).resolves.toBeUndefined();
  });

  it('verifyClaimedMime throws MimeMismatchError when claimed lies', async () => {
    const buf = await readFile(join(FIXTURES, 'tiny.png'));
    await expect(verifyClaimedMime(buf, 'image/jpeg')).rejects.toBeInstanceOf(MimeMismatchError);
  });

  it('verifyClaimedMime throws when file format is unrecognisable', async () => {
    const garbage = Buffer.from('not a real file');
    await expect(verifyClaimedMime(garbage, 'image/png')).rejects.toBeInstanceOf(MimeMismatchError);
  });

  it('detectMimeFromFile reads only the head of the file (no full-file load)', async () => {
    const { detectMimeFromFile } = await import('./magic-number.js');
    const mime = await detectMimeFromFile(join(FIXTURES, 'tiny.mp4'));
    expect(mime).toBe('video/mp4');
  });
});
