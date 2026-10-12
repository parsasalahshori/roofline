import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.ts';
import { R2ObjectStore, r2For } from '../src/providers/r2.ts';

const KEY = 'companies/c1/proposals/p1/signed-abc.pdf';

function fixture(name: string): string[] {
  return readFileSync(new URL(`./fixtures/r2/${name}`, import.meta.url), 'utf8').trim().split('\n');
}

function setup(respond: () => Response) {
  const seen: Request[] = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(input instanceof Request ? input : new Request(input, init));
    return respond();
  }) as typeof fetch;
  const store = new R2ObjectStore({
    accountId: 'acct123',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret-example-key',
    bucket: 'bucket1',
    fetch: stub,
  });
  return { seen, store };
}

function assertShape(req: Request, lines: string[]): void {
  const url = new URL(req.url);
  const auth = req.headers.get('authorization') ?? '';
  const actual = [
    req.method,
    `host: ${url.host}`,
    `path: ${url.pathname}`,
    ...(req.headers.get('content-type') ? [`content-type: ${req.headers.get('content-type')}`] : []),
    `authorization-prefix: ${auth.slice(0, auth.indexOf('AKIDEXAMPLE/') + 'AKIDEXAMPLE/'.length)}`,
  ];
  expect(actual).toEqual(lines);
}

describe('R2 object store', () => {
  it('signs a PUT with SigV4', async () => {
    const { seen, store } = setup(() => new Response(null, { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.put(KEY, bytes, 'application/pdf');
    const req = seen[0]!;
    expect(req.method).toBe('PUT');
    const url = new URL(req.url);
    expect(url.host).toBe('acct123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe(`/bucket1/${KEY}`);
    expect(req.headers.get('x-amz-content-sha256')).toBe(createHash('sha256').update(bytes).digest('hex'));
    const auth = req.headers.get('authorization') ?? '';
    expect(auth.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/')).toBe(true);
    expect(auth).toContain('/auto/s3/aws4_request');
    expect(req.headers.get('content-type')).toBe('application/pdf');
    assertShape(req, fixture('put-request.txt'));
  });

  it('get returns bytes on 200 and null on 404', async () => {
    const ok = setup(() => new Response(new Uint8Array([9, 8, 7]), { status: 200 }));
    expect(await ok.store.get(KEY)).toEqual(new Uint8Array([9, 8, 7]));
    assertShape(ok.seen[0]!, fixture('get-request.txt'));
    const missing = setup(() => new Response('nope', { status: 404 }));
    expect(await missing.store.get(KEY)).toBeNull();
  });

  it('a 500 with provider text throws a plain message with the status and without the provider text', async () => {
    const { store } = setup(() => new Response('SECRET-PROVIDER-TEXT', { status: 500 }));
    const put = await store.put(KEY, new Uint8Array([1]), 'application/pdf').catch((e: Error) => e);
    expect(put).toBeInstanceOf(Error);
    expect((put as Error).message).toContain('500');
    expect((put as Error).message).not.toContain('SECRET');
    const get = await store.get(KEY).catch((e: Error) => e);
    expect((get as Error).message).toContain('500');
    expect((get as Error).message).not.toContain('SECRET');
  });

  it('r2For returns null unless all four settings are present, and an R2ObjectStore when they are', () => {
    const full = {
      R2_ACCOUNT_ID: 'acct123',
      R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      R2_SECRET_ACCESS_KEY: 's',
      R2_BUCKET: 'bucket1',
    };
    expect(r2For({} as Config)).toBeNull();
    for (const k of Object.keys(full)) {
      expect(r2For({ ...full, [k]: undefined } as unknown as Config)).toBeNull();
    }
    expect(r2For(full as unknown as Config)).toBeInstanceOf(R2ObjectStore);
  });
});
