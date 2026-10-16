import { and, desc, eq, sql } from 'drizzle-orm';
import { cleanGutterAdjustments, gutterAdjustmentsChanged, type GutterAdjustments, type MeasurementView } from '@roofline/shared';
import { measurements, windowMeasurements } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { getMeasurement } from './measurements.ts';

/**
 * What Measure gutters works from, for a measurement the member may see (null otherwise): the measurement (its roof),
 * the stored gutter adjustments, the house's eave height when a Measure windows run at the same home found one
 * (Google's height map, metres) or its floors, and an exact report's eave length (EagleView measurements only). No
 * outside lookups.
 */
export type GutterInputs = {
  view: MeasurementView;
  adjustments: GutterAdjustments;
  eaveHeightM: number | null;
  floors: number | null;
  /** An EagleView measurement's eave length (ft): the gutter total. Null for every other measurement. */
  reportEaveFt: number | null;
};

/**
 * A stored value read tolerantly: anything not shaped like adjustments is the empty set, and rows from before added
 * runs, a typed total and who changed them have none. Run ids are checked against the roof later (cleanGutterAdjustments).
 */
function storedAdjustments(raw: unknown): GutterAdjustments {
  const r = raw !== null && typeof raw === 'object' ? (raw as Partial<GutterAdjustments>) : {};
  const ids = (list: unknown) => (Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  const downspouts = r.downspouts !== null && typeof r.downspouts === 'object' && !Array.isArray(r.downspouts) ? r.downspouts : {};
  const added = Array.isArray(r.addedRuns) ? r.addedRuns : [];
  // Every key the roof might have, so the cleaner keeps them: measured ids plus the added ones.
  const known = [...ids(r.excludedRunIds), ...Object.keys(downspouts)].map((id) => ({ id }));
  return cleanGutterAdjustments(known, {
    excludedRunIds: ids(r.excludedRunIds),
    downspouts,
    size: r.size ?? null,
    addedRuns: added,
    totalFt: r.totalFt ?? null,
    adjustedBy: r.adjustedBy ?? null,
  });
}

export async function gutterInputs(tx: Tx, ctx: TenantContext, id: string, now: Date = new Date()): Promise<GutterInputs | null> {
  const view = await getMeasurement(tx, ctx, id, now);
  if (view === null) return null;
  const [row] = await tx
    .select({ adjustments: measurements.gutterAdjustments, eaveFt: measurements.eaveFt, method: measurements.method })
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
  const eaveFt = row?.eaveFt ?? null;
  return {
    view,
    adjustments: storedAdjustments(row?.adjustments),
    eaveHeightM: withEave?.geometry?.eaveHeightM ?? null,
    floors: withFloors?.stories ?? null,
    reportEaveFt: row?.method === 'eagleview' && eaveFt !== null && eaveFt > 0 ? eaveFt : null,
  };
}

/**
 * Replaces a measurement's gutter adjustments (cleaned against the runs the caller worked out), stamped with who made
 * them (the member's name as the company knows it) and when; with nothing changed, no one is named. Null when the member
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
  const cleaned = cleanGutterAdjustments(runs, { ...adjustments, adjustedBy: null });
  let adjustedBy: GutterAdjustments['adjustedBy'] = null;
  if (gutterAdjustmentsChanged(cleaned)) {
    // The tenant role cannot read `users`; company_members is the view it can.
    const found =
      ctx.userId === null
        ? null
        : await tx.execute<{ name: string | null }>(sql`select cm.name from company_members cm where cm.user_id = ${ctx.userId} limit 1`);
    const name = found?.rows[0]?.name?.trim() || null;
    adjustedBy = { name: name ?? 'Someone at the company', at: now.toISOString() };
  }
  const clean = { ...cleaned, adjustedBy };
  await tx
    .update(measurements)
    .set({ gutterAdjustments: clean, updatedAt: now })
    .where(and(eq(measurements.id, id), eq(measurements.companyId, ctx.companyId)));
  return clean;
}
