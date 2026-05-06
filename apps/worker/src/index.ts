import pino from 'pino';
import { loadConfig } from './config.js';
import { startWorker } from './consumer.js';
import { startCleanupCron } from './cleanup/cron.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL });
  log.info(
    {
      concurrency: config.WORKER_CONCURRENCY,
      mediaMountPath: config.MEDIA_MOUNT_PATH,
    },
    'worker boot — compression consumer + cleanup-cron running',
  );

  const handle = startWorker(config.REDIS_URL, config.DATABASE_URL);

  handle.worker.on('error', (err) => log.error({ err }, 'worker error'));
  handle.worker.on('failed', (job, err) =>
    log.warn({ jobId: job?.id, err: err.message }, 'job failed'),
  );

  // Plan 6 Task 7: cleanup-cron piggy-backs on the compression worker's
  // Redis + Prisma connections (handle exposes them via StartWorkerHandle).
  const cleanupCron = startCleanupCron({
    redis: handle.redis,
    prisma: handle.prisma,
    mediaMountPath: config.MEDIA_MOUNT_PATH,
    logger: log,
  });

  cleanupCron.worker.on('error', (err) =>
    log.error({ err }, 'cleanup-cron worker error'),
  );
  cleanupCron.worker.on('failed', (job, err) =>
    log.warn(
      { jobName: job?.name, err: err.message },
      'cleanup-cron job failed',
    ),
  );

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down worker');
    // Close cleanup-cron first so its in-flight sweeps drain before the
    // compression-worker tears down the shared Redis/Prisma connections.
    try {
      await cleanupCron.close();
    } catch (err) {
      log.error({ err }, 'error during cleanup-cron shutdown');
    }
    try {
      await handle.close();
    } catch (err) {
      log.error({ err }, 'error during worker shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('Worker boot failed:', err);
  process.exit(1);
});
