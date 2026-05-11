import { describe, expect, it, vi } from 'vitest';
import type * as fs from 'node:fs';
import { checkGlobalDiskFree, GlobalDiskLowError } from './disk-free.js';

type StatFsBigInt = ReturnType<typeof fs.statfsSync>;

// ESM-Caveat: Direkter `vi.spyOn(fs, 'statfsSync')` schlägt mit "Cannot
// redefine property" fehl, weil `node:fs` ein read-only Namespace-Module ist.
// `vi.mock` patcht das Modul auf Resolver-Ebene — sauber und re-entrant.
let mockStat: StatFsBigInt;

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof fs>();
  return {
    ...actual,
    statfsSync: vi.fn(() => mockStat),
  };
});

describe('checkGlobalDiskFree (C5-Rev3)', () => {
  it('passes when free is plentiful', () => {
    // bavail × bsize = 26_214_400 × 4096 = 100 GiB free.
    mockStat = {
      type: 0n,
      bsize: 4096n,
      blocks: 100_000_000n,
      bfree: 26_214_400n,
      bavail: 26_214_400n,
      files: 0n,
      ffree: 0n,
    } as unknown as StatFsBigInt;

    expect(() => checkGlobalDiskFree('/var/data', 1_000_000_000n, 5_000_000_000n)).not.toThrow();
  });

  it('throws GlobalDiskLowError when free - claimed < reserve', () => {
    // bavail × bsize = 6_000_000_000 × 1 = 6 GB free.
    // claim 2 GB, reserve 5 GB → 6−2 = 4 GB < 5 GB → must throw.
    mockStat = {
      type: 0n,
      bsize: 1n,
      blocks: 6_000_000_000n,
      bfree: 6_000_000_000n,
      bavail: 6_000_000_000n,
      files: 0n,
      ffree: 0n,
    } as unknown as StatFsBigInt;

    expect(() => checkGlobalDiskFree('/var/data', 2_000_000_000n, 5_000_000_000n)).toThrow(
      GlobalDiskLowError,
    );
  });
});
