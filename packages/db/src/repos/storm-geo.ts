import { sql } from 'drizzle-orm';
import { hexCenterSpacingM, nextCircleRadiusM } from '@roofline/shared';
import type { Tx } from '../tenant.ts';

/** A targeting circle: centre in degrees, radius in metres. */
export type CoverCircle = { lat: number; lng: number; radiusM: number };

/** The most doublings tried before giving up (2^30 times the minimum covers the planet). */
const MAX_DOUBLINGS = 30;

/** The storm id and the contour geometry (EPSG:5070) at the company's threshold, or null. */
async function contourAt(tx: Tx, companyStormId: string) {
  const storm = await tx.execute<{ storm_id: string }>(
    sql`select storm_id from company_storms where id = ${companyStormId}`,
  );
  const stormId = storm.rows[0]?.storm_id;
  if (!stormId) return null;
  const settings = await tx.execute<{ hail_threshold_in: string | number | null }>(
    sql`select hail_threshold_in from company_settings limit 1`,
  );
  const raw = settings.rows[0]?.hail_threshold_in;
  const threshold = raw === undefined || raw === null ? 1 : Number(raw);
  return { stormId, threshold };
}

/**
 * Circles that together cover the storm's hail contour at the company's threshold (the smallest
 * contour threshold at or above it), laid out on a hexagonal grid whose hexagon side equals the
 * circle radius, so each circle covers its whole hexagon. The radius starts at `minRadiusM` and
 * doubles until there are at most `maxCircles` circles. Ordered by lat, then lng. Empty when the
 * storm is not this company's or has no contour at or above the threshold.
 */
export async function coverCircles(
  tx: Tx,
  companyStormId: string,
  minRadiusM: number,
  maxCircles: number,
): Promise<CoverCircle[]> {
  const found = await contourAt(tx, companyStormId);
  if (!found) return [];
  const { stormId, threshold } = found;

  let radius = Math.max(1, minRadiusM);
  for (let attempt = 0; attempt <= MAX_DOUBLINGS; attempt++) {
    const side = radius;
    const spacing = hexCenterSpacingM(radius); // side * sqrt(3): the distance between neighbouring centres
    const result = await tx.execute<{ lat: number; lng: number }>(sql`
      with c as (
        select ST_Transform(k.geom, 5070) as g
        from storm_contours k
        where k.storm_id = ${stormId}
          and k.threshold_in = (
            select min(k2.threshold_in) from storm_contours k2
            where k2.storm_id = ${stormId} and k2.threshold_in >= ${threshold}::numeric
          )
        limit 1
      ),
      grid as (
        select h.geom as hex, c.g as g
        from c, ST_HexagonGrid(${side}::float8, c.g) as h
      )
      select ST_Y(ST_Transform(ST_Centroid(hex), 4326)) as lat,
             ST_X(ST_Transform(ST_Centroid(hex), 4326)) as lng
      from grid
      where ST_Intersects(hex, g)
      order by lat, lng
    `);
    if (spacing <= 0) return [];
    const rows = result.rows;
    if (rows.length === 0) return [];
    if (rows.length <= maxCircles || attempt === MAX_DOUBLINGS) {
      return rows.map((r) => ({ lat: Number(r.lat), lng: Number(r.lng), radiusM: Math.ceil(radius) }));
    }
    radius = nextCircleRadiusM(radius);
  }
  return [];
}

/** A point inside the storm's contour at the company's threshold, or null when there is none. */
export async function swathCenter(tx: Tx, companyStormId: string): Promise<{ lat: number; lng: number } | null> {
  const found = await contourAt(tx, companyStormId);
  if (!found) return null;
  const { stormId, threshold } = found;
  const result = await tx.execute<{ lat: number; lng: number }>(sql`
    select ST_Y(p) as lat, ST_X(p) as lng
    from (
      select ST_PointOnSurface(k.geom) as p
      from storm_contours k
      where k.storm_id = ${stormId}
        and k.threshold_in = (
          select min(k2.threshold_in) from storm_contours k2
          where k2.storm_id = ${stormId} and k2.threshold_in >= ${threshold}::numeric
        )
      limit 1
    ) s
  `);
  const row = result.rows[0];
  return row ? { lat: Number(row.lat), lng: Number(row.lng) } : null;
}
