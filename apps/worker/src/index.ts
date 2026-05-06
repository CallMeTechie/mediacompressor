import pino from 'pino';
import { loadConfig } from './config.js';
import { startWorker } from './consumer.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL });
  log.info(
    { concurrency: config.WORKER_CONCURRENCY },
    'worker boot — compression consumer running',
  );

  const handle = startWorker(config.REDIS_URL, config.DATABASE_URL);

  handle.worker.on('error', (err) => log.error({ err }, 'worker error'));
  handle.worker.on('failed', (job, err) =>
    log.warn({ jobId: job?.id, err: err.message }, 'job failed'),
  );

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down worker');
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
