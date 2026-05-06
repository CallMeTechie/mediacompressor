import { z } from 'zod';

const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  CSRF_SECRET: z.string().min(32),
  API_KEY_PEPPER: z.string().min(32),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ARGON2_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(8),
  TUSD_SHARED_SECRET: z.string().min(32),
  TUSD_DATA_DIR: z.string().default('/media/tusd-data'),
  TUSD_FINAL_DIR: z.string().default('/media/uploads'),
  MEDIA_MOUNT_PATH: z.string().default('/media'),
  MIN_FREE_BYTES_RESERVE: z.coerce.bigint().default(5n * 1024n * 1024n * 1024n), // 5 GB
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
