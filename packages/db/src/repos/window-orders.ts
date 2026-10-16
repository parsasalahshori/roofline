import { and, eq } from 'drizzle-orm';
import { resolveOrderSettings, type WindowOrderLine, type WindowOrderSettings, type WindowOrderSettingsPatch, type WindowOrderStatus } from '@roofline/shared';
import { companySettings, windowOrders } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { getWindowMeasurement } from './window-measurements.ts';

/*
 * Window factory orders. Every read goes through the window measurement (and so through its property: rep visibility,
 * spec 3.2): an order on a measurement the member may not see is reported exactly like one that does not exist (null).
 */

export type WindowOrderRow = typeof windowOrders.$inferSelect;

/** The company's window order settings: its stored changes laid over the defaults in code. */
export async function getWindowOrderSettings(tx: Tx, ctx: TenantContext): Promise<WindowOrderSettings> {
  const [row] = await tx.select({ s: companySettings.windowOrderSettings }).from(companySettings).where(eq(companySettings.companyId, ctx.companyId)).limit(1);
  return resolveOrderSettings(row?.s ?? null);
}

/** Replaces the company's stored window order settings (null = back to the defaults) and answers the resolved ones. */
export async function saveWindowOrderSettings(tx: Tx, ctx: TenantContext, stored: WindowOrderSettingsPatch | null, now: Date): Promise<WindowOrderSettings> {
  await tx
    .insert(companySettings)
    .values({ companyId: ctx.companyId, windowOrderSettings: stored, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: companySettings.companyId, set: { windowOrderSettings: stored, updatedAt: now } });
  return getWindowOrderSettings(tx, ctx);
}

/** The order of a window measurement the member may see; null otherwise (or when there is none). */
export async function getWindowOrderForMeasurement(tx: Tx, ctx: TenantContext, windowMeasurementId: string): Promise<WindowOrderRow | null> {
  if ((await getWindowMeasurement(tx, ctx, windowMeasurementId)) === null) return null;
  const [row] = await tx
    .select()
    .from(windowOrders)
    .where(and(eq(windowOrders.companyId, ctx.companyId), eq(windowOrders.windowMeasurementId, windowMeasurementId)))
    .limit(1);
  return row ?? null;
}

/** One order the member may see (through its measurement); null otherwise. */
export async function getWindowOrder(tx: Tx, ctx: TenantContext, id: string): Promise<WindowOrderRow | null> {
  const [row] = await tx.select().from(windowOrders).where(and(eq(windowOrders.companyId, ctx.companyId), eq(windowOrders.id, id))).limit(1);
  if (row === undefined) return null;
  return (await getWindowMeasurement(tx, ctx, row.windowMeasurementId)) === null ? null : row;
}

/**
 * A new draft order for a measurement the member may see; null when they may not. The caller has checked there is none
 * (one per measurement: a second insert fails on window_orders_company_measurement_uniq).
 */
export async function createWindowOrder(
  tx: Tx,
  ctx: TenantContext,
  o: { windowMeasurementId: string; lines: WindowOrderLine[]; settings: WindowOrderSettings },
  now: Date,
): Promise<WindowOrderRow | null> {
  if ((await getWindowMeasurement(tx, ctx, o.windowMeasurementId)) === null) return null;
  const [row] = await tx
    .insert(windowOrders)
    .values({
      companyId: ctx.companyId,
      windowMeasurementId: o.windowMeasurementId,
      status: 'draft',
      lines: o.lines,
      settings: o.settings,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

export type WindowOrderChange = Partial<{
  status: WindowOrderStatus;
  lines: WindowOrderLine[];
  settings: WindowOrderSettings;
  poNumber: string;
  readyAt: Date | null;
  readyByUserId: string | null;
  sentAt: Date | null;
  sentByUserId: string | null;
}>;

/**
 * Changes an order the member may see, only while it is still in `expected` status (two people marking it ready at once:
 * the second finds it changed). Null when not visible; 'changed' when its status is no longer `expected`.
 */
export async function updateWindowOrder(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  expected: WindowOrderStatus,
  change: WindowOrderChange,
  now: Date,
): Promise<WindowOrderRow | 'changed' | null> {
  const visible = await getWindowOrder(tx, ctx, id);
  if (visible === null) return null;
  const [row] = await tx
    .update(windowOrders)
    .set({ ...change, updatedAt: now })
    .where(and(eq(windowOrders.companyId, ctx.companyId), eq(windowOrders.id, id), eq(windowOrders.status, expected)))
    .returning();
  return row ?? 'changed';
}
