// apps/api/src/quota/disk-free.ts

import * as fs from 'node:fs';

export class GlobalDiskLowError extends Error {
  readonly code = 'GLOBAL_DISK_LOW';
  constructor(message: string) {
    super(message);
    this.name = 'GlobalDiskLowError';
  }
}

/**
 * C5-Rev3: Global disk-free check. Prevents the case where logical user
 * quotas sum to more headroom than physically available on disk.
 *
 * Throws GlobalDiskLowError when accepting `claimedSize` would leave the
 * filesystem with less than `minFreeReserve` bytes free.
 */
export function checkGlobalDiskFree(
  mountPath: string,
  claimedSize: bigint,
  minFreeReserve: bigint,
): void {
  const stat = fs.statfsSync(mountPath, { bigint: true });
  const free = stat.bavail * BigInt(stat.bsize);
  if (free - claimedSize < minFreeReserve) {
    throw new GlobalDiskLowError(
      `global disk low (free=${free}, claim=${claimedSize}, reserve=${minFreeReserve})`,
    );
  }
}
