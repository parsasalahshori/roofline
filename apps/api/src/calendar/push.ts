import {
  appointments,
  calendarConnections,
  companies,
  deleteEventLink,
  getAppointmentView,
  getConnection,
  getEventLink,
  markConnectionError,
  saveEventLink,
  setPushError,
  withTenant,
  type CalendarConnectionRow,
  type TenantContext,
} from '@roofline/db';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../app.ts';
import type { JobMeta } from '../jobs/queue.ts';
import { systemContext } from '../permissions.ts';
import { CalendarAuthError, CalendarUnavailableError, type ExternalEventInput } from '../providers/calendar.ts';
import { eventInputFor } from './event-text.ts';
import { accessTokenFor, forgetCachedToken } from './tokens.ts';

/*
 * Pushes one appointment to its assignee's connected calendar (C1 Task 13). Each database access is
 * its own short transaction; provider calls never run inside one. The stored etag after a push is the
 * one the provider returned, so the pull (Task 14) can skip our own echo. Provider error text is
 * never logged or stored; the plain reasons are 'reconnect' and 'unavailable'.
 */

type Link = NonNullable<Awaited<ReturnType<typeof getEventLink>>>;
type View = NonNullable<Awaited<ReturnType<typeof getAppointmentView>>>;

type Loaded = {
  view: View | null;
  row: { status: string; archivedAt: Date | null; assignedUserId: string | null; updatedAt: Date } | null;
  timeZone: string;
  link: Link | null;
  assignee: CalendarConnectionRow | null;
  linkConn: CalendarConnectionRow | null;
};

const RECONNECT_PLAIN = 'Reconnect your calendar.'; // the same text tokens.ts stores on the connection

/** Runs provider calls with a token for `conn`. If a cached token is refused, it is forgotten and the calls run once more with a fresh one (a dead grant makes accessTokenFor mark the connection error). If the fresh token is refused too, the connection is marked error here. */
async function withToken<T>(deps: AppDeps, ctx: TenantContext, conn: CalendarConnectionRow, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await accessTokenFor(deps, ctx, conn);
  try {
    return await fn(token);
  } catch (err) {
    if (!(err instanceof CalendarAuthError)) throw err;
    forgetCachedToken(conn.id);
  }
  const fresh = await accessTokenFor(deps, ctx, conn);
  try {
    return await fn(fresh);
  } catch (err) {
    if (err instanceof CalendarAuthError) {
      forgetCachedToken(conn.id);
      await withTenant(deps.pools, ctx, (tx) => markConnectionError(tx, ctx, conn.id, RECONNECT_PLAIN, deps.clock.now()));
    }
    throw err;
  }
}

/** Reads everything one push needs in a single transaction. */
async function load(deps: AppDeps, ctx: TenantContext, appointmentId: string): Promise<Loaded> {
  return withTenant(deps.pools, ctx, async (tx) => {
    const view = await getAppointmentView(tx, ctx, appointmentId);
    const [row] = await tx
      .select({ status: appointments.status, archivedAt: appointments.archivedAt, assignedUserId: appointments.assignedUserId, updatedAt: appointments.updatedAt })
      .from(appointments)
      .where(and(eq(appointments.id, appointmentId), eq(appointments.companyId, ctx.companyId)))
      .limit(1);
    const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
    const link = await getEventLink(tx, ctx, appointmentId);
    const found = row?.assignedUserId ? await getConnection(tx, ctx, row.assignedUserId) : null;
    const assignee = found && found.status === 'connected' && found.calendarId !== null ? found : null;
    let linkConn: CalendarConnectionRow | null = null;
    if (link) {
      [linkConn = null] = await tx
        .select()
        .from(calendarConnections)
        .where(and(eq(calendarConnections.id, link.connectionId), eq(calendarConnections.companyId, ctx.companyId)))
        .limit(1);
    }
    return { view, row: row ?? null, timeZone: company?.timezone ?? 'America/Chicago', link, assignee, linkConn };
  });
}

/** Deletes the remote event when its connection still works, then drops the link row. */
async function removeRemote(deps: AppDeps, ctx: TenantContext, appointmentId: string, conn: CalendarConnectionRow | null, link: Link): Promise<void> {
  if (conn && conn.status !== 'error' && conn.calendarId !== null) {
    try {
      await withToken(deps, ctx, conn, (token) => deps.calendars[conn.provider].deleteEvent(token, conn.calendarId!, link.providerEventId));
    } catch (err) {
      // A dead old connection is already marked error (by accessTokenFor or withToken); its event cannot be reached, so only the link is dropped.
      if (!(err instanceof CalendarAuthError)) throw err;
    }
  }
  await withTenant(deps.pools, ctx, (tx) => deleteEventLink(tx, ctx, appointmentId));
}

/** Creates the remote event and records the link. */
async function createAndLink(deps: AppDeps, ctx: TenantContext, appointmentId: string, conn: CalendarConnectionRow, token: string, input: ExternalEventInput): Promise<void> {
  const r = await deps.calendars[conn.provider].createEvent(token, conn.calendarId!, input);
  await withTenant(deps.pools, ctx, (tx) => saveEventLink(tx, ctx, { appointmentId, connectionId: conn.id, providerEventId: r.id, etag: r.etag }, deps.clock.now()));
}

/** Records the new etag of an event we updated. */
async function relink(deps: AppDeps, ctx: TenantContext, appointmentId: string, conn: CalendarConnectionRow, link: Link, etag: string | null): Promise<void> {
  await withTenant(deps.pools, ctx, (tx) => saveEventLink(tx, ctx, { appointmentId, connectionId: conn.id, providerEventId: link.providerEventId, etag }, deps.clock.now()));
}

/** Updates the linked event, handling a vanished event and an edit made on the provider's side. */
async function updateLinked(
  deps: AppDeps,
  ctx: TenantContext,
  appointmentId: string,
  conn: CalendarConnectionRow,
  link: Link,
  token: string,
  input: ExternalEventInput,
  updatedAt: Date,
): Promise<void> {
  const api = deps.calendars[conn.provider];
  const calendarId = conn.calendarId!;
  let res = await api.updateEvent(token, calendarId, link.providerEventId, link.etag, input);
  if (res === 'conflict') {
    const ext = await api.getEvent(token, calendarId, link.providerEventId);
    if (ext && ext.updatedAt.getTime() > updatedAt.getTime()) return; // the provider's edit is newer; the pull applies it
    if (!ext) res = 'gone';
    else res = await api.updateEvent(token, calendarId, link.providerEventId, null, input);
  }
  if (res === 'conflict') return;
  if (res === 'gone') return createAndLink(deps, ctx, appointmentId, conn, token, input);
  await relink(deps, ctx, appointmentId, conn, link, res.etag);
}

/** The push proper: removes, creates or updates the remote event. */
async function sync(deps: AppDeps, ctx: TenantContext, appointmentId: string, d: Loaded): Promise<void> {
  let link = d.link;
  const conn = d.assignee;
  if (link && link.connectionId !== conn?.id) {
    await removeRemote(deps, ctx, appointmentId, d.linkConn, link);
    link = null;
  }
  const gone = !d.view || !d.row || d.row.status === 'canceled' || d.row.archivedAt !== null || !conn;
  if (gone) {
    if (link) await removeRemote(deps, ctx, appointmentId, d.linkConn, link);
    return;
  }
  const input = eventInputFor(d.view!, { jobUrl: d.view!.jobId ? `${deps.config.APP_ORIGIN}/jobs/${d.view!.jobId}` : null, timeZone: d.timeZone });
  const current = link;
  await withToken(deps, ctx, conn, (token) =>
    current ? updateLinked(deps, ctx, appointmentId, conn, current, token, input, d.row!.updatedAt) : createAndLink(deps, ctx, appointmentId, conn, token, input),
  );
}

/** Pushes one appointment to the people's connected calendars (C1 Task 13). */
export async function pushAppointment(deps: AppDeps, companyId: string, appointmentId: string, meta: JobMeta): Promise<void> {
  const ctx = systemContext(companyId);
  const d = await load(deps, ctx, appointmentId);
  if (!d.row) {
    if (d.link) await withTenant(deps.pools, ctx, (tx) => deleteEventLink(tx, ctx, appointmentId));
    return;
  }
  try {
    await sync(deps, ctx, appointmentId, d);
  } catch (err) {
    if (err instanceof CalendarAuthError) {
      await withTenant(deps.pools, ctx, (tx) => setPushError(tx, ctx, appointmentId, 'reconnect'));
      return;
    }
    if (err instanceof CalendarUnavailableError && meta.lastAttempt) {
      await withTenant(deps.pools, ctx, (tx) => setPushError(tx, ctx, appointmentId, 'unavailable'));
    }
    throw err;
  }
}
