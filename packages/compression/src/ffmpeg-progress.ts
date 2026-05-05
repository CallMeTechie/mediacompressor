export function parseProgressChunk(chunk: string, totalSeconds: number): number | null {
  if (chunk.includes('progress=end')) return 100;
  const match = chunk.match(/out_time_us=(\d+)/);
  if (!match) return null;
  const elapsedSeconds = Number(match[1]) / 1_000_000;
  if (totalSeconds <= 0) return null;
  return Math.min(100, Math.round((elapsedSeconds / totalSeconds) * 100));
}
