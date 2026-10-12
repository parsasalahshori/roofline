import { and, eq } from 'drizzle-orm';
import {
  appointments,
  calendarConnections,
  companies,
  deleteLinkByEventId,
  linkByEventId,
  markConnectionError,
  pruneBusyBlocksEndingBefore,
  removeBusyBlocks,
  replaceBusyBlocks,
  saveCursor,
  setAppointmentStatus,
  updateAppointment,
  upsertBusyBlocks,
  withTenant,
  zoneDayAfter,
  zoneDayStart,
  type CalendarConnectionRow,
  type TenantContext,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { CalendarAuthError, type ExternalEvent } from '../providers/calendar.ts';
import { accessTokenFor, forgetCachedToken } from './tokens.ts';

/** Server-side words for activity text (Ruling 8); not UI copy. */
export const PROVIDER_WORD = { google: 'Google Calendar', microsoft: 'Outlook' } as const;

const DAY_MS = 86_400_000;

/**
 * The stored sync cursor is '<ISO baseline>|<provider cursor>': the baseline is when the last full sync ran.
 * Providers only follow their own cursor (Graph freezes its window in the deltaLink, Google ignores timeMin/timeMax
 * with a syncToken), so we re-baseline with a full sync once a day. A cursor without the prefix counts as stale.
 */
function decodeCursor(stored: string | null): { baseline: Date; cursor: string } | null {
  if (stored === null) return null;
  const bar = stored.indexOf('|');
  if (bar < 0) return null;
  const baseline = new Date(stored.slice(0, bar));
  if (Number.isNaN(baseline.getTime())) return null;
  return { baseline, cursor: stored.slice(bar + 1) };
}

function encodeCursor(baseline: Date, cursor: string): string {
  return baseline.toISOString() + '|' + cursor;
}

/** Adapters return all-day events as UTC midnights; availability reads them as company-zone instants, so store zone day starts. */
function inCompanyZone(ev: ExternalEvent, zone: string): ExternalEvent {
  if (!ev.allDay) return ev;
  const startDay = ev.start.toISOString().slice(0, 10);
  const endDay = ev.end.toISOString().slice(0, 10);
  const start = zoneDayStart(startDay, zone);
  let end = zoneDayStart(endDay, zone);
  if (end.getTime() <= start.getTime()) end = zoneDayStart(zoneDayAfter(startDay), zone);
  return { ...ev, start, end };
}

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

  const decoded = decodeCursor(conn.syncCursor);
  const stale = decoded === null || now.getTime() - decoded.baseline.getTime() > DAY_MS;
  const providerCursor = stale ? null : decoded.cursor;

  const calls = deps.calendars[conn.provider];
  let page;
  try {
    page = await calls.syncEvents(await accessTokenFor(deps, ctx, conn), calendarId, providerCursor, window);
  } catch (err) {
    if (!(err instanceof CalendarAuthError)) throw err; // CalendarUnavailableError and anything else: retry later, never mark the connection.
    // A cached access token may simply be dead: forget it and retry once with a fresh one before giving up.
    forgetCachedToken(conn.id);
    try {
      page = await calls.syncEvents(await accessTokenFor(deps, ctx, conn), calendarId, providerCursor, window);
    } catch (err2) {
      if (err2 instanceof CalendarAuthError) {
        forgetCachedToken(conn.id);
        await withTenant(deps.pools, ctx, (tx) => markConnectionError(tx, ctx, conn.id, 'Reconnect your calendar.', deps.clock.now()));
      }
      throw err2;
    }
  }
  const fullResync = page.fullResync || stale;
  const baseline = fullResync || decoded === null ? now : decoded.baseline;

  return withTenant(deps.pools, ctx, async (tx) => {
    const [locked] = await tx
      .select({ status: calendarConnections.status, syncCursor: calendarConnections.syncCursor })
      .from(calendarConnections)
      .where(and(eq(calendarConnections.companyId, ctx.companyId), eq(calendarConnections.id, conn.id)))
      .limit(1)
      .for('update');
    // Another pull of this connection already applied this page, or the connection was disconnected / marked error meanwhile.
    if (!locked || locked.status !== 'connected' || locked.syncCursor !== conn.syncCursor) return { moved: 0, canceled: 0, busy: 0 };
    const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
    const zone = company?.timezone ?? 'America/Chicago';
    let moved = 0;
    let canceled = 0;
    const toUpsert: ExternalEvent[] = [];
    const toRemove: string[] = [];

    for (const raw of page.events) {
      const ev = inCompanyZone(raw, zone);
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

    if (fullResync) await replaceBusyBlocks(tx, ctx, conn.id, conn.userId, toUpsert);
    else {
      if (toUpsert.length > 0) await upsertBusyBlocks(tx, ctx, conn.id, conn.userId, toUpsert);
      if (toRemove.length > 0) await removeBusyBlocks(tx, ctx, conn.id, toRemove);
      await pruneBusyBlocksEndingBefore(tx, ctx, conn.id, window.from);
    }

    await saveCursor(tx, ctx, conn.id, encodeCursor(baseline, page.nextCursor), now);
    return { moved, canceled, busy: toUpsert.length };
  });
}
