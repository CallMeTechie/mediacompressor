export const PROFILES = ['web-optimized', 'mobile-low', 'archive-medium'] as const;
export type Profile = (typeof PROFILES)[number];

export const IMAGE_OUTPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);
export const VIDEO_OUTPUT_FORMATS = new Set(['mp4', 'webm']);

export const VIDEO_OUTPUT_CODECS = {
  mp4: 'libx264',
  webm: 'libvpx-vp9',
} as const satisfies Record<'mp4' | 'webm', string>;

export const IMAGE_INPUT_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/tiff',
  'image/bmp',
]);

export const VIDEO_INPUT_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
]);

export type VideoOutputFormat = keyof typeof VIDEO_OUTPUT_CODECS;

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
