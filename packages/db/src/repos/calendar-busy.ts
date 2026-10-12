import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { calendarBusyBlocks, calendarConnections, calendarEventLinks } from '../schema/tenant.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/** The only fields of an outside event this repo keeps: times and the provider's id. Structurally compatible with the api's `ExternalEvent`. */
export type ExternalEventLike = { id: string; start: Date; end: Date; allDay: boolean };

/** Stores or updates busy time for outside events. Times only: no title, attendee or place is ever kept. */
export async function upsertBusyBlocks(
  tx: Tx,
  ctx: TenantContext,
  connectionId: string,
  userId: string,
  events: readonly ExternalEventLike[],
): Promise<void> {
  const rows = events
    .filter((e) => e.end.getTime() > e.start.getTime())
    .map((e) => ({
      companyId: ctx.companyId,
      connectionId,
      userId,
      providerEventId: e.id,
      startsAt: e.start,
      endsAt: e.end,
      allDay: e.allDay,
    }));
  if (rows.length === 0) return;
  // One statement cannot touch the same conflict key twice: keep the last copy of each event id.
  const byId = new Map(rows.map((r) => [r.providerEventId, r]));
  await tx
    .insert(calendarBusyBlocks)
    .values([...byId.values()])
    .onConflictDoUpdate({
      target: [calendarBusyBlocks.connectionId, calendarBusyBlocks.providerEventId],
      set: {
        startsAt: sql`excluded.starts_at`,
        endsAt: sql`excluded.ends_at`,
        allDay: sql`excluded.all_day`,
        updatedAt: sql`now()`,
      },
    });
}

export async function removeBusyBlocks(
  tx: Tx,
  ctx: TenantContext,
  connectionId: string,
  providerEventIds: readonly string[],
): Promise<void> {
  if (providerEventIds.length === 0) return;
  await tx
    .delete(calendarBusyBlocks)
    .where(
      and(
        eq(calendarBusyBlocks.companyId, ctx.companyId),
        eq(calendarBusyBlocks.connectionId, connectionId),
        inArray(calendarBusyBlocks.providerEventId, [...providerEventIds]),
      ),
    );
}

/** Drops the connection's busy blocks that ended before `cutoff` (past the sync window, so they can no longer matter). */
export async function pruneBusyBlocksEndingBefore(tx: Tx, ctx: TenantContext, connectionId: string, cutoff: Date): Promise<void> {
  await tx
    .delete(calendarBusyBlocks)
    .where(
      and(
        eq(calendarBusyBlocks.companyId, ctx.companyId),
        eq(calendarBusyBlocks.connectionId, connectionId),
        lt(calendarBusyBlocks.endsAt, cutoff),
      ),
    );
}

/** Drops every busy block of the connection, then stores the given events (a full re-sync). */
export async function replaceBusyBlocks(
  tx: Tx,
  ctx: TenantContext,
  connectionId: string,
  userId: string,
  events: readonly ExternalEventLike[],
): Promise<void> {
  await tx
    .delete(calendarBusyBlocks)
    .where(and(eq(calendarBusyBlocks.companyId, ctx.companyId), eq(calendarBusyBlocks.connectionId, connectionId)));
  await upsertBusyBlocks(tx, ctx, connectionId, userId, events);
}

export async function linkByEventId(
  tx: Tx,
  ctx: TenantContext,
  connectionId: string,
  providerEventId: string,
): Promise<{ appointmentId: string; etag: string | null } | null> {
  const [row] = await tx
    .select({ appointmentId: calendarEventLinks.appointmentId, etag: calendarEventLinks.etag })
    .from(calendarEventLinks)
    .where(
      and(
        eq(calendarEventLinks.companyId, ctx.companyId),
        eq(calendarEventLinks.connectionId, connectionId),
        eq(calendarEventLinks.providerEventId, providerEventId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function deleteLinkByEventId(
  tx: Tx,
  ctx: TenantContext,
  connectionId: string,
  providerEventId: string,
): Promise<void> {
  await tx
    .delete(calendarEventLinks)
    .where(
      and(
        eq(calendarEventLinks.companyId, ctx.companyId),
        eq(calendarEventLinks.connectionId, connectionId),
        eq(calendarEventLinks.providerEventId, providerEventId),
      ),
    );
}

export async function saveCursor(
  tx: Tx,
  ctx: TenantContext,
  connectionId: string,
  cursor: string,
  now: Date,
): Promise<void> {
  await tx
    .update(calendarConnections)
    .set({ syncCursor: cursor, lastSyncedAt: now, updatedAt: now })
    .where(and(eq(calendarConnections.companyId, ctx.companyId), eq(calendarConnections.id, connectionId)));
}
