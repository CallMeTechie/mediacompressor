/**
 * Stable error-code contract for all clients (Spec Sektion 8).
 * Adding entries is additive; never remove or rename without API-version-bump.
 */
export const ERROR_CODES = [
  // Auth
  'AUTH_REQUIRED',
  'AUTH_INVALID',
  'AUTH_EXPIRED',
  'INVITE_INVALID',
  'INVITE_EXPIRED',
  'INVITE_CONSUMED',
  // Quotas / Limits
  'QUOTA_PARALLEL_EXCEEDED',
  'QUOTA_STORAGE_EXCEEDED',
  'QUOTA_HOURLY_EXCEEDED',
  'QUOTA_FILE_SIZE_EXCEEDED',
  'GLOBAL_DISK_LOW',
  // Validation
  'VALIDATION_FAILED',
  'UNSUPPORTED_INPUT_FORMAT',
  'UNSUPPORTED_OUTPUT_FORMAT',
  'UNKNOWN_PROFILE',
  // Upload
  'UPLOAD_INCOMPLETE',
  'UPLOAD_MIME_MISMATCH',
  // Engine
  'ENGINE_INPUT_CORRUPT',
  'ENGINE_TIMEOUT',
  'ENGINE_OOM',
  'ENGINE_INTERNAL',
  // System
  'STORAGE_UNAVAILABLE',
  'STREAM_NOT_AVAILABLE',
  'EXPIRED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET = new Set<string>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}
