import { and, eq } from 'drizzle-orm';
import {
  appointments,
  calendarConnections,
  deleteLinkByEventId,
  linkByEventId,
  markConnectionError,
  removeBusyBlocks,
  replaceBusyBlocks,
  saveCursor,
  setAppointmentStatus,
  updateAppointment,
  upsertBusyBlocks,
  withTenant,
  type CalendarConnectionRow,
  type TenantContext,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { CalendarAuthError, type ExternalEvent } from '../providers/calendar.ts';
import { accessTokenFor } from './tokens.ts';

/** Server-side words for activity text (Ruling 8); not UI copy. */
export const PROVIDER_WORD = { google: 'Google Calendar', microsoft: 'Outlook' } as const;

const DAY_MS = 86_400_000;

/**
 * Pulls one connection's changes now (C1 Task 14). Provider calls run outside any transaction; one
 * tenant transaction then applies the page and saves the cursor. Pull-originated changes never queue a push.
 * Only times and provider ids of outside events are kept: no titles, no attendees.
 */
export async function pullConnection(deps: AppDeps, ctx: TenantContext, conn: CalendarConnectionRow): Promise<{ moved: number; canceled: number; busy: number }> {
  if (conn.status !== 'connected' || conn.calendarId === null) return { moved: 0, canceled: 0, busy: 0 };
  const calendarId = conn.calendarId;
  const now = deps.clock.now();
  const window = { from: new Date(now.getTime() - DAY_MS), to: new Date(now.getTime() + 60 * DAY_MS) };

  const token = await accessTokenFor(deps, ctx, conn);
  let page;
  try {
    page = await deps.calendars[conn.provider].syncEvents(token, calendarId, conn.syncCursor, window);
  } catch (err) {
    if (err instanceof CalendarAuthError) {
      await withTenant(deps.pools, ctx, (tx) => markConnectionError(tx, ctx, conn.id, 'Reconnect your calendar.', deps.clock.now()));
    }
    // CalendarUnavailableError and anything else: retry later, never mark the connection.
    throw err;
  }

  return withTenant(deps.pools, ctx, async (tx) => {
    const [locked] = await tx
      .select({ status: calendarConnections.status, syncCursor: calendarConnections.syncCursor })
      .from(calendarConnections)
      .where(and(eq(calendarConnections.companyId, ctx.companyId), eq(calendarConnections.id, conn.id)))
      .limit(1)
      .for('update');
    // Another pull of this connection already applied this page, or the connection was disconnected / marked error meanwhile.
    if (!locked || locked.status !== 'connected' || locked.syncCursor !== conn.syncCursor) return { moved: 0, canceled: 0, busy: 0 };
    let moved = 0;
    let canceled = 0;
    const toUpsert: ExternalEvent[] = [];
    const toRemove: string[] = [];

    for (const ev of page.events) {
      const link = await linkByEventId(tx, ctx, conn.id, ev.id);
      if (link === null) {
        if (ev.busy && !ev.cancelled) toUpsert.push(ev);
        else toRemove.push(ev.id);
        continue;
      }
      if (ev.cancelled) {
        const [prior] = await tx.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, link.appointmentId));
        const r = await setAppointmentStatus(tx, ctx, link.appointmentId, 'canceled', now, {
          origin: 'pull',
          activitySummary: 'Canceled in ' + PROVIDER_WORD[conn.provider],
        });
        await deleteLinkByEventId(tx, ctx, conn.id, ev.id);
        if (r !== null && prior !== undefined && prior.status !== 'canceled') canceled++;
        continue;
      }
      // Our own write coming back: nothing to do.
      if (ev.etag !== null && ev.etag === link.etag) continue;
      const [row] = await tx.select().from(appointments).where(eq(appointments.id, link.appointmentId));
      if (!row) continue;
      const changed = ev.start.getTime() !== row.startsAt.getTime() || ev.end.getTime() !== row.endsAt.getTime();
      if (changed && ev.updatedAt.getTime() > row.updatedAt.getTime()) {
        const r = await updateAppointment(tx, ctx, link.appointmentId, { startsAt: ev.start, endsAt: ev.end }, now, {
          origin: 'pull',
          activitySummary: 'Moved in ' + PROVIDER_WORD[conn.provider],
        });
        if (r !== null) moved++;
      }
    }

    if (page.fullResync) await replaceBusyBlocks(tx, ctx, conn.id, conn.userId, toUpsert);
    else {
      if (toUpsert.length > 0) await upsertBusyBlocks(tx, ctx, conn.id, conn.userId, toUpsert);
      if (toRemove.length > 0) await removeBusyBlocks(tx, ctx, conn.id, toRemove);
    }

    await saveCursor(tx, ctx, conn.id, page.nextCursor, now);
    return { moved, canceled, busy: toUpsert.length };
  });
}
