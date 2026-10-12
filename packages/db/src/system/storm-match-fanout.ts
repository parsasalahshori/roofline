import { sql } from 'drizzle-orm';
import type { Db } from '../pools.ts';

/*
 * The storm-match fan-out (S1 Task 9). Runs on the app_system pool, which has ALL on companies and
 * SELECT on storms. It only LISTS the companies worth matching; the matching itself runs per company
 * in `withTenant`, as app_tenant, from the 'storm-match-company' job.
 */

/**
 * The companies (each once, ordered by id) whose service area meets the 0.75 inch hail footprint
 * (`storms.geom_075`) of a storm whose convective day is one of `days` ('YYYY-MM-DD'). A company
 * with no service area never matches. No days: no companies.
 */
export async function companiesWithCandidateStorms(sys: Db, input: { days: string[] }): Promise<{ companyId: string }[]> {
  if (input.days.length === 0) return [];
  const days = sql.join(
    input.days.map((d) => sql`${d}::date`),
    sql`, `,
  );
  const result = await sys.execute(sql`
    select c.id as "companyId"
    from companies c
    where c.service_area is not null
      and exists (
        select 1 from storms s
        where s.convective_day in (${days})
          and s.geom_075 && c.service_area
          and ST_Intersects(s.geom_075, c.service_area)
      )
    order by c.id`);
  return result.rows.map((r) => ({ companyId: String(r.companyId) }));
}
