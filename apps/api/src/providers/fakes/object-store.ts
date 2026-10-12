import type { ObjectStore } from '../object-store.ts';

export type ObjectStoreCall = { method: 'put'; key: string; contentType: string } | { method: 'get'; key: string };

export class MemoryObjectStore implements ObjectStore {
  readonly configured = true;
  readonly calls: ObjectStoreCall[] = [];
  private failures = 0;
  private readonly items = new Map<string, { bytes: Uint8Array; contentType: string }>();
  failNext(n = 1): void {
    this.failures = n;
  }
  private record(call: ObjectStoreCall): void {
    this.calls.push(call);
    if (this.failures > 0) {
      this.failures--;
      throw new Error('Fake object store failure');
    }
  }
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.record({ method: 'put', key, contentType });
    this.items.set(key, { bytes: new Uint8Array(bytes), contentType });
  }
  async get(key: string): Promise<Uint8Array | null> {
    this.record({ method: 'get', key });
    const item = this.items.get(key);
    return item ? new Uint8Array(item.bytes) : null;
  }
}
