import { and, eq, max } from 'drizzle-orm';
import {
  companyTerms,
  customers,
  getMeasurement,
  getMeasurementBasics,
  properties,
  stormHits,
  withTenant,
  type TenantContext,
} from '@roofline/db';
import type { Calculation, FinancingTerms, QuoteLine, Scope, Tier } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { can } from '../permissions.ts';
import { priceOptions } from './build.ts';

/** One tier as "Make proposal" would price it now: the same templates, price book and terms (priceOptions). */
export type PreviewOption = {
  tier: Tier;
  name: string;
  highlights: string[];
  material: Scope['material'];
  wastePercent: number;
  enabled: boolean;
  calculation: Calculation;
  addOnLines: QuoteLine[];
  totalCents: number;
  monthlyEstimateCents: number | null;
};

/**
 * GET /api/measurements/:id/preview: what the Measure screen shows beside a measured roof before any proposal exists.
 * The home (address, town, its customer, the largest hail stored for it) for anyone who may see the measurement; the
 * three priced options and the financing terms only for those who see money (`view_money_totals`), else null. A roof
 * the pricing engine cannot price (no outline yet) answers null options rather than an error.
 */
export type MeasurementPreview = {
  addressLine: string;
  city: string;
  state: string;
  customerName: string | null;
  hailIn: number | null;
  options: PreviewOption[] | null;
  financing: FinancingTerms | null;
};

export async function measurementPreview(deps: AppDeps, ctx: TenantContext, id: string): Promise<MeasurementPreview> {
  return withTenant(deps.pools, ctx, async (tx) => {
    // getMeasurement applies rep visibility; a measurement the caller may not see is a 404
    const view = await getMeasurement(tx, ctx, id);
    if (!view) throw new AppError(404, MESSAGES.notFound);
    const [home] = await tx
      .select({ addressLine: properties.addressLine, city: properties.city, state: properties.state, customerName: customers.displayName })
      .from(properties)
      .leftJoin(customers, and(eq(customers.id, properties.customerId), eq(customers.companyId, properties.companyId)))
      .where(and(eq(properties.id, view.propertyId), eq(properties.companyId, ctx.companyId)))
      .limit(1);
    if (!home) throw new AppError(404, MESSAGES.notFound);
    const [hail] = await tx
      .select({ hailIn: max(stormHits.hailIn) })
      .from(stormHits)
      .where(and(eq(stormHits.propertyId, view.propertyId), eq(stormHits.companyId, ctx.companyId)));

    let options: PreviewOption[] | null = null;
    let financing: FinancingTerms | null = null;
    const basics = can(ctx, 'view_money_totals') ? await getMeasurementBasics(tx, ctx, id) : null;
    if (basics) {
      try {
        const priced = await priceOptions(tx, ctx, basics);
        options = priced.map((o) => ({
          tier: o.tier,
          name: o.name,
          highlights: o.highlights,
          material: o.scope.material,
          wastePercent: o.scope.wastePercent,
          enabled: o.enabled,
          calculation: o.calculation,
          addOnLines: o.addOnLines,
          totalCents: o.totalCents,
          monthlyEstimateCents: o.monthlyEstimateCents,
        }));
        financing = (await companyTerms(tx, ctx, basics.kind)).financing;
      } catch (err) {
        // No roof to price yet (or one too large): the screen shows the roof without prices
        if (!(err instanceof AppError) || err.status !== 400) throw err;
      }
    }
    return {
      addressLine: home.addressLine,
      city: home.city,
      state: home.state,
      customerName: home.customerName ?? null,
      hailIn: hail?.hailIn ?? null,
      options,
      financing,
    };
  });
}
