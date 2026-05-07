// View-time sanitization for Job.errorMessage. Plan-2 worker may write raw
// ffmpeg-stderr or stack-traces containing server-side paths; rendering them
// verbatim leaks storage-topology and is a defense-in-depth violation.
//
// Allowlist-based: the worker is conventioned to write either a known code
// prefix ("CODE: detail") or a free string. We map known codes to user-safe
// messages; everything else collapses to a generic "Job failed.". Plan 10
// (operations) tracks the worker convention; a Plan-2-followup may split
// Job.errorMessage into Job.errorCode + Job.errorDetail.
//
// C9-LI: Allowlist-Mapping lives in @mediacompressor/shared so worker and BFF
// share the same single-source-of-truth.

import { KNOWN_ERROR_MESSAGES } from '@mediacompressor/shared';

export function redactErrorMessage(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  // Conventioned format: "CODE: detail" — only the CODE part is mapped.
  const colonIdx = raw.indexOf(':');
  const head = colonIdx >= 0 ? raw.slice(0, colonIdx).trim() : raw.trim();
  if (Object.prototype.hasOwnProperty.call(KNOWN_ERROR_MESSAGES, head)) {
    return KNOWN_ERROR_MESSAGES[head as keyof typeof KNOWN_ERROR_MESSAGES];
  }
  // Unknown / free-form text — never render to the user.
  return 'Job failed.';
}
