import { eq, sql } from 'drizzle-orm';
import type { EmailOptOutSource } from '@roofline/shared';
import type { Db } from '../pools.ts';
import { companies } from '../schema/index.ts';

/** The company an unsubscribe token names: its id and display name; null when no such company. Any status. */
export async function companyForUnsubscribe(system: Db, companyId: string): Promise<{ id: string; name: string } | null> {
  const [row] = await system
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return row ?? null;
}

/**
 * Adds the address to the company's email_opt_outs (unique on company and email, so a repeat adds nothing). True when a row was added.
 * Raw SQL on purpose: Drizzle's insert lists every column (id, created_at, updated_at too), and app_system holds INSERT only on
 * company_id, email, source and at (migration 0018). Only those three are named here; `at` takes its default.
 * The email column is citext, so the conflict check ignores case.
 */
export async function recordEmailOptOut(
  system: Db,
  input: { companyId: string; email: string; source: EmailOptOutSource },
): Promise<boolean> {
  const result = await system.execute(sql`
    insert into email_opt_outs (company_id, email, source)
    values (${input.companyId}::uuid, ${input.email}::text, ${input.source}::text)
    on conflict (company_id, email) do nothing
    returning id`);
  return result.rows.length > 0;
}
