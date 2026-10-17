import type { QuoteProduct } from '@roofline/shared';

/*
 * What the browser keeps so a reload resumes: the request's id and token (sessionStorage and localStorage, both: a new
 * tab on the same phone resumes from localStorage; a reload from either), and the "seed" the quote page leaves behind
 * (the quote's id, address and services) so the measuring page can open the request without asking again. The seed
 * and the token never go in a URL.
 */

export type Stored = { requestId: string; token: string; expiresAt: string; quoteId: string | null };
export type Seed = { quoteId: string; address: string; services: QuoteProduct[] };

const tokenKey = (slug: string) => `roofline.homeowner.${slug}`;
const seedKey = (slug: string) => `roofline.homeowner.seed.${slug}`;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const stores = (): Store[] => {
  const out: Store[] = [];
  for (const get of [() => window.sessionStorage, () => window.localStorage]) {
    try {
      out.push(get());
    } catch {
      // Storage can be blocked (private windows); the page still works without resuming.
    }
  }
  return out;
};

function readJson(key: string): unknown {
  for (const s of stores()) {
    try {
      const raw = s.getItem(key);
      if (raw !== null) return JSON.parse(raw) as unknown;
    } catch {
      // Unreadable: try the next store.
    }
  }
  return null;
}
function writeJson(key: string, value: unknown): void {
  for (const s of stores()) {
    try {
      s.setItem(key, JSON.stringify(value));
    } catch {
      // Full or blocked: ignore.
    }
  }
}
function clear(key: string): void {
  for (const s of stores()) {
    try {
      s.removeItem(key);
    } catch {
      // Ignore.
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function readStored(slug: string, now = Date.now()): Stored | null {
  const v = readJson(tokenKey(slug));
  if (!isRecord(v) || typeof v.requestId !== 'string' || typeof v.token !== 'string' || typeof v.expiresAt !== 'string') return null;
  if (Date.parse(v.expiresAt) <= now) return null;
  return { requestId: v.requestId, token: v.token, expiresAt: v.expiresAt, quoteId: typeof v.quoteId === 'string' ? v.quoteId : null };
}
export const writeStored = (slug: string, s: Stored): void => writeJson(tokenKey(slug), s);
export const clearStored = (slug: string): void => clear(tokenKey(slug));

export function readSeed(slug: string): Seed | null {
  const v = readJson(seedKey(slug));
  if (!isRecord(v) || typeof v.quoteId !== 'string' || typeof v.address !== 'string' || !Array.isArray(v.services)) return null;
  const services = v.services.filter((p): p is QuoteProduct => p === 'windows' || p === 'roof');
  return services.length === 0 ? null : { quoteId: v.quoteId, address: v.address, services };
}
export const writeSeed = (slug: string, seed: Seed): void => writeJson(seedKey(slug), seed);
