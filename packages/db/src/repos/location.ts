import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { companies, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/** Where a company is, for things that need one place: the weather today. */
export type CompanyLocation = { lat: number; lng: number };

const place = (row: { lat: number | null; lng: number | null } | undefined): CompanyLocation | null =>
  row && row.lat !== null && row.lng !== null && Number.isFinite(row.lat) && Number.isFinite(row.lng)
    ? { lat: row.lat, lng: row.lng }
    : null;

/**
 * The company's one place: a point inside its service area, or, when no service area is drawn, the
 * middle of its pinned addresses that are not archived. Null when it has neither.
 *
 * This is the company's location, not the member's view: it counts every pinned address in the
 * company, whatever a rep may see (the scope helpers are deliberately not applied), and it reads
 * nothing but a single point. Row-level security keeps both reads inside `ctx.companyId`.
 */
export async function companyLocation(tx: Tx, ctx: TenantContext): Promise<CompanyLocation | null> {
  // A point on the surface, not the centroid: for an L-shaped or split area the centroid can fall outside it.
  const [area] = await tx
    .select({
      lat: sql<number | null>`ST_Y(ST_PointOnSurface(${companies.serviceArea}))`,
      lng: sql<number | null>`ST_X(ST_PointOnSurface(${companies.serviceArea}))`,
    })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const fromArea = place(area);
  if (fromArea) return fromArea;

  // An aggregate over no rows is one row of nulls.
  const [pins] = await tx
    .select({
      lat: sql<number | null>`ST_Y(ST_Centroid(ST_Collect(${properties.geom})))`,
      lng: sql<number | null>`ST_X(ST_Centroid(ST_Collect(${properties.geom})))`,
    })
    .from(properties)
    .where(and(eq(properties.companyId, ctx.companyId), isNull(properties.archivedAt), isNotNull(properties.geom)));
  return place(pins);
}
