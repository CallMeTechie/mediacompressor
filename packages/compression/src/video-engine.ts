import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import {
  VIDEO_OUTPUT_CODECS,
  VIDEO_OUTPUT_FORMATS,
  type CompressionRequest,
  type CompressionResult,
  type VideoOutputFormat,
} from './types.js';
import { buildFfmpegArgs } from './ffmpeg-args.js';
import { parseProgressChunk } from './ffmpeg-progress.js';
import { probeVideo, VideoProbeError } from './video-probe.js';

const CRF_BY_PROFILE: Record<string, number> = {
  'web-optimized': 28,
  'mobile-low': 36,
  'archive-medium': 22,
};

export async function compressVideo(req: CompressionRequest): Promise<CompressionResult> {
  const start = Date.now();
  const inputBytes = (await stat(req.inputPath)).size;

  const targetFormat = (req.overrides?.targetFormat ?? 'mp4').toLowerCase();
  if (!VIDEO_OUTPUT_FORMATS.has(targetFormat)) {
    throw new Error(`UNSUPPORTED_OUTPUT_FORMAT: ${targetFormat}`);
  }
  const codec = VIDEO_OUTPUT_CODECS[targetFormat as VideoOutputFormat];
  const crf = clampCrf(req.overrides?.quality, CRF_BY_PROFILE[req.profile] ?? 28, codec);

  let probe;
  try {
    probe = await probeVideo(req.inputPath);
  } catch (err) {
    if (err instanceof VideoProbeError) {
      throw new Error(`ENGINE_INPUT_CORRUPT: ${err.message}`);
    }
    throw err;
  }

  const args = buildFfmpegArgs({
    inputs: [{ path: req.inputPath }],
    output: req.outputPath,
    videoCodec: codec,
    crf,
    preset: codec === 'libx264' ? 'medium' : undefined,
  });

  await runFfmpeg(args, probe.duration, req.signal, req.onProgress, req.outputPath, undefined);

  const outputBytes = (await stat(req.outputPath)).size;

  return {
    outputPath: req.outputPath,
    outputBytes,
    inputBytes,
    durationMs: Date.now() - start,
    outputFormat: targetFormat,
    metadata: {
      width: probe.width,
      height: probe.height,
      duration: probe.duration,
      codec: probe.codec,
    },
  };
}

function clampCrf(override: number | undefined, fallback: number, codec: string): number {
  const max = codec === 'libvpx-vp9' ? 63 : 51;
  const v = override ?? fallback;
  return Math.max(1, Math.min(max, Math.round(v)));
}

export async function runFfmpeg(
  args: string[],
  duration: number,
  signal: AbortSignal,
  onProgress: ((p: number) => void) | undefined,
  outputPath: string,
  maxFileSize: number | undefined,
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    const abort = () => proc.kill('SIGTERM');
    signal.addEventListener('abort', abort, { once: true });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4096);
      const percent = parseProgressChunk(text, duration);
      if (percent !== null && onProgress) onProgress(percent);
    });

    proc.on('error', (err) => {
      signal.removeEventListener('abort', abort);
      rejectRun(err);
    });

    proc.on('close', async (code) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        await rm(outputPath, { force: true });
        rejectRun(new Error('CANCELED'));
        return;
      }
      if (code !== 0) {
        await rm(outputPath, { force: true });
        const lower = stderrTail.toLowerCase();
        if (
          lower.includes('invalid data') ||
          lower.includes('moov atom not found') ||
          lower.includes('invalid argument')
        ) {
          rejectRun(new Error(`ENGINE_INPUT_CORRUPT: ${stderrTail.trim()}`));
          return;
        }
        rejectRun(new Error(`ENGINE_INTERNAL: ffmpeg exited ${code} — ${stderrTail.trim()}`));
        return;
      }
      if (maxFileSize !== undefined) {
        try {
          const { size } = await stat(outputPath);
          if (size >= maxFileSize - 1024) {
            await rm(outputPath, { force: true });
            rejectRun(new Error(`ENGINE_INPUT_CORRUPT: output truncated by filesize cap`));
            return;
          }
        } catch {
          // stat failed — output may have been removed already
        }
      }
      resolveRun();
    });
  });
}
