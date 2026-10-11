import { companySettings } from '../schema/index.ts';
import type { Tx } from '../tenant.ts';

/**
 * Subdomain names that must never be a company slug. Slugs become `<slug>.<app-domain>` for the
 * hosted policy pages (F3), so a company called "API" or "App" must not take those hosts.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin', 'api', 'app', 'assets', 'auth', 'cdn', 'email', 'help', 'hooks', 'login', 'mail',
  'signup', 'static', 'status', 'support', 'www',
]);

const MAX_SLUG_LENGTH = 48;

/** What a name with no usable letters or digits becomes. */
const FALLBACK_SLUG = 'company';

/**
 * A company name as a URL-safe slug: lowercase ASCII letters and digits joined by single hyphens.
 * Accents are folded ("Café" → "cafe"); anything else that is not a letter or digit separates words.
 * A name with nothing usable (only punctuation, or a script with no ASCII letters) gets "company".
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? FALLBACK_SLUG : slug;
}

/**
 * Picks the slug for a new company given the slugs that already start with the same base: the base
 * itself when it is free and not reserved, otherwise `base-2`, `base-3`, ...
 * `existing` may contain unrelated slugs; only `base` and `base-<number>` count.
 */
export function pickFreeSlug(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base) && !RESERVED_SLUGS.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Gives a new company its default settings row (every column takes its table default). Runs in a
 * `withTenant` transaction for that company, so row-level security applies.
 */
export async function insertDefaultSettings(tx: Tx, companyId: string): Promise<void> {
  await tx.insert(companySettings).values({ companyId });
}
