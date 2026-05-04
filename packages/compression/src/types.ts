export const PROFILES = ['web-optimized', 'mobile-low', 'archive-medium'] as const;
export type Profile = (typeof PROFILES)[number];

export const IMAGE_OUTPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);
export const VIDEO_OUTPUT_FORMATS = new Set(['mp4', 'webm']);

export interface CompressionOverrides {
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  targetFormat?: string;
}

export interface CompressionRequest {
  inputPath: string;
  outputPath: string;
  profile: Profile;
  overrides?: CompressionOverrides;
  onProgress?: (percent: number) => void;
  signal: AbortSignal;
}

export interface CompressionResultMetadata {
  width?: number;
  height?: number;
  duration?: number;
  codec?: string;
}

export interface CompressionResult {
  outputPath: string;
  outputBytes: number;
  inputBytes: number;
  durationMs: number;
  outputFormat: string;
  metadata: CompressionResultMetadata;
}
