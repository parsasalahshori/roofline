import { sql } from 'drizzle-orm';
import type { Tx } from '../tenant.ts';

/** One home in the hail path that may be door-knocked. */
export type HomeInZone = {
  footprintId: number;
  lng: number;
  lat: number;
  /** Largest contour threshold (inches) whose polygon contains the footprint centroid. */
  hailIn: number;
  /** Set when an active property of the company sits inside the footprint (a customer's or a bare home). */
  propertyId: string | null;
  /** The saved address ("123 Main St, Omaha, NE 68102") of that property; null for a home with no property. */
  address: string | null;
};

/** A stop to store. `position` is 1-based inside its route. */
export type NewStop = {
  footprintId: number;
  propertyId: string | null;
  lng: number;
  lat: number;
  address: string | null;
  hailIn: number;
};

export type NewRoute = { userId: string; name: string; stops: NewStop[] };

export type BuiltRoute = { id: string; userId: string; name: string; stops: number };

/** The company `withTenant` scoped this transaction to, read from `app.company_id`. */
const CURRENT_COMPANY = sql`nullif(current_setting('app.company_id', true), '')::uuid`;

/** Stops inserted per statement. */
const STOP_INSERT_CHUNK = 500;

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
 * Every building footprint whose centroid is inside the threshold zone and that may be door-knocked:
 * not excluded by the company, and not sitting on an active property of a do-not-contact customer.
 * Each home carries its hail size, its centroid, and (when one exists) one active property and its
 * saved address. Ordered by footprint id so the result is deterministic.
 */
export async function listHomesInZone(tx: Tx, stormId: string, thresholdIn: number): Promise<HomeInZone[]> {
  const result = await tx.execute(sql`
    with ${zoneCte(stormId, thresholdIn)}
    select f.id::text as footprint_id,
      ST_X(ST_Centroid(f.geom)) as lng,
      ST_Y(ST_Centroid(f.geom)) as lat,
      coalesce(
        (select max(c2.threshold_in) from storm_contours c2
          where c2.storm_id = ${stormId}::uuid and ST_Intersects(c2.geom, ST_Centroid(f.geom))),
        ${thresholdIn}::numeric
      )::text as hail_in,
      pp.id::text as property_id,
      case when pp.id is null then null
        else pp.address_line || ', ' || pp.city || ', ' || pp.state || ' ' || pp.zip end as address
    from building_footprints f
    cross join zone
    left join lateral (
      select p.id, p.address_line, p.city, p.state, p.zip
      from properties p
      where p.archived_at is null
        and p.geom is not null
        and ST_Intersects(f.geom, p.geom)
      order by (p.customer_id is not null) desc, p.id
      limit 1
    ) pp on true
    where f.geom && zone.g
      and ST_Intersects(zone.g, ST_Centroid(f.geom))
      and not exists (select 1 from door_exclusions e where e.footprint_id = f.id)
      and not exists (
        select 1
        from properties dp
        join customers c on c.id = dp.customer_id
        where dp.archived_at is null
          and dp.geom is not null
          and ST_Intersects(f.geom, dp.geom)
          and c.do_not_contact = true
      )
    order by f.id
  `);
  return (
    result.rows as {
      footprint_id: string;
      lng: number | string;
      lat: number | string;
      hail_in: string | number;
      property_id: string | null;
      address: string | null;
    }[]
  ).map((r) => ({
    footprintId: Number(r.footprint_id),
    lng: Number(r.lng),
    lat: Number(r.lat),
    hailIn: Number(r.hail_in),
    propertyId: r.property_id ?? null,
    address: r.address ?? null,
  }));
}

/** The routes already built for a company storm, oldest first (then by name and id). */
export async function listBuiltRoutes(tx: Tx, companyStormId: string): Promise<BuiltRoute[]> {
  const result = await tx.execute(sql`
    select id::text as id, user_id::text as user_id, name, stops
    from door_routes
    where company_storm_id = ${companyStormId}::uuid
    order by created_at, name, id
  `);
  return (result.rows as { id: string; user_id: string; name: string; stops: number | string }[]).map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    stops: Number(r.stops),
  }));
}

/**
 * Stores the routes and their stops unless the company storm already has routes. A transaction-scoped
 * advisory lock on the company storm serialises concurrent builds, so the second one sees the first's
 * routes and returns them with created = false. Routes come back in the input order.
 */
export async function insertRoutesOnce(
  tx: Tx,
  companyStormId: string,
  routes: NewRoute[],
): Promise<{ created: boolean; routes: BuiltRoute[] }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'door-routes:' + companyStormId}, 0))`);
  const existing = await listBuiltRoutes(tx, companyStormId);
  if (existing.length > 0) return { created: false, routes: existing };

  const built: BuiltRoute[] = [];
  for (const route of routes) {
    const inserted = await tx.execute(sql`
      insert into door_routes (company_id, company_storm_id, user_id, name, status, stops)
      values (${CURRENT_COMPANY}, ${companyStormId}::uuid, ${route.userId}::uuid, ${route.name}, 'ready', ${route.stops.length}::int)
      returning id::text as id
    `);
    const routeId = (inserted.rows[0] as { id: string }).id;
    for (let from = 0; from < route.stops.length; from += STOP_INSERT_CHUNK) {
      const tuples = route.stops.slice(from, from + STOP_INSERT_CHUNK).map(
        (s, k) => sql`(${CURRENT_COMPANY}, ${routeId}::uuid, ${from + k + 1}::int, ${s.footprintId}::bigint,
          ${s.propertyId}::uuid, ST_SetSRID(ST_MakePoint(${s.lng}::float8, ${s.lat}::float8), 4326),
          ${s.address}::text, ${s.hailIn}::numeric)`,
      );
      await tx.execute(sql`
        insert into door_stops (company_id, route_id, position, footprint_id, property_id, point, address, hail_in)
        values ${sql.join(tuples, sql`, `)}
      `);
    }
    built.push({ id: routeId, userId: route.userId, name: route.name, stops: route.stops.length });
  }
  return { created: true, routes: built };
}
