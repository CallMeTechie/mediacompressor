import { stat } from 'node:fs/promises';
import sharp from 'sharp';
import { IMAGE_OUTPUT_FORMATS, type CompressionRequest, type CompressionResult } from './types.js';

const MAX_PIXELS = 256_000_000; // 256 MP — Spec Sektion 7

const PROFILE_QUALITY: Record<string, number> = {
  'web-optimized': 80,
  'mobile-low': 60,
  'archive-medium': 90,
};

export async function compressImage(req: CompressionRequest): Promise<CompressionResult> {
  const start = Date.now();
  const inputBytes = (await stat(req.inputPath)).size;

  const targetFormat = (req.overrides?.targetFormat ?? 'webp').toLowerCase();
  if (!IMAGE_OUTPUT_FORMATS.has(targetFormat)) {
    throw new Error(`UNSUPPORTED_OUTPUT_FORMAT: ${targetFormat}`);
  }
  const quality = clampQuality(req.overrides?.quality, PROFILE_QUALITY[req.profile] ?? 80);

  sharp.cache(false);
  let pipeline = sharp(req.inputPath, {
    failOn: 'truncated',
    limitInputPixels: MAX_PIXELS,
  });

  const maxWidth = clampDimension(req.overrides?.maxWidth);
  const maxHeight = clampDimension(req.overrides?.maxHeight);
  if (maxWidth || maxHeight) {
    pipeline = pipeline.resize({
      width: maxWidth,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const formatted = applyOutputFormat(pipeline, targetFormat, quality);
  const info = await formatted.toFile(req.outputPath);

  return {
    outputPath: req.outputPath,
    outputBytes: info.size,
    inputBytes,
    durationMs: Date.now() - start,
    outputFormat: targetFormat,
    metadata: {
      width: info.width,
      height: info.height,
    },
  };
}

function clampDimension(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 1 || v > 16384) {
    throw new Error(`VALIDATION_FAILED: dimension out of range`);
  }
  return v;
}

function clampQuality(override: number | undefined, fallback: number): number {
  const q = override ?? fallback;
  return Math.max(1, Math.min(100, Math.round(q)));
}

function applyOutputFormat(p: sharp.Sharp, format: string, quality: number): sharp.Sharp {
  switch (format) {
    case 'jpeg':
      return p.jpeg({ quality });
    case 'png':
      return p.png({ compressionLevel: 9 });
    case 'webp':
      return p.webp({ quality });
    case 'avif':
      return p.avif({ quality });
    default:
      throw new Error(`UNSUPPORTED_OUTPUT_FORMAT: ${format}`);
  }
}
