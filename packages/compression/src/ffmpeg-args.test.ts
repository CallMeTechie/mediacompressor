import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs } from './ffmpeg-args.js';

describe('buildFfmpegArgs', () => {
  it('places -protocol_whitelist file BEFORE every -i', () => {
    const args = buildFfmpegArgs({
      inputs: [{ path: '/media/uploads/u1/j1/source.bin' }],
      output: '/media/results/u1/j1/output.mp4',
      videoCodec: 'libx264',
      crf: 23,
    });
    const wlIdx = args.indexOf('-protocol_whitelist');
    const iIdx = args.indexOf('-i');
    expect(wlIdx).toBeGreaterThan(-1);
    expect(iIdx).toBeGreaterThan(wlIdx);
    expect(args[wlIdx + 1]).toBe('file');
  });

  it('repeats -protocol_whitelist for each input', () => {
    const args = buildFfmpegArgs({
      inputs: [{ path: '/a' }, { path: '/b' }],
      output: '/o',
      videoCodec: 'libx264',
      crf: 23,
    });
    const occurrences = args.filter((a) => a === '-protocol_whitelist').length;
    expect(occurrences).toBe(2);
  });

  it('always uses file (not crypto, not concat) as the only allowed protocol', () => {
    const args = buildFfmpegArgs({
      inputs: [{ path: '/x' }],
      output: '/o',
      videoCodec: 'libx264',
      crf: 23,
    });
    const wlIdx = args.indexOf('-protocol_whitelist');
    expect(args[wlIdx + 1]).toBe('file');
  });

  it('emits -fs filesize cap when maxFileSize is set', () => {
    const args = buildFfmpegArgs({
      inputs: [{ path: '/x' }],
      output: '/o',
      videoCodec: 'libx264',
      crf: 23,
      maxFileSize: 1_000_000,
    });
    const fsIdx = args.indexOf('-fs');
    expect(fsIdx).toBeGreaterThan(-1);
    expect(args[fsIdx + 1]).toBe('1000000');
  });

  it('emits -t duration cap when maxDuration is set', () => {
    const args = buildFfmpegArgs({
      inputs: [{ path: '/x' }],
      output: '/o',
      videoCodec: 'libx264',
      crf: 23,
      maxDuration: 300,
    });
    const tIdx = args.indexOf('-t');
    expect(tIdx).toBeGreaterThan(-1);
    expect(args[tIdx + 1]).toBe('300');
  });

  it('returns an array — never a single shell string', () => {
    const args = buildFfmpegArgs({
      inputs: [{ path: '/x' }],
      output: '/o',
      videoCodec: 'libx264',
      crf: 23,
    });
    expect(Array.isArray(args)).toBe(true);
  });

  it('rejects unknown video codec at runtime', () => {
    expect(() =>
      buildFfmpegArgs({
        inputs: [{ path: '/x' }],
        output: '/o',
        // @ts-expect-error  unknown codec must be rejected at type level too
        videoCodec: 'rogueCodec',
        crf: 23,
      }),
    ).toThrow(/Unknown video codec/);
  });

  it('always passes -loglevel error and -progress pipe:2', () => {
    const args = buildFfmpegArgs({
      inputs: [{ path: '/x' }],
      output: '/o',
      videoCodec: 'libx264',
      crf: 23,
    });
    expect(args).toContain('-loglevel');
    expect(args).toContain('error');
    expect(args).toContain('-progress');
    expect(args).toContain('pipe:2');
  });
});
