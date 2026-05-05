import { spawn } from 'node:child_process';

export class VideoProbeError extends Error {
  constructor(
    public readonly inputPath: string,
    cause: string,
  ) {
    super(`ffprobe failed for ${inputPath}: ${cause}`);
    this.name = 'VideoProbeError';
  }
}

export interface VideoProbeResult {
  width: number;
  height: number;
  duration: number;
  codec: string;
}

/**
 * Inspect a video file using ffprobe. Returns dimensions, duration, and codec.
 * Throws VideoProbeError on any failure.
 *
 * The ESLint rule `@mediacompressor/no-direct-ffmpeg-spawn` (extended in Task 11)
 * also blocks `spawn('ffprobe', ...)` outside this file's allowlist.
 * Like ffmpeg, ffprobe is invoked with `-protocol_whitelist file` per input.
 */
export async function probeVideo(inputPath: string): Promise<VideoProbeResult> {
  return new Promise((resolveProbe, rejectProbe) => {
    const args = [
      '-v',
      'error',
      '-show_entries',
      'stream=width,height,duration,codec_name',
      '-select_streams',
      'v:0',
      '-of',
      'json',
      '-protocol_whitelist',
      'file',
      inputPath,
    ];
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on('error', (err) => rejectProbe(new VideoProbeError(inputPath, err.message)));
    proc.on('close', (code) => {
      if (code !== 0) {
        rejectProbe(new VideoProbeError(inputPath, stderr.trim() || `exit ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const stream = parsed.streams?.[0];
        if (!stream) throw new Error('no video stream');
        const duration = stream.duration ? Number.parseFloat(stream.duration) : Number.NaN;
        resolveProbe({
          width: Number(stream.width),
          height: Number(stream.height),
          duration: Number.isFinite(duration) ? duration : 0,
          codec: String(stream.codec_name),
        });
      } catch (err) {
        rejectProbe(new VideoProbeError(inputPath, (err as Error).message));
      }
    });
  });
}
