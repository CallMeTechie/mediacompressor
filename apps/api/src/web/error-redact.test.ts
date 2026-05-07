import { describe, expect, it } from 'vitest';
import { redactErrorMessage } from './error-redact.js';

describe('web/error-redact', () => {
  it('null/empty → null', () => {
    expect(redactErrorMessage(null)).toBeNull();
    expect(redactErrorMessage('')).toBeNull();
  });

  it('known code "INPUT_CORRUPT: …" → friendly message (path stripped)', () => {
    expect(
      redactErrorMessage(
        'INPUT_CORRUPT: details that contain /media/uploads/abc/source.bin',
      ),
    ).toBe('The input file appears to be corrupted.');
  });

  it('known code without colon → friendly message', () => {
    expect(redactErrorMessage('TIMEOUT')).toBe('The job timed out and could not finish.');
  });

  it('unknown code prefix → generic "Job failed."', () => {
    expect(redactErrorMessage('SOMETHING_NEW: leaky detail')).toBe('Job failed.');
  });

  it('free-form ffmpeg stderr (with server path) → generic "Job failed."', () => {
    expect(
      redactErrorMessage('ffmpeg: Cannot open /media/uploads/abc/source.bin'),
    ).toBe('Job failed.');
  });

  // C9-LI PFLICHT — Allowlist comes from packages/shared, not a local const.
  // Verifies single-source-of-truth between Plan-2-Worker and Plan-8b-BFF.
  it('C9-LI: KNOWN_ERROR_MESSAGES is imported from @mediacompressor/shared', async () => {
    const sharedImport = await import('@mediacompressor/shared');
    expect(sharedImport.KNOWN_ERROR_MESSAGES).toBeDefined();
    expect(sharedImport.KNOWN_ERROR_MESSAGES.INPUT_CORRUPT).toBe(
      'The input file appears to be corrupted.',
    );
    expect(sharedImport.KNOWN_ERROR_MESSAGES.TIMEOUT).toBe(
      'The job timed out and could not finish.',
    );
    // Object identity: re-importing yields the same object (single source).
    const second = await import('@mediacompressor/shared');
    expect(second.KNOWN_ERROR_MESSAGES).toBe(sharedImport.KNOWN_ERROR_MESSAGES);
  });
});
