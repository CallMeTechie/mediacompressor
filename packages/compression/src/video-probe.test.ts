import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeVideo, VideoProbeError } from './video-probe.js';

const FIXTURES = join(import.meta.dirname, '..', 'test-fixtures');

describe('probeVideo', () => {
  it('returns width, height, duration, codec for tiny.mp4', async () => {
    const meta = await probeVideo(join(FIXTURES, 'tiny.mp4'));
    expect(meta.width).toBe(16);
    expect(meta.height).toBe(16);
    expect(meta.duration).toBeGreaterThan(0.5);
    expect(meta.codec).toMatch(/h264|libx264/i);
  });

  it('throws VideoProbeError on corrupt input', async () => {
    await expect(probeVideo(join(FIXTURES, 'corrupt.mp4'))).rejects.toBeInstanceOf(VideoProbeError);
  });

  it('throws on non-existent file', async () => {
    await expect(probeVideo(join(FIXTURES, 'does-not-exist.mp4'))).rejects.toBeInstanceOf(VideoProbeError);
  });
});
