import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, stat as fsStat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { StorageAdapter, StorageStat } from './types.js';

export class PathTraversalError extends Error {
  constructor(key: string) {
    super(`Path traversal attempt rejected: ${key}`);
    this.name = 'PathTraversalError';
  }
}

export interface LocalFsAdapterOptions {
  /** Absolute directory path; all keys are stored relative to this root. */
  root: string;
}

export class LocalFsAdapter implements StorageAdapter {
  private readonly root: string;

  constructor(options: LocalFsAdapterOptions) {
    this.root = resolve(options.root);
  }

  async put(key: string, source: Readable | Buffer): Promise<void> {
    const path = await this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    if (Buffer.isBuffer(source)) {
      await writeFile(path, source);
      return;
    }
    await new Promise<void>((resolveStream, rejectStream) => {
      const out = createWriteStream(path);
      source.pipe(out);
      out.on('finish', () => resolveStream());
      out.on('error', rejectStream);
      source.on('error', rejectStream);
    });
  }

  async get(key: string): Promise<Readable> {
    const path = await this.resolveKey(key);
    return createReadStream(path);
  }

  async stat(key: string): Promise<StorageStat> {
    const path = await this.resolveKey(key);
    const s = await fsStat(path);
    return { size: s.size, modified: s.mtime };
  }

  async delete(key: string): Promise<void> {
    const path = await this.resolveKey(key);
    await unlink(path);
  }

  /**
   * Resolve a relative storage key to an absolute filesystem path strictly inside
   * the configured root. Throws PathTraversalError on:
   *   - absolute keys
   *   - keys containing `..` segments that escape the root
   *   - keys whose final resolved path lies outside the root (lexical check)
   *   - keys whose PHYSICAL path (via realpath) lies outside the root,
   *     i.e. via symlinks pointing outside (C1-Rev3 — Spec Sektion 7
   *     „O_NOFOLLOW beim Öffnen wenn möglich")
   */
  private async resolveKey(key: string): Promise<string> {
    // (a) Lexical check — fast, catches all `..` and absolute attempts
    if (isAbsolute(key)) throw new PathTraversalError(key);
    const normalized = normalize(key);
    if (normalized.startsWith('..') || normalized.includes(`${sep}..${sep}`)) {
      throw new PathTraversalError(key);
    }
    const absolute = resolve(this.root, normalized);
    const rel = relative(this.root, absolute);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new PathTraversalError(key);
    }

    // (b) Physical check — catches symlinks pointing out of root.
    // Use realpath on the parent directory so this works for files that don't
    // yet exist (writes). Then compose with the basename of `absolute`.
    let realParent: string;
    try {
      realParent = await realpath(dirname(absolute));
    } catch {
      // parent doesn't exist yet — recurse via a cheap loop up to root,
      // ensuring no link in the chain escapes root.
      realParent = dirname(absolute);
      let probe = realParent;
      while (probe !== this.root && probe !== dirname(probe)) {
        probe = dirname(probe);
      }
      if (probe !== this.root) throw new PathTraversalError(key);
    }
    const realRoot = await realpath(this.root);
    const physicalRel = relative(realRoot, realParent);
    if (physicalRel.startsWith('..') || isAbsolute(physicalRel)) {
      throw new PathTraversalError(key);
    }

    return absolute;
  }
}
