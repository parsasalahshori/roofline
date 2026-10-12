import { type AdErrorKind, AdPlatformError } from '../ads-google.ts';

export { AdPlatformError };

/** Injected fetch (tests pass a fake that reads fixtures; production passes globalThis.fetch). */
export type FetchLike = typeof fetch;

/** Settings the adapter needs; built from Config in index.ts. */
export type GoogleAdsSettings = {
  developerToken: string;
  managerId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  apiVersion: string;
};

/** Authenticated REST client for the Google Ads API. */
export interface GoogleAdsHttp {
  /** POST customers/{customerId}/googleAds:search with {query}; returns the `results` array (all pages). */
  search(customerId: string, query: string): Promise<Record<string, unknown>[]>;
  /** POST customers/{customerId}/googleAds:mutate with {mutateOperations}; returns `mutateOperationResponses`. */
  mutate(
    customerId: string,
    mutateOperations: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]>;
  /** POST/GET any other path under /{apiVersion}/ (e.g. customers/{id}/customerClientLinks:mutate); returns parsed JSON. */
  request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>>;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_HOST = 'https://googleads.googleapis.com';
/** Refresh this long before the token's stated expiry, so a request never starts with a stale token. */
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Google Ads ids are digits; the console shows them with dashes. */
function digitsOnly(id: string): string {
  return id.replace(/-/g, '');
}

/** Parses an error body if it is JSON; anything else is treated as no detail. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The (key, value) pairs of every errorCode in a GoogleAdsFailure body. */
function errorCodePairs(body: unknown): Array<{ key: string; value: string }> {
  if (!isRecord(body) || !isRecord(body.error)) return [];
  const pairs: Array<{ key: string; value: string }> = [];
  for (const detail of records(body.error.details)) {
    for (const failure of records(detail.errors)) {
      if (!isRecord(failure.errorCode)) continue;
      for (const [key, value] of Object.entries(failure.errorCode)) {
        pairs.push({ key, value: typeof value === 'string' ? value : '' });
      }
    }
  }
  return pairs;
}

/** The gRPC-style status word of an error body, such as PERMISSION_DENIED. */
function errorStatusWord(body: unknown): string {
  return isRecord(body) &&
    isRecord(body.error) &&
    typeof body.error.status === 'string'
    ? body.error.status
    : '';
}

const POLICY_KEYS: ReadonlySet<string> = new Set([
  'policyViolationError',
  'policyFindingError',
]);
const PAYMENT_KEYS: ReadonlySet<string> = new Set([
  'billingSetupError',
  'paymentsAccountError',
  'accountBudgetError',
]);
const ACCESS_KEYS: ReadonlySet<string> = new Set([
  'authorizationError',
  'authenticationError',
]);
const ACCESS_STATUS_WORDS: ReadonlySet<string> = new Set([
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
]);

/**
 * Maps a failed Google response to our error kind. Only the status and error codes are read; the
 * provider's message is never kept. Checked in order: policy, payment, targeting, access, other.
 */
function classify(status: number | undefined, body: unknown): AdErrorKind {
  const pairs = errorCodePairs(body);
  const has = (test: (p: { key: string; value: string }) => boolean): boolean =>
    pairs.some(test);

  if (has((p) => POLICY_KEYS.has(p.key) || p.value.startsWith('POLICY_')))
    return 'policy';
  if (has((p) => PAYMENT_KEYS.has(p.key) || p.value.startsWith('BILLING_')))
    return 'payment';
  if (
    has((p) => p.key === 'criterionError' || p.value.startsWith('CRITERION_'))
  )
    return 'targeting';
  if (
    has((p) => ACCESS_KEYS.has(p.key)) ||
    status === 401 ||
    status === 403 ||
    ACCESS_STATUS_WORDS.has(errorStatusWord(body))
  ) {
    return 'access';
  }
  return 'other';
}

/** Authenticated Google Ads REST client: OAuth refresh with a cached access token, and JSON calls. */
class GoogleAdsRest implements GoogleAdsHttp {
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly settings: GoogleAdsSettings,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number,
  ) {}

  async search(
    customerId: string,
    query: string,
  ): Promise<Record<string, unknown>[]> {
    const path = `customers/${digitsOnly(customerId)}/googleAds:search`;
    const results: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    do {
      const body: JsonRecord =
        pageToken === undefined ? { query } : { query, pageToken };
      const page = await this.call('POST', path, body);
      results.push(...records(page.results));
      pageToken =
        typeof page.nextPageToken === 'string' && page.nextPageToken !== ''
          ? page.nextPageToken
          : undefined;
    } while (pageToken !== undefined);
    return results;
  }

  async mutate(
    customerId: string,
    mutateOperations: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const path = `customers/${digitsOnly(customerId)}/googleAds:mutate`;
    const json = await this.call('POST', path, { mutateOperations });
    return records(json.mutateOperationResponses);
  }

  request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    return this.call(method, path.replace(/^\/+/, ''), body);
  }

  /** Calls one API path under /{apiVersion}/ and returns the parsed JSON object. */
  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<JsonRecord> {
    const accessToken = await this.accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': this.settings.developerToken,
      'login-customer-id': digitsOnly(this.settings.managerId),
      'Content-Type': 'application/json',
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await this.send(
      `${API_HOST}/${this.settings.apiVersion}/${path}`,
      init,
    );
    return readJsonObject(res);
  }

  /** The cached access token, refreshed when it is near expiry. Concurrent callers share one refresh. */
  private async accessToken(): Promise<string> {
    if (this.token !== null && this.now() < this.token.expiresAt)
      return this.token.value;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const started = this.now();
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.settings.clientId,
      client_secret: this.settings.clientSecret,
      refresh_token: this.settings.refreshToken,
    });
    const res = await this.send(
      TOKEN_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      },
      'access',
    );
    const grant = await readJsonObject(res);
    if (
      typeof grant.access_token !== 'string' ||
      typeof grant.expires_in !== 'number'
    ) {
      throw new AdPlatformError('access', res.status);
    }
    this.token = {
      value: grant.access_token,
      expiresAt: started + grant.expires_in * 1000 - EXPIRY_MARGIN_MS,
    };
    return grant.access_token;
  }

  /**
   * Sends one request. A network failure or timeout is 'other'. A non-2xx response is classified from
   * its error body, or is always `failureKind` when one is given (the token endpoint is always 'access').
   */
  private async send(
    url: string,
    init: RequestInit,
    failureKind?: AdErrorKind,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch {
      throw new AdPlatformError('other');
    }
    if (res.ok) return res;

    if (failureKind !== undefined)
      throw new AdPlatformError(failureKind, res.status);
    const text = await res.text().catch(() => '');
    throw new AdPlatformError(
      classify(res.status, parseJson(text)),
      res.status,
    );
  }
}

/** Reads a 2xx body as a JSON object. An empty body is {}; anything unreadable is 'other'. */
async function readJsonObject(res: Response): Promise<JsonRecord> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new AdPlatformError('other', res.status);
  }
  if (text.trim() === '') return {};
  const parsed = parseJson(text);
  if (!isRecord(parsed)) throw new AdPlatformError('other', res.status);
  return parsed;
}

export function createGoogleAdsHttp(
  settings: GoogleAdsSettings,
  fetchImpl: FetchLike,
  now: () => number = Date.now,
): GoogleAdsHttp {
  return new GoogleAdsRest(settings, fetchImpl, now);
}
