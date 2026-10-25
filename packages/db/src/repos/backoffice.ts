import { and, asc, desc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import {
  ORDER_STAGES,
  resolveBackofficeSettings,
  resolveProductCatalog,
  type BackofficeSettings,
  type OrderEvent,
  type OrderStage,
  type ProductCatalog,
  type Tier,
  type WindowDesign,
} from '@roofline/shared';
import { backofficeOrderEvents, backofficeOrders, backofficeQuotes, companySettings, customers, jobs, properties, windowOrders, windowMeasurements, type StoredHouseVisual } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { memberNames } from './appointments.ts';
import { jobScope } from './scope.ts';

/*
 * The WinChoice back office: the company's switch, price book and settings (company_settings), its quotes, and its
 * orders with their timeline. Everything runs inside the caller's withTenant. A rep sees only the quotes and orders of
 * jobs they may see (jobScope); the owner and office see all of the company's.
 */

/* ---------------------------------------------------------------------------------------------------------------- */
/* Switch, catalog and settings                                                                                     */
/* ---------------------------------------------------------------------------------------------------------------- */

/** Whether the company has the back office on (false when it has no settings row yet). */
export async function getBackofficeEnabled(tx: Tx, ctx: TenantContext): Promise<boolean> {
  const [row] = await tx.select({ on: companySettings.backofficeEnabled }).from(companySettings).where(eq(companySettings.companyId, ctx.companyId)).limit(1);
  return row?.on === true;
}

/** Turns the back office on or off for the company (the owner's settings, or the demo seed). */
export async function setBackofficeEnabled(tx: Tx, ctx: TenantContext, on: boolean, now: Date): Promise<void> {
  await tx
    .insert(companySettings)
    .values({ companyId: ctx.companyId, backofficeEnabled: on, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: companySettings.companyId, set: { backofficeEnabled: on, updatedAt: now } });
}

/** The company's price book: what it saved, else the defaults in code (version 0). */
export async function getProductCatalog(tx: Tx, ctx: TenantContext): Promise<ProductCatalog> {
  const [row] = await tx.select({ c: companySettings.productCatalog }).from(companySettings).where(eq(companySettings.companyId, ctx.companyId)).limit(1);
  return resolveProductCatalog(row?.c ?? null);
}

/** Saves the price book (the route has checked every field) with its version one higher than the one it replaces. */
export async function saveProductCatalog(tx: Tx, ctx: TenantContext, next: Omit<ProductCatalog, 'version'>, now: Date): Promise<ProductCatalog> {
  const before = await getProductCatalog(tx, ctx);
  const stored: ProductCatalog = { ...next, version: before.version + 1 };
  await tx
    .insert(companySettings)
    .values({ companyId: ctx.companyId, productCatalog: stored, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: companySettings.companyId, set: { productCatalog: stored, updatedAt: now } });
  return stored;
}

/** The company's back office settings laid over the defaults. */
export async function getBackofficeSettings(tx: Tx, ctx: TenantContext): Promise<BackofficeSettings> {
  const [row] = await tx.select({ s: companySettings.backoffice }).from(companySettings).where(eq(companySettings.companyId, ctx.companyId)).limit(1);
  return resolveBackofficeSettings(row?.s ?? null);
}

export async function saveBackofficeSettings(tx: Tx, ctx: TenantContext, next: BackofficeSettings, now: Date): Promise<BackofficeSettings> {
  await tx
    .insert(companySettings)
    .values({ companyId: ctx.companyId, backoffice: next, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: companySettings.companyId, set: { backoffice: next, updatedAt: now } });
  return getBackofficeSettings(tx, ctx);
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Quotes                                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

export type BackofficeQuoteRow = typeof backofficeQuotes.$inferSelect;

/** A quote with who it is for and where (the job's customer and address). */
export type BackofficeQuoteWithJob = {
  quote: BackofficeQuoteRow;
  customerId: string;
  customerName: string;
  address: string;
  propertyId: string;
  orderId: string | null;
};

const addressOf = (p: { addressLine: string; city: string; state: string; zip: string }): string => `${p.addressLine}, ${p.city}, ${p.state} ${p.zip}`;

const quoteSelect = {
  quote: backofficeQuotes,
  customerId: customers.id,
  customerName: customers.displayName,
  propertyId: properties.id,
  line: properties.addressLine,
  city: properties.city,
  state: properties.state,
  zip: properties.zip,
  orderId: backofficeOrders.id,
};

type QuoteJoined = { quote: BackofficeQuoteRow; customerId: string; customerName: string; propertyId: string; line: string; city: string; state: string; zip: string; orderId: string | null };

function shapeQuote(r: QuoteJoined): BackofficeQuoteWithJob {
  return { quote: r.quote, customerId: r.customerId, customerName: r.customerName, propertyId: r.propertyId, address: addressOf({ addressLine: r.line, city: r.city, state: r.state, zip: r.zip }), orderId: r.orderId };
}

function quotesQuery(tx: Tx, where: SQL | undefined) {
  return tx
    .select(quoteSelect)
    .from(backofficeQuotes)
    .innerJoin(jobs, and(eq(jobs.companyId, backofficeQuotes.companyId), eq(jobs.id, backofficeQuotes.jobId)))
    .innerJoin(customers, and(eq(customers.companyId, jobs.companyId), eq(customers.id, jobs.customerId)))
    .innerJoin(properties, and(eq(properties.companyId, jobs.companyId), eq(properties.id, jobs.propertyId)))
    .leftJoin(backofficeOrders, and(eq(backofficeOrders.companyId, backofficeQuotes.companyId), eq(backofficeOrders.quoteId, backofficeQuotes.id)))
    .where(where);
}

/** One quote the member may see, or null (missing, another company's, or a rep's job they cannot see). */
export async function getBackofficeQuote(tx: Tx, ctx: TenantContext, id: string): Promise<BackofficeQuoteWithJob | null> {
  const [row] = await quotesQuery(tx, and(eq(backofficeQuotes.id, id), eq(backofficeQuotes.companyId, ctx.companyId), jobScope(ctx))).limit(1);
  return row ? shapeQuote(row) : null;
}

/** The quotes the member may see, newest change first. */
export async function listBackofficeQuotes(tx: Tx, ctx: TenantContext, options: { jobId?: string; limit?: number } = {}): Promise<BackofficeQuoteWithJob[]> {
  const where = and(eq(backofficeQuotes.companyId, ctx.companyId), jobScope(ctx), options.jobId !== undefined ? eq(backofficeQuotes.jobId, options.jobId) : undefined);
  const rows = await quotesQuery(tx, where).orderBy(desc(backofficeQuotes.updatedAt), desc(backofficeQuotes.id)).limit(Math.min(options.limit ?? 200, 500));
  return rows.map(shapeQuote);
}

export type NewBackofficeQuote = { jobId: string; tier: Tier; designs: WindowDesign[]; accessories: { accessoryId: string; quantity: number }[]; catalogVersion: number };

/** A new draft for a job the member may see; null when they may not (or it does not exist). */
export async function createBackofficeQuote(tx: Tx, ctx: TenantContext, input: NewBackofficeQuote, now: Date): Promise<BackofficeQuoteRow | null> {
  const [job] = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, input.jobId), eq(jobs.companyId, ctx.companyId), jobScope(ctx))).limit(1);
  if (!job) return null;
  const [row] = await tx
    .insert(backofficeQuotes)
    .values({
      companyId: ctx.companyId,
      jobId: input.jobId,
      tier: input.tier,
      designs: input.designs,
      accessories: input.accessories,
      catalogVersion: input.catalogVersion,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

export type BackofficeQuoteChange = Partial<Pick<BackofficeQuoteRow, 'status' | 'tier' | 'designs' | 'accessories' | 'discountPercent' | 'catalogVersion'>>;

/** Changes a quote that is not accepted yet. 'locked': it was accepted (its order exists). Null: not found. */
export async function updateBackofficeQuote(tx: Tx, ctx: TenantContext, id: string, change: BackofficeQuoteChange, now: Date): Promise<BackofficeQuoteRow | 'locked' | null> {
  const found = await getBackofficeQuote(tx, ctx, id);
  if (!found) return null;
  const [row] = await tx
    .update(backofficeQuotes)
    .set({ ...change, updatedAt: now })
    .where(and(eq(backofficeQuotes.id, id), eq(backofficeQuotes.companyId, ctx.companyId), ne(backofficeQuotes.status, 'accepted')))
    .returning();
  return row ?? 'locked';
}

/** Saves the house visual of a quote the member may see. A visual may change after acceptance (it is a picture, not a price). */
export async function setBackofficeQuoteVisual(tx: Tx, ctx: TenantContext, id: string, visual: StoredHouseVisual, now: Date): Promise<boolean> {
  if (!(await getBackofficeQuote(tx, ctx, id))) return false;
  await tx.update(backofficeQuotes).set({ houseVisual: visual, updatedAt: now }).where(and(eq(backofficeQuotes.id, id), eq(backofficeQuotes.companyId, ctx.companyId)));
  return true;
}

/** The window order sheet (window_orders) of a measurement, when it has one: the id the back office order links to. */
export async function findWindowOrderIdForMeasurements(tx: Tx, ctx: TenantContext, measurementIds: string[]): Promise<string | null> {
  if (measurementIds.length === 0) return null;
  const rows = await tx
    .select({ id: windowOrders.id })
    .from(windowOrders)
    .where(and(eq(windowOrders.companyId, ctx.companyId), inArray(windowOrders.windowMeasurementId, measurementIds)))
    .orderBy(desc(windowOrders.updatedAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** The ids of the uploads (photos) on the window measurements of an address, for choosing a house photo that is already uploaded. */
export async function windowUploadsForProperty(tx: Tx, ctx: TenantContext, propertyId: string): Promise<{ id: string; key: string; kind: 'jpeg' | 'png'; widthPx: number; heightPx: number; bytes: number }[]> {
  const rows = await tx
    .select({ uploads: windowMeasurements.uploads })
    .from(windowMeasurements)
    .where(and(eq(windowMeasurements.companyId, ctx.companyId), eq(windowMeasurements.propertyId, propertyId)));
  return rows.flatMap((r) => r.uploads.map((u) => ({ id: u.id, key: u.key, kind: u.kind, widthPx: u.widthPx, heightPx: u.heightPx, bytes: u.bytes })));
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Orders                                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

export type BackofficeOrderRow = typeof backofficeOrders.$inferSelect;
export type BackofficeOrderEventRow = typeof backofficeOrderEvents.$inferSelect;
export type BackofficeOrderWithJob = { order: BackofficeOrderRow; customerId: string; customerName: string; address: string };

function ordersQuery(tx: Tx, where: SQL | undefined) {
  return tx
    .select({ order: backofficeOrders, customerId: customers.id, customerName: customers.displayName, line: properties.addressLine, city: properties.city, state: properties.state, zip: properties.zip })
    .from(backofficeOrders)
    .innerJoin(jobs, and(eq(jobs.companyId, backofficeOrders.companyId), eq(jobs.id, backofficeOrders.jobId)))
    .innerJoin(customers, and(eq(customers.companyId, jobs.companyId), eq(customers.id, jobs.customerId)))
    .innerJoin(properties, and(eq(properties.companyId, jobs.companyId), eq(properties.id, jobs.propertyId)))
    .where(where);
}

const shapeOrder = (r: { order: BackofficeOrderRow; customerId: string; customerName: string; line: string; city: string; state: string; zip: string }): BackofficeOrderWithJob => ({
  order: r.order,
  customerId: r.customerId,
  customerName: r.customerName,
  address: addressOf({ addressLine: r.line, city: r.city, state: r.state, zip: r.zip }),
});

/** The orders the member may see, oldest in their stage first (the ones waiting longest on top). */
export async function listBackofficeOrders(tx: Tx, ctx: TenantContext, options: { stage?: OrderStage } = {}): Promise<BackofficeOrderWithJob[]> {
  const where = and(eq(backofficeOrders.companyId, ctx.companyId), jobScope(ctx), options.stage !== undefined ? eq(backofficeOrders.stage, options.stage) : undefined);
  return (await ordersQuery(tx, where).orderBy(asc(backofficeOrders.stageChangedAt), asc(backofficeOrders.id))).map(shapeOrder);
}

export async function getBackofficeOrder(tx: Tx, ctx: TenantContext, id: string): Promise<BackofficeOrderWithJob | null> {
  const [row] = await ordersQuery(tx, and(eq(backofficeOrders.id, id), eq(backofficeOrders.companyId, ctx.companyId), jobScope(ctx))).limit(1);
  return row ? shapeOrder(row) : null;
}

/** The orders' events, oldest first, keyed by order id, with the name of who made each move. */
export async function listBackofficeOrderEvents(tx: Tx, ctx: TenantContext, orderIds: string[]): Promise<Map<string, OrderEvent[]>> {
  const out = new Map<string, OrderEvent[]>(orderIds.map((id) => [id, []]));
  if (orderIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(backofficeOrderEvents)
    .where(and(eq(backofficeOrderEvents.companyId, ctx.companyId), inArray(backofficeOrderEvents.orderId, orderIds)))
    .orderBy(asc(backofficeOrderEvents.seq));
  const names = await memberNames(tx);
  for (const e of rows) {
    out.get(e.orderId)?.push({
      id: e.id,
      stage: e.stage,
      at: e.createdAt.toISOString(),
      byUserName: e.byUserId === null ? null : (names.get(e.byUserId) ?? null),
      note: e.note,
      plannedFor: e.plannedFor,
      notified: e.notified,
    });
  }
  return out;
}

/**
 * Accepts a quote: marks it accepted and makes its order at 'sold' with the first event. Null when the quote was already
 * accepted (another request got there first); the caller has checked the quote may be accepted and priced it.
 */
export async function acceptBackofficeQuote(
  tx: Tx,
  ctx: TenantContext,
  quote: BackofficeQuoteRow,
  frozen: { units: number; totalCents: number; windowOrderId: string | null; catalog: ProductCatalog },
  now: Date,
): Promise<{ order: BackofficeOrderRow; event: BackofficeOrderEventRow } | null> {
  const [accepted] = await tx
    .update(backofficeQuotes)
    .set({ status: 'accepted', catalogVersion: frozen.catalog.version, catalogSnapshot: frozen.catalog, updatedAt: now })
    .where(and(eq(backofficeQuotes.id, quote.id), eq(backofficeQuotes.companyId, ctx.companyId), ne(backofficeQuotes.status, 'accepted')))
    .returning({ id: backofficeQuotes.id });
  if (!accepted) return null;
  const [order] = await tx
    .insert(backofficeOrders)
    .values({ companyId: ctx.companyId, jobId: quote.jobId, quoteId: quote.id, stage: 'sold', stageChangedAt: now, units: frozen.units, totalCents: frozen.totalCents, windowOrderId: frozen.windowOrderId, createdAt: now, updatedAt: now })
    .returning();
  const [event] = await tx
    .insert(backofficeOrderEvents)
    .values({ companyId: ctx.companyId, orderId: order!.id, stage: 'sold', byUserId: ctx.userId, note: 'Quote accepted', createdAt: now })
    .returning();
  return { order: order!, event: event! };
}

/** Moves an order to a stage and writes the event. Null when the order is not found or not visible. */
export async function moveBackofficeOrder(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  move: { stage: OrderStage; note: string; plannedFor: string | null },
  now: Date,
): Promise<{ before: OrderStage; order: BackofficeOrderRow; event: BackofficeOrderEventRow } | null> {
  const found = await getBackofficeOrder(tx, ctx, id);
  if (!found) return null;
  // Lock the row so two moves at once are written one after the other, each from the stage it saw.
  const [locked] = await tx.select().from(backofficeOrders).where(and(eq(backofficeOrders.id, id), eq(backofficeOrders.companyId, ctx.companyId))).limit(1).for('update');
  const before = locked!.stage;
  const stageChanged = before !== move.stage;
  const [order] = await tx
    .update(backofficeOrders)
    .set({ stage: move.stage, ...(stageChanged ? { stageChangedAt: now } : {}), updatedAt: now })
    .where(and(eq(backofficeOrders.id, id), eq(backofficeOrders.companyId, ctx.companyId)))
    .returning();
  const [event] = await tx
    .insert(backofficeOrderEvents)
    .values({ companyId: ctx.companyId, orderId: id, stage: move.stage, byUserId: ctx.userId, note: move.note, plannedFor: move.plannedFor, createdAt: now })
    .returning();
  return { before, order: order!, event: event! };
}

/** Writes how the customer was told onto the event (the one column an event may change). */
export async function setOrderEventNotified(tx: Tx, ctx: TenantContext, eventId: string, notified: NonNullable<OrderEvent['notified']>): Promise<void> {
  await tx.update(backofficeOrderEvents).set({ notified }).where(and(eq(backofficeOrderEvents.id, eventId), eq(backofficeOrderEvents.companyId, ctx.companyId)));
}

/** Everything the notice for a move needs about the customer: first name and contact, and the company's name. */
export async function orderCustomerFacts(tx: Tx, ctx: TenantContext, customerId: string): Promise<{ firstName: string; displayName: string; emails: string[]; doNotContact: boolean } | null> {
  const [c] = await tx
    .select({ firstName: customers.firstName, displayName: customers.displayName, emails: customers.emails, doNotContact: customers.doNotContact })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)))
    .limit(1);
  if (!c) return null;
  const first = c.firstName?.trim() || c.displayName.trim().split(/\s+/)[0] || c.displayName;
  return { firstName: first, displayName: c.displayName, emails: Array.isArray(c.emails) ? c.emails : [], doNotContact: c.doNotContact };
}

/** The newest order of a job, with the times of the moves the homeowner app shows dates for. Null when the job has none. */
export async function jobOrderProgress(tx: Tx, ctx: TenantContext, jobId: string): Promise<{ stage: OrderStage; measuredAt: Date | null; orderedAt: Date | null; installedAt: Date | null } | null> {
  const [order] = await tx
    .select({ id: backofficeOrders.id, stage: backofficeOrders.stage })
    .from(backofficeOrders)
    .where(and(eq(backofficeOrders.companyId, ctx.companyId), eq(backofficeOrders.jobId, jobId)))
    .orderBy(desc(backofficeOrders.createdAt))
    .limit(1);
  if (!order) return null;
  const events = await tx
    .select({ stage: backofficeOrderEvents.stage, at: backofficeOrderEvents.createdAt })
    .from(backofficeOrderEvents)
    .where(and(eq(backofficeOrderEvents.companyId, ctx.companyId), eq(backofficeOrderEvents.orderId, order.id)));
  // The first time the order reached a stage or any later one (a move straight to in-production still counts as ordered).
  const first = (from: OrderStage): Date | null => {
    const times = events.filter((e) => ORDER_STAGES.indexOf(e.stage) >= ORDER_STAGES.indexOf(from)).map((e) => e.at.getTime());
    return times.length === 0 ? null : new Date(Math.min(...times));
  };
  return { stage: order.stage, measuredAt: first('measured'), orderedAt: first('ordered'), installedAt: first('installed') };
}
