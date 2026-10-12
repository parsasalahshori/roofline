import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStore } from '../object-store.ts';

/**
 * The demo's object store: files in one local directory (DEMO_FILES_DIR), so the API, the worker and
 * the demo seed — separate processes — see the same signed PDFs and recordings, and they survive a
 * restart. Each key is stored under its sha256, so no key can name a path outside the directory.
 * Demo mode only (createObjectStore); nothing here leaves the machine.
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
  }
}
