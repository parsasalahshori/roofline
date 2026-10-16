import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { DirObjectStore } from '../../src/providers/fakes/dir-object-store.ts';
import { MemoryObjectStore } from '../../src/providers/fakes/object-store.ts';
import { parseListObjects, R2ObjectStore } from '../../src/providers/r2.ts';
import { UnconfiguredObjectStore } from '../../src/providers/object-store.ts';

/* ObjectStore.list: what the google-retention job lists to find Google content and orphans under its prefixes. */

const PAGE = (keys: string[], next?: string) => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>b</Name><Prefix>roof-photos/</Prefix><IsTruncated>${next !== undefined}</IsTruncated>
${keys.map((k) => `<Contents><Key>${k}</Key><LastModified>2026-10-01T10:00:00.000Z</LastModified><Size>3</Size></Contents>`).join('')}
${next !== undefined ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}</ListBucketResult>`;

describe('ObjectStore.list', () => {
  test('S3 ListObjectsV2 XML: keys (unescaped), times, and the next page', () => {
    const page = parseListObjects(PAGE(['roof-photos/a.png', 'roof-photos/b&amp;c.png'], 'tok&amp;1'));
    expect(page.objects).toEqual([
      { key: 'roof-photos/a.png', lastModified: new Date('2026-10-01T10:00:00.000Z') },
      { key: 'roof-photos/b&c.png', lastModified: new Date('2026-10-01T10:00:00.000Z') },
    ]);
    expect(page).toMatchObject({ truncated: true, next: 'tok&1' });
    expect(parseListObjects(PAGE([]))).toEqual({ objects: [], truncated: false, next: null });
  });

  test('R2 follows the continuation token across pages, with the prefix on every request', async () => {
    const urls: URL[] = [];
    const store = new R2ObjectStore({
      accountId: 'acct',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      bucket: 'files',
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        urls.push(url);
        return new Response(url.searchParams.get('continuation-token') === null ? PAGE(['roof-photos/1.png'], 'next') : PAGE(['roof-photos/2.png']));
      },
    });
    expect((await store.list('roof-photos/')).map((o) => o.key)).toEqual(['roof-photos/1.png', 'roof-photos/2.png']);
    expect(urls.map((u) => [u.searchParams.get('list-type'), u.searchParams.get('prefix'), u.searchParams.get('continuation-token')])).toEqual([
      ['2', 'roof-photos/', null],
      ['2', 'roof-photos/', 'next'],
    ]);
  });

  test('R2 refuses with a plain error on a failed listing', async () => {
    const store = new R2ObjectStore({ accountId: 'a', accessKeyId: 'i', secretAccessKey: 's', bucket: 'b', fetch: async () => new Response('<Error>secret detail</Error>', { status: 500 }) });
    await expect(store.list('roof-photos/')).rejects.toThrow("File storage isn't available right now (status 500).");
  });

  test('the demo directory store lists by prefix from each file\'s key, and delete removes both files', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dir-store-'));
    const store = new DirObjectStore(dir);
    await store.put('roof-photos/a.png', new Uint8Array([1]));
    await store.put('window-photos/b.jpg', new Uint8Array([2]));
    await store.put('signed/c.pdf', new Uint8Array([3]));
    expect((await store.list('roof-photos/')).map((o) => o.key)).toEqual(['roof-photos/a.png']);
    expect((await store.list('window-photos/'))[0]!.lastModified).toBeInstanceOf(Date);
    await store.delete('roof-photos/a.png');
    expect(await store.list('roof-photos/')).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(4);
    expect(await new DirObjectStore(path.join(dir, 'missing')).list('roof-photos/')).toEqual([]);
  });

  test('the memory store lists by prefix and can be back-dated; the unconfigured store refuses', async () => {
    const store = new MemoryObjectStore();
    await store.put('roof-photos/a.png', new Uint8Array([1]), 'image/png');
    await store.put('other/b', new Uint8Array([1]), 'x');
    store.setLastModified('roof-photos/a.png', new Date('2026-01-01T00:00:00Z'));
    expect(await store.list('roof-photos/')).toEqual([{ key: 'roof-photos/a.png', lastModified: new Date('2026-01-01T00:00:00Z') }]);
    await expect(new UnconfiguredObjectStore().list()).rejects.toThrow("File storage isn't set up.");
  });
});
