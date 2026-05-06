// UC13-Fix: strikte UUIDv4-Layout-Regex (8-4-4-4-12) statt {36}-mit-dashes.
// Defense-in-Depth: parseUploadPath rejects non-UUID-Patterns wie
// 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' oder dash-Positionen-Mismatch.
const UUID_RE_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UPLOAD_PATH_RE = new RegExp(
  `^uploads\\/(${UUID_RE_SRC})\\/(${UUID_RE_SRC})\\/source\\.bin$`,
);

export function uploadSourcePath(userId: string, jobId: string): string {
  return `uploads/${userId}/${jobId}/source.bin`;
}

export function parseUploadPath(p: string): { userId: string; jobId: string } | null {
  const m = p.match(UPLOAD_PATH_RE);
  if (!m) return null;
  return { userId: m[1]!, jobId: m[2]! };
}

export function isValidUploadPath(p: string): boolean {
  return UPLOAD_PATH_RE.test(p);
}
