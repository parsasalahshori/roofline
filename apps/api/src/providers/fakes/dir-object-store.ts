import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStore, StoredObject } from '../object-store.ts';

/**
 * The demo's object store: files in one local directory (DEMO_FILES_DIR), so the API, the worker and
 * the demo seed — separate processes — see the same signed PDFs and recordings, and they survive a
 * restart. Each key is stored under its sha256, so no key can name a path outside the directory.
 * Demo mode only (createObjectStore); nothing here leaves the machine. Each file has a `<sha256>.key` beside it holding
 * its key, so `list` can find keys by prefix (files written before that existed have none and are not listed).
 */
export class DirObjectStore implements ObjectStore {
  readonly configured = true;
  constructor(private readonly dir: string) {}

  private fileFor(key: string): string {
    return path.join(this.dir, createHash('sha256').update(key).digest('hex'));
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.fileFor(key), bytes);
    await writeFile(`${this.fileFor(key)}.key`, key, 'utf8');
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.fileFor(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Like the memory fake: a deterministic non-HTTP URL; the demo serves files through the API, not by URL. */
  async signedGetUrl(key: string, seconds: number): Promise<string> {
    return `demo-file://${key}?expires=${Math.floor(Date.now() / 1000) + seconds}`;
  }

  async delete(key: string): Promise<void> {
    await rm(this.fileFor(key), { force: true });
    await rm(`${this.fileFor(key)}.key`, { force: true });
  }

  async list(prefix: string): Promise<StoredObject[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: StoredObject[] = [];
    for (const name of names.filter((n) => n.endsWith('.key')).sort()) {
      const key = await readFile(path.join(this.dir, name), 'utf8');
      if (!key.startsWith(prefix)) continue;
      try {
        out.push({ key, lastModified: (await stat(path.join(this.dir, name.slice(0, -4)))).mtime });
      } catch {
        // The bytes are gone (a half-finished delete): nothing to list.
      }
    }
    return out;
  }
}
