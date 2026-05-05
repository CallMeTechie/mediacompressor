import { VIDEO_OUTPUT_CODECS } from './types.js';

const ALLOWED_VIDEO_CODECS = new Set<string>(Object.values(VIDEO_OUTPUT_CODECS));

export interface FfmpegInput {
  /** Absolute path validated to lie inside the storage root. */
  path: string;
}

export interface BuildFfmpegArgsOptions {
  inputs: FfmpegInput[];
  output: string;
  videoCodec: 'libx264' | 'libvpx-vp9';
  crf: number;
  preset?: string;
  vfFilter?: string;
  maxFileSize?: number;
  maxDuration?: number;
}

/**
 * Build a SAFE ffmpeg argument array.
 *
 * Pflicht-Pattern (Spec C2):
 * - `-protocol_whitelist file` PER INPUT, never global, never with crypto/concat/http
 * - input paths must be absolute and validated upstream against the storage root
 * - returned value is always a string array — never a single shell command
 * - vfFilter is opaque to this function; callers must build it from validated
 *   numeric inputs only (no strings from user input)
 */
export function buildFfmpegArgs(opts: BuildFfmpegArgsOptions): string[] {
  if (!ALLOWED_VIDEO_CODECS.has(opts.videoCodec)) {
    throw new Error(`Unknown video codec: ${opts.videoCodec}`);
  }

  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2'];

  for (const input of opts.inputs) {
    args.push('-protocol_whitelist', 'file', '-i', input.path);
  }

  args.push('-c:v', opts.videoCodec, '-crf', String(opts.crf));

  if (opts.preset) args.push('-preset', opts.preset);
  if (opts.vfFilter) args.push('-vf', opts.vfFilter);
  if (opts.maxFileSize) args.push('-fs', String(opts.maxFileSize));
  if (opts.maxDuration) args.push('-t', String(opts.maxDuration));

  args.push(opts.output);
  return args;
}
