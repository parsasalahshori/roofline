import type { PublicQuoteConfig, PublicQuoteEstimate, PublicQuoteLeadResult, PublicQuoteSlots, QuoteProduct } from '@roofline/shared';
import { quote } from '../../copy/quote.ts';

/*
 * The instant quote page's calls to /api/public/quote/:slug. Plain fetch, no cookies, no React Query: the page is
 * its own small bundle (main.tsx loads it alone for /q/*). Nothing personal ever goes in a URL; the lead's details go
 * in the POST body only.
 */

export class QuoteApiError extends Error {
  readonly status: number;
  readonly field: string | undefined;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.name = 'QuoteApiError';
    this.status = status;
    this.field = field;
  }
}

const base = (slug: string) => `/api/public/quote/${encodeURIComponent(slug)}`;

async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'omit',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new QuoteApiError(0, quote.loadFailed);
  }
  let parsed: unknown;
  try {
    const text = await res.text();
    parsed = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    throw new QuoteApiError(res.status, quote.genericError);
  }
  if (res.ok) return parsed as T;
  const failure = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown; field?: unknown }) : {};
  throw new QuoteApiError(
    res.status,
    typeof failure.error === 'string' && failure.error !== '' ? failure.error : quote.genericError,
    typeof failure.field === 'string' ? failure.field : undefined,
  );
}

export type EstimateAnswer = PublicQuoteEstimate & { formToken: string };

export type LeadBody = {
  quoteId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  postalCode: string;
  products: QuoteProduct[];
  consent: true;
  /** The optional "text me" box. */
  textConsent: boolean;
  /** The homeowner's own window count, when they changed it. */
  windowCount?: number;
  consentVersion: string;
  formToken: string;
  slotId?: string;
  website: string;
  turnstileToken?: string;
};

export const quoteApi = {
  config: (slug: string, signal?: AbortSignal) => call<PublicQuoteConfig>(base(slug), undefined, signal),
  estimate: (slug: string, body: { address: string; website: string; turnstileToken?: string }) => call<EstimateAnswer>(`${base(slug)}/estimate`, body),
  slots: (slug: string, signal?: AbortSignal) => call<PublicQuoteSlots>(`${base(slug)}/slots`, undefined, signal),
  lead: (slug: string, body: LeadBody) => call<PublicQuoteLeadResult>(`${base(slug)}/lead`, body),
};
