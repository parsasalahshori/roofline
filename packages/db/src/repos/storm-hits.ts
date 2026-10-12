import { sql } from 'drizzle-orm';
import type { Tx } from '../tenant.ts';

/** The company `withTenant` scoped this transaction to, read from `app.company_id`. */
const CURRENT_COMPANY = sql`nullif(current_setting('app.company_id', true), '')::uuid`;

/**
 * CTE `zone`: the region where hail met the threshold, clipped to the company's service area.
 * Contours nest, so the one with the smallest threshold_in at or above the threshold is the whole
 * region at that level. Zero rows when the storm has no such contour or the company has no area.
 * ST_MakeValid guards the intersection against invalid contour rings. All geometry is SRID 4326.
 */
function zoneCte(stormId: string, thresholdIn: number) {
  return sql`zone as (
    select ST_Intersection(ST_MakeValid(c.geom), a.area) as g
    from storm_contours c
    cross join (select service_area as area from companies where id = ${CURRENT_COMPANY}) a
    where c.storm_id = ${stormId}::uuid
      and c.threshold_in >= ${thresholdIn}::numeric
      and a.area is not null
    order by c.threshold_in asc
    limit 1
  )`;
}

/**
 * The part of the threshold contour inside the company's service area, as GeoJSON text, or null
 * when the storm has no contour at that threshold or the intersection is empty.
 */
export async function thresholdContourInArea(tx: Tx, stormId: string, thresholdIn: number): Promise<string | null> {
  const result = await tx.execute(sql`
    with ${zoneCte(stormId, thresholdIn)}
    select ST_AsGeoJSON(zone.g) as geojson
    from zone
    where zone.g is not null and not ST_IsEmpty(zone.g)
  `);
  const row = result.rows[0] as { geojson: string | null } | undefined;
  return row?.geojson ?? null;
}

/**
 * Writes one storm_hits row for every active property with a location inside the threshold zone,
 * with the hail size of the highest contour level that contains it, then returns how many distinct
 * customers the company storm has hit. Rows are inserted or updated in place and never deleted
 * (contours only grow, so a property cannot leave the zone). A property with no customer is a hit
 * but not a customer.
 */
export async function refreshHits(
  tx: Tx,
  companyStormId: string,
  stormId: string,
  thresholdIn: number,
): Promise<{ customersHit: number }> {
  await tx.execute(sql`
    with ${zoneCte(stormId, thresholdIn)}
    insert into storm_hits (company_id, company_storm_id, property_id, customer_id, hail_in)
    select ${CURRENT_COMPANY}, ${companyStormId}::uuid, p.id, p.customer_id,
      (select max(c2.threshold_in) from storm_contours c2
        where c2.storm_id = ${stormId}::uuid and ST_Intersects(c2.geom, p.geom))
    from properties p, zone
    where p.archived_at is null
      and p.geom is not null
      and ST_Intersects(zone.g, p.geom)
    on conflict (company_storm_id, property_id) do update
      set hail_in = excluded.hail_in, customer_id = excluded.customer_id, updated_at = now()
  `);
  const result = await tx.execute(sql`
    select count(distinct customer_id)::int as n
    from storm_hits
    where company_storm_id = ${companyStormId}::uuid and customer_id is not null
  `);
  return { customersHit: Number((result.rows[0] as { n: number | string } | undefined)?.n ?? 0) };
}

/**
 * How many building footprints have their centroid inside the threshold zone (the part of the
 * threshold contour within the company's service area). 0 when the zone is empty.
 */
export async function countHomes(tx: Tx, stormId: string, thresholdIn: number): Promise<number> {
  const result = await tx.execute(sql`
    with ${zoneCte(stormId, thresholdIn)}
    select count(*)::int as n
    from building_footprints f, zone
    where f.geom && zone.g
      and ST_Intersects(zone.g, ST_Centroid(f.geom))
  `);
  return Number((result.rows[0] as { n: number | string } | undefined)?.n ?? 0);
}

/**
 * How many distinct customers own an active property inside the threshold zone, using the same
 * property test as `refreshHits`. Writes nothing.
 */
export async function countCustomersHit(tx: Tx, stormId: string, thresholdIn: number): Promise<number> {
  const result = await tx.execute(sql`
    with ${zoneCte(stormId, thresholdIn)}
    select count(distinct p.customer_id)::int as n
    from properties p, zone
    where p.archived_at is null
      and p.geom is not null
      and p.customer_id is not null
      and ST_Intersects(zone.g, p.geom)
  `);
  return Number((result.rows[0] as { n: number | string } | undefined)?.n ?? 0);
}
