import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, setUnauthorizedHandler } from '../src/api/client.ts';
import { common } from '../src/copy/common.ts';
import { errors } from '../src/copy/errors.ts';

const fetchMock = vi.fn<typeof fetch>();

function reply(status: number, body?: unknown, raw?: string): Response {
  return new Response(raw ?? (body === undefined ? null : JSON.stringify(body)), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The ApiError a call ends in; fails the test if it resolves. */
async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setUnauthorizedHandler(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('reads a JSON answer', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    await expect(apiFetch<{ ok: boolean }>('/api/auth/me')).resolves.toEqual({ ok: true });
  });

  it('sends cookies for this site, and a JSON body with the method it was given', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    const signal = new AbortController().signal;
    await apiFetch('/api/auth/login', { method: 'POST', body: { email: 'a@b.co' }, signal });

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/auth/login');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"email":"a@b.co"}', signal });
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('sends a plain GET with no body and no content type', async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    await apiFetch('/api/auth/me');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('content-type')).toBeNull();
  });

  it('resolves to undefined when the answer has no body', async () => {
    fetchMock.mockResolvedValue(reply(204));
    await expect(apiFetch('/api/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('turns a 409 with the latest view into an ApiError that carries it', async () => {
    const latest = { id: 't1', status: 'approved' };
    fetchMock.mockResolvedValue(reply(409, { error: "This changed while you were looking. Here's the latest.", latest }));

    const error = await failure(apiFetch('/api/approvals/t1/approve', { method: 'POST' }));
    expect(error.status).toBe(409);
    expect(error.message).toBe("This changed while you were looking. Here's the latest.");
    expect(error.latest).toEqual(latest);
    expect(error.field).toBeUndefined();
  });

  it('carries the field a 400 is about', async () => {
    fetchMock.mockResolvedValue(reply(400, { error: 'Please enter a valid email.', field: 'email' }));

    const error = await failure(apiFetch('/api/auth/login', { method: 'POST', body: {} }));
    expect(error.status).toBe(400);
    expect(error.message).toBe('Please enter a valid email.');
    expect(error.field).toBe('email');
  });

  it('turns a failed request into a status 0 error with the network words', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await failure(apiFetch('/api/auth/me'));
    expect(error.status).toBe(0);
    expect(error.message).toBe(common.networkError);
  });

  it('lets an aborted request stay an abort: it is not a lost connection', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    fetchMock.mockRejectedValue(abort);

    await expect(apiFetch('/api/auth/me')).rejects.toBe(abort);
  });

  it('gives plain words when the server answered with something that is not ours', async () => {
    fetchMock.mockResolvedValue(reply(502, undefined, '<html>Bad gateway</html>'));

    const error = await failure(apiFetch('/api/auth/me'));
    expect(error.status).toBe(502);
    expect(error.message).toBe(errors.generic);
  });

  it('gives plain words when a good answer cannot be read', async () => {
    fetchMock.mockResolvedValue(reply(200, undefined, '<!doctype html><title>Roofline</title>'));

    const error = await failure(apiFetch('/api/auth/me'));
    expect(error.status).toBe(200);
    expect(error.message).toBe(errors.generic);
  });

  it('calls the unauthorized handler once for a 401, and still fails the call', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(reply(401, { error: 'Please sign in.' }));

    const error = await failure(apiFetch('/api/approvals'));
    expect(error.status).toBe(401);
    expect(error.message).toBe('Please sign in.');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not call the handler for a 401 the caller asked to handle itself', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(reply(401, { error: "That email and password don't match." }));

    const error = await failure(apiFetch('/api/auth/login', { method: 'POST', body: {}, redirectOn401: false }));
    expect(error.status).toBe(401);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not call the handler for other statuses', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(reply(403, { error: "Your role can't do that. Ask the owner." }));

    await failure(apiFetch('/api/team'));
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
