import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { JOB_STAGE_LABELS, type JobStage } from '@roofline/shared';
import { companies, customers, jobs, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { customerScope, jobScope, propertyScope } from './scope.ts';

/** A GeoJSON MultiPolygon in longitude, latitude order. */
export type GeoJsonMultiPolygon = { type: 'MultiPolygon'; coordinates: number[][][][] };

/** The visible map area in degrees. The antimeridian is not supported: `west` < `east`. */
export type Bbox = { west: number; south: number; east: number; north: number };

/** One address of a customer who is not archived. */
export type CustomerPin = {
  propertyId: string;
  customerId: string;
  lng: number;
  lat: number;
  name: string;
  addressLine: string;
};

/** One open job, at its address. */
export type JobPin = {
  jobId: string;
  customerId: string;
  propertyId: string;
  stage: JobStage;
  stageLabel: string;
  lng: number;
  lat: number;
  name: string;
  addressLine: string;
};

/** Pins close together on the map, as one: `count` of them, at their middle. */
export type PinCluster = { layer: 'customers' | 'jobs'; lng: number; lat: number; count: number };

export type PinsResult =
  | { mode: 'points'; customers: CustomerPin[]; jobs: JobPin[] }
  | { mode: 'clusters'; clusters: PinCluster[]; total: number };

export type PinLayer = 'customers' | 'jobs';

/** More pins than this in the box and the server sends clusters instead of points. */
export const SERVER_CLUSTER_ABOVE = 2000;

/** The box is cut into this many cells across; the pins in a cell become one cluster. */
const CLUSTER_CELLS_ACROSS = 48;

/** The stages whose jobs are still going: `installed` and `lost` are done. */
const OPEN_STAGES: JobStage[] = ['lead', 'inspection', 'proposal', 'won'];

/*
 * The pin rules, written once so that the count, the points and the clusters cannot disagree.
 * - A customer pin is an address with a location, not archived, of a customer who is not archived;
 *   the member must be allowed to see both (a rep sees only their own customers' addresses).
 * - A job pin is a job still going (`OPEN_STAGES`), not archived, of a customer who is not archived,
 *   that the member may see, at an address with a location. A job always has a customer and an
 *   address a rep who sees the job may see, so only the job's own scope applies.
 */

const envelopeOf = (bbox: Bbox) =>
  sql`ST_MakeEnvelope(${bbox.west}::float8, ${bbox.south}::float8, ${bbox.east}::float8, ${bbox.north}::float8, 4326)`;

const customerPinWhere = (ctx: TenantContext, bbox: Bbox) =>
  and(
    isNull(properties.archivedAt),
    isNull(customers.archivedAt),
    customerScope(ctx),
    propertyScope(ctx),
    sql`ST_Intersects(${properties.geom}, ${envelopeOf(bbox)})`,
  );

const jobPinWhere = (ctx: TenantContext, bbox: Bbox) =>
  and(
    isNull(jobs.archivedAt),
    isNull(customers.archivedAt),
    inArray(jobs.stage, OPEN_STAGES),
    jobScope(ctx),
    sql`ST_Intersects(${properties.geom}, ${envelopeOf(bbox)})`,
  );

const lng = sql<number>`ST_X(${properties.geom})`;
const lat = sql<number>`ST_Y(${properties.geom})`;

async function countCustomerPins(tx: Tx, ctx: TenantContext, bbox: Bbox): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(properties)
    .innerJoin(customers, eq(properties.customerId, customers.id))
    .where(customerPinWhere(ctx, bbox));
  return row?.n ?? 0;
}

async function countJobPins(tx: Tx, ctx: TenantContext, bbox: Bbox): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(jobs)
    .innerJoin(properties, eq(jobs.propertyId, properties.id))
    .innerJoin(customers, eq(jobs.customerId, customers.id))
    .where(jobPinWhere(ctx, bbox));
  return row?.n ?? 0;
}

async function customerPins(tx: Tx, ctx: TenantContext, bbox: Bbox): Promise<CustomerPin[]> {
  return tx
    .select({
      propertyId: properties.id,
      customerId: customers.id,
      lng,
      lat,
      name: customers.displayName,
      addressLine: properties.addressLine,
    })
    .from(properties)
    .innerJoin(customers, eq(properties.customerId, customers.id))
    .where(customerPinWhere(ctx, bbox))
    .orderBy(asc(sql`lower(${properties.addressLine})`), asc(properties.id));
}

async function jobPins(tx: Tx, ctx: TenantContext, bbox: Bbox): Promise<JobPin[]> {
  const rows = await tx
    .select({
      jobId: jobs.id,
      customerId: jobs.customerId,
      propertyId: jobs.propertyId,
      stage: jobs.stage,
      lng,
      lat,
      name: customers.displayName,
      addressLine: properties.addressLine,
    })
    .from(jobs)
    .innerJoin(properties, eq(jobs.propertyId, properties.id))
    .innerJoin(customers, eq(jobs.customerId, customers.id))
    .where(jobPinWhere(ctx, bbox))
    .orderBy(desc(jobs.createdAt), asc(jobs.id));
  return rows.map((row) => ({ ...row, stageLabel: JOB_STAGE_LABELS[row.stage] }));
}

/** Pins grouped by the grid cell they fall in; each cluster sits at the middle of its pins. */
async function clusters(tx: Tx, ctx: TenantContext, bbox: Bbox, layer: PinLayer): Promise<PinCluster[]> {
  const cell = (bbox.east - bbox.west) / CLUSTER_CELLS_ACROSS;
  const middle = sql`ST_Centroid(ST_Collect(${properties.geom}))`;
  const snapped = sql`ST_SnapToGrid(${properties.geom}, ${cell}::float8)`;
  const columns = { lng: sql<number>`ST_X(${middle})`, lat: sql<number>`ST_Y(${middle})`, count: count() };

  const rows =
    layer === 'customers'
      ? await tx
          .select(columns)
          .from(properties)
          .innerJoin(customers, eq(properties.customerId, customers.id))
          .where(customerPinWhere(ctx, bbox))
          .groupBy(snapped)
      : await tx
          .select(columns)
          .from(jobs)
          .innerJoin(properties, eq(jobs.propertyId, properties.id))
          .innerJoin(customers, eq(jobs.customerId, customers.id))
          .where(jobPinWhere(ctx, bbox))
          .groupBy(snapped);
  return rows.map((row) => ({ layer, ...row })).sort((a, b) => a.lng - b.lng || a.lat - b.lat);
}

/**
 * The pins inside `bbox` for the layers asked for, for what the member may see. Both layers are
 * counted first; above `SERVER_CLUSTER_ABOVE` pins in all the answer is clusters (per layer, over
 * a grid of 1/48 of the box's width) and the count, otherwise every pin.
 */
export async function mapPins(
  tx: Tx,
  ctx: TenantContext,
  bbox: Bbox,
  layers: ReadonlySet<PinLayer>,
): Promise<PinsResult> {
  const wantCustomers = layers.has('customers');
  const wantJobs = layers.has('jobs');
  const customerCount = wantCustomers ? await countCustomerPins(tx, ctx, bbox) : 0;
  const jobCount = wantJobs ? await countJobPins(tx, ctx, bbox) : 0;
  const total = customerCount + jobCount;

  if (total > SERVER_CLUSTER_ABOVE) {
    const found: PinCluster[] = [];
    if (customerCount > 0) found.push(...(await clusters(tx, ctx, bbox, 'customers')));
    if (jobCount > 0) found.push(...(await clusters(tx, ctx, bbox, 'jobs')));
    return { mode: 'clusters', clusters: found, total };
  }

  return {
    mode: 'points',
    customers: customerCount > 0 ? await customerPins(tx, ctx, bbox) : [],
    jobs: jobCount > 0 ? await jobPins(tx, ctx, bbox) : [],
  };
}

type Extent = { west: number | null; south: number | null; east: number | null; north: number | null };

/** `[west, south, east, north]`, or null when there is nothing to take the extent of. */
function boundsOf({ west, south, east, north }: Extent): [number, number, number, number] | null {
  return west === null || south === null || east === null || north === null ? null : [west, south, east, north];
}

/**
 * Where the map starts. `serviceArea` is the company's service area as GeoJSON, or null. `bounds`
 * (`[west, south, east, north]`) is that area's extent; with no service area, the extent of the
 * located addresses the member may see; with neither, null.
 */
export async function mapArea(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ serviceArea: GeoJsonMultiPolygon | null; bounds: [number, number, number, number] | null }> {
  const [area] = await tx
    .select({
      geojson: sql<string | null>`ST_AsGeoJSON(${companies.serviceArea})`,
      west: sql<number | null>`ST_XMin(${companies.serviceArea})`,
      south: sql<number | null>`ST_YMin(${companies.serviceArea})`,
      east: sql<number | null>`ST_XMax(${companies.serviceArea})`,
      north: sql<number | null>`ST_YMax(${companies.serviceArea})`,
    })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));

  if (area?.geojson != null) {
    const serviceArea = JSON.parse(area.geojson) as GeoJsonMultiPolygon;
    return { serviceArea, bounds: boundsOf(area) };
  }

  const [extent] = await tx
    .select({
      west: sql<number | null>`ST_XMin(ST_Extent(${properties.geom}))`,
      south: sql<number | null>`ST_YMin(ST_Extent(${properties.geom}))`,
      east: sql<number | null>`ST_XMax(ST_Extent(${properties.geom}))`,
      north: sql<number | null>`ST_YMax(ST_Extent(${properties.geom}))`,
    })
    .from(properties)
    .where(and(isNull(properties.archivedAt), propertyScope(ctx)));
  return { serviceArea: null, bounds: extent === undefined ? null : boundsOf(extent) };
}
