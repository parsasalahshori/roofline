import { and, desc, eq } from 'drizzle-orm';
import { cleanGutterAdjustments, EMPTY_GUTTER_ADJUSTMENTS, type GutterAdjustments, type MeasurementView } from '@roofline/shared';
import { measurements, windowMeasurements } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { getMeasurement } from './measurements.ts';

/**
 * What Measure gutters works from, for a measurement the member may see (null otherwise): the measurement (its roof),
 * the stored gutter adjustments, and the house's eave height when a Measure windows run at the same home found one
 * (Google's height map, metres) or its floors. No outside lookups.
 */
export type GutterInputs = {
  view: MeasurementView;
  adjustments: GutterAdjustments;
  eaveHeightM: number | null;
  floors: number | null;
};

/** A stored value read tolerantly: anything not shaped like adjustments is the empty set. */
function storedAdjustments(raw: unknown): GutterAdjustments {
  if (raw === null || typeof raw !== 'object') return { ...EMPTY_GUTTER_ADJUSTMENTS };
  const r = raw as Partial<GutterAdjustments>;
  return {
    excludedRunIds: Array.isArray(r.excludedRunIds) ? r.excludedRunIds.filter((x): x is string => typeof x === 'string') : [],
    downspouts: r.downspouts !== null && typeof r.downspouts === 'object' && !Array.isArray(r.downspouts) ? { ...r.downspouts } : {},
    size: r.size === '5in' || r.size === '6in' ? r.size : null,
  };
}

export async function gutterInputs(tx: Tx, ctx: TenantContext, id: string, now: Date = new Date()): Promise<GutterInputs | null> {
  const view = await getMeasurement(tx, ctx, id, now);
  if (view === null) return null;
  const [row] = await tx
    .select({ adjustments: measurements.gutterAdjustments })
    .from(measurements)
    .where(and(eq(measurements.id, id), eq(measurements.companyId, ctx.companyId)))
    .limit(1);
  // The newest windows run at this home that knows the eave height or the floors.
  const windows = await tx
    .select({ geometry: windowMeasurements.geometry, stories: windowMeasurements.stories })
    .from(windowMeasurements)
    .where(and(eq(windowMeasurements.propertyId, view.propertyId), eq(windowMeasurements.companyId, ctx.companyId)))
    .orderBy(desc(windowMeasurements.createdAt))
    .limit(5);
  const withEave = windows.find((w) => typeof w.geometry?.eaveHeightM === 'number');
  const withFloors = windows.find((w) => typeof w.stories === 'number');
  return {
    view,
    adjustments: storedAdjustments(row?.adjustments),
    eaveHeightM: withEave?.geometry?.eaveHeightM ?? null,
    floors: withFloors?.stories ?? null,
  };
}

/**
 * Replaces a measurement's gutter adjustments (cleaned against the runs the caller worked out). Null when the member
 * may not see the measurement. Gutters are not on a proposal, so a locked (sent) measurement still takes them.
 */
export async function setGutterAdjustments(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  runs: readonly { id: string }[],
  adjustments: Partial<GutterAdjustments>,
  now: Date,
): Promise<GutterAdjustments | null> {
  const visible = await getMeasurement(tx, ctx, id, now);
  if (visible === null) return null;
  const clean = cleanGutterAdjustments(runs, adjustments);
  await tx
    .update(measurements)
    .set({ gutterAdjustments: clean, updatedAt: now })
    .where(and(eq(measurements.id, id), eq(measurements.companyId, ctx.companyId)));
  return clean;
}
