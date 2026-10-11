export const TWILIO_API = 'https://api.twilio.com/2010-04-01';
export const TWILIO_MESSAGING = 'https://messaging.twilio.com/v1';
export const TWILIO_TRUSTHUB = 'https://trusthub.twilio.com/v1';

/** How long a Twilio request may take before we give up on it (the outcome is then unknown). */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Twilio refused the request (a 4xx). Only the status and Twilio's numeric error code are kept: its
 * message echoes phone numbers and bodies, so it is never stored, shown or logged.
 */
export class TwilioApiError extends Error {
  readonly status: number;
  readonly code: number | null;
  constructor(status: number, code: number | null) {
    super(`Twilio refused the request (status ${status}, code ${code ?? 'none'}).`);
    this.status = status;
    this.code = code;
  }
}

/** Twilio did not answer usably: a network error, a timeout, a 5xx or an unreadable 2xx body. */
export class TwilioUnreachableError extends Error {
  constructor() {
    super("Twilio didn't answer.");
  }
}

type Credentials = { accountSid: string; authToken: string };
type Params = Record<string, string | string[] | undefined>;

/** A small Twilio REST client: Basic auth, form bodies for POST, query strings for GET and DELETE. */
export class TwilioHttp {
  private readonly credentials: Credentials;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number;

  constructor(o: { accountSid: string; authToken: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.credentials = { accountSid: o.accountSid, authToken: o.authToken };
    this.fetchImpl = o.fetch;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** A client for the same fetch and timeout, with other credentials (a company's subaccount). */
  as(sub: Credentials): TwilioHttp {
    return new TwilioHttp({ ...sub, fetch: this.fetchImpl, timeoutMs: this.timeoutMs });
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE', url: string, params?: Params): Promise<T> {
    const { accountSid, authToken } = this.credentials;
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    let target = url;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(paramEntries(params)).toString();
    } else {
      const query = new URL(url);
      for (const [key, value] of paramEntries(params)) query.searchParams.append(key, value);
      target = query.toString();
    }

    // Looked up at call time, so a global fetch installed after this client was built is used.
    const send = this.fetchImpl ?? globalThis.fetch;
    let res: Response;
    try {
      res = await send(target, init);
    } catch {
      throw new TwilioUnreachableError();
    }

    if (res.status >= 400 && res.status < 500) {
      throw new TwilioApiError(res.status, await readErrorCode(res));
    }
    if (!res.ok) throw new TwilioUnreachableError();
    if (res.status === 204) return undefined as T;

    try {
      return JSON.parse(await res.text()) as T;
    } catch {
      throw new TwilioUnreachableError();
    }
  }
}

/** The parameter pairs to send: undefined values are left out, and an array repeats its key. */
function paramEntries(params: Params | undefined): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) pairs.push([key, item]);
    } else {
      pairs.push([key, value]);
    }
  }
  return pairs;
}

/** The numeric `code` from a 4xx body, or null when the body is unreadable or has none. */
async function readErrorCode(res: Response): Promise<number | null> {
  try {
    const body = JSON.parse(await res.text()) as { code?: unknown };
    return typeof body.code === 'number' ? body.code : null;
  } catch {
    return null;
  }
}
