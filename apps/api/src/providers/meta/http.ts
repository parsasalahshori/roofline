import { createHmac } from 'node:crypto';
import { type AdErrorKind, AdPlatformError } from '../ads-google.ts';

/*
 * Graph API calls for the Meta adapter. Every request carries the system-user token and an
 * appsecret_proof, and every failure becomes an AdPlatformError whose kind is a short plain word.
 * Meta's own message text, the token, the secret and the proof never leave this file in an error.
 */

/** Shell from the Task 18 lead: types are final, bodies are filled by package P1. */
export type MetaHttpOptions = { appSecret: string; token: string; version: string; fetch?: typeof fetch; baseUrl?: string };
export interface MetaHttp {
  /** GET <base>/<version>/<path>?<query>&access_token&appsecret_proof; returns parsed JSON. Throws AdPlatformError. */
  get(path: string, query?: Record<string, string>): Promise<unknown>;
  /** POST form-encoded (string values; objects/arrays JSON-stringified) or a FormData body. Throws AdPlatformError. */
  post(path: string, body: Record<string, unknown> | FormData): Promise<unknown>;
}

const DEFAULT_BASE_URL = 'https://graph.facebook.com';
// Image uploads and report pulls can be slow, so the limit is generous but still finite.
const TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

/** Graph error codes that mean the token or the app lacks access. */
const ACCESS_CODES: ReadonlySet<number> = new Set([190, 102, 10, 200, 299]);
/** Graph error codes for rate limits: retry later, never a fix the owner can make. */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([17, 4, 32, 613]);
/** Graph error codes for ad policy rejections. */
const POLICY_CODES: ReadonlySet<number> = new Set([1487390, 1487301]);
/** Graph error subcodes that mean Meta requires the Housing special ad category (matched, never stored). */
const SPECIAL_CATEGORY_SUBCODES: ReadonlySet<number> = new Set([1885832, 1870034, 1870047, 1815857]);
/** Graph error subcodes for a missing or failing payment method. */
const PAYMENT_SUBCODES: ReadonlySet<number> = new Set([1359188, 2446392]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The `error` object of a Graph failure body, or null when the body carries no error. */
function errorOf(body: unknown): JsonRecord | null {
  if (!isRecord(body) || !('error' in body)) return null;
  return isRecord(body.error) ? body.error : {};
}

/** Lower-cased provider text, used only to match a kind. It is never stored or shown. */
function textOf(error: JsonRecord | null): string {
  if (!error) return '';
  return ['message', 'error_user_title', 'error_user_msg']
    .map((key) => (typeof error[key] === 'string' ? error[key] : ''))
    .join(' ')
    .toLowerCase();
}

/** Maps a Graph failure (HTTP status plus parsed body) to one of the shared ad error kinds. */
export function mapMetaError(status: number, body: unknown): AdErrorKind {
  const error = errorOf(body);
  const code = numberOf(error?.code);
  const subcode = numberOf(error?.error_subcode);
  const text = textOf(error);

  if ((code !== undefined && ACCESS_CODES.has(code)) || status === 401 || status === 403) return 'access';
  if (
    code === 2635 ||
    (subcode !== undefined && SPECIAL_CATEGORY_SUBCODES.has(subcode)) ||
    text.includes('special ad categor')
  ) {
    return 'targeting';
  }
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) return 'other';
  if ((code !== undefined && POLICY_CODES.has(code)) || text.includes('ad policies') || text.includes('rejected')) {
    return 'policy';
  }
  if ((subcode !== undefined && PAYMENT_SUBCODES.has(subcode)) || text.includes('payment') || text.includes('billing')) {
    return 'payment';
  }
  if (code === 100 && (subcode === 1487851 || text.includes('targeting'))) return 'targeting';
  return 'other';
}

/** HMAC-SHA256(key = app secret, message = token), hex. */
export function appSecretProof(token: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(token).digest('hex');
}

/** Graph query values keep commas readable; every other reserved character is percent-encoded. */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/%2C/g, ',');
}

function stringifyField(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Runs one request and returns the parsed JSON, or throws the mapped AdPlatformError. */
async function send(fetchFn: (input: string, init: RequestInit) => Promise<Response>, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    // A refused connection, DNS failure, timeout or abort: no status, no provider text.
    throw new AdPlatformError('other');
  }

  let parsed: unknown;
  try {
    const text = await response.text();
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (!response.ok || errorOf(parsed) !== null) {
    const error = errorOf(parsed);
    const graph = { code: numberOf(error?.code), subcode: numberOf(error?.error_subcode) };
    throw new AdPlatformError(mapMetaError(response.status, parsed), response.status, graph);
  }
  if (parsed === undefined) throw new AdPlatformError('other', response.status);
  return parsed;
}

export function createMetaHttp(options: MetaHttpOptions): MetaHttp {
  const { appSecret, token, version } = options;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const proof = appSecretProof(token, appSecret);
  // Called as a plain function, so an injected fake and the native fetch both work.
  const impl = options.fetch ?? globalThis.fetch;
  const fetchFn = (input: string, init: RequestInit) => impl(input, init);

  const urlFor = (path: string): string => `${baseUrl}/${version}/${path.replace(/^\/+/, '')}`;

  return {
    async get(path, query) {
      const pairs: string[] = [];
      for (const [key, value] of Object.entries(query ?? {})) {
        pairs.push(`${encodeURIComponent(key)}=${encodeQueryValue(value)}`);
      }
      pairs.push(`access_token=${encodeQueryValue(token)}`, `appsecret_proof=${encodeQueryValue(proof)}`);
      return send(fetchFn, `${urlFor(path)}?${pairs.join('&')}`, { method: 'GET' });
    },

    async post(path, body) {
      if (body instanceof FormData) {
        body.append('access_token', token);
        body.append('appsecret_proof', proof);
        return send(fetchFn, urlFor(path), { method: 'POST', body });
      }
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        form.append(key, stringifyField(value));
      }
      form.append('access_token', token);
      form.append('appsecret_proof', proof);
      return send(fetchFn, urlFor(path), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      });
    },
  };
}

export { AdPlatformError };
