import { z } from 'zod';

export type EagleViewHost = 'orders' | 'property';
export type EagleViewErrorKind = 'network' | 'unavailable' | 'rejected' | 'not_found' | 'bad_response';

/** Thrown by EagleViewHttp. Message is our own plain text: never provider text, secrets or addresses. */
export class EagleViewHttpError extends Error {
  constructor(
    readonly kind: EagleViewErrorKind,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

export type EagleViewResponse = { status: number; body: unknown };

const TOKEN_URL = 'https://apicenter.eagleview.com/oauth2/v1/token';
const TIMEOUT_MS = 15_000;
/** Refresh this long before the provider's stated expiry. */
const EXPIRY_MARGIN_S = 60;

const BASE_URLS: Record<EagleViewHost, Record<'sandbox' | 'production', string>> = {
  orders: {
    sandbox: 'https://webservices-integrations.eagleview.com',
    production: 'https://webservices.eagleview.com',
  },
  property: {
    sandbox: 'https://sandbox.apis.eagleview.com',
    production: 'https://apis.eagleview.com',
  },
};

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
});

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type RawResult = { status: number; text: string };

const MESSAGES: Record<EagleViewErrorKind, string> = {
  network: "EagleView didn't answer.",
  unavailable: 'EagleView is unavailable right now.',
  rejected: 'EagleView rejected the request.',
  not_found: 'EagleView has no record for this request.',
  bad_response: 'EagleView sent a response we could not read.',
};

function fail(kind: EagleViewErrorKind, status: number | null): EagleViewHttpError {
  return new EagleViewHttpError(kind, status, MESSAGES[kind]);
}

/** Maps a non-401 provider status to our error kind; null when the status is a 2xx success. */
function errorForStatus(status: number): EagleViewHttpError | null {
  if (status >= 200 && status < 300) {
    // 204 is listed explicitly as not_found in the adapter contract (no content, no record).
    return status === 204 ? fail('not_found', status) : null;
  }
  if (status === 429 || status >= 500) return fail('unavailable', status);
  if (status === 401 || status === 403) return fail('rejected', status);
  if (status === 404 || status === 422) return fail('not_found', status);
  return fail('rejected', status);
}

/**
 * TO CONFIRM AT PARTNER ONBOARDING: the production auth flavor for Measurement Orders. v1 used a bearer
 * token from the account integration; this class uses the client-credentials token for both hosts. Auth
 * lives only here (plan Ruling 5), so a different flavor changes this class and nothing else.
 */
export class EagleViewHttp {
  readonly env: 'sandbox' | 'production';
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private cached: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(o: {
    clientId: string;
    clientSecret: string;
    env: 'sandbox' | 'production';
    fetch?: typeof fetch;
    now?: () => number;
  }) {
    this.env = o.env;
    this.clientId = o.clientId;
    this.clientSecret = o.clientSecret;
    // Wrapped so the native fetch is never invoked with this instance as its receiver.
    this.fetchFn = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = o.now ?? Date.now;
  }

  /**
   * Resolves for 2xx (body = parsed JSON, or null when empty). Throws EagleViewHttpError otherwise.
   * A 401 drops the cached token and retries once with a fresh token.
   */
  async request(host: EagleViewHost, method: 'GET' | 'POST', path: string, body?: unknown): Promise<EagleViewResponse> {
    let res = await this.send(host, method, path, body, await this.accessToken());
    if (res.status === 401) {
      this.cached = null;
      res = await this.send(host, method, path, body, await this.accessToken());
    }
    const failure = errorForStatus(res.status);
    if (failure) throw failure;
    return { status: res.status, body: parseBody(res.text) };
  }

  private async send(
    host: EagleViewHost,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    token: string,
  ): Promise<RawResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const init: RequestInit = {
      method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return this.fetchRaw(`${BASE_URLS[host][this.env]}${path}`, init);
  }

  private async fetchRaw(url: string, init: RequestInit): Promise<RawResult> {
    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch {
      throw fail('network', null);
    }
    try {
      return { status: res.status, text: await res.text() };
    } catch {
      throw fail('network', null);
    }
  }

  /** Returns a cached token, or shares the one fetch that is already in flight. */
  private accessToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt) return Promise.resolve(this.cached.token);
    if (this.pending) return this.pending;
    this.pending = this.fetchToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetchRaw(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const failure = errorForStatus(res.status);
    if (failure) throw failure;
    const parsed = tokenSchema.safeParse(parseBody(res.text));
    if (!parsed.success) throw fail('bad_response', res.status);
    const lifetimeMs = Math.max(0, parsed.data.expires_in - EXPIRY_MARGIN_S) * 1000;
    this.cached = { token: parsed.data.access_token, expiresAt: this.now() + lifetimeMs };
    return parsed.data.access_token;
  }
}

/** Empty body is null; invalid JSON throws bad_response. */
function parseBody(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw fail('bad_response', null);
  }
}
