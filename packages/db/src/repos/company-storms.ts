import { eq, sql } from 'drizzle-orm';
import { companyStorms } from '../schema/index.ts';
import type { Tx } from '../tenant.ts';

/** One company_storms row as Drizzle selects it. */
export type CompanyStormRow = typeof companyStorms.$inferSelect;

/** The company `withTenant` scoped this transaction to, read from `app.company_id`. */
const CURRENT_COMPANY = sql`nullif(current_setting('app.company_id', true), '')::uuid`;

/** The service area of the company this transaction is scoped to (null when it has none). */
const COMPANY_AREA = sql`(select service_area from companies where id = ${CURRENT_COMPANY})`;

/**
 * Records that a storm matched the company this transaction is scoped to, or refreshes the numbers
 * of the row that is already there. The conflict update touches only max_in, customers_hit,
 * homes_hit and last_matched_at, so a dismissed storm stays dismissed and plan_task_id and
 * alerted_at are never overwritten. `created` is true when no row existed before this call.
 * Run it inside `withTenant`.
 */
export async function upsertCompanyStorm(
  tx: Tx,
  input: { stormId: string; maxIn: number; customersHit: number; homesHit: number; now: Date },
): Promise<{ companyStorm: CompanyStormRow; created: boolean }> {
  const existing = await findCompanyStorm(tx, input.stormId);
  const [row] = await tx
    .insert(companyStorms)
    .values({
      companyId: CURRENT_COMPANY,
      stormId: input.stormId,
      maxIn: input.maxIn,
      customersHit: input.customersHit,
      homesHit: input.homesHit,
      lastMatchedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [companyStorms.companyId, companyStorms.stormId],
      set: {
        maxIn: input.maxIn,
        customersHit: input.customersHit,
        homesHit: input.homesHit,
        lastMatchedAt: input.now,
        updatedAt: input.now,
      },
    })
    .returning();
  return { companyStorm: row!, created: existing === null };
}

/** The company's row for one storm, or null when the storm never matched it. RLS limits it to the company. */
export async function findCompanyStorm(tx: Tx, stormId: string): Promise<CompanyStormRow | null> {
  const [row] = await tx.select().from(companyStorms).where(eq(companyStorms.stormId, stormId)).limit(1);
  return row ?? null;
}

/**
 * The highest hail threshold (inches) among the storm's contours that touch the company's service
 * area, or null when none does or the company has no service area.
 */
export async function maxInInArea(tx: Tx, stormId: string): Promise<number | null> {
  const result = await tx.execute(sql`
    select max(c.threshold_in)::float8 as max_in
    from storm_contours c
    where c.storm_id = ${stormId}::uuid
      and ST_Intersects(c.geom, ${COMPANY_AREA})
  `);
  const value = (result.rows[0] as { max_in: number | null } | undefined)?.max_in;
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Storms of the given convective days (YYYY-MM-DD) whose 0.75 inch footprint touches the company's
 * service area, newest day first. An empty `days` list returns an empty list.
 */
export async function candidateStormsForCompany(
  tx: Tx,
  days: string[],
): Promise<{ id: string; status: 'provisional' | 'final'; maxIn: number; finalAt: Date | null; convectiveDay: string }[]> {
  if (days.length === 0) return [];
  const dayList = sql.join(
    days.map((d) => sql`${d}::date`),
    sql`, `,
  );
  const result = await tx.execute(sql`
    select s.id, s.status, s.max_in::float8 as max_in, s.final_at, s.convective_day::text as convective_day
    from storms s
    where s.convective_day in (${dayList})
      and s.merged_into is null
      and ST_Intersects(s.geom_075, ${COMPANY_AREA})
    order by s.convective_day desc, s.id
  `);
  return (
    result.rows as {
      id: string;
      status: 'provisional' | 'final';
      max_in: number | string;
      final_at: Date | string | null;
      convective_day: string;
    }[]
  ).map((r) => ({
    id: r.id,
    status: r.status,
    maxIn: Number(r.max_in),
    finalAt: r.final_at === null ? null : new Date(r.final_at),
    convectiveDay: r.convective_day,
  }));
}
