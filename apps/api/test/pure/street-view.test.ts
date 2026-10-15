import { describe, expect, it, vi } from 'vitest';
import { GoogleStreetView, StreetViewUnavailableError } from '../../src/providers/street-view.ts';
import { FakeStreetView, plainJpeg } from '../../src/providers/fakes/street-view.ts';

/* Street View with a mocked fetch: no network. The key must never reach an error. */

const KEY = 'AIza-secret-key-123';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sv(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const urls: string[] = [];
  const api = new GoogleStreetView({
    key: KEY,
    fetch: (async (url: string, init: RequestInit) => {
      urls.push(url);
      return handler(url, init);
    }) as unknown as typeof fetch,
  });
  return { api, urls };
}

async function failure(p: Promise<unknown>): Promise<StreetViewUnavailableError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(StreetViewUnavailableError);
    const e = err as StreetViewUnavailableError;
    expect(e.message).not.toContain(KEY);
    expect(e.stack ?? '').not.toContain(KEY);
    expect(e.cause).toBeUndefined();
    return e;
  }
  throw new Error('expected a failure');
}

const REQ = { panoId: 'abc_DEF-1', heading: 12.345, fov: 45, pitch: 3, widthPx: 640, heightPx: 640 };

describe('metadata', () => {
  it('reads the pano, the camera spot and the capture month', async () => {
    const { api, urls } = sv(async () => json({ status: 'OK', pano_id: 'abc_DEF-1', location: { lat: 36.37, lng: -94.2 }, date: '2019-05' }));
    expect(await api.metadata([-94.2001, 36.3702])).toEqual({ panoId: 'abc_DEF-1', location: [-94.2, 36.37], capturedOn: '2019-05' });
    expect(urls[0]).toContain('/metadata?location=36.3702000,-94.2001000&radius=60&source=outdoor&key=');
  });

  it('ZERO_RESULTS and NOT_FOUND are no imagery (null), not errors', async () => {
    expect(await sv(async () => json({ status: 'ZERO_RESULTS' })).api.metadata([-94, 36])).toBeNull();
    expect(await sv(async () => json({ status: 'NOT_FOUND' })).api.metadata([-94, 36])).toBeNull();
  });

  it('a denied key, a bad answer and an HTTP error are typed failures without the key', async () => {
    expect((await failure(sv(async () => json({ status: 'REQUEST_DENIED', error_message: `bad key ${KEY}` })).api.metadata([-94, 36]))).reason).toBe('denied');
    expect((await failure(sv(async () => new Response('not json')).api.metadata([-94, 36]))).reason).toBe('bad-answer');
    expect((await failure(sv(async () => json({ status: 'OK', location: { lat: 1 } })).api.metadata([-94, 36]))).reason).toBe('bad-answer');
    expect((await failure(sv(async () => json({}, 500)).api.metadata([-94, 36]))).reason).toBe('http');
  });

  it('a network error carrying the URL becomes a fresh error', async () => {
    const e = await failure(sv(async (url) => Promise.reject(new TypeError(`fetch failed ${url}`))).api.metadata([-94, 36]));
    expect(e.reason).toBe('http');
  });

  it('a hung request times out', async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const api = new GoogleStreetView({ key: KEY, fetch: hang as unknown as typeof fetch });
    vi.useFakeTimers();
    try {
      const pending = failure(api.metadata([-94, 36]));
      await vi.advanceTimersByTimeAsync(8_000);
      expect((await pending).reason).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('image', () => {
  const jpg = plainJpeg();

  it('asks for the pano, heading, fov, pitch and outdoor imagery at 640 x 640 at most', async () => {
    const { api, urls } = sv(async () => new Response(jpg, { headers: { 'content-type': 'image/jpeg' } }));
    const bytes = await api.image({ ...REQ, widthPx: 2000, heightPx: 2000 });
    expect(bytes[0]).toBe(0xff);
    expect(urls[0]).toMatch(/\?size=640x640&pano=abc_DEF-1&heading=12\.35&fov=45\.0&pitch=3\.0&source=outdoor&return_error_code=true&key=/);
  });

  it('no imagery (404), a non-image answer and an oversized one are typed failures', async () => {
    expect((await failure(sv(async () => new Response('', { status: 404 })).api.image(REQ))).reason).toBe('no-image');
    expect((await failure(sv(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })).api.image(REQ))).reason).toBe('bad-answer');
    expect((await failure(sv(async () => new Response('notajpeg', { headers: { 'content-type': 'image/jpeg' } })).api.image(REQ))).reason).toBe('bad-answer');
    const big = new Uint8Array(3 * 1024 * 1024);
    big[0] = 0xff;
    big[1] = 0xd8;
    expect((await failure(sv(async () => new Response(big, { headers: { 'content-type': 'image/jpeg' } })).api.image(REQ))).reason).toBe('too-large');
  });

  it('a pano id that is not Google-shaped is refused before any request', async () => {
    const { api, urls } = sv(async () => new Response(jpg, { headers: { 'content-type': 'image/jpeg' } }));
    await failure(api.image({ ...REQ, panoId: 'x&key=evil' }));
    expect(urls).toEqual([]);
  });
});

describe('the fake', () => {
  it('stands the camera south of the house and answers a grey JPEG; none and failures', async () => {
    const f = new FakeStreetView();
    const pano = (await f.metadata([-94, 36]))!;
    expect(pano.location[1]).toBeLessThan(36);
    expect((await f.image(REQ))[0]).toBe(0xff);
    f.none = true;
    expect(await f.metadata([-94, 36])).toBeNull();
    f.none = false;
    f.failNext();
    await expect(f.metadata([-94, 36])).rejects.toBeInstanceOf(StreetViewUnavailableError);
  });
});
