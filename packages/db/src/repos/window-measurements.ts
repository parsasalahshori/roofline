import { and, desc, eq, notExists, type SQL, sql } from 'drizzle-orm';
import type { EstimatedWindows, LngLat, MeasuredWindow, WindowAdjustments, WindowDetectorName, WindowsMissReason } from '@roofline/shared';
import { homeownerRequests, properties, type StoredFacadePhoto, type StoredWindowUpload, type WindowGeometry, windowMeasurements } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { getProperty } from './properties.ts';
import { propertyScope } from './scope.ts';

/*
 * Measure windows' rows. Every read goes through the property (rep visibility, spec 3.2): a window measurement the
 * member may not see is reported exactly like one that does not exist (null).
 */

export type WindowMeasurementRow = typeof windowMeasurements.$inferSelect;

export type NewWindowMeasurement = {
  propertyId: string;
  address: string;
  center: LngLat;
  photos: StoredFacadePhoto[];
  windows: MeasuredWindow[];
  estimated: EstimatedWindows | null;
  stories: number | null;
  geometry: WindowGeometry | null;
  detector: WindowDetectorName | null;
  missingReason: WindowsMissReason | null;
  reviewReasons: string[];
  tookMs: number;
  photosDeleteBy: Date | null;
};

/** The property is not one the member can see. */
export class WindowMeasurementPropertyNotFoundError extends Error {
  constructor() {
    super('That address does not exist, or the member cannot see it.');
    this.name = 'WindowMeasurementPropertyNotFoundError';
  }
}

const EMPTY_ADJUSTMENTS: WindowAdjustments = { excludedWindowIds: [], manualCounts: {} };

export async function createWindowMeasurement(tx: Tx, ctx: TenantContext, m: NewWindowMeasurement, now: Date): Promise<WindowMeasurementRow> {
  const property = await getProperty(tx, ctx, m.propertyId);
  if (!property) throw new WindowMeasurementPropertyNotFoundError();
  const [row] = await tx
    .insert(windowMeasurements)
    .values({
      companyId: ctx.companyId,
      propertyId: m.propertyId,
      address: m.address,
      center: m.center,
      photos: m.photos,
      windows: m.windows,
      estimated: m.estimated,
      stories: m.stories,
      geometry: m.geometry,
      detector: m.detector,
      missingReason: m.missingReason,
      reviewReasons: m.reviewReasons,
      adjustments: EMPTY_ADJUSTMENTS,
      tookMs: Math.max(0, Math.round(m.tookMs)),
      photosDeleteBy: m.photosDeleteBy,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

/**
 * One window measurement the member may see; null otherwise. `lock`: the row is locked (FOR UPDATE) until the
 * transaction ends, for a read-change-write of its adjustments that must not lose a change made at the same time.
 */
export async function getWindowMeasurement(tx: Tx, ctx: TenantContext, id: string, opts?: { lock?: boolean }): Promise<WindowMeasurementRow | null> {
  const query = tx
    .select({ row: windowMeasurements })
    .from(windowMeasurements)
    .innerJoin(properties, and(eq(properties.id, windowMeasurements.propertyId), eq(properties.companyId, windowMeasurements.companyId)))
    .where(and(eq(windowMeasurements.id, id), eq(windowMeasurements.companyId, ctx.companyId), propertyScope(ctx)))
    .limit(1);
  const [found] = await (opts?.lock === true ? query.for('update', { of: windowMeasurements }) : query);
  return found?.row ?? null;
}

/**
 * Leaves out the window measurements that belong to a homeowner's app request (each request keeps the windows and photos
 * the homeowner measured on one of its own; see repos/homeowner.ts). They are not the company's work: they have no walls
 * or street photos, and a reader that wants the company's own measurement of an address must not see them (or find them
 * crowding the company's out of its "newest few"). Use it in the `where` of a query over `window_measurements`.
 */
export function notHomeownerMeasurement(tx: Tx): SQL {
  return notExists(
    tx
      .select({ one: sql`1` })
      .from(homeownerRequests)
      .where(
        and(
          eq(homeownerRequests.companyId, windowMeasurements.companyId),
          eq(homeownerRequests.propertyId, windowMeasurements.propertyId),
          eq(homeownerRequests.windowMeasurementId, windowMeasurements.id),
        ),
      ),
  );
}

/**
 * The newest window measurement of a property the member may see; null when there is none (or they may not see it). The
 * windows a homeowner measured in the app are kept on a measurement of their own request: it is never the answer here
 * (it has no walls or street photos, and would hide the company's own earlier measurement); a new measurement of the
 * address starts with those windows instead (adoptHomeownerWindows).
 */
export async function getLatestWindowMeasurementForProperty(tx: Tx, ctx: TenantContext, propertyId: string): Promise<WindowMeasurementRow | null> {
  const [found] = await tx
    .select({ row: windowMeasurements })
    .from(windowMeasurements)
    .innerJoin(properties, and(eq(properties.id, windowMeasurements.propertyId), eq(properties.companyId, windowMeasurements.companyId)))
    .where(and(eq(windowMeasurements.propertyId, propertyId), eq(windowMeasurements.companyId, ctx.companyId), propertyScope(ctx), notHomeownerMeasurement(tx)))
    .orderBy(desc(windowMeasurements.createdAt), desc(windowMeasurements.id))
    .limit(1);
  return found?.row ?? null;
}

export type WindowMeasurementChange = Partial<Pick<WindowMeasurementRow, 'adjustments' | 'photos' | 'stories' | 'reviewReasons'>>;

/** Changes a window measurement the member may see; null when they may not (or it does not exist). */
export async function updateWindowMeasurement(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  change: WindowMeasurementChange,
  now: Date,
): Promise<WindowMeasurementRow | null> {
  const visible = await getWindowMeasurement(tx, ctx, id);
  if (visible === null) return null;
  const [row] = await tx
    .update(windowMeasurements)
    .set({ ...change, updatedAt: now })
    .where(and(eq(windowMeasurements.id, id), eq(windowMeasurements.companyId, ctx.companyId)))
    .returning();
  return row ?? null;
}

/**
 * Adds one uploaded photo to a window measurement the member may see, atomically (two uploads at once both land), unless
 * it already holds `max`: then 'full'. Null when the member may not see it (or it does not exist).
 */
export async function appendWindowUpload(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  upload: StoredWindowUpload,
  max: number,
  now: Date,
): Promise<WindowMeasurementRow | 'full' | null> {
  const visible = await getWindowMeasurement(tx, ctx, id);
  if (visible === null) return null;
  const [row] = await tx
    .update(windowMeasurements)
    .set({ uploads: sql`${windowMeasurements.uploads} || ${JSON.stringify([upload])}::jsonb`, updatedAt: now })
    .where(and(eq(windowMeasurements.id, id), eq(windowMeasurements.companyId, ctx.companyId), sql`jsonb_array_length(${windowMeasurements.uploads}) < ${max}`))
    .returning();
  return row ?? 'full';
}
