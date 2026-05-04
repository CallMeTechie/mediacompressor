import type { Readable } from 'node:stream';

export interface StorageStat {
  size: number;
  modified: Date;
}

/**
 * Storage abstraction (Spec Sektion 3 / packages/storage).
 *
 * Default-Impl: LocalFsAdapter (Plan 2).
 * Erweiterung: S3Adapter für MinIO-Migration ohne Konsumenten-Bruch.
 *
 * Pflicht-Invariante für jede Implementation:
 * - jeder `key` wird intern zu einem absoluten Pfad innerhalb des konfigurierten
 *   Storage-Roots aufgelöst; Aufrufe mit `..` oder absoluten Pfaden müssen abgelehnt
 *   werden (Path-Traversal-Schutz, Spec Sektion 7).
 */
export interface StorageAdapter {
  put(key: string, source: Readable | Buffer): Promise<void>;
  get(key: string): Promise<Readable>;
  stat(key: string): Promise<StorageStat>;
  delete(key: string): Promise<void>;
  presignDownload?(key: string, ttl: number): Promise<string>;
}
