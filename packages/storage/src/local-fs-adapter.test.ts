import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalFsAdapter, PathTraversalError } from './local-fs-adapter.js';

let root: string;
let adapter: LocalFsAdapter;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-storage-test-'));
  adapter = new LocalFsAdapter({ root });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('LocalFsAdapter', () => {
  it('put then get round-trips bytes', async () => {
    await adapter.put('user-1/job-1/source.bin', Buffer.from('hello world'));
    const stream = await adapter.get('user-1/job-1/source.bin');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello world');
  });

  it('stat returns size and mtime', async () => {
    await adapter.put('stat-test.bin', Buffer.from('xxxxx'));
    const stat = await adapter.stat('stat-test.bin');
    expect(stat.size).toBe(5);
    expect(stat.modified).toBeInstanceOf(Date);
  });

  it('delete removes the file; subsequent stat throws', async () => {
    await adapter.put('to-delete.bin', Buffer.from('x'));
    await adapter.delete('to-delete.bin');
    await expect(adapter.stat('to-delete.bin')).rejects.toThrow();
  });

  it('rejects keys with parent-traversal segments', async () => {
    await expect(adapter.put('../escape.bin', Buffer.from('x'))).rejects.toBeInstanceOf(
      PathTraversalError,
    );
    await expect(adapter.get('user-1/../../etc/passwd')).rejects.toBeInstanceOf(
      PathTraversalError,
    );
  });

  it('rejects absolute keys', async () => {
    await expect(adapter.put('/etc/passwd', Buffer.from('x'))).rejects.toBeInstanceOf(
      PathTraversalError,
    );
  });

  it('rejects keys that resolve outside root via traversal sequences', async () => {
    await expect(adapter.put('a/../../b/../escape.bin', Buffer.from('x'))).rejects.toBeInstanceOf(
      PathTraversalError,
    );
  });

  it('rejects keys whose resolved path traverses a symlink out of root (C1-Rev3)', async () => {
    // Create a symlink INSIDE root that points OUTSIDE — lexical resolveKey
    // alone would not catch this, only realpath() does.
    const { symlinkSync } = await import('node:fs');
    symlinkSync('/etc', join(root, 'evil'));
    await expect(adapter.put('evil/passwd', Buffer.from('x'))).rejects.toBeInstanceOf(
      PathTraversalError,
    );
    await expect(adapter.get('evil/passwd')).rejects.toBeInstanceOf(PathTraversalError);
  });
});
