import type { HomeownerCompany, HomeownerCreated, HomeownerRequestView, HomeownerStatus, HomeownerWindowInput, QuoteProduct } from '@roofline/shared';
import { homeownerMeasure as copy } from '../../../copy/homeownerMeasure.ts';

/*
 * The homeowner API (/api/public/homeowner/:slug, docs/windows/homeowner-api.md) as the browser calls it. Plain fetch,
 * no cookies. Every call after POST /requests carries the bearer token. Every refusal has a sentence written for the
 * homeowner (`error`) and a machine `code`; a 429 is retried once when the wait is short (nothing was stored by it).
 */

export class HomeownerApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly field: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  constructor(status: number, message: string, code?: string, field?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'HomeownerApiError';
    this.status = status;
    this.code = code;
    this.field = field;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type HomeownerSlots = { timeZone: string; slots: { id: string; start: string; end: string }[] };
export type ContactBody = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  zip: string;
  contactConsent: true;
  textConsent: boolean;
  consentVersion: string;
};
export type BookBody = { slotStart: string } | { callMe: true };
export type Uploaded = { id: string; widthPx: number; heightPx: number };

export type Session = { requestId: string; token: string };

/** The longest wait a 429 is worth holding the screen for (the photo limit is 3 s; the minute limits are not waited out). */
const MAX_AUTO_WAIT_S = 5;

type Deps = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> };

export function homeownerApi(slug: string, deps: Deps = {}) {
  const doFetch = (input: string, init: RequestInit) => (deps.fetch ?? globalThis.fetch)(input, init);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = `/api/public/homeowner/${encodeURIComponent(slug)}`;

  async function send<T>(path: string, init: { method: string; token?: string; json?: unknown; body?: Blob; contentType?: string; signal?: AbortSignal }, retried = false): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.body !== undefined) {
      headers['Content-Type'] = init.contentType ?? 'application/octet-stream';
      body = init.body;
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { method: init.method, credentials: 'omit', headers, body, signal: init.signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new HomeownerApiError(0, copy.loadFailed);
    }
    let parsed: unknown;
    try {
      const text = await res.text();
      parsed = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      throw new HomeownerApiError(res.status, copy.genericError);
    }
    if (res.ok) return parsed as T;
    const f = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown; code?: unknown; field?: unknown }) : {};
    const retryAfter = Number(res.headers.get('Retry-After'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
    if (res.status === 429 && !retried && wait !== undefined && wait <= MAX_AUTO_WAIT_S) {
      await sleep(wait * 1000);
      return send<T>(path, init, true);
    }
    throw new HomeownerApiError(
      res.status,
      res.status === 429 ? copy.rateLimited : typeof f.error === 'string' && f.error !== '' ? f.error : copy.genericError,
      typeof f.code === 'string' ? f.code : undefined,
      typeof f.field === 'string' ? f.field : undefined,
      wait,
    );
  }

  const at = (s: Session) => `/requests/${encodeURIComponent(s.requestId)}`;

  return {
    company: (signal?: AbortSignal) => send<HomeownerCompany>('/company', { method: 'GET', signal }),
    create: (address: string, services: QuoteProduct[]) => send<HomeownerCreated>('/requests', { method: 'POST', json: { address, services } }),
    view: (s: Session, signal?: AbortSignal) => send<HomeownerRequestView>(at(s), { method: 'GET', token: s.token, signal }),
    upload: (s: Session, photo: Blob) => send<Uploaded>(`${at(s)}/uploads`, { method: 'POST', token: s.token, body: photo, contentType: photo.type === 'image/png' ? 'image/png' : 'image/jpeg' }),
    putWindow: (s: Session, w: HomeownerWindowInput) => send<HomeownerRequestView>(`${at(s)}/windows`, { method: 'POST', token: s.token, json: w }),
    deleteWindow: (s: Session, windowId: string) => send<HomeownerRequestView>(`${at(s)}/windows/${encodeURIComponent(windowId)}`, { method: 'DELETE', token: s.token }),
    setCount: (s: Session, count: number | null) => send<HomeownerRequestView>(at(s), { method: 'PATCH', token: s.token, json: { estimatedTotalOverride: count } }),
    contact: (s: Session, body: ContactBody) => send<HomeownerRequestView>(`${at(s)}/contact`, { method: 'POST', token: s.token, json: body }),
    slots: (s: Session) => send<HomeownerSlots>(`${at(s)}/slots`, { method: 'GET', token: s.token }),
    book: (s: Session, body: BookBody) => send<HomeownerRequestView>(`${at(s)}/book`, { method: 'POST', token: s.token, json: body }),
    status: (s: Session) => send<HomeownerStatus>(`${at(s)}/status`, { method: 'GET', token: s.token }),
  };
}

export type HomeownerClient = ReturnType<typeof homeownerApi>;
