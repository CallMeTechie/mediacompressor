import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export interface CompressJobData {
  jobId: string;
  userId: string;
  inputPath: string;
  outputPath: string;
  profile: string;
  overrides?: Record<string, unknown>;
}

export function createCompressionQueue(redis: Redis): Queue<CompressJobData> {
  return new Queue<CompressJobData>('compression', { connection: redis });
}
