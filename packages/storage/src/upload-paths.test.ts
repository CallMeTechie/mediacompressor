import { describe, expect, it } from 'vitest';
import { uploadSourcePath, parseUploadPath, isValidUploadPath } from './upload-paths.js';

describe('upload-paths', () => {
  const userId = '550e8400-e29b-41d4-a716-446655440000';
  const jobId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

  it('uploadSourcePath builds canonical path', () => {
    expect(uploadSourcePath(userId, jobId)).toBe(`uploads/${userId}/${jobId}/source.bin`);
  });

  it('parseUploadPath roundtrips', () => {
    expect(parseUploadPath(uploadSourcePath(userId, jobId))).toEqual({ userId, jobId });
  });

  it('parseUploadPath rejects path-traversal', () => {
    expect(parseUploadPath(`uploads/../etc/passwd`)).toBeNull();
    expect(parseUploadPath(`uploads/${userId}/../source.bin`)).toBeNull();
  });

  it('isValidUploadPath enforces strict format', () => {
    expect(isValidUploadPath(uploadSourcePath(userId, jobId))).toBe(true);
    expect(isValidUploadPath('uploads/abc/def/source.bin')).toBe(false);
    expect(isValidUploadPath('uploads/x/y/z')).toBe(false);
  });

  // UC13 PFLICHT-REGRESSIONSTEST
  it('UC13: rejects non-UUID-pattern with 36 hex chars', () => {
    expect(parseUploadPath(`uploads/${'a'.repeat(36)}/${'a'.repeat(36)}/source.bin`)).toBeNull();
  });

  it('UC13: rejects UUIDs with dashes at wrong positions', () => {
    // 36 chars, dashes vorhanden, aber nicht 8-4-4-4-12-Layout
    expect(
      parseUploadPath(
        'uploads/aaaaaaaa-aaaaaa-aaaa-aaaa-aaaaaaaaaaaa/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/source.bin',
      ),
    ).toBeNull();
  });
});
