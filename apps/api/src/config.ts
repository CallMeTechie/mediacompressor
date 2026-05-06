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
  // Plan-5-Followup: tusd v2.4.0 has no `-hooks-http-header` flag, so we cannot
  // make tusd inject a static auth header on hook calls. Plan 9 will front
  // tusd with Caddy that injects X-Tusd-Shared-Secret. Until then, Compose
  // deployments rely on the internal docker network for trust (default false).
  // Set to true once Caddy is in place so the api enforces the header.
  TUSD_REQUIRE_SHARED_SECRET: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === 'true' || v === '1'),
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
