import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { carryExcluded, cleanExcluded, isRoof3d, measureRoof, measurementGoogleDeleteBy, ROOF_3D_NONE_REASONS, roof3dSnapshotCurrent, sameOutline, solarDataCurrent, type InstantEstimate, type LngLat, type MeasurementKind, type MeasurementMethod, type MeasurementView, type Outline, type PitchSource, type Ring, type Roof3dInput, type Roof3dSnapshot, type RoofModel, type RoofPlane, type SolarSnapshot } from '@roofline/shared';
import { jobs, measurements, properties, proposals } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { getProperty, type PropertyRow } from './properties.ts';
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
  /**
   * All footprints near the home, in order; the main structure is `included: true` and marked `main: true` (only
   * that entry carries the key).
   */
  structures: { footprintId: string; included: boolean; areaSqFt: number; ring: Ring; main?: boolean }[];
  estimate: InstantEstimate;
  /** Roof facets counted for the measurement (null: none worked out). */
  facets?: number | null;
  overhangFt: number;
  /** Map centre, [lng, lat] (not stored in its own column; derived on read: see Package 1). */
  center: LngLat;
  /** Where the estimate's pitch came from (null: not recorded). */
  pitchSource?: PitchSource | null;
  /** Google Solar's roof planes, for facets to take their own pitch from (only with pitchSource 'solar'). */
  pitchPlanes?: RoofPlane[] | null;
  /** The Google Solar answer used, kept so measuring the home again does not ask again. */
  solar?: SolarSnapshot | null;
  /**
   * The roof reconstructed in 3D from Google Solar's height map (or why there is none), kept so measuring the home
   * again does not buy it again. The roof is drawn from it while an outline ring is its outline.
   */
  roof3d?: Roof3dSnapshot | null;
};

export type MeasurementPatch = {
  outline?: Outline;
  /** Footprint ids that count; every other structure becomes excluded. */
  includedStructures?: string[];
  pitchX12?: number;
  overhangFt?: number;
  valleyFt?: number;
  /**
   * Roof facet ids ('A', 'B', ...) to leave out of the quote, replacing the list ([] quotes the whole roof). Each must
   * be a facet of the roof as it is after this change.
   */
  excludedFacets?: string[];
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
    // Only the main building carries the key, so structures stored before it existed read back the same.
    ...(s.main === true ? { main: true } : {}),
  }));
}

/** Metres in one degree of latitude (and of longitude at the equator). */
const M_PER_DEG = 111_320;
/** The furthest north a home in the US lies (Alaska's north coast is about 71.4 degrees). */
const MAX_US_LAT = 72;
/** The smallest box half-width, in degrees: about 50 m, so a tiny radius still finds the building under the point. */
const MIN_BOX_DEG = 0.0005;

/**
 * The half-width in degrees of a box that holds every point within `radiusM` of a point at `lat`:
 * the radius in degrees of longitude there (wider than latitude, which it also covers), with room to spare.
 */
export function footprintBoxDegrees(lat: number, radiusM: number): number {
  const cos = Math.cos((Math.min(Math.abs(lat), MAX_US_LAT) * Math.PI) / 180);
  return Math.max(MIN_BOX_DEG, (radiusM / (M_PER_DEG * cos)) * 1.5);
}

/**
 * The footprintsNear query. `geom && ST_Expand(point, deg)` is a bounding-box test the GIST index on
 * `geom` answers, so only the few buildings around the point are read; the exact geography distance
 * then runs on those. (A test on `geom::geography` alone cannot use that index: it scans the table.)
 */
export function footprintsNearQuery(point: LngLat, radiusM: number) {
  const pt = sql`ST_SetSRID(ST_MakePoint(${point[0]}::float8, ${point[1]}::float8), 4326)`;
  const deg = footprintBoxDegrees(point[1], radiusM);
  return sql`
    select id::text as id,
           ST_AsGeoJSON(geom) as geojson,
           area_sq_ft::float8 as area_sq_ft,
           ST_Covers(geom, ${pt}) as contains,
           case when ST_Covers(geom, ${pt}) then 0
                else ST_Distance(geom::geography, ${pt}::geography) end::float8 as distance_m
      from building_footprints
     where geom && ST_Expand(${pt}, ${deg}::float8)
       and ST_DWithin(geom::geography, ${pt}::geography, ${radiusM}::float8)
     order by contains desc, distance_m asc`;
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
  const result = await tx.execute(footprintsNearQuery(point, radiusM));
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

/** One footprint of the global table by id (the bigserial written as a string), or null. Open ring, like footprintsNear. */
export async function footprintById(tx: Tx, id: string): Promise<{ id: string; ring: Ring; areaSqFt: number } | null> {
  if (!/^\d{1,19}$/.test(id)) return null;
  const result = await tx.execute(sql`
    select id::text as id, ST_AsGeoJSON(geom) as geojson, area_sq_ft::float8 as area_sq_ft
      from building_footprints
     where id = ${id}::bigint`);
  const row = result.rows[0];
  if (row === undefined) return null;
  const geojson = JSON.parse(String(row.geojson)) as { coordinates: [number, number][][] };
  return { id: String(row.id), ring: openRing(geojson.coordinates[0] as Ring), areaSqFt: Number(row.area_sq_ft) };
}

/**
 * The company's saved, not archived home on this footprint that the caller may see, or null: one already linked to
 * it first, else one with no footprint yet whose point lies inside it (homes saved before any measure); the oldest wins.
 */
export async function propertyOnFootprint(tx: Tx, ctx: TenantContext, footprintId: string): Promise<PropertyRow | null> {
  if (!/^\d{1,19}$/.test(footprintId)) return null;
  const inside = sql`(${properties.footprintId} is null and ${properties.geom} is not null and ST_Covers((select f.geom from building_footprints f where f.id = ${footprintId}::bigint), ${properties.geom}))`;
  const [row] = await tx
    .select()
    .from(properties)
    .where(
      and(
        eq(properties.companyId, ctx.companyId),
        or(eq(properties.footprintId, footprintId), inside),
        isNull(properties.archivedAt),
        propertyScope(ctx),
      ),
    )
    .orderBy(sql`(${properties.footprintId} is null)`, asc(properties.createdAt), asc(properties.id))
    .limit(1);
  return row ?? null;
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
      facets: m.facets ?? null,
      pitchSource: m.pitchSource ?? null,
      pitchPlanes: measuredPitch(m.pitchSource ?? null) && m.pitchPlanes != null && m.pitchPlanes.length > 0 ? m.pitchPlanes : null,
      solar: m.solar ?? null,
      roof3d: m.roof3d ?? null,
      // Google's content on the row (the Solar answer, the roof photo) goes 30 days after its download.
      googleDeleteBy: measurementGoogleDeleteBy(m.solar ?? null, m.roof3d ?? null),
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: measurements.id });

  const view = await getMeasurement(tx, ctx, row!.id);
  return view!;
}

/**
 * One measurement the member may see (through its property), as the API answers it; null otherwise. `now` decides
 * whether Google's photo of a 3D roof may still be shown (30 days).
 */
export async function getMeasurement(tx: Tx, ctx: TenantContext, id: string, now: Date = new Date()): Promise<MeasurementView | null> {
  const [found] = await tx
    .select({
      row: measurements,
      outlineGeoJson: sql<string | null>`ST_AsGeoJSON(${measurements.outline})`,
      propertyGeom: properties.geom,
      propertyCustomerId: properties.customerId,
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
  // The roof drawn over the outline is worked out on read (deterministic), and its lines give the ridge, valley
  // and edge lengths, so what is drawn and what is priced agree. With facets left out, the estimate is the quoted
  // facets' (the numbers updateMeasurement stored).
  const planes = planesOf(row);
  const roof3d = roof3dOf(row);
  const measured = measureRoof({ outline: outline ?? [], pitchX12, overhangFt, valleyFt, planes, excludedFacets: row.excludedFacets, roof3d });
  const fromOutline: InstantEstimate = measured.estimate;
  // An exact report's or an aerial measure's numbers are the measurement itself: shown as stored, never
  // worked out again from the outline (B5). Proposals are priced from the same stored columns.
  const estimate: InstantEstimate = keepsStoredNumbers(row) ? storedEstimate(row, fromOutline) : fromOutline;

  const center: LngLat = found.propertyGeom ?? (outline?.[0] ? ringCentroid(outline[0]) : US_MAP_CENTER);
  const in3d = roof3d !== null && (outline ?? []).some((ring) => sameOutline(ring, roof3d.roof));

  return {
    id: row.id,
    propertyId: row.propertyId,
    jobId: row.jobId ?? null,
    kind: row.kind,
    method: row.method,
    outline,
    structures: storedStructures(row.structures),
    estimate,
    facets: keepsStoredNumbers(row) ? (row.facets ?? null) : (measured.roof?.totals.facetCount ?? row.facets ?? null),
    overhangFt,
    center,
    locked: await isMeasurementLocked(tx, ctx, row.id),
    providerRef: row.providerRef ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    drawMode: outline === null,
    hasCustomer: row.jobId !== null || found.propertyCustomerId !== null,
    roof: measured.roof,
    pitchSource: row.pitchSource ?? null,
    pitchPlanes: planes,
    excludedFacets: measured.roof?.excluded ?? [],
    // Only while the roof drawn is the reconstruction (an outline moved by hand gets the outline's roof instead).
    roof3d: in3d ? roof3d.roof : null,
    // Google's photo of it, while the roof is the reconstruction and the photo may still be kept (Solar API terms).
    roofPhoto:
      in3d && row.roof3d?.photo != null && solarDataCurrent(row.roof3d, now)
        ? { url: `/api/measurements/${row.id}/roof-photo`, corners: row.roof3d.photo.corners }
        : null,
    ...(in3d && roofPhotoGone(row.roof3d ?? null, now) ? { roofPhotoExpired: true } : {}),
    needsReview: in3d && (roof3d.roof.quality?.reasons.length ?? 0) > 0 ? { reasons: [...roof3d.roof.quality!.reasons] } : null,
    ...roof3dStatus(row.roof3d ?? null, in3d),
  };
}

/** Whether a 3D snapshot's Google photo is past its days: deleted by the retention job, or still named but expired. */
export function roofPhotoGone(snapshot: Roof3dSnapshot | null, now: Date): boolean {
  if (snapshot === null || typeof snapshot !== 'object') return false;
  if (typeof snapshot.photoDeletedAt === 'string') return true;
  return snapshot.photo != null && !solarDataCurrent(snapshot, now);
}

/**
 * Why a measurement has no 3D roof (the kept snapshot's typed reason), and whether the 3D roof shown is an older
 * reconstruction's (MeasurementView.roof3dMissing, roof3dOutdated). Tolerant of any stored shape: an unknown reason is
 * left out, never thrown on.
 */
export function roof3dStatus(snapshot: Roof3dSnapshot | null, in3d: boolean): Pick<MeasurementView, 'roof3dMissing' | 'roof3dOutdated'> {
  if (snapshot === null || typeof snapshot !== 'object') return { roof3dMissing: null };
  if (in3d) return { roof3dMissing: null, ...(roof3dSnapshotCurrent(snapshot) ? {} : { roof3dOutdated: true }) };
  const none = snapshot.roof == null ? snapshot.none : undefined;
  return { roof3dMissing: none !== undefined && (ROOF_3D_NONE_REASONS as readonly string[]).includes(none) ? none : null };
}

/** Whether the pitch is a measured one whose planes the facets keep: Google Solar's segments, or its 3D roof. */
function measuredPitch(source: PitchSource | null): boolean {
  return source === 'solar' || source === 'solar-3d';
}

/**
 * The reconstructed roof kept on a measurement, for measureRoof: its faces keep their own pitch while the pitch is
 * still the reconstruction's; a pitch a person picked is every sloped face's.
 */
function roof3dOf(row: { pitchSource: PitchSource | null; roof3d: Roof3dSnapshot | null }): Roof3dInput | null {
  const roof = row.roof3d?.roof;
  return isRoof3d(roof) ? { roof, ownPitch: row.pitchSource === 'solar-3d' } : null;
}

/** The 3D roof snapshot kept on a measurement the member may see: undefined when they may not see it (or it does not exist). */
export async function measurementRoof3d(tx: Tx, ctx: TenantContext, id: string): Promise<Roof3dSnapshot | null | undefined> {
  const [row] = await tx
    .select({ roof3d: measurements.roof3d })
    .from(measurements)
    .innerJoin(properties, and(eq(properties.id, measurements.propertyId), eq(properties.companyId, measurements.companyId)))
    .where(and(eq(measurements.id, id), eq(measurements.companyId, ctx.companyId), propertyScope(ctx)))
    .limit(1);
  return row === undefined ? undefined : (row.roof3d ?? null);
}

/**
 * The newest reconstructed roof (or "none there") kept on a measurement of this home that the caller may see, or null.
 * The caller decides whether it is still fresh and for this roof (roof3dSnapshotFresh).
 */
export async function latestRoof3dSnapshot(tx: Tx, ctx: TenantContext, propertyId: string): Promise<Roof3dSnapshot | null> {
  const [row] = await tx
    .select({ roof3d: measurements.roof3d })
    .from(measurements)
    .innerJoin(properties, and(eq(properties.id, measurements.propertyId), eq(properties.companyId, measurements.companyId)))
    .where(
      and(
        eq(measurements.companyId, ctx.companyId),
        eq(measurements.propertyId, propertyId),
        isNotNull(measurements.roof3d),
        propertyScope(ctx),
      ),
    )
    .orderBy(sql`${measurements.createdAt} desc`)
    .limit(1);
  return row?.roof3d ?? null;
}

/** The roof planes the facets take their pitch from: Google Solar's (or its 3D roof's), while the pitch is still Solar's. */
function planesOf(row: { pitchSource: PitchSource | null; pitchPlanes: RoofPlane[] | null }): RoofPlane[] | null {
  return measuredPitch(row.pitchSource) && Array.isArray(row.pitchPlanes) && row.pitchPlanes.length > 0 ? row.pitchPlanes : null;
}

/**
 * The newest Google Solar answer kept on a measurement of this home (any the caller may see), or null. The caller
 * decides whether it is still fresh and for the same point (solarSnapshotFresh).
 */
export async function latestSolarSnapshot(tx: Tx, ctx: TenantContext, propertyId: string): Promise<SolarSnapshot | null> {
  const [row] = await tx
    .select({ solar: measurements.solar })
    .from(measurements)
    .innerJoin(properties, and(eq(properties.id, measurements.propertyId), eq(properties.companyId, measurements.companyId)))
    .where(
      and(
        eq(measurements.companyId, ctx.companyId),
        eq(measurements.propertyId, propertyId),
        isNotNull(measurements.solar),
        propertyScope(ctx),
      ),
    )
    .orderBy(sql`${measurements.createdAt} desc`)
    .limit(1);
  return row?.solar ?? null;
}

/** Whether a measurement's stored numbers come from a report or aerial imagery rather than from its outline. */
function keepsStoredNumbers(row: { kind: MeasurementKind; method: MeasurementMethod }): boolean {
  return row.kind === 'exact' || row.method === 'aerial';
}

/** The stored surface, lengths and pitch as an estimate; the footprint and plan areas come from the outline. */
function storedEstimate(row: typeof measurements.$inferSelect, fromOutline: InstantEstimate): InstantEstimate {
  const surfaceSqFt = row.surfaceSqFt ?? 0;
  return {
    footprintSqFt: row.footprintSqFt ?? fromOutline.footprintSqFt,
    planSqFt: fromOutline.planSqFt,
    surfaceSqFt,
    squares: Math.round(surfaceSqFt) / 100,
    edgeFt: row.edgeFt ?? 0,
    ridgeFt: row.ridgeFt ?? 0,
    valleyFt: row.valleyFt ?? 0,
    pitchX12: row.pitchX12 ?? 0,
  };
}

/** Whether two facet id lists are the same, in the same order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** The facet ids stored on a row (the column is jsonb: anything that is not a list of strings counts as none). */
function storedExcluded(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Changes a measurement the member may see. Null when they may not (or it does not exist); 'exact' for an
 * exact report's measurement, which is never changed (B5); 'locked' when a proposal has been sent from it;
 * 'unknown_structure' when an included id is not one of its structures; 'no_structure' when no structure would be
 * included (a measurement with structures); 'unknown_facet' when a facet id to leave out is not a facet of the roof
 * after the change; 'no_facets' when every facet would be left out. Nothing is written in those cases.
 * A hand-drawn outline replaces the outline and keeps the structures; included structures rebuild the outline from
 * their rings unless an outline is given. A measurement with no structures keeps its outline when included
 * structures are sent.
 * Facets left out of the quote: `excludedFacets` replaces the list. Without it, a new outline, other structures, a
 * pitch or an overhang keep the same facets out only when the roof's facets are unchanged (carryExcluded); otherwise
 * the whole roof is quoted again.
 * The stored totals (surface, edges, ridge, valley, footprint) are recomputed from the outline, pitch, overhang,
 * valley and the facets quoted, so proposals price only those; `facets` stays the whole roof's count.
 */
export async function updateMeasurement(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  p: MeasurementPatch,
  now: Date,
): Promise<MeasurementView | 'exact' | 'locked' | 'unknown_structure' | 'no_structure' | 'unknown_facet' | 'no_facets' | null> {
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
  if (found.row.kind === 'exact') return 'exact';
  if (await isMeasurementLocked(tx, ctx, id)) return 'locked';

  const current = found.row;
  let structures = storedStructures(current.structures);
  const outlineBefore: Outline | null = outlineFromGeoJson(found.outlineGeoJson);
  let outline: Outline | null = outlineBefore;

  if (p.includedStructures !== undefined) {
    if (p.includedStructures.length === 0 && structures.length > 0) return 'no_structure';
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
  // A pitch a person picks is the whole roof's: the facets stop taking their own from Google Solar's planes.
  const pitchSource: PitchSource | null = p.pitchX12 !== undefined ? 'manual' : current.pitchSource;
  const pitchPlanes = p.pitchX12 !== undefined ? null : current.pitchPlanes;
  const planes = planesOf({ pitchSource, pitchPlanes });
  const roof3d = roof3dOf({ pitchSource, roof3d: current.roof3d });

  // The facets left out of the quote, checked against (or carried over to) the roof as it is after this change.
  const excludedBefore = storedExcluded(current.excludedFacets);
  const roofAfter = measureRoof({ outline: outline ?? [], pitchX12, overhangFt, planes, roof3d }).roof;
  const reshaped = p.outline !== undefined || p.includedStructures !== undefined || p.pitchX12 !== undefined || p.overhangFt !== undefined;
  let excludedFacets: string[];
  // Whether other facets are quoted than before (the same facets under new letters are not a change).
  let facetsChanged: boolean;
  if (p.excludedFacets !== undefined) {
    const facetIds = new Set((roofAfter?.facets ?? []).map((f) => f.id));
    if (p.excludedFacets.some((fid) => !facetIds.has(fid))) return 'unknown_facet';
    if (facetIds.size > 0 && new Set(p.excludedFacets).size >= facetIds.size) return 'no_facets';
    excludedFacets = cleanExcluded(roofAfter, p.excludedFacets);
    facetsChanged = !sameIds(excludedFacets, cleanExcluded(roofAfter, excludedBefore));
  } else if (reshaped && excludedBefore.length > 0) {
    const roofBefore: RoofModel | null = measureRoof({
      outline: outlineBefore ?? [],
      pitchX12: current.pitchX12 ?? 0,
      overhangFt: current.overhangFt ?? 0,
      planes: planesOf(current),
      roof3d: roof3dOf(current),
    }).roof;
    excludedFacets = carryExcluded(roofBefore, roofAfter, excludedBefore);
    // Carried over means the very same facets (by shape) stay out; none carried quotes the whole roof again.
    facetsChanged = excludedFacets.length === 0;
  } else {
    excludedFacets = cleanExcluded(roofAfter, excludedBefore);
    facetsChanged = !sameIds(excludedFacets, excludedBefore);
  }

  // A new outline or pitch, or other facets quoted, gets the valleys its roof has (0 means "the roof's"), unless a
  // length is sent with it.
  const roofChanged = p.outline !== undefined || p.includedStructures !== undefined || p.pitchX12 !== undefined || facetsChanged;
  const valleyIn = p.valleyFt ?? (roofChanged ? 0 : (current.valleyFt ?? 0));
  const { estimate, roof } = measureRoof({ outline: outline ?? [], pitchX12, overhangFt, valleyFt: valleyIn, planes, excludedFacets, roof3d });
  const valleyFt = p.valleyFt ?? estimate.valleyFt;

  await tx
    .update(measurements)
    .set({
      outline: outline !== null ? toMultiPolygonEwkt(outline) : null,
      structures,
      pitchX12,
      overhangFt,
      valleyFt,
      // The quoted facets' numbers (the whole roof's when none is left out): what proposals are priced from.
      footprintSqFt: estimate.footprintSqFt,
      surfaceSqFt: estimate.surfaceSqFt,
      edgeFt: estimate.edgeFt,
      ridgeFt: estimate.ridgeFt,
      facets: roof?.totals.facetCount ?? null,
      excludedFacets,
      pitchSource,
      pitchPlanes,
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
