import { sql } from 'drizzle-orm';
import type { TenantContext, Tx } from '../tenant.ts';

/** One company storm as the API shows it. Mirrors apps/web/src/features/storm/types.ts StormSummary. */
export type StormSummaryRow = {
  id: string;
  placeName: string | null;
  /** YYYY-MM-DD. */
  day: string;
  maxIn: number;
  status: 'provisional' | 'final';
  customersHit: number;
  homesHit: number;
  planTaskId: string | null;
  planStatus: string | null;
};

export type SwathFeatureRow = {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: { thresholdIn: number };
};
export type SwathCollectionRow = { type: 'FeatureCollection'; features: SwathFeatureRow[] };

type RawSummary = {
  id: string;
  place_name: string | null;
  day: string;
  max_in: string | number;
  status: string;
  customers_hit: string | number;
  homes_hit: string | number;
  plan_task_id: string | null;
  plan_status: string | null;
};

const toSummary = (r: RawSummary): StormSummaryRow => ({
  id: r.id,
  placeName: r.place_name,
  day: r.day,
  maxIn: Number(r.max_in),
  status: r.status === 'final' ? 'final' : 'provisional',
  customersHit: Number(r.customers_hit),
  homesHit: Number(r.homes_hit),
  planTaskId: r.plan_task_id,
  planStatus: r.plan_status,
});

const SELECT = sql`
  select cs.id::text as id, s.place_name, s.convective_day::text as day, cs.max_in, s.status,
         cs.customers_hit, cs.homes_hit, cs.plan_task_id::text as plan_task_id, t.status as plan_status
  from company_storms cs
  join storms s on s.id = cs.storm_id
  left join agent_tasks t on t.company_id = cs.company_id and t.id = cs.plan_task_id
`;

/** The company's storms that are not dismissed, newest first. `since` keeps only storms first matched at or after it. */
export async function listCompanyStorms(tx: Tx, ctx: TenantContext, opts: { since?: Date } = {}): Promise<StormSummaryRow[]> {
  const since = opts.since === undefined ? sql`` : sql`and cs.created_at >= ${opts.since.toISOString()}::timestamptz`;
  const rows = await tx.execute<RawSummary>(sql`
    ${SELECT}
    where cs.company_id = ${ctx.companyId}::uuid and cs.status <> 'dismissed' ${since}
    order by s.convective_day desc, cs.created_at desc, cs.id
  `);
  return rows.rows.map(toSummary);
}

/** One company storm (dismissed ones too), or null when it is not this company's. */
export async function getCompanyStormSummary(tx: Tx, ctx: TenantContext, id: string): Promise<StormSummaryRow | null> {
  const rows = await tx.execute<RawSummary>(sql`
    ${SELECT}
    where cs.company_id = ${ctx.companyId}::uuid and cs.id = ${id}::uuid
  `);
  const row = rows.rows[0];
  return row ? toSummary(row) : null;
}

type RawContour = { threshold_in: string | number; geometry: SwathFeatureRow['geometry'] };

/** The storm's contours from 0.75 inch up, as GeoJSON, smallest threshold first. Storms are global data. */
export async function stormSwath(tx: Tx, stormId: string): Promise<SwathCollectionRow> {
  const rows = await tx.execute<RawContour>(sql`
    select c.threshold_in, ST_AsGeoJSON(c.geom)::json as geometry
    from storm_contours c
    where c.storm_id = ${stormId}::uuid and c.threshold_in >= 0.75
    order by c.threshold_in asc
  `);
  return {
    type: 'FeatureCollection',
    features: rows.rows.map((r) => ({
      type: 'Feature' as const,
      geometry: r.geometry,
      properties: { thresholdIn: Number(r.threshold_in) },
    })),
  };
}

/** Marks the company storm dismissed. False when it is not this company's. A plan task is left as it is. */
export async function dismissCompanyStorm(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update company_storms set status = 'dismissed', updated_at = ${now.toISOString()}::timestamptz
    where company_id = ${ctx.companyId}::uuid and id = ${id}::uuid
    returning id
  `);
  return rows.rows.length > 0;
}

/** The global storm a company storm points at, and the company storm's own status; null when not this company's. */
export async function companyStormRef(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<{ stormId: string; status: string } | null> {
  const rows = await tx.execute<{ storm_id: string; status: string }>(sql`
    select storm_id::text as storm_id, status from company_storms
    where company_id = ${ctx.companyId}::uuid and id = ${id}::uuid
  `);
  const row = rows.rows[0];
  return row ? { stormId: row.storm_id, status: row.status } : null;
}
