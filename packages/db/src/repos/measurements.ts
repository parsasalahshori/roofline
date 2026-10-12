import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { instantEstimate, type InstantEstimate, type LngLat, type MeasurementKind, type MeasurementMethod, type MeasurementView, type Outline, type Ring } from '@roofline/shared';
import { jobs, measurements, properties, proposals } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { getProperty } from './properties.ts';
import { jobScope, propertyScope } from './scope.ts';

/** The centre of the United States: the map opens here when a measurement has no address point and no outline. */
export const US_MAP_CENTER: LngLat = [-98.5795, 39.8283];

export type NewMeasurement = {
  propertyId: string;
  jobId?: string | null;
  kind: MeasurementKind;
  method: MeasurementMethod;
  /** Null: draw mode / manual. */
  outline: Outline | null;
  /** All footprints near the home, in order; the main structure is `included: true`. */
  structures: { footprintId: string; included: boolean; areaSqFt: number; ring: Ring }[];
  estimate: InstantEstimate;
  overhangFt: number;
  /** Map centre, [lng, lat] (not stored in its own column; derived on read: see Package 1). */
  center: LngLat;
};

export type MeasurementPatch = {
  outline?: Outline;
  /** Footprint ids that count; every other structure becomes excluded. */
  includedStructures?: string[];
  pitchX12?: number;
  overhangFt?: number;
  valleyFt?: number;
};

/** The property (or the job) a measurement is for is not one the member can see, or the job is not at that property. */
export class MeasurementPropertyNotFoundError extends Error {
  constructor() {
    super('That address does not exist, or the member cannot see it.');
    this.name = 'MeasurementPropertyNotFoundError';
  }
}

type StoredStructure = MeasurementView['structures'][number];

/** Closes a ring for PostGIS (the first corner repeated at the end). */
function closeRing(ring: Ring): Ring {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

/**
 * Drops a repeated closing corner. PostGIS rings come back closed; the view hands out open rings so the
 * outline editor shows one handle per corner.
 */
function openRing(ring: Ring): Ring {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (ring.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring;
}

/** The outline as EWKT: one polygon per ring, SRID 4326. */
function toMultiPolygonEwkt(outline: Outline): string {
  const polygons = outline.map((ring) => `((${closeRing(ring).map(([lng, lat]) => `${lng} ${lat}`).join(', ')}))`);
  return `SRID=4326;MULTIPOLYGON(${polygons.join(', ')})`;
}

/** The outer rings of a GeoJSON MultiPolygon as stored (null when the column is null). */
function outlineFromGeoJson(geojson: string | null): Outline | null {
  if (geojson === null) return null;
  const parsed = JSON.parse(geojson) as { coordinates: [number, number][][][] };
  return parsed.coordinates.map((polygon) => openRing(polygon[0] as Ring));
}

/** The centroid (mean of the corners) of a ring, without a repeated closing corner. */
function ringCentroid(ring: Ring): LngLat {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const corners = first && last && first[0] === last[0] && first[1] === last[1] && ring.length > 1 ? ring.slice(0, -1) : ring;
  if (corners.length === 0) return US_MAP_CENTER;
  const sum = corners.reduce<LngLat>((acc, [lng, lat]) => [acc[0] + lng, acc[1] + lat], [0, 0]);
  return [sum[0] / corners.length, sum[1] / corners.length];
}

function storedStructures(value: unknown): StoredStructure[] {
  if (!Array.isArray(value)) return [];
  return (value as Record<string, unknown>[]).map((s) => ({
    footprintId: String(s.footprintId),
    included: s.included === true,
    areaSqFt: Number(s.areaSqFt),
    ring: openRing(s.ring as Ring),
  }));
}

/**
 * Footprints within `radiusM` metres of a point, global table (no company filter). The one that
 * contains the point comes first, then the nearest; `distanceM` is 0 for a containing footprint.
 */
export async function footprintsNear(
  tx: Tx,
  point: LngLat,
  radiusM: number,
): Promise<{ id: string; ring: Ring; areaSqFt: number; contains: boolean; distanceM: number }[]> {
  const pt = sql`ST_SetSRID(ST_MakePoint(${point[0]}::float8, ${point[1]}::float8), 4326)`;
  const result = await tx.execute(sql`
    select id::text as id,
           ST_AsGeoJSON(geom) as geojson,
           area_sq_ft::float8 as area_sq_ft,
           ST_Covers(geom, ${pt}) as contains,
           case when ST_Covers(geom, ${pt}) then 0
                else ST_Distance(geom::geography, ${pt}::geography) end::float8 as distance_m
      from building_footprints
     where ST_DWithin(geom::geography, ${pt}::geography, ${radiusM}::float8)
     order by contains desc, distance_m asc`);
  return result.rows.map((row) => {
    const geojson = JSON.parse(String(row.geojson)) as { coordinates: [number, number][][] };
    return {
      id: String(row.id),
      ring: openRing(geojson.coordinates[0] as Ring),
      areaSqFt: Number(row.area_sq_ft),
      contains: row.contains === true,
      distanceM: Number(row.distance_m),
    };
  });
}

/** Whether a proposal for this measurement has been sent (spec §7): a locked measurement cannot change. A draft or ready proposal does not lock it. */
export async function isMeasurementLocked(tx: Tx, ctx: TenantContext, id: string): Promise<boolean> {
  const [found] = await tx
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.companyId, ctx.companyId),
        eq(proposals.measurementId, id),
        or(isNotNull(proposals.sentAt), inArray(proposals.status, ['sent', 'viewed', 'signed', 'declined', 'expired'])),
      ),
    )
    .limit(1);
  return found !== undefined;
}

/** Writes a measurement for a property the member can see; a job, when given, must be at that property. */
export async function createMeasurement(tx: Tx, ctx: TenantContext, m: NewMeasurement, now: Date): Promise<MeasurementView> {
  const property = await getProperty(tx, ctx, m.propertyId);
  if (!property) throw new MeasurementPropertyNotFoundError();
  if (m.jobId != null) {
    const [job] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.id, m.jobId), eq(jobs.companyId, ctx.companyId), eq(jobs.propertyId, m.propertyId), jobScope(ctx)),
      )
      .limit(1);
    if (!job) throw new MeasurementPropertyNotFoundError();
  }

  const [row] = await tx
    .insert(measurements)
    .values({
      companyId: ctx.companyId,
      propertyId: m.propertyId,
      jobId: m.jobId ?? null,
      kind: m.kind,
      method: m.method,
      outline: m.outline !== null && m.outline.length > 0 ? toMultiPolygonEwkt(m.outline) : null,
      structures: m.structures,
      footprintSqFt: m.estimate.footprintSqFt,
      overhangFt: m.overhangFt,
      pitchX12: m.estimate.pitchX12,
      surfaceSqFt: m.estimate.surfaceSqFt,
      edgeFt: m.estimate.edgeFt,
      ridgeFt: m.estimate.ridgeFt,
      valleyFt: m.estimate.valleyFt,
      facets: null,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: measurements.id });

  const view = await getMeasurement(tx, ctx, row!.id);
  return view!;
}

/** One measurement the member may see (through its property), as the API answers it; null otherwise. */
export async function getMeasurement(tx: Tx, ctx: TenantContext, id: string): Promise<MeasurementView | null> {
  const [found] = await tx
    .select({
      row: measurements,
      outlineGeoJson: sql<string | null>`ST_AsGeoJSON(${measurements.outline})`,
      propertyGeom: properties.geom,
    })
    .from(measurements)
    .innerJoin(
      properties,
      and(eq(properties.id, measurements.propertyId), eq(properties.companyId, measurements.companyId)),
    )
    .where(and(eq(measurements.id, id), eq(measurements.companyId, ctx.companyId), propertyScope(ctx)))
    .limit(1);
  if (!found) return null;

  const row = found.row;
  const outline = outlineFromGeoJson(found.outlineGeoJson);
  const pitchX12 = row.pitchX12 ?? 0;
  const overhangFt = row.overhangFt ?? 0;
  const valleyFt = row.valleyFt ?? 0;
  const estimate: InstantEstimate = instantEstimate({ outline: outline ?? [], pitchX12, overhangFt, valleyFt });

  const center: LngLat = found.propertyGeom ?? (outline?.[0] ? ringCentroid(outline[0]) : US_MAP_CENTER);

  return {
    id: row.id,
    propertyId: row.propertyId,
    jobId: row.jobId ?? null,
    kind: row.kind,
    method: row.method,
    outline,
    structures: storedStructures(row.structures),
    estimate,
    facets: row.facets ?? null,
    overhangFt,
    center,
    locked: await isMeasurementLocked(tx, ctx, row.id),
    providerRef: row.providerRef ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    drawMode: outline === null,
  };
}

/**
 * Changes a measurement the member may see. Null when they may not (or it does not exist); 'locked'
 * when a proposal has been sent from it; 'unknown_structure' when an included id is not one of its
 * structures (nothing is written). A hand-drawn outline replaces the outline and keeps the
 * structures; included structures rebuild the outline from their rings unless an outline is given.
 * A measurement with no structures keeps its outline when included structures are sent.
 * The stored totals are recomputed from the outline, pitch, overhang and valley.
 */
export async function updateMeasurement(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  p: MeasurementPatch,
  now: Date,
): Promise<MeasurementView | 'locked' | 'unknown_structure' | null> {
  const [found] = await tx
    .select({ row: measurements, outlineGeoJson: sql<string | null>`ST_AsGeoJSON(${measurements.outline})` })
    .from(measurements)
    .innerJoin(
      properties,
      and(eq(properties.id, measurements.propertyId), eq(properties.companyId, measurements.companyId)),
    )
    .where(and(eq(measurements.id, id), eq(measurements.companyId, ctx.companyId), propertyScope(ctx)))
    .limit(1)
    .for('update', { of: measurements });
  if (!found) return null;
  if (await isMeasurementLocked(tx, ctx, id)) return 'locked';

  const current = found.row;
  let structures = storedStructures(current.structures);
  let outline: Outline | null = outlineFromGeoJson(found.outlineGeoJson);

  if (p.includedStructures !== undefined) {
    const known = new Set(structures.map((s) => s.footprintId));
    if (p.includedStructures.some((fid) => !known.has(fid))) return 'unknown_structure';
    const included = new Set(p.includedStructures);
    structures = structures.map((s) => ({ ...s, included: included.has(s.footprintId) }));
  }
  if (p.outline !== undefined) {
    outline = p.outline;
  } else if (p.includedStructures !== undefined && structures.length > 0) {
    const rings = structures.filter((s) => s.included).map((s) => s.ring);
    outline = rings.length > 0 ? rings : null;
  }

  const pitchX12 = p.pitchX12 ?? current.pitchX12 ?? 0;
  const overhangFt = p.overhangFt ?? current.overhangFt ?? 0;
  const valleyFt = p.valleyFt ?? current.valleyFt ?? 0;
  const estimate = instantEstimate({ outline: outline ?? [], pitchX12, overhangFt, valleyFt });

  await tx
    .update(measurements)
    .set({
      outline: outline !== null ? toMultiPolygonEwkt(outline) : null,
      structures,
      pitchX12,
      overhangFt,
      valleyFt,
      footprintSqFt: estimate.footprintSqFt,
      surfaceSqFt: estimate.surfaceSqFt,
      edgeFt: estimate.edgeFt,
      ridgeFt: estimate.ridgeFt,
      updatedAt: now,
    })
    .where(and(eq(measurements.id, id), eq(measurements.companyId, ctx.companyId)));

  return getMeasurement(tx, ctx, id);
}

/** Points an address at the footprint the estimator chose. No error when the member cannot see the address. */
export async function setPropertyFootprint(tx: Tx, ctx: TenantContext, propertyId: string, footprintId: string): Promise<void> {
  await tx
    .update(properties)
    .set({ footprintId })
    .where(and(eq(properties.id, propertyId), eq(properties.companyId, ctx.companyId), propertyScope(ctx)));
}
