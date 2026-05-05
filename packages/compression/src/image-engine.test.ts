import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { compressImage } from './image-engine.js';

const FIXTURES = join(import.meta.dirname, '..', 'test-fixtures');
let outDir: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'mc-img-test-'));
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('compressImage — format conversion', () => {
  it('JPEG → WebP produces valid WebP', async () => {
    const out = join(outDir, 'a.webp');
    const result = await compressImage({
      inputPath: join(FIXTURES, 'tiny.jpg'),
      outputPath: out,
      profile: 'web-optimized',
      overrides: { targetFormat: 'webp' },
      signal: new AbortController().signal,
    });
    expect(result.outputFormat).toBe('webp');
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
  });

  it('PNG → JPEG produces valid JPEG', async () => {
    const out = join(outDir, 'b.jpg');
    const result = await compressImage({
      inputPath: join(FIXTURES, 'tiny.png'),
      outputPath: out,
      profile: 'web-optimized',
      overrides: { targetFormat: 'jpeg' },
      signal: new AbortController().signal,
    });
    expect(result.outputFormat).toBe('jpeg');
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('AVIF output uses heif container (sharp identifies AVIF as heif)', async () => {
    const out = join(outDir, 'c.avif');
    await compressImage({
      inputPath: join(FIXTURES, 'tiny.png'),
      outputPath: out,
      profile: 'web-optimized',
      overrides: { targetFormat: 'avif' },
      signal: new AbortController().signal,
    });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('heif');
  });

  it('rejects unknown targetFormat', async () => {
    const out = join(outDir, 'x.foo');
    await expect(
      compressImage({
        inputPath: join(FIXTURES, 'tiny.png'),
        outputPath: out,
        profile: 'web-optimized',
        overrides: { targetFormat: 'foo' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/UNSUPPORTED_OUTPUT_FORMAT/);
  });
});
