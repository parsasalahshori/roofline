// Checks a migrated database before a deploy: citext and postgis in public, no grant left for the
// Supabase Data API roles (anon, authenticated), app roles that are neither superuser nor BYPASSRLS,
// and forced row-level security on every tenant table. Prints one line per problem and exits 1, or
// prints "Preflight passed.".
// Usage: DATABASE_URL_OWNER=... npm run db:preflight
import { preflight } from '../src/preflight.ts';

const url = process.env.DATABASE_URL_OWNER ?? 'postgres://roofline:roofline@127.0.0.1:54329/roofline';

const { ok, problems } = await preflight(url);
if (!ok) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log('Preflight passed.');
