import { describe, expect, it } from 'vitest';
import {
  IMAGE_OUTPUT_FORMATS,
  VIDEO_OUTPUT_FORMATS,
  PROFILES,
  type CompressionRequest,
  type CompressionResult,
  type Profile,
} from './index.js';

describe('compression types', () => {
  it('CompressionRequest shape matches Spec Sektion 3', () => {
    const req: CompressionRequest = {
      inputPath: '/media/uploads/u1/j1/source.bin',
      outputPath: '/media/results/u1/j1/output.webp',
      profile: 'web-optimized',
      signal: new AbortController().signal,
    };
    expect(req.profile).toBe('web-optimized');
  });

  it('CompressionResult shape matches Spec', () => {
    const res: CompressionResult = {
      outputPath: '/x',
      outputBytes: 0,
      inputBytes: 0,
      durationMs: 0,
      outputFormat: 'webp',
      metadata: {},
    };
    expect(res.outputBytes).toBe(0);
  });

  it('exports allowlists for image and video output formats', () => {
    expect(IMAGE_OUTPUT_FORMATS).toEqual(new Set(['jpeg', 'png', 'webp', 'avif']));
    expect(VIDEO_OUTPUT_FORMATS).toEqual(new Set(['mp4', 'webm']));
  });

  it('exports the canonical profile names', () => {
    expect(PROFILES).toContain('web-optimized');
    expect(PROFILES).toContain('mobile-low');
    expect(PROFILES).toContain('archive-medium');
  });

  it('Profile type is the union of PROFILES entries', () => {
    const p: Profile = 'web-optimized';
    expect(PROFILES).toContain(p);
  });
});
