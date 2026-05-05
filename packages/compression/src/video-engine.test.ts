import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compressVideo } from './video-engine.js';

const FIXTURES = join(import.meta.dirname, '..', 'test-fixtures');
let outDir: string;

beforeAll(() => { outDir = mkdtempSync(join(tmpdir(), 'mc-vid-test-')); });
afterAll(() => { rmSync(outDir, { recursive: true, force: true }); });

describe('compressVideo', () => {
  it('MP4 input produces valid WebM (VP9) output', async () => {
    const out = join(outDir, 'a.webm');
    const result = await compressVideo({
      inputPath: join(FIXTURES, 'tiny.mp4'),
      outputPath: out,
      profile: 'web-optimized',
      overrides: { targetFormat: 'webm' },
      signal: new AbortController().signal,
    });
    expect(result.outputFormat).toBe('webm');
    expect(statSync(out).size).toBeGreaterThan(0);
  });

  it('MP4 → MP4 (H.264) re-encode', async () => {
    const out = join(outDir, 'a.mp4');
    const result = await compressVideo({
      inputPath: join(FIXTURES, 'tiny.mp4'),
      outputPath: out,
      profile: 'mobile-low',
      overrides: { targetFormat: 'mp4' },
      signal: new AbortController().signal,
    });
    expect(result.outputFormat).toBe('mp4');
  });

  it('emits progress callbacks at least once during conversion', async () => {
    const out = join(outDir, 'progress.webm');
    const calls: number[] = [];
    await compressVideo({
      inputPath: join(FIXTURES, 'tiny.mp4'),
      outputPath: out,
      profile: 'web-optimized',
      overrides: { targetFormat: 'webm' },
      onProgress: (p) => calls.push(p),
      signal: new AbortController().signal,
    });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...calls)).toBe(100);
  });

  it('cancels via AbortSignal — uses slow.mp4 to avoid race', async () => {
    const out = join(outDir, 'cancel.webm');
    const ctrl = new AbortController();
    const promise = compressVideo({
      inputPath: join(FIXTURES, 'slow.mp4'),
      outputPath: out,
      profile: 'archive-medium',
      overrides: { targetFormat: 'webm' },
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 200);
    await expect(promise).rejects.toThrow(/CANCELED/);
    const { existsSync } = await import('node:fs');
    expect(existsSync(out)).toBe(false);
  });

  it('throws ENGINE_INPUT_CORRUPT for corrupt.mp4', async () => {
    const out = join(outDir, 'corrupt.webm');
    await expect(
      compressVideo({
        inputPath: join(FIXTURES, 'corrupt.mp4'),
        outputPath: out,
        profile: 'web-optimized',
        overrides: { targetFormat: 'webm' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/ENGINE_INPUT_CORRUPT/);
  });

  it('rejects unknown targetFormat', async () => {
    const out = join(outDir, 'x.foo');
    await expect(
      compressVideo({
        inputPath: join(FIXTURES, 'tiny.mp4'),
        outputPath: out,
        profile: 'web-optimized',
        overrides: { targetFormat: 'foo' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/UNSUPPORTED_OUTPUT_FORMAT/);
  });
});
