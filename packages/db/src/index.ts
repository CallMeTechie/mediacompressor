import { PrismaClient } from '../prisma/generated/client/index.js';

export interface CreatePrismaClientOptions {
  databaseUrl?: string;
  logQueries?: boolean;
}

export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  return new PrismaClient({
    ...(options.databaseUrl !== undefined
      ? { datasources: { db: { url: options.databaseUrl } } }
      : {}),
    log: options.logQueries ? ['query', 'info', 'warn', 'error'] : ['warn', 'error'],
  });
}

export type { PrismaClient } from '../prisma/generated/client/index.js';
