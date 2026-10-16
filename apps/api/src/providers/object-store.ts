import type { Pools } from '@roofline/db';
import type { Config } from '../config.ts';
import { DirObjectStore } from './fakes/dir-object-store.ts';
import { MemoryObjectStore } from './fakes/object-store.ts';
import { r2For } from './r2.ts';

export interface ObjectStore {
  readonly configured: boolean;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** A GET URL that stops working after `seconds` (Ruling 6; Task 12 playback). */
  signedGetUrl(key: string, seconds: number): Promise<string>;
  /** Removes one object; a missing key is not an error (Task 16 sweep). */
  delete(key: string): Promise<void>;
  /**
   * Every object whose key starts with `prefix`, with when it was last written (the google-retention job's sweep of
   * Google content under its own prefixes, orphans included). Keys only, never bytes.
   */
  list(prefix: string): Promise<StoredObject[]>;
}

/** One object in a listing. */
export type StoredObject = { key: string; lastModified: Date };

export class ObjectStoreUnavailableError extends Error {}

export class UnconfiguredObjectStore implements ObjectStore {
  readonly configured = false;
  async put(): Promise<void> {
    throw new ObjectStoreUnavailableError("File storage isn't set up.");
  }
  async get(): Promise<Uint8Array | null> {
    throw new ObjectStoreUnavailableError("File storage isn't set up.");
  }
  async signedGetUrl(): Promise<string> {
    throw new ObjectStoreUnavailableError("File storage isn't set up.");
  }
  async delete(): Promise<void> {
    throw new ObjectStoreUnavailableError("File storage isn't set up.");
  }
  async list(): Promise<StoredObject[]> {
    throw new ObjectStoreUnavailableError("File storage isn't set up.");
  }
}

export function createObjectStore(config: Config, pools: Pools): ObjectStore {
  void pools;
  // Demo mode: one directory shared by the API, the worker and the seed (in memory, each would have its own).
  if (config.DEMO_MODE && config.DEMO_FILES_DIR) return new DirObjectStore(config.DEMO_FILES_DIR);
  if (config.FAKE_PROVIDERS) return new MemoryObjectStore();
  return r2For(config) ?? (config.NODE_ENV === 'production' ? new UnconfiguredObjectStore() : new MemoryObjectStore());
}
