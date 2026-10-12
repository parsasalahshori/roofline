import { and, eq, sql } from 'drizzle-orm';
import type { CalendarProvider } from '@roofline/shared';
import { calendarBusyBlocks, calendarConnections } from '../schema/tenant.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Data access for each person's calendar connection (spec Decisions 19-22). One connection per
 * person, keyed by (company, user). Every query names the context's company, so a connection of
 * another company is never found. Links (calendar-links.ts) and busy blocks (calendar-busy.ts) live
 * in their own repos; this file only drops busy blocks when the calendar they came from changes.
 */

export type CalendarConnectionRow = typeof calendarConnections.$inferSelect;

/** The connection of one person in the context's company, or null. */
export async function getConnection(tx: Tx, ctx: TenantContext, userId: string): Promise<CalendarConnectionRow | null> {
  const [row] = await tx
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.companyId, ctx.companyId), eq(calendarConnections.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Connects (or reconnects) a person's calendar. A new grant resets the sync cursor and the status. If
 * the person had a connection already, its busy blocks go too, since they may belong to another
 * provider or calendar. The row id stays the same on the upsert.
 */
export async function saveConnection(
  tx: Tx,
  ctx: TenantContext,
  c: { userId: string; provider: CalendarProvider; accountEmail: string; encryptedCredentials: Buffer; scopes: string[]; calendarId: string; calendarName: string },
  now: Date,
): Promise<CalendarConnectionRow> {
  const existing = await getConnection(tx, ctx, c.userId);
  if (existing) {
    await tx
      .delete(calendarBusyBlocks)
      .where(and(eq(calendarBusyBlocks.companyId, ctx.companyId), eq(calendarBusyBlocks.connectionId, existing.id)));
  }
  const [row] = await tx
    .insert(calendarConnections)
    .values({
      companyId: ctx.companyId,
      userId: c.userId,
      provider: c.provider,
      accountEmail: c.accountEmail,
      calendarId: c.calendarId,
      calendarName: c.calendarName,
      encryptedCredentials: c.encryptedCredentials,
      scopes: c.scopes,
      status: 'connected',
      lastErrorPlain: null,
      syncCursor: null,
      lastSyncedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [calendarConnections.companyId, calendarConnections.userId],
      set: {
        provider: c.provider,
        accountEmail: c.accountEmail,
        calendarId: c.calendarId,
        calendarName: c.calendarName,
        encryptedCredentials: c.encryptedCredentials,
        scopes: c.scopes,
        status: 'connected',
        lastErrorPlain: null,
        syncCursor: null,
        lastSyncedAt: null,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error('The calendar connection was not saved.');
  return row;
}

/** Points a connection at another calendar: resets its cursor and drops the busy blocks of the old one. No-op without a connection. */
export async function setConnectionCalendar(
  tx: Tx,
  ctx: TenantContext,
  userId: string,
  calendarId: string,
  calendarName: string,
  now: Date,
): Promise<void> {
  const existing = await getConnection(tx, ctx, userId);
  if (!existing) return;
  await tx
    .update(calendarConnections)
    .set({ calendarId, calendarName, syncCursor: null, lastSyncedAt: null, updatedAt: now })
    .where(and(eq(calendarConnections.companyId, ctx.companyId), eq(calendarConnections.id, existing.id)));
  await tx
    .delete(calendarBusyBlocks)
    .where(and(eq(calendarBusyBlocks.companyId, ctx.companyId), eq(calendarBusyBlocks.connectionId, existing.id)));
}

/** Marks a connection as broken with a reason key a person can read. The status is `error` until a reconnect. */
export async function markConnectionError(tx: Tx, ctx: TenantContext, connectionId: string, errorPlain: string, now: Date): Promise<void> {
  await tx
    .update(calendarConnections)
    .set({ status: 'error', lastErrorPlain: errorPlain, updatedAt: now })
    .where(and(eq(calendarConnections.companyId, ctx.companyId), eq(calendarConnections.id, connectionId)));
}

/** Replaces the stored credentials of a connection, e.g. after the provider rotated the refresh token. Status and cursor stay as they are. */
export async function updateConnectionCredentials(
  tx: Tx,
  ctx: TenantContext,
  connectionId: string,
  encryptedCredentials: Buffer,
  now: Date,
): Promise<void> {
  await tx
    .update(calendarConnections)
    .set({ encryptedCredentials, updatedAt: now })
    .where(and(eq(calendarConnections.companyId, ctx.companyId), eq(calendarConnections.id, connectionId)));
}

/** Removes a person's connection. Its busy blocks and event links go with it (foreign keys cascade). True when a row was removed. */
export async function deleteConnection(tx: Tx, ctx: TenantContext, userId: string): Promise<boolean> {
  const rows = await tx
    .delete(calendarConnections)
    .where(and(eq(calendarConnections.companyId, ctx.companyId), eq(calendarConnections.userId, userId)))
    .returning({ id: calendarConnections.id });
  return rows.length > 0;
}

/** How many active members of the company have a connected calendar (the setup checklist fact). */
export async function connectedMemberCount(tx: Tx, ctx: TenantContext): Promise<number> {
  // company_members is a view limited to the company by row security (see repos/setup.ts).
  const result = await tx.execute(
    sql`select count(*)::int as n
          from calendar_connections cc
         where cc.company_id = ${ctx.companyId}
           and cc.status = 'connected'
           and exists (select 1 from company_members m where m.user_id = cc.user_id and m.status = 'active')`,
  );
  const row = result.rows[0] as { n: number } | undefined;
  return row?.n ?? 0;
}
