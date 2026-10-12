import { CalendarAuthError, CalendarUnavailableError } from './calendar.ts';

/** A fetch bound to the Google adapter's timeout and error mapping. */
export type GoogleHttp = (url: string, init?: RequestInit) => Promise<Response>;

/** Constant messages: never built from tokens, URLs, headers or response bodies. */
export const GOOGLE_UNAVAILABLE_MESSAGE = "Couldn't reach Google Calendar.";
export const GOOGLE_RECONNECT_MESSAGE = 'Reconnect your calendar.';

/** The OAuth token endpoint. Its 401/403 are client-credential problems, not a dead grant, so the adapter classifies them from the OAuth error body. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const DEFAULT_TIMEOUT_MS = 10000;

/** Reads a JSON body; a body that is not JSON is an unavailable service, not a crash. */
export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new CalendarUnavailableError(GOOGLE_UNAVAILABLE_MESSAGE);
  }
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']);

/** True when a 403 body says rate or quota limit (not a permission problem). Never throws; a body that is not JSON is not a rate limit. */
async function isRateLimited(res: Response): Promise<boolean> {
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error !== 'object' || error === null) return false;
    const { status, errors } = error as { status?: unknown; errors?: unknown };
    if (status === 'RESOURCE_EXHAUSTED') return true;
    const reason = Array.isArray(errors) ? (errors[0] as { reason?: unknown } | null)?.reason : undefined;
    return typeof reason === 'string' && RATE_LIMIT_REASONS.has(reason);
  } catch {
    return false;
  }
}

/** Builds the GoogleHttp: 10 s default timeout; network/timeout/429/5xx and rate/quota 403s -> CalendarUnavailableError; 401 and other 403s -> CalendarAuthError (the token endpoint is exempt from the 401/403 mapping); every other status is returned as is. */
export function makeGoogleHttp(o: { fetch?: typeof fetch; timeoutMs?: number }): GoogleHttp {
  const doFetch = o.fetch ?? globalThis.fetch;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (url, init) => {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new CalendarUnavailableError(GOOGLE_UNAVAILABLE_MESSAGE);
    }
    if (res.status === 429 || res.status >= 500) throw new CalendarUnavailableError(GOOGLE_UNAVAILABLE_MESSAGE);
    if (url === GOOGLE_TOKEN_URL) return res;
    if (res.status === 403 && (await isRateLimited(res))) throw new CalendarUnavailableError(GOOGLE_UNAVAILABLE_MESSAGE);
    if (res.status === 401 || res.status === 403) throw new CalendarAuthError(GOOGLE_RECONNECT_MESSAGE);
    return res;
  };
}
