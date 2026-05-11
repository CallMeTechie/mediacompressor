import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { compressImage } from './image-engine.js';

const FIXTURES = join(import.meta.dirname, '..', 'test-fixtures');
let outDir: string;

// Probe runtime libheif-decoder availability at module-load time. In CI
// (Ubuntu runner without libheif-plugin-libde265) sharp's prebuilt-libvips
// fails with "No decoding plugin installed" / "bad seek". Locally (Plan 2
// Task 4-bis env) the probe succeeds and both HEIC/AVIF tests run.
// Must run synchronously at registration time because `it.skipIf` evaluates
// its condition before `beforeAll` hooks fire.
const heifDecoderAvailable = await (async () => {
  try {
    await sharp(join(FIXTURES, 'tiny.heic')).metadata();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/No decoding plugin/.test(msg) || /bad seek/.test(msg)) {
      console.warn(
        '[image-engine.test] SKIP: HEIC/AVIF tests — libheif decoder plugin not installed in this environment.',
      );
      return false;
    }
    throw err; // unexpected error — surface it
  }
})();

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

describe('compressImage — resize', () => {
  it('respects maxWidth (preserving aspect ratio)', async () => {
    const out = join(outDir, 'resize-w.webp');
    await compressImage({
      inputPath: join(FIXTURES, 'tiny.png'), // 256x256
      outputPath: out,
      profile: 'web-optimized',
      overrides: { targetFormat: 'webp', maxWidth: 100 },
      signal: new AbortController().signal,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100); // 1:1 ratio preserved
  });

  it('respects maxHeight when stricter than maxWidth', async () => {
    const out = join(outDir, 'resize-h.webp');
    await compressImage({
      inputPath: join(FIXTURES, 'tiny.png'),
      outputPath: out,
      profile: 'web-optimized',
      overrides: { targetFormat: 'webp', maxWidth: 200, maxHeight: 50 },
      signal: new AbortController().signal,
    });
    const meta = await sharp(out).metadata();
    expect(meta.height).toBeLessThanOrEqual(50);
  });

  it('does NOT upscale when image is already smaller', async () => {
    const out = join(outDir, 'no-upscale.webp');
    await compressImage({
      inputPath: join(FIXTURES, 'tiny.png'), // 256x256
      outputPath: out,
      profile: 'web-optimized',
      overrides: { targetFormat: 'webp', maxWidth: 1000 },
      signal: new AbortController().signal,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(256);
  });
});

describe('compressImage — security regressions', () => {
  it('rejects pixel-bomb PNG with limitInputPixels-specific error (C4-Fix)', async () => {
    // bomb.png is a VALID PNG of 16001x16001 (256_032_001 pixels) — it exceeds
    // the 256_000_000 limitInputPixels cap and must be rejected by sharp's
    // limit, not by malformed-PNG detection.
    const out = join(outDir, 'bomb.webp');
    await expect(
      compressImage({
        inputPath: join(FIXTURES, 'bomb.png'),
        outputPath: out,
        profile: 'web-optimized',
        overrides: { targetFormat: 'webp' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/pixel limit|input image exceeds|limitInputPixels/i);
  });

  it('rejects path-traversal targetFormat (allowlist), not interpolating into pipeline', async () => {
    const out = join(outDir, 'evil.bin');
    await expect(
      compressImage({
        inputPath: join(FIXTURES, 'tiny.png'),
        outputPath: out,
        profile: 'web-optimized',
        overrides: { targetFormat: '../../../etc/passwd' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/UNSUPPORTED_OUTPUT_FORMAT/);
  });
});

describe('compressImage — HEIC and AVIF input', () => {
  it.skipIf(!heifDecoderAvailable)('reads HEIC and converts to WebP', async () => {
    const out = join(outDir, 'heic.webp');
    const result = await compressImage({
      inputPath: join(FIXTURES, 'tiny.heic'),
      outputPath: out,
      profile: 'web-optimized',
      overrides: { targetFormat: 'webp' },
      signal: new AbortController().signal,
    });
    expect(result.outputFormat).toBe('webp');
  });

  it.skipIf(!heifDecoderAvailable)('reads AVIF and converts to JPEG', async () => {
    const out = join(outDir, 'avif.jpg');
    const result = await compressImage({
      inputPath: join(FIXTURES, 'tiny.avif'),
      outputPath: out,
      profile: 'web-optimized',
      overrides: { targetFormat: 'jpeg' },
      signal: new AbortController().signal,
    });
    expect(result.outputFormat).toBe('jpeg');
  });
});
