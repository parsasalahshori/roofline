import { describe, expect, it, vi } from 'vitest';
import { homeownerApi, HomeownerApiError } from '../src/features/quote/measure/api.ts';
import { homeownerMeasure as copy } from '../src/copy/homeownerMeasure.ts';
import { BASE, CREATED, REQ, SLUG, TOKEN, WINDOW, view } from './homeowner-fixtures.ts';

/* The homeowner API client with a stand-in fetch: the URLs, the bearer token, the bodies and how refusals come out. */

type Call = { url: string; init: RequestInit };
function fakeFetch(...replies: (() => Response)[]) {
  const calls: Call[] = [];
  const f = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    return Promise.resolve(next());
  });
  return { f: f as unknown as typeof fetch, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });

describe('homeowner API client', () => {
  const session = { requestId: REQ, token: TOKEN };

  it('creates a request without a token and sends the address and services', async () => {
    const { f, calls } = fakeFetch(json(CREATED, 201));
    const made = await homeownerApi(SLUG, { fetch: f }).create('4810 Underwood Ave', ['windows']);
    expect(made.token).toBe(TOKEN);
    expect(calls[0]!.url).toBe(`${BASE}/requests`);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.init.credentials).toBe('omit');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ address: '4810 Underwood Ave', services: ['windows'] });
  });

  it('puts the bearer token on every request call, with the right verb and path', async () => {
    const { f, calls } = fakeFetch(json(view([WINDOW])));
    const api = homeownerApi(SLUG, { fetch: f });
    await api.view(session);
    await api.putWindow(session, { id: WINDOW.id, room: 'Kitchen', style: 'double-hung', scale: WINDOW.scale, uploadId: WINDOW.uploadId!, corners: WINDOW.corners! });
    await api.deleteWindow(session, 'w-kitchen-1');
    await api.setCount(session, 18);
    await api.setCount(session, null);
    await api.book(session, { callMe: true });
    expect(calls.map((c) => `${c.init.method} ${c.url.replace(BASE, '')}`)).toEqual([
      `GET /requests/${REQ}`,
      `POST /requests/${REQ}/windows`,
      `DELETE /requests/${REQ}/windows/w-kitchen-1`,
      `PATCH /requests/${REQ}`,
      `PATCH /requests/${REQ}`,
      `POST /requests/${REQ}/book`,
    ]);
    for (const c of calls) expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[3]!.init.body as string)).toEqual({ estimatedTotalOverride: 18 });
    expect(JSON.parse(calls[4]!.init.body as string)).toEqual({ estimatedTotalOverride: null });
  });

  it('sends a photo as its own bytes with its type, not as JSON', async () => {
    const { f, calls } = fakeFetch(json({ id: 'u1', widthPx: 3024, heightPx: 4032 }, 201));
    const photo = new Blob(['jpegbytes'], { type: 'image/jpeg' });
    const up = await homeownerApi(SLUG, { fetch: f }).upload(session, photo);
    expect(up).toEqual({ id: 'u1', widthPx: 3024, heightPx: 4032 });
    expect(calls[0]!.url).toBe(`${BASE}/requests/${REQ}/uploads`);
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg');
    expect(calls[0]!.init.body).toBe(photo);
  });

  it('shows the server sentence and keeps the code and field of a refusal', async () => {
    const { f } = fakeFetch(json({ error: 'The card is too small to tap.', code: 'window_unsizable', field: 'scale' }, 422));
    const err = await homeownerApi(SLUG, { fetch: f }).putWindow(session, { id: 'x', room: 'a', style: 'picture', scale: WINDOW.scale }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HomeownerApiError);
    expect(err).toMatchObject({ status: 422, code: 'window_unsizable', field: 'scale', message: 'The card is too small to tap.' });
  });

  it('says the connection failed when fetch itself fails, and the generic sentence for an unreadable answer', async () => {
    const down = vi.fn(() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch;
    await expect(homeownerApi(SLUG, { fetch: down }).company()).rejects.toMatchObject({ status: 0, message: copy.loadFailed });
    const { f } = fakeFetch(() => new Response('<html>', { status: 502 }));
    await expect(homeownerApi(SLUG, { fetch: f }).company()).rejects.toMatchObject({ status: 502, message: copy.genericError });
  });

  it('waits out a short 429 once and retries; a long wait or a second 429 is shown', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { f, calls } = fakeFetch(json({ error: 'Slow down', code: 'rate_limited' }, 429, { 'Retry-After': '3' }), json({ id: 'u1', widthPx: 10, heightPx: 10 }, 201));
    const up = await homeownerApi(SLUG, { fetch: f, sleep }).upload(session, new Blob(['x'], { type: 'image/jpeg' }));
    expect(up.id).toBe('u1');
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(calls).toHaveLength(2);

    const long = fakeFetch(json({ error: 'Slow down', code: 'rate_limited' }, 429, { 'Retry-After': '60' }));
    await expect(homeownerApi(SLUG, { fetch: long.f, sleep }).view(session)).rejects.toMatchObject({ status: 429, message: copy.rateLimited, retryAfterSeconds: 60 });
    expect(long.calls).toHaveLength(1);

    const twice = fakeFetch(json({ error: 'Slow down', code: 'rate_limited' }, 429, { 'Retry-After': '3' }));
    await expect(homeownerApi(SLUG, { fetch: twice.f, sleep }).view(session)).rejects.toMatchObject({ status: 429 });
    expect(twice.calls).toHaveLength(2);
  });
});
