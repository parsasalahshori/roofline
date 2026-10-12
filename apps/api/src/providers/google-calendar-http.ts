import { CalendarAuthError, CalendarUnavailableError } from './calendar.ts';

/** A fetch bound to the Google adapter's timeout and error mapping. */
export type GoogleHttp = (url: string, init?: RequestInit) => Promise<Response>;

/** Constant messages: never built from tokens, URLs, headers or response bodies. */
export const GOOGLE_UNAVAILABLE_MESSAGE = "Couldn't reach Google Calendar.";
export const GOOGLE_RECONNECT_MESSAGE = 'Reconnect your calendar.';

const DEFAULT_TIMEOUT_MS = 10000;

/** Builds the GoogleHttp: 10 s default timeout; network/timeout/429/5xx -> CalendarUnavailableError; 401/403 -> CalendarAuthError; every other status is returned as is. */
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
    if (res.status === 401 || res.status === 403) throw new CalendarAuthError(GOOGLE_RECONNECT_MESSAGE);
    return res;
  };
}
