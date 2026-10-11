import { common } from '../copy/common.ts';
import { errors } from '../copy/errors.ts';

/**
 * A request the server refused, or that never reached it. `message` is a plain sentence for a
 * person (the server's own words, or ours when it had none). `status` is 0 when there was no
 * answer at all. `field` names the form field the message is about. `latest` is the current state
 * of the thing that changed under a 409.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly field?: string;
  readonly latest?: unknown;

  constructor(status: number, message: string, field?: string, latest?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (field !== undefined) this.field = field;
    if (latest !== undefined) this.latest = latest;
  }
}

export type ApiRequest = {
  method?: string;
  /** Sent as JSON. */
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Whether a 401 sends the person to the sign-in page (the default). The sign-in, reset, verify
   * and invite pages turn it off: a 401 there is an answer to show, not a lost session.
   */
  redirectOn401?: boolean;
};

let onUnauthorized: () => void = () => {};

/** What to do when a request comes back 401 (unless it asked for `redirectOn401: false`). */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

type Parsed = { readable: true; value: unknown } | { readable: false };

/** The JSON in a response body (`undefined` when there is none), or `readable: false` for text that is not JSON. */
function parseJson(text: string): Parsed {
  if (text === '') return { readable: true, value: undefined };
  try {
    return { readable: true, value: JSON.parse(text) as unknown };
  } catch {
    return { readable: false };
  }
}

/** A request cancelled on purpose (a screen closed, a search typed over) is not a lost connection. */
const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Talks JSON to the server. Resolves with the parsed body of a 2xx answer; anything else is an ApiError. */
export async function apiFetch<T>(path: string, init: ApiRequest = {}): Promise<T> {
  const { method = 'GET', body, signal, redirectOn401 = true } = init;

  let response: Response;
  let text: string;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    text = await response.text();
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError(0, common.networkError);
  }

  const parsed = parseJson(text);

  if (response.ok) {
    // Text that is not JSON behind a good status (a web page served in place of the server) is no answer we can use
    if (!parsed.readable) throw new ApiError(response.status, errors.generic);
    return parsed.value as T;
  }

  const failure = parsed.readable && isRecord(parsed.value) ? parsed.value : {};
  const error = new ApiError(
    response.status,
    typeof failure.error === 'string' && failure.error !== '' ? failure.error : errors.generic,
    typeof failure.field === 'string' ? failure.field : undefined,
    failure.latest,
  );
  if (response.status === 401 && redirectOn401) onUnauthorized();
  throw error;
}
