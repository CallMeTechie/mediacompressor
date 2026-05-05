import { detectMimeFromFile } from '@mediacompressor/storage';
import { compressImage } from './image-engine.js';
import { compressVideo } from './video-engine.js';
import {
  IMAGE_INPUT_MIMES,
  VIDEO_INPUT_MIMES,
  type CompressionRequest,
  type CompressionResult,
} from './types.js';

/**
 * Single entry point for the worker. Detects whether the input is an image or
 * video by magic-number inspection and dispatches accordingly.
 *
 * Uses `detectMimeFromFile` (file-type's stream-based path API) instead of
 * `readFile`+`detectMime` to avoid loading the entire file into memory
 * (Spec C2-Rev2-Fix).
 */
export async function compress(req: CompressionRequest): Promise<CompressionResult> {
  const mime = await detectMimeFromFile(req.inputPath);
  if (!mime) {
    throw new Error('UNSUPPORTED_INPUT_FORMAT: unrecognized magic number');
  }
  if (IMAGE_INPUT_MIMES.has(mime)) return compressImage(req);
  if (VIDEO_INPUT_MIMES.has(mime)) return compressVideo(req);
  throw new Error(`UNSUPPORTED_INPUT_FORMAT: ${mime}`);
}
