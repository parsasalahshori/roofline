import { createMeasurement, getEstimatorSettings, getMeasurement, getProperty, withTenant, type TenantContext } from '@roofline/db';
import type { MeasurementView } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import type { AerialRoof } from '../providers/aerial.ts';

const OFF_MESSAGE = 'Aerial measure is turned off for this company.';
export const AERIAL_FALLBACK = 'Aerial measure is taking longer than usual. Try again in a minute.';

/** Poll timing; tests set `intervalMs` to 0 so nothing waits. */
export const aerialTiming = {
  intervalMs: 3000,
  budgetMs: 60_000,
  sleep: (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms)),
};

/** Asks the provider until the roofs are ready: one check right away, then every interval, within the budget. */
async function waitForRoofs(deps: AppDeps, requestId: string): Promise<AerialRoof[]> {
  let waited = 0;
  for (;;) {
    let answer;
    try {
      answer = await deps.aerial.result(requestId);
    } catch {
      throw new AppError(503, AERIAL_FALLBACK);
    }
    if (answer.status === 'complete') return answer.roofs;
    if (waited >= aerialTiming.budgetMs) throw new AppError(503, AERIAL_FALLBACK);
    await aerialTiming.sleep(aerialTiming.intervalMs);
    // An interval of 0 (tests) still advances: count at least one millisecond per round.
    waited += Math.max(aerialTiming.intervalMs, 1);
  }
}

/**
 * Measures the roof of a measurement's home from aerial imagery and saves the answer as a NEW
 * measurement (method 'aerial'); the source measurement is never changed. Provider calls run
 * outside any transaction, and provider text is never passed on.
 */
export async function aerialMeasure(deps: AppDeps, ctx: TenantContext, measurementId: string): Promise<MeasurementView> {
  const loaded = await withTenant(deps.pools, ctx, async (tx) => {
    const source = await getMeasurement(tx, ctx, measurementId);
    if (source === null) return null;
    const property = await getProperty(tx, ctx, source.propertyId);
    const settings = await getEstimatorSettings(tx, ctx, deps.aerial.configured);
    return { source, property, settings };
  });
  if (loaded === null || loaded.property === null) throw new AppError(404, MESSAGES.notFound);
  const { source, property, settings } = loaded;
  if (!settings.aerialMeasure || !deps.aerial.configured) throw new AppError(403, OFF_MESSAGE);

  const address = `${property.addressLine}, ${property.city}, ${property.state} ${property.zip}`;
  let requestId: string;
  try {
    ({ requestId } = await deps.aerial.start(address));
  } catch {
    throw new AppError(503, AERIAL_FALLBACK);
  }
  const roofs = await waitForRoofs(deps, requestId);
  const roof = roofs.find((r) => r.structureIndex === 0) ?? roofs[0];
  if (roof === undefined) throw new AppError(503, AERIAL_FALLBACK);

  return withTenant(deps.pools, ctx, (tx) =>
    createMeasurement(
      tx,
      ctx,
      {
        propertyId: source.propertyId,
        jobId: source.jobId,
        kind: 'estimate',
        method: 'aerial',
        outline: source.outline,
        structures: source.structures,
        estimate: { ...source.estimate, surfaceSqFt: roof.areaSqFt, pitchX12: roof.pitchX12 },
        overhangFt: source.overhangFt,
        center: source.center,
      },
      deps.clock.now(),
    ),
  );
}
