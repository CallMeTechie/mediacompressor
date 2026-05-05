import { describe, expect, it } from 'vitest';
import { parseProgressChunk } from './ffmpeg-progress.js';

describe('parseProgressChunk', () => {
  it('extracts percent from out_time_us when total duration is known', () => {
    const chunk = 'frame=42\nfps=24.0\nout_time_us=500000\nprogress=continue\n';
    expect(parseProgressChunk(chunk, 1.0)).toBe(50);
  });

  it('returns 100 on progress=end', () => {
    expect(parseProgressChunk('progress=end\n', 5.0)).toBe(100);
  });

  it('returns null when chunk does not contain progress markers', () => {
    expect(parseProgressChunk('frame=1\n', 1.0)).toBeNull();
  });
});
