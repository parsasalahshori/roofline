import { and, eq } from 'drizzle-orm';
import { calendarBusyBlocks, calendarEventLinks } from '../schema/tenant.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Data access for the link between an appointment and its event in a person's calendar (spec
 * Decisions 19-22). One link per appointment. Every query names the context's company.
 */

/** The link of one appointment in the context's company, or null. */
export async function getEventLink(tx: Tx, ctx: TenantContext, appointmentId: string): Promise<(typeof calendarEventLinks.$inferSelect) | null> {
  const [row] = await tx
    .select()
    .from(calendarEventLinks)
    .where(and(eq(calendarEventLinks.companyId, ctx.companyId), eq(calendarEventLinks.appointmentId, appointmentId)))
    .limit(1);
  return row ?? null;
}

/** Records a successful push: creates the link or updates it in place, and clears any earlier push error. Safe to repeat. */
export async function saveEventLink(
  tx: Tx,
  ctx: TenantContext,
  l: { appointmentId: string; connectionId: string; providerEventId: string; etag: string | null },
  now: Date,
): Promise<void> {
  await tx
    .insert(calendarEventLinks)
    .values({ companyId: ctx.companyId, ...l, lastPushedAt: now, pushErrorPlain: null })
    .onConflictDoUpdate({
      target: calendarEventLinks.appointmentId,
      set: { connectionId: l.connectionId, providerEventId: l.providerEventId, etag: l.etag, lastPushedAt: now, pushErrorPlain: null, updatedAt: now },
    });
}

/** Sets (or clears, with null) the plain-language push error on an existing link. Does nothing when there is no link yet. */
export async function setPushError(tx: Tx, ctx: TenantContext, appointmentId: string, errorPlain: string | null): Promise<void> {
  await tx
    .update(calendarEventLinks)
    .set({ pushErrorPlain: errorPlain })
    .where(and(eq(calendarEventLinks.companyId, ctx.companyId), eq(calendarEventLinks.appointmentId, appointmentId)));
}

/** Drops the link of one appointment. */
export async function deleteEventLink(tx: Tx, ctx: TenantContext, appointmentId: string): Promise<void> {
  await tx
    .delete(calendarEventLinks)
    .where(and(eq(calendarEventLinks.companyId, ctx.companyId), eq(calendarEventLinks.appointmentId, appointmentId)));
}

/**
 * Drops the busy block (if any) the pull stored for an event the app itself created. The pull can see a new
 * event before its link is saved and take it for an outside busy event; the push calls this in the same
 * transaction as `saveEventLink`, so the appointment's own event never blocks its assignee's availability.
 */
export async function deleteBusyBlockForEvent(tx: Tx, ctx: TenantContext, connectionId: string, providerEventId: string): Promise<void> {
  await tx
    .delete(calendarBusyBlocks)
    .where(
      and(
        eq(calendarBusyBlocks.companyId, ctx.companyId),
        eq(calendarBusyBlocks.connectionId, connectionId),
        eq(calendarBusyBlocks.providerEventId, providerEventId),
      ),
    );
}
