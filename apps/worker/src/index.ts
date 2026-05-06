import pino from 'pino';
import { loadConfig } from './config.js';
// startWorker will be added in Task 11
// import { startWorker } from './consumer.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL });
  log.info(
    { concurrency: config.WORKER_CONCURRENCY },
    'worker boot — Task 10 stub, consumer added in Task 11',
  );
  // const worker = startWorker(config.REDIS_URL, config.DATABASE_URL);
  // process.on('SIGTERM', async () => { await worker.close(); process.exit(0); });
  await new Promise<void>((resolve) => process.on('SIGTERM', resolve));
}

main().catch((err: unknown) => {
  console.error('Worker boot failed:', err);
  process.exit(1);
});
