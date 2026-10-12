import { readFileSync } from 'node:fs';

/** Canned-fetch helpers for the Meta adapter tests. Nothing here reaches the network. */
export type MetaCall = { url: string; init: RequestInit | undefined };
export function fakeFetch(answer: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: MetaCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  return { fetch: fn, calls };
}
export function json(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/meta/${name}`, import.meta.url), 'utf8');
}
