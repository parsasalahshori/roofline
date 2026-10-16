import type { PhotoWindowInput, WindowPhotoUpload } from '@roofline/shared';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.ts';
import { windowPhotos as copy } from '../src/copy/measureWindows.ts';
import { uploadWindowPhoto } from '../src/features/measure/windows/api.ts';
import type { PendingDraft, PendingStore, PendingUpload } from '../src/features/measure/windows/pendingStore.ts';
import { usePhotoWindowDrafts } from '../src/features/measure/windows/photoDrafts.ts';
import { useWindowUploads } from '../src/features/measure/windows/PhotoWindows.tsx';

/* Uploads that survive a bad connection and a closed tab: stall timeout, retries, waiting offline, resuming. */

const UPLOAD: WindowPhotoUpload = { id: 'up1', widthPx: 1200, heightPx: 1600, focal35mm: 26, takenAt: null };

/** The device's store, in memory (IndexedDB stand-in). */
function memoryStore(): PendingStore & { uploads: Map<string, PendingUpload>; drafts: Map<string, PendingDraft> } {
  const uploads = new Map<string, PendingUpload>();
  const drafts = new Map<string, PendingDraft>();
  return {
    uploads,
    drafts,
    putUpload: async (u) => void uploads.set(u.key, u),
    deleteUpload: async (k) => void uploads.delete(k),
    listUploads: async (id) => [...uploads.values()].filter((u) => u.measurementId === id),
    putDraft: async (d) => void drafts.set(d.measurementId, d),
    deleteDraft: async (id) => void drafts.delete(id),
    getDraft: async (id) => drafts.get(id) ?? null,
  };
}

type Behaviour = 'ok' | 'neterror' | 'stall' | 500;
let script: Behaviour[];
let sent: number;
class FakeXHR {
  status = 0;
  responseText = '';
  withCredentials = false;
  timeout = 0;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  aborted = false;
  open() {}
  setRequestHeader() {}
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  send() {
    sent += 1;
    const b = script.shift() ?? 'ok';
    if (b === 'stall') return;
    setTimeout(() => {
      if (this.aborted) return;
      if (b === 'neterror') {
        this.onerror?.();
        return;
      }
      this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
      this.status = b === 'ok' ? 201 : b;
      this.responseText = JSON.stringify(b === 'ok' ? UPLOAD : { error: 'Busy' });
      this.onload?.();
    }, 5);
  }
}

let online: boolean;
beforeEach(() => {
  script = [];
  sent = 0;
  online = true;
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const photo = () => new File(['x'], 'kitchen.jpg', { type: 'image/jpeg' });

describe('the upload request', () => {
  it('a stalled upload (nothing sent for a while) is stopped and fails as a network error', async () => {
    script = ['stall'];
    const err = await uploadWindowPhoto('w1', photo(), () => undefined, { stallMs: 40 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
  });
});

describe('uploads that survive', () => {
  it('a network failure is tried again by itself; the photo is kept on the device until the server has it', async () => {
    script = ['neterror', 500, 'ok'];
    const store = memoryStore();
    const { result } = renderHook(() => useWindowUploads('w1', [], { store, backoffMs: [1, 1] }));
    act(() => result.current.add([photo()]));
    await waitFor(() => expect(store.uploads.size).toBe(1));
    expect(result.current.waiting).toBe(1);
    await waitFor(() => expect(result.current.items[0]!.status).toBe('done'));
    expect(sent).toBe(3);
    expect(result.current.waiting).toBe(0);
    await waitFor(() => expect(store.uploads.size).toBe(0));
  });

  it('after three tries it says so and can be tried again; the photo stays kept', async () => {
    script = ['neterror', 'neterror', 'neterror', 'ok'];
    const store = memoryStore();
    const { result } = renderHook(() => useWindowUploads('w1', [], { store, backoffMs: [1, 1] }));
    act(() => result.current.add([photo()]));
    await waitFor(() => expect(result.current.items[0]!.status).toBe('error'));
    expect(result.current.items[0]!.error).toBe(copy.uploadFailed);
    expect(result.current.items[0]!.retryable).toBe(true);
    expect(store.uploads.size).toBe(1);
    act(() => result.current.retry(result.current.items[0]!.key));
    await waitFor(() => expect(result.current.items[0]!.status).toBe('done'));
  });

  it('offline: the photo waits (not an error) and goes when the phone is back online', async () => {
    online = false;
    const store = memoryStore();
    const { result } = renderHook(() => useWindowUploads('w1', [], { store, backoffMs: [1, 1] }));
    act(() => result.current.add([photo()]));
    await waitFor(() => expect(result.current.items[0]!.status).toBe('waiting'));
    expect(sent).toBe(0);
    expect(result.current.waiting).toBe(1);
    online = true;
    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(result.current.items[0]!.status).toBe('done'));
    expect(sent).toBe(1);
  });

  it('a tab closed before the upload finished: opening the measurement again lists the photo and sends it', async () => {
    const store = memoryStore();
    await store.putUpload({ key: 'k1', measurementId: 'w1', name: 'den.jpg', type: 'image/jpeg', blob: new Blob(['x'], { type: 'image/jpeg' }), prepared: true, addedAt: 1 });
    await store.putUpload({ key: 'k2', measurementId: 'other', name: 'x.jpg', type: 'image/jpeg', blob: new Blob(['x'], { type: 'image/jpeg' }), prepared: true, addedAt: 2 });
    const { result } = renderHook(() => useWindowUploads('w1', [], { store, backoffMs: [1, 1] }));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0]!.name).toBe('den.jpg');
    await waitFor(() => expect(result.current.items[0]!.status).toBe('done'));
    expect(store.uploads.has('k1')).toBe(false);
    expect(store.uploads.has('k2')).toBe(true);
  });

  it('Remove forgets the kept photo too, and frees its preview', async () => {
    script = ['neterror', 'neterror', 'neterror'];
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(Object.create(URL) as typeof URL, { createObjectURL: () => 'blob:p1', revokeObjectURL: revoke }));
    const store = memoryStore();
    const { result } = renderHook(() => useWindowUploads('w1', [], { store, backoffMs: [1, 1] }));
    act(() => result.current.add([photo()]));
    await waitFor(() => expect(result.current.items[0]!.status).toBe('error'));
    act(() => result.current.remove(result.current.items[0]!.key));
    expect(result.current.items).toHaveLength(0);
    expect(revoke).toHaveBeenCalledWith('blob:p1');
    await waitFor(() => expect(store.uploads.size).toBe(0));
  });

  it('leaving the screen frees the previews of every photo added (not only those there at first)', async () => {
    const revoke = vi.fn();
    let n = 0;
    vi.stubGlobal('URL', Object.assign(Object.create(URL) as typeof URL, { createObjectURL: () => `blob:p${++n}`, revokeObjectURL: revoke }));
    const { result, unmount } = renderHook(() => useWindowUploads('w1', [], { store: memoryStore(), backoffMs: [1, 1] }));
    act(() => result.current.add([photo(), photo()]));
    await waitFor(() => expect(result.current.items.every((it) => it.status === 'done')).toBe(true));
    unmount();
    expect(revoke.mock.calls.map((c) => c[0])).toEqual(['blob:p1', 'blob:p2']);
  });
});

describe('windows saved on the phone, not yet on the server', () => {
  const w = (id: string): PhotoWindowInput => ({ id, uploadId: 'up1', corners: [[0, 0], [10, 0], [10, 10], [0, 10]], scale: { kind: 'known-side', side: 'width', inches: 30 } });

  it('kept until the server has them; put back and saved after a closed tab', async () => {
    const store = memoryStore();
    const restore = vi.fn();
    const first = renderHook(({ server }) => usePhotoWindowDrafts('w1', server, restore, store), { initialProps: { server: [w('a')] as PhotoWindowInput[] } });
    act(() => first.result.current.keep([w('a'), w('b')]));
    await waitFor(() => expect(store.drafts.get('w1')?.photoWindows).toHaveLength(2));
    first.unmount();
    // The tab closed before the PATCH: the server still has [a]
    renderHook(() => usePhotoWindowDrafts('w1', [w('a')], restore, store));
    await waitFor(() => expect(restore).toHaveBeenCalledWith([w('a'), w('b')]));
    cleanup();
    // The server has it now: the kept list goes
    const again = renderHook(({ server }) => usePhotoWindowDrafts('w1', server, vi.fn(), store), { initialProps: { server: [w('a'), w('b')] as PhotoWindowInput[] } });
    await waitFor(() => expect(store.drafts.size).toBe(0));
    again.unmount();
  });

  it('never saved over a list someone else changed since', async () => {
    const store = memoryStore();
    const restore = vi.fn();
    const first = renderHook(() => usePhotoWindowDrafts('w1', [w('a')], restore, store));
    act(() => first.result.current.keep([w('a'), w('b')]));
    await waitFor(() => expect(store.drafts.size).toBe(1));
    first.unmount();
    // The office deleted a and added c meanwhile
    renderHook(() => usePhotoWindowDrafts('w1', [w('c')], restore, store));
    await waitFor(() => expect(store.drafts.size).toBe(0));
    expect(restore).not.toHaveBeenCalled();
  });
});
