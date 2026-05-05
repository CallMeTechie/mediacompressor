import { createReadStream } from 'node:fs';
import { fileTypeFromBuffer, fileTypeFromStream } from 'file-type';

export class MimeMismatchError extends Error {
  constructor(
    public readonly claimed: string,
    public readonly actual: string | undefined,
  ) {
    super(
      actual
        ? `Claimed MIME ${claimed} does not match detected ${actual}`
        : `Could not detect MIME for input claiming ${claimed}`,
    );
    this.name = 'MimeMismatchError';
  }
}

/** Detect the actual MIME from the first bytes of a buffer. */
export async function detectMime(buffer: Buffer): Promise<string | undefined> {
  const result = await fileTypeFromBuffer(buffer);
  return result?.mime;
}

/**
 * Stream-based MIME detection that reads only the first ~4 KB of the file
 * (no full-file load). Use this when you have a path on disk — avoids the
 * memory blowup that would happen if you `readFile`-then-`detectMime` on a
 * multi-GB upload (Spec C2-Rev2-Fix).
 */
export async function detectMimeFromFile(filePath: string): Promise<string | undefined> {
  const stream = createReadStream(filePath);
  // fileTypeFromStream reads only the first ~4 KB then closes the stream —
  // no full-file load (Spec C2-Rev2-Fix for memory-DoS on large uploads).
  const result = await fileTypeFromStream(stream as unknown as ReadableStream<Uint8Array>);
  stream.destroy();
  return result?.mime;
}

/**
 * Verify that the magic-number-detected MIME matches the claimed MIME.
 * Throws MimeMismatchError on any mismatch (including detection failure).
 *
 * Tolerates HEIC/HEIF synonyms (`image/heic` ↔ `image/heif`) — both are valid
 * names for the same container, and tools differ in which they emit.
 */
export async function verifyClaimedMime(buffer: Buffer, claimed: string): Promise<void> {
  const actual = await detectMime(buffer);
  if (!actual) throw new MimeMismatchError(claimed, undefined);
  if (actual === claimed) return;
  if (
    (claimed === 'image/heic' && actual === 'image/heif') ||
    (claimed === 'image/heif' && actual === 'image/heic')
  ) {
    return;
  }
  throw new MimeMismatchError(claimed, actual);
}
