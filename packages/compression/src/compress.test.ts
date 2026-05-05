import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compress } from './compress.js';

const FIXTURES = join(import.meta.dirname, '..', 'test-fixtures');
let outDir: string;

beforeAll(() => { outDir = mkdtempSync(join(tmpdir(), 'mc-compress-test-')); });
afterAll(() => { rmSync(outDir, { recursive: true, force: true }); });

describe('compress (façade)', () => {
  it('dispatches image input to image-engine', async () => {
    const out = join(outDir, 'a.webp');
    const result = await compress({
      inputPath: join(FIXTURES, 'tiny.png'),
      outputPath: out,
      profile: 'web-optimized',
      overrides: { targetFormat: 'webp' },
      signal: new AbortController().signal,
    });
    expect(result.outputFormat).toBe('webp');
    expect(statSync(out).isFile()).toBe(true);
  });

  it('dispatches video input to video-engine', async () => {
    const out = join(outDir, 'a.webm');
    const result = await compress({
      inputPath: join(FIXTURES, 'tiny.mp4'),
      outputPath: out,
      profile: 'web-optimized',
      overrides: { targetFormat: 'webm' },
      signal: new AbortController().signal,
    });
    expect(result.outputFormat).toBe('webm');
  });

  it('rejects unrecognized input file (no MIME detected)', async () => {
    const garbage = join(outDir, 'garbage.bin');
    writeFileSync(garbage, 'not a media file');
    await expect(
      compress({
        inputPath: garbage,
        outputPath: join(outDir, 'x.webp'),
        profile: 'web-optimized',
        overrides: { targetFormat: 'webp' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });
});
