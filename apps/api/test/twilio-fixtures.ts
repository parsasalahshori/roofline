import { readFileSync } from 'node:fs';

/** One request the fake Twilio fetch received, kept for assertions. */
export type RecordedRequest = {
  method: string;
  url: string;
  /** The raw Authorization header, e.g. 'Basic <base64>', or '' when absent. */
  auth: string;
  /** The form body of a POST, parsed; null when there is no body. */
  form: URLSearchParams | null;
  /** The parsed body when the content type is application/json; otherwise null. */
  json: unknown;
};

/** A fixture file under test/fixtures/twilio, read and parsed. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/twilio/${name}.json`, import.meta.url), 'utf8'));
}

/** A route value: a fixture name, a list of names served in order (the last repeats), or inline JSON. */
type RouteValue = string | string[];

/** The body for one route value: inline JSON when it starts with '{', otherwise a fixture file. */
function bodyFor(value: string): unknown {
  return value.startsWith('{') ? JSON.parse(value) : fixture(value);
}

/**
 * A fake `fetch` for Twilio. Route keys are 'METHOD <url prefix>' (split at the first space); the
 * longest matching prefix with the same method wins. Every matched call answers HTTP 200 with JSON.
 * A call that matches no route is recorded and rejects, which fails the test that made it.
 */
export function fixtureFetch(routes: Record<string, RouteValue>): typeof fetch & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const counters = new Map<string, number>();

  const parsedRoutes = Object.entries(routes).map(([key, value]) => {
    const space = key.indexOf(' ');
    return { key, method: key.slice(0, space).toUpperCase(), prefix: key.slice(space + 1), value };
  });

  const fake = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = typeof init?.body === 'string' && init.body ? init.body : null;
    const contentType = headers.get('content-type') ?? '';

    requests.push({
      method,
      url,
      auth: headers.get('authorization') ?? '',
      form: body === null ? null : new URLSearchParams(body),
      json: body !== null && contentType.includes('application/json') ? JSON.parse(body) : null,
    });

    let best: (typeof parsedRoutes)[number] | undefined;
    for (const route of parsedRoutes) {
      if (route.method !== method || !url.startsWith(route.prefix)) continue;
      if (!best || route.prefix.length > best.prefix.length) best = route;
    }
    if (!best) {
      throw new Error(`No fixture route for ${method} ${new URL(url).pathname}`);
    }

    let served: string;
    if (Array.isArray(best.value)) {
      const index = counters.get(best.key) ?? 0;
      counters.set(best.key, index + 1);
      served = best.value[Math.min(index, best.value.length - 1)] as string;
    } else {
      served = best.value;
    }

    return new Response(JSON.stringify(bodyFor(served)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return Object.assign(fake as unknown as typeof fetch, { requests }) as typeof fetch & {
    requests: RecordedRequest[];
  };
}
