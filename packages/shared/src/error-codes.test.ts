import { describe, expect, it } from 'vitest';
import { ERROR_CODES, isErrorCode } from './error-codes.js';

describe('error-codes', () => {
  it('exposes the full canonical error-code list from the design spec', () => {
    expect(ERROR_CODES).toContain('AUTH_REQUIRED');
    expect(ERROR_CODES).toContain('QUOTA_STORAGE_EXCEEDED');
    expect(ERROR_CODES).toContain('UNSUPPORTED_INPUT_FORMAT');
    expect(ERROR_CODES).toContain('ENGINE_INPUT_CORRUPT');
    expect(ERROR_CODES).toContain('GLOBAL_DISK_LOW');
    expect(ERROR_CODES).toContain('STREAM_NOT_AVAILABLE');
  });

  it('isErrorCode accepts known codes and rejects unknown', () => {
    expect(isErrorCode('AUTH_REQUIRED')).toBe(true);
    expect(isErrorCode('VALIDATION_FAILED')).toBe(true);
    expect(isErrorCode('NOT_A_REAL_CODE')).toBe(false);
    expect(isErrorCode('')).toBe(false);
  });
});
