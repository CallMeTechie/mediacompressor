import { describe, expect, it } from 'vitest';
import type { StorageAdapter, StorageStat } from './types.js';

describe('storage interface', () => {
  it('StorageAdapter has put, get, stat, delete; presignDownload optional', () => {
    const fake: StorageAdapter = {
      put: async () => undefined,
      get: async () => Buffer.from('') as unknown as never,
      stat: async (): Promise<StorageStat> => ({ size: 0, modified: new Date(0) }),
      delete: async () => undefined,
    };
    expect(typeof fake.put).toBe('function');
    expect(typeof fake.get).toBe('function');
    expect(typeof fake.stat).toBe('function');
    expect(typeof fake.delete).toBe('function');
    expect(fake.presignDownload).toBeUndefined();
  });
});
