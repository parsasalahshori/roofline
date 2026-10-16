// What must survive the phone closing the tab before the work reached the server: photos not yet uploaded (their
// bytes) and photographed windows not yet saved. Android discards background tabs and iOS kills the iPhone app's web
// view under memory pressure; on site that is common (the camera app opened, a call came in). IndexedDB on this
// device only, per measurement; removed as soon as the server has it. Where IndexedDB is missing or refused (private
// mode, an old web view), everything still works for the visit; it just does not survive a closed tab.
import type { PhotoWindowInput } from '@roofline/shared';

const DB = 'roofline-window-photos';
const VERSION = 1;
const UPLOADS = 'uploads';
const DRAFTS = 'drafts';

/** A photo waiting to upload. `prepared` once it is the JPEG that will be sent (HEIC converted, made smaller). */
export type PendingUpload = { key: string; measurementId: string; name: string; type: string; blob: Blob; prepared: boolean; addedAt: number };
/** Photographed windows saved on this device but not yet on the server (the whole list, as the next PATCH sends it). */
export type PendingDraft = {
  measurementId: string;
  photoWindows: PhotoWindowInput[];
  /** The server's list this one was made from: a kept list is put back only while the server still has that one. */
  base: string;
  savedAt: number;
};

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening !== null) return opening;
  opening = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(UPLOADS)) db.createObjectStore(UPLOADS, { keyPath: 'key' }).createIndex('measurementId', 'measurementId');
        if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: 'measurementId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

/** One request in its own transaction; null (never a throw) when storage is unavailable or the request fails. */
async function run<T>(store: string, mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (db === null) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const req = make(tx.objectStore(store));
      let value: T | null = null;
      req.onsuccess = () => {
        value = req.result;
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export const pendingStore = {
  putUpload: (u: PendingUpload) => run(UPLOADS, 'readwrite', (s) => s.put(u)).then(() => undefined),
  deleteUpload: (key: string) => run(UPLOADS, 'readwrite', (s) => s.delete(key)).then(() => undefined),
  async listUploads(measurementId: string): Promise<PendingUpload[]> {
    const all = await run<PendingUpload[]>(UPLOADS, 'readonly', (s) => s.index('measurementId').getAll(measurementId) as IDBRequest<PendingUpload[]>);
    return (all ?? []).filter((u) => u.blob instanceof Blob).sort((a, b) => a.addedAt - b.addedAt);
  },
  putDraft: (d: PendingDraft) => run(DRAFTS, 'readwrite', (s) => s.put(d)).then(() => undefined),
  deleteDraft: (measurementId: string) => run(DRAFTS, 'readwrite', (s) => s.delete(measurementId)).then(() => undefined),
  getDraft: (measurementId: string) => run<PendingDraft | undefined>(DRAFTS, 'readonly', (s) => s.get(measurementId) as IDBRequest<PendingDraft | undefined>).then((d) => d ?? null),
};

export type PendingStore = typeof pendingStore;
