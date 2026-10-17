import { eq } from 'drizzle-orm';
import { resolveCatalog, type WindowCatalog } from '@roofline/shared';
import { companySettings } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * The company's window catalog (company_settings.window_catalog): the style choices, tier names and prices, adders,
 * included list, trust facts, offer and financing line that the homeowner pages and the app show. Null in the row means
 * the defaults in code.
 */

/** The company's catalog: what it stored laid over the defaults. */
export async function getWindowCatalog(tx: Tx, ctx: TenantContext): Promise<WindowCatalog> {
  const [row] = await tx.select({ c: companySettings.windowCatalog }).from(companySettings).where(eq(companySettings.companyId, ctx.companyId)).limit(1);
  return resolveCatalog(row?.c ?? null);
}

/** Replaces the stored catalog (the route has checked every field; null = back to the defaults) and answers the resolved one. */
export async function saveWindowCatalog(tx: Tx, ctx: TenantContext, stored: WindowCatalog | null, now: Date): Promise<WindowCatalog> {
  await tx
    .insert(companySettings)
    .values({ companyId: ctx.companyId, windowCatalog: stored, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: companySettings.companyId, set: { windowCatalog: stored, updatedAt: now } });
  return getWindowCatalog(tx, ctx);
}
