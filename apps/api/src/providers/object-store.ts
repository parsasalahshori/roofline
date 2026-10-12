import type { Pools } from '@roofline/db';
import type { Config } from '../config.ts';
import { MemoryObjectStore } from './fakes/object-store.ts';
import { r2For } from './r2.ts';

export interface ObjectStore {
  readonly configured: boolean;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export class ObjectStoreUnavailableError extends Error {}

export class UnconfiguredObjectStore implements ObjectStore {
  readonly configured = false;
  async put(): Promise<void> {
    throw new ObjectStoreUnavailableError("File storage isn't set up.");
  }
  async get(): Promise<Uint8Array | null> {
    throw new ObjectStoreUnavailableError("File storage isn't set up.");
  }
}

export function createObjectStore(config: Config, pools: Pools): ObjectStore {
  void pools;
  if (config.FAKE_PROVIDERS) return new MemoryObjectStore();
  return r2For(config) ?? (config.NODE_ENV === 'production' ? new UnconfiguredObjectStore() : new MemoryObjectStore());
}
